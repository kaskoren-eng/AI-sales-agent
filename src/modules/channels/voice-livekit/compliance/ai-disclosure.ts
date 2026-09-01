/**
 * AI disclosure tracking — the caller must learn they were talking to an AI.
 *
 * PRODUCT DECISION (2026-07-17, documented): for the Israeli market today, END-OF-CALL disclosure
 * is acceptable — if the caller never asked and Keren never happened to say it, the goodbye
 * carries one natural disclosure sentence. There is no Israeli statute mandating timely
 * disclosure yet (the Privacy Protection Authority recommends it; the prompt already answers
 * honestly when asked).
 *
 * ⚠️ REVISIT BEFORE SERVING EU LEADS: the EU AI Act (Art. 50) requires TIMELY disclosure —
 * end-of-call would not comply. California SB 1001 is similar in spirit. If ClickScales ever
 * dials into either market, the disclosure moves to the opening.
 *
 * DETECTION IS DETERMINISTIC, NOT DELEGATED: we scan what the agent actually SAID (the call
 * transcript), never ask the LLM whether it remembers disclosing. A model's memory of its own
 * compliance is not evidence; the transcript is.
 */

/**
 * Phrases that count as the agent disclosing she is an AI. Matched against AGENT transcript
 * lines only. Kept deliberately broad — any of these makes it unambiguous to a Hebrew speaker.
 */
const DISCLOSURE_PATTERNS: RegExp[] = [
  /סוכנת\s+AI/u, // "אני סוכנת AI" — the prompt's own phrasing
  /סוכן\s+AI/u,
  // ה? — the definite article rides the adjective too: "העוזרת הדיגיטלית של קורן".
  /עוזרת\s+ה?דיגיטלית/u,
  /עוזרת\s+ה?אוטומטית/u,
  /סוכנת\s+ה?וירטואלית/u,
  // Masculine forms, because an agent's gender is a tenant setting. Without these, a male agent
  // could disclose perfectly and still be recorded as `missed` — a compliance report that is wrong
  // in the direction of alarm, which is how a real finding gets dismissed as a known false positive.
  // The (?!ת) stops the masculine pattern from also matching the feminine spelling.
  /עוזר\s+ה?דיגיטלי(?!ת)/u,
  /עוזר\s+ה?אוטומטי(?!ת)/u,
  /סוכן\s+ה?וירטואלי(?!ת)/u,
  /בינה\s+מלאכותית/u,
  /(?<![֐-׿])AI(?![֐-׿A-Za-z])\s+(של|מ)/u, // "ה-AI של ClickScales"
];

/** Does this single agent utterance disclose that she is an AI? */
export function hasAiDisclosure(text: string): boolean {
  return DISCLOSURE_PATTERNS.some((p) => p.test(text));
}

/**
 * The one-liner end_call appends to the goodbye when nothing was disclosed during the call.
 *
 * ⚠️ ONE COMMA WAS REMOVED HERE ON 2026-09-01 AND NOBODY HAS HEARD THE RESULT. Koren's round-13
 * card `g1` was the same sentence shape — a name-and-role clause read out as a greeting — and his
 * verdict was that the commas make it robotic. The comma after `רק שתדע` is the same comma doing
 * the same thing, and this sentence is spoken at the END of a call to a lead who never learned she
 * was an AI, so it is a compliance line as well as a stylistic one. Zero words changed.
 *
 * It is on round 14 (card `d1`) and it has NOT yet been judged. If he dislikes it, the comma goes
 * back — it is one character.
 */
export const END_DISCLOSURE_INSTRUCTION =
  'IMPORTANT: you have not yet told the caller you are an AI. Your goodbye MUST include one ' +
  'natural, warm Hebrew sentence disclosing you are Koren\'s digital assistant — for example: ' +
  '"רק שתדע אני העוזרת הדיגיטלית של קורן — היה כיף לדבר!".';
