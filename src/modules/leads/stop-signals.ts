/**
 * WHEN TO STOP CHASING A LEAD.
 *
 * Koren, 2026-09-04: *"we need a guardrail so the agent won't do extra follow-up if the lead
 * already said — on the phone or in WhatsApp — that he doesn't want to talk anymore. A model so
 * the agent knows when to STOP, not just when to continue."*
 *
 * -- WHAT THIS FIXES ---------------------------------------------------------------------------
 *
 * Before this file, `opted_out` had exactly ONE writer in the entire codebase: the voice agent's
 * `end_call(reason: 'opt_out')` tool. Which means:
 *
 *   · a lead who wrote "תפסיקו לשלוח לי הודעות" in WhatsApp was dialled by the callback ladder the
 *     next morning, three times, because no inbound text path ever set the flag;
 *   · a lead who said "לא מעוניין" on the phone got the full ladder, because `not_interested` is a
 *     different `end_call` reason and nothing downstream treated it as a stop.
 *
 * Enforcement was never the gap — `callbacks.worker.ts`, `flow-executor.worker.ts` and
 * `meeting-reminders.worker.ts` all refuse an opted-out lead. DETECTION was the gap. This is it.
 *
 * -- THREE TIERS, NOT A BOOLEAN ----------------------------------------------------------------
 *
 *   HARD STOP   "אל תתקשרו אליי יותר", "הסר", "STOP". A do-not-contact instruction. Permanent,
 *               cross-channel, `leads.status = 'opted_out'`, and no tenant setting reaches it.
 *               Israeli spam law (חוק התקשורת, תיקון 40) is about exactly this sentence.
 *
 *   SOFT STOP   "לא מעוניין", "כבר סגרתי עם מישהו אחר". He does not want the follow-ups; he has
 *               not forbidden contact. The ladder stops and `leads.followup_stopped_at` is set.
 *               If he writes back or calls in later, he is a live lead again — see
 *               `clearFollowupStop`. This tier exists because collapsing it into HARD would
 *               permanently burn every lead who ever said "not now, thanks" and collapsing it into
 *               CONTINUE is what the system did until today.
 *
 *   CONTINUE    "לא עכשיו", "אני בישיבה", "תחזור אליי מחר". TIMING, NOT REFUSAL — the sales model
 *               (`docs/gtm/keren-sales-model.md`, objection #4) says so explicitly, and these are
 *               the leads the follow-up ladder exists for. Misreading one of these as a stop
 *               silently deletes the feature.
 *
 * -- TWO LAYERS, AND WHY THE ORDER MATTERS -----------------------------------------------------
 *
 *   1. A DETERMINISTIC phrase list, checked first and alone sufficient for HARD. A legal
 *      obligation must not depend on OpenAI being reachable, on a model version, or on a JSON
 *      parse succeeding. If the phrase list fires, we stop, and no classifier can talk us out
 *      of it — `classify` never downgrades a hard keyword hit.
 *
 *   2. An LLM classifier for everything the list cannot catch, which is most real refusals.
 *      Nobody writes "אני מבקש להסיר את מספרי מרשימת התפוצה"; they write "אחי די, מצאתי כבר".
 *
 * -- WHAT HAPPENS WHEN THE CLASSIFIER IS DOWN --------------------------------------------------
 *
 * We fall back to the phrase lists — NOT to "stop everyone". An outage that soft-stops every
 * inbound message would quietly end every live conversation in the system, and the damage would
 * be invisible until a week of pipeline had gone missing. The hard list is still enforced (that is
 * the part the law is about) and the soft list still fires; only the judgement calls are lost.
 *
 * Ambiguity is different from unavailability: a classifier that RETURNS and is unsure resolves to
 * SOFT STOP. Stopping a lead who meant "call me later" costs one lead and he can reopen it by
 * answering; chasing a lead who meant "leave me alone" costs a complaint.
 *
 * NO I/O IN THE PURE HALF. `detectStopPhrase` is a pure function over a string so the phrase list
 * can be tested exhaustively without a network, and `classifyStopSignal` takes the LLM as a
 * parameter for the same reason.
 */

export type StopVerdict = 'hard_stop' | 'soft_stop' | 'continue';

