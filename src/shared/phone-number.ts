/**
 * Phone-number canonicalisation for DID ROUTING.
 *
 * ── Why this is not `phoneSuffix()` ───────────────────────────────────────────────────────────
 *
 * `tools/lead-store.ts` matches leads by their last 9 digits, which is exactly right there: the
 * question is "is this the same person I already know about, whatever format the CRM stored?", and
 * a false match inside one tenant is a merged contact record.
 *
 * Routing an inbound call is a different question with a different blast radius. A suffix collision
 * — two numbers in different countries sharing nine trailing digits — would hand tenant A's caller
 * to tenant B's agent. That is the precise failure this whole phase exists to prevent, so matching
 * here is EXACT, over a set of candidate spellings, and never fuzzy.
 *
 * The cost of exactness is that an unanticipated format fails to match and the caller hears "not in
 * service". That is the right direction to fail: it is visible, it is logged with the number that
 * missed, and it is fixed with one INSERT — whereas routing to the wrong tenant is silent and
 * discovered by a customer.
 */

/** Everything that is not a digit or a leading plus. Carriers send spaces, dashes and parens. */
function strip(raw: string): string {
  return raw.trim().replace(/[^\d+]/g, '');
}

/**
 * Canonical storage form: `+` followed by digits.
 *
 * Returns null for anything that cannot be a real international number, so a typo in provisioning
 * fails at the INSERT rather than becoming a row that can never match an incoming call.
 */
export function toE164(raw: string, defaultCountryCode = '972'): string | null {
  const cleaned = strip(raw);
  if (!cleaned) return null;

  let digits: string;
  if (cleaned.startsWith('+')) {
    digits = cleaned.slice(1);
  } else if (cleaned.startsWith('00')) {
    // International access prefix, common in Europe and on some SIP trunks.
    digits = cleaned.slice(2);
  } else if (cleaned.startsWith('0')) {
    // A national number (Israeli mobiles arrive as 05x…). The trunk lives in Israel, so this is
    // the sane default — but it IS an assumption, which is why it is a parameter and not a literal.
    digits = defaultCountryCode + cleaned.slice(1);
  } else {
    digits = cleaned;
  }

  // A `+` anywhere but the front means we were handed something that is not a phone number.
  if (digits.includes('+')) return null;
  // E.164 allows at most 15 digits; below 8 there is no country code plus subscriber number.
  if (!/^\d{8,15}$/.test(digits)) return null;

  return `+${digits}`;
}

/**
 * Every spelling a stored `e164` column might plausibly hold for this incoming number.
 *
 * Zadarma is not consistent: the trunk config declares `+972555070922` while SIP participant
 * attributes have arrived as `972555070922`. Rather than trusting one side to normalise, the
 * lookup asks for all of them and lets the unique index decide.
 *
 * Deliberately does NOT include suffix or partial forms — see the file header.
 */
export function didCandidates(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const canonical = toE164(raw);
  const cleaned = strip(raw);

  const forms = new Set<string>();
  if (canonical) {
    forms.add(canonical);
    forms.add(canonical.slice(1)); // bare digits, no plus
  }
  if (cleaned) {
    forms.add(cleaned);
    if (cleaned.startsWith('+')) forms.add(cleaned.slice(1));
    else forms.add(`+${cleaned}`);
  }
  return [...forms];
}
