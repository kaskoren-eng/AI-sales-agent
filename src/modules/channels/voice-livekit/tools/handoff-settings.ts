/**
 * Per-tenant human-handoff configuration (`tenants.settings.handoff`, VOICE-owned).
 *
 * Who gets pinged when a lead asks for a human, and on which channels. `ownerName` is what the
 * agent SAYS on the call ("אני מעבירה את זה לקורן") — a null ownerName degrades the line to a
 * generic "the team", it never blocks the handoff. Same for the contact fields: an unconfigured
 * owner means no notification goes out (logged loudly), but the lead is still flagged and the
 * call still ends politely. The handoff itself is never hostage to config.
 */

export interface HandoffSettings {
  /** First name the agent speaks on the call. Null → generic "הצוות שלנו". */
  ownerName: string | null;
  /** E.164-ish phone for the WhatsApp alert. Null → whatsapp channel is skipped. */
  ownerPhone: string | null;
  /** Email for the fallback alert. Null → email channel is skipped. */
  ownerEmail: string | null;
  /** Which channels to attempt. Both by default — WhatsApp is fast, email is reliable. */
  notify: Array<'whatsapp' | 'email'>;
}

export const HANDOFF_DEFAULTS: HandoffSettings = {
  ownerName: null,
  ownerPhone: null,
  ownerEmail: null,
  notify: ['whatsapp', 'email'],
};

function cleanString(v: unknown, maxLen: number): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 && trimmed.length <= maxLen ? trimmed : null;
}

/** Reads `settings.handoff`, tolerating any malformed shape (→ defaults). Never throws. */
export function resolveHandoffSettings(settings: unknown): HandoffSettings {
  const raw =
    settings && typeof settings === 'object'
      ? ((settings as Record<string, unknown>)['handoff'] as Record<string, unknown> | undefined)
      : undefined;
  if (!raw || typeof raw !== 'object') return HANDOFF_DEFAULTS;

  const notify = Array.isArray(raw.notify)
    ? (raw.notify.filter((c): c is 'whatsapp' | 'email' => c === 'whatsapp' || c === 'email') as Array<
        'whatsapp' | 'email'
      >)
    : HANDOFF_DEFAULTS.notify;

  return {
    ownerName: cleanString(raw.ownerName, 100),
    ownerPhone: cleanString(raw.ownerPhone, 30),
    ownerEmail: cleanString(raw.ownerEmail, 255),
    notify: notify.length > 0 ? notify : HANDOFF_DEFAULTS.notify,
  };
}