export type StopSource =
  /** The deterministic list matched. Authoritative; never revisited. */
  | 'phrase'
  /** The LLM classifier decided. */
  | 'classifier'
  /** The classifier was unreachable or unparseable; the phrase lists had the last word. */
  | 'phrase_fallback'
  /** Nothing fired. */
  | 'none';

export interface StopSignal {
  verdict: StopVerdict;
  source: StopSource;
  /** The phrase that matched, or the classifier's own one-line reason. For the audit trail. */
  evidence?: string;
}

/**
 * Hebrew is written with and without niqqud, with ״gershayim״, with and without the doubled yod
 * of "אליי", and people type into WhatsApp with no punctuation at all. Normalizing here means the
 * phrase list stays readable instead of becoming a wall of alternations.
 *
 * Deliberately NOT stripping the definite article or normalizing final letters: "מהרשימה" and
 * "הרשימה" are both spelled out in the list, and a stemmer that guesses is how a phrase list
 * starts matching sentences nobody wrote.
 */
export function normalizeForStopMatch(text: string): string {
  return text
    .normalize('NFKC')
    // Hebrew points and cantillation — U+0591–U+05C7.
    .replace(/[֑-ׇ]/g, '')
    // Apostrophes and the Hebrew geresh/gershayim are DELETED, not spaced: "don't" must become
    // "dont" and not "don t", or the English half of the hard list silently never matches. This
    // exact bug was live until its own test caught it.
    .replace(/['`´׳״’]/g, '')
    // Everything else that is punctuation becomes a space.
    .replace(/[.,!?;:"()[\]{}\-–—_/\\|*~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * DO-NOT-CONTACT. Every entry here is an instruction, not an opinion — the difference between
 * "I don't want your product" and "don't contact me again".
 *
 * Kept narrow on purpose. A false positive here is permanent: the lead is opted out and no part of
 * this system will ever contact him again, including a human reading a dashboard. Anything that
 * merely sounds negative belongs in the soft list or to the classifier.
 */
export const HARD_STOP_PHRASES: readonly string[] = [
  // — Hebrew: explicit removal —
  'הסר אותי',
  'תסיר אותי',
  'הסירו אותי',
  'להסיר אותי',
  'תורידו אותי',
  'תוריד אותי',
  'להוריד אותי מהרשימה',
  'הסרה מרשימת התפוצה',
  'מרשימת התפוצה',
  // — Hebrew: don't call —
  'אל תתקשר',
  'אל תתקשרו',
  'לא לתקשר אליי',
  'תפסיק להתקשר',
  'תפסיקו להתקשר',
  'די להתקשר',
  'תפסיק לצלצל',
  'תפסיקו לצלצל',
  // — Hebrew: don't message —
  'אל תשלח לי',
  'אל תשלחו לי',
  'תפסיק לשלוח',
  'תפסיקו לשלוח',
  'די לשלוח',
  // — Hebrew: don't contact, harassment —
  'אל תפנו אליי',
  'אל תפנה אליי',
  'תפסיקו לפנות',
  'לא ליצור איתי קשר',
  'לא רוצה שתתקשרו',
  'לא רוצה שיתקשרו אליי',
  'לא רוצה שתפנו אליי',
  'אתם מטרידים',
  'אתה מטריד',
  'זו הטרדה',
  'תפסיקו להטריד',
  // — English —
  'do not call me',
  // Apostrophes are stripped by the normalizer, so "don't" arrives here as "dont".
  'dont call me',
  'do not contact me',
  'dont contact me',
  'stop calling',
  'stop texting',
  'stop messaging',
  'remove me',
  'take me off',
  'unsubscribe',
  'opt out',
  'opt me out',
];

/**
 * A bare "stop" / "עצור" is a hard stop only when it is the WHOLE message — the SMS convention.
 * Inside a sentence it is far too often "stop by tomorrow" or "אני רוצה לעצור רגע ולחשוב", and
 * matching it as a substring would opt out leads who were still talking to us.
 */
export const HARD_STOP_EXACT: readonly string[] = ['stop', 'unsubscribe', 'remove', 'הסר', 'הסירו', 'עצור'];

/**
 * NOT INTERESTED — end the follow-ups, do not blacklist the person.
 *
 * Wider than the hard list, because the cost of a false positive here is one lead who stops
 * getting chased and can reopen the conversation with a single message.
 */
export const SOFT_STOP_PHRASES: readonly string[] = [
  'לא מעוניין',
  'לא מעוניינת',
  'לא מעוניינים',
  'לא רלוונטי',
  'לא רלוונטי בשבילי',
  'לא מתאים לי',
  'לא מתאים לנו',
  'לא צריך',
  'לא צריכים',
  'אין לי צורך',
  'אין צורך',
  'כבר סגרתי',
  'כבר סגרנו',
  'כבר יש לי',
  'כבר עובד עם',
  'כבר עובדים עם',
  'מצאתי פתרון',
  'מצאנו פתרון',
  'בחרנו במישהו אחר',
  'תודה אבל לא',
  'לא תודה',
  'עזוב אותי',
  'not interested',
  'no thanks',
  'no thank you',
  'not for me',
  'we already have',
  'we went with',
  'already sorted',
];

/**
 * TIMING, NOT REFUSAL. These are here as a NEGATIVE guard: a message that matches one of them and
 * no hard phrase is never soft-stopped by the phrase layer, whatever else it contains.
 *
 * The case this exists for: *"אני לא מעוניין לדבר עכשיו, תתקשר מחר"* contains "לא מעוניין" and is
 * the single most valuable message a lead can send us — he is asking for the callback the whole
 * follow-up model was built around. Without this guard the phrase list would end that lead.
 */
export const TIMING_PHRASES: readonly string[] = [
  'לא עכשיו',
  'לא כרגע',
  'תתקשר מאוחר יותר',
  'תתקשרו מאוחר יותר',
  'תתקשר אליי מחר',
  'תתקשר מחר',
  'תחזור אליי',
  'תחזרו אליי',
  'דבר איתי מחר',
  'אני בישיבה',
  'אני עסוק',
  'אני נוהג',
  'בהמשך השבוע',
  'call me later',
  'call me tomorrow',
  'call back later',
  'not right now',
  'in a meeting',
  'im busy',
  "i'm busy",
];

function containsAny(haystack: string, needles: readonly string[]): string | null {
  for (const n of needles) {
    if (haystack.includes(n)) return n;
  }
  return null;
}

/**
 * The deterministic layer. Pure, no I/O, and the only thing standing between us and a lawsuit when
 * OpenAI is down.
 *
 * Order is the whole design: hard beats timing beats soft.
 */
export function detectStopPhrase(text: string): StopSignal {
  const normalized = normalizeForStopMatch(text);
  if (!normalized) return { verdict: 'continue', source: 'none' };

  if (HARD_STOP_EXACT.includes(normalized)) {
    return { verdict: 'hard_stop', source: 'phrase', evidence: normalized };
  }
  const hard = containsAny(normalized, HARD_STOP_PHRASES);
  if (hard) return { verdict: 'hard_stop', source: 'phrase', evidence: hard };

  // A request to be called later is not a refusal, even when it is phrased with a "no" in it.
  if (containsAny(normalized, TIMING_PHRASES)) {
    return { verdict: 'continue', source: 'phrase', evidence: 'timing' };
  }

  const soft = containsAny(normalized, SOFT_STOP_PHRASES);
  if (soft) return { verdict: 'soft_stop', source: 'phrase', evidence: soft };

  return { verdict: 'continue', source: 'none' };
}

/**
 * The LLM half. Injected rather than imported so the tests never touch a network and so the voice
 * path can pass its own client.
 *
 * `complete` must return the model's raw text. Anything it throws is caught here.
 */
export interface StopClassifier {
  complete(params: { systemPrompt: string; userText: string }): Promise<string>;
}

export const STOP_CLASSIFIER_PROMPT = `You classify ONE message from a sales lead, in Hebrew or English.

Answer with JSON only: {"verdict":"hard_stop"|"soft_stop"|"continue","reason":"<8 words max>"}

hard_stop — he instructs us not to contact him again (do-not-call / remove me / stop messaging /
  accuses us of harassment). An INSTRUCTION about contact itself.
soft_stop — he is not interested, has bought elsewhere, or does not want the offer. A refusal of
  the OFFER, not of contact.
continue — anything else, INCLUDING: he is busy, asks to be called later or at a specific time,
  asks a question, negotiates, complains about the product, or is merely rude. Being asked to call
  back later is the most valuable message a lead sends — it is ALWAYS continue.

If you cannot tell whether he is refusing the offer or only deferring it, answer soft_stop.`;

/**
 * Full verdict: phrase list first, classifier for the rest.
 *
 * A hard phrase hit short-circuits — the classifier is never asked, so it can never soften a
 * do-not-call instruction into "he's just annoyed".
 */
export async function classifyStopSignal(
  text: string,
  classifier: StopClassifier | null,
): Promise<StopSignal> {
  const phrase = detectStopPhrase(text);
  if (phrase.verdict === 'hard_stop') return phrase;

  if (!classifier) {
    return phrase.source === 'none'
      ? { verdict: phrase.verdict, source: 'none' }
      : { ...phrase, source: 'phrase_fallback' };
  }

  try {
    const raw = await classifier.complete({
      systemPrompt: STOP_CLASSIFIER_PROMPT,
      userText: text,
    });
    const parsed = parseVerdict(raw);
    if (!parsed) {
      // Unparseable is UNAVAILABLE, not ambiguous — we did not get an opinion, so we keep the
      // phrase layer's instead of inventing a stop.
      return { ...phrase, source: 'phrase_fallback', evidence: phrase.evidence ?? 'unparseable' };
    }
    // The phrase layer may still be stricter than the model: it found a hard phrase → handled
    // above; it found a soft phrase and the model says continue → the model wins, because the
    // soft list is broad by design and the model saw the sentence around the phrase.
    return parsed;
  } catch {
    return { ...phrase, source: 'phrase_fallback', evidence: phrase.evidence ?? 'classifier_error' };
  }
}

function parseVerdict(raw: string): StopSignal | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { verdict?: unknown; reason?: unknown };
    const v = obj.verdict;
    if (v !== 'hard_stop' && v !== 'soft_stop' && v !== 'continue') return null;
    return {
      verdict: v,
      source: 'classifier',
      evidence: typeof obj.reason === 'string' ? obj.reason.slice(0, 120) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * WHAT WE SAY BACK TO SOMEBODY WHO ASKED US TO STOP (Koren approved, 2026-09-06).
 *
 * Until this existed a lead who wrote "הסר" got silence, which is both cold and — for a do-not-call
 * request — evidentially weak: the confirmation IS the record that we honoured it, on the channel
 * he used, at a timestamp anyone can read back.
 *
 * THREE RULES THIS COPY OBEYS, and each one is a trap avoided:
 *
 *   1. GENDER-NEUTRAL. We do not know whether the lead is male or female, and Hebrew makes you
 *      choose in the second person. "אם משהו ישתנה" rather than "אם תשנה את דעתך"; "הסרנו אותך"
 *      rather than anything inflected. A wrong gender on the last message a lead ever gets from us
 *      is the one place it is least forgivable.
 *   2. NO AGENT NAME, no company voice, no offer, no link. A confirmation that sells is a
 *      contact, and a contact is the thing he just forbade.
 *   3. ONE SENTENCE. There is no reply to invite and no conversation to continue.
 *
 * ONLY EVER SENT ON THE CHANNEL HE JUST WROTE ON — which is why the 24-hour WhatsApp window is
 * open by construction and no template is needed: his own message opened it seconds ago. There is
 * deliberately NO confirmation for a stop heard on a VOICE call: the agent already says goodbye
 * out loud, and a text arriving afterwards is a second contact, not an acknowledgement.
 */
export const STOP_CONFIRMATIONS: Readonly<Record<'hard_stop' | 'soft_stop', string>> = {
  hard_stop: 'קיבלנו. הסרנו אותך מרשימת הפניות ולא ניצור קשר שוב.',
  soft_stop: 'תודה על העדכון, לא נטריד יותר. אם משהו ישתנה, אנחנו כאן.',
};

/** The line to send back, or null when the verdict is `continue` and nothing is owed. */
export function stopConfirmationText(verdict: StopVerdict): string | null {
  return verdict === 'continue' ? null : STOP_CONFIRMATIONS[verdict];
}
