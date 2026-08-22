/**
 * Layer 2 of the RAG gate: is THIS utterance worth a knowledge lookup?
 *
 * Pure and synchronous — no DB, no network, no LLM. An LLM router here would spend exactly the
 * latency the gate exists to save, so the rule is a cheap, auditable heuristic.
 *
 * ⚠️ THE RULE IS "SKIP ACKNOWLEDGEMENTS", NOT "SKIP NON-QUESTIONS".
 *
 * The RAG plan proposed gating on questions. That is wrong for this product, and the failure is
 * silent: Hebrew objections are STATEMENTS, not questions — "זה יקר לי", "אני לא חושב שAI יכול
 * לעשות את זה", "אני מעדיף שאדם יחזור". Objection answers are precisely the content that moved into
 * the knowledge base, so a question-gate would suppress the retrievals the KB most exists for, on the
 * turns that decide whether the call is won. The eval covers those exact utterances.
 *
 * So: retrieve for everything EXCEPT the short closed-class noises that carry no information need.
 */

/**
 * Pure acknowledgements. A closed list, deliberately — every entry is a complete utterance that can
 * only ever mean "I heard you", never a question in disguise. Anything not on this list retrieves.
 *
 * Kept literal rather than clever: a stemmer or a fuzzy match would eventually swallow a real
 * question, and the cost of a needless retrieval (one DB hit) is far below the cost of a missed one
 * (she cannot answer, and says "I'll have the team follow up" to a lead who asked a simple question).
 */
const ACKNOWLEDGEMENTS = new Set([
  'כן',
  'לא',
  'בסדר',
  'אוקיי',
  'אוקי',
  'okay',
  'ok',
  'טוב',
  'תודה',
  'תודה רבה',
  'סבבה',
  'מעולה',
  'יופי',
  'הבנתי',
  'ברור',
  'נכון',
  'בטח',
  'כן כן',
  'לא לא',
  'אוקיי תודה',
  'בסדר גמור',
  'שלום',
  'הלו',
  'אהלן',
  'רגע',
  'שנייה',
  'אמממ',
  'אהh',
]);

/** Strip the punctuation and niqqud STT sometimes emits, so "כן." and "כן" are the same utterance. */
function normalize(text: string): string {
  return text
    .replace(/[֑-ׇ]/g, '') // niqqud / cantillation
    .replace(/[.,!?;:־–—"'`()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * True when the utterance is a bare acknowledgement and should NOT trigger retrieval.
 *
 * The word-count ceiling matters: "כן, אבל כמה זה עולה" starts with an acknowledgement and is very
 * much a question, so only utterances that are ENTIRELY acknowledgement are skipped.
 */
export function isAcknowledgement(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return true; // nothing said → nothing to look up
  if (normalized.split(' ').length > 3) return false;
  return ACKNOWLEDGEMENTS.has(normalized);
}

export interface GateDecision {
  retrieve: boolean;
  /** Why, for the per-turn log line — so a call transcript can be read against what was fetched. */
  reason:
    | 'ok'
    | 'rag_disabled'
    | 'phase_gate'
    | 'acknowledgement'
    | 'too_short'
    | 'contact_data'
    | 'answering_agent';
}

/**
 * ── R2.1: SKIP THE TURNS WHERE THE CALLER IS ANSWERING, NOT ASKING ─────────────────────────────
 *
 * Measured on the 2026-08-22 real call: 28 of 40 retrievals (70%) returned nothing usable, costing
 * 7,645ms of embedding and DB work. 22 of them were in `qualifying` and 14 in `scheduling`. The
 * transcript says exactly why — those turns are the caller handing over data she asked for:
 *
 *     "קורן שטרית."            <- a name
 *     "050."                   <- a phone number, in pieces
 *     "9788.  8.  45."
 *     "K-A-S קורן, שטרודל gmail נקודה com."
 *
 * None of these is an information need. There is nothing in a knowledge base that answers them, and
 * embedding them is pure cost. Two cheap, auditable rules catch the whole class.
 */

/** Mostly-digits utterances: a phone number being read out, in whole or in pieces. */
const DIGIT_HEAVY = /^[\d\s.,\-+()־]{3,}$/;

/**
 * An email being spelled out. The Hebrew word for "@" spoken aloud is included.
 *
 * `com` carries word boundaries deliberately: without them it matches inside ordinary words,
 * and this rule's false positives are the expensive kind — a real question silently un-grounded.
 */
const EMAIL_SHAPE = /@|שטרודל|gmail|נקודה קום|dot com|com/i;

/**
 * Her asking for contact details. If her last turn was one of these, the caller's next turn is the
 * answer to it — data, not a question.
 *
 * Matched against HER OWN words rather than the call stage, because the stage is too coarse: she asks
 * for a name during `discovery` and for a phone during `scheduling`, and both are the same situation.
 */
const ASKED_FOR_CONTACT = /מה השם|השם המלא|מספר הטלפון|מה הטלפון|כתובת המייל|מה המייל|עם מי אני מדבר/;

/**
 * True when the utterance is the caller handing over contact data rather than asking anything.
 *
 * Deliberately narrow. A false positive here means a real question goes un-grounded, which is the
 * expensive failure; a false negative just costs one embedding, which is the cheap one. So it fires
 * only on shapes that cannot be a question: digits, or an address being spelled.
 */
export function isContactData(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  if (DIGIT_HEAVY.test(normalized)) return true;
  // An email is only contact data when it is SHORT — "מה המייל שלכם?" contains "מייל" and is a
  // question about the company, not an address being dictated.
  return EMAIL_SHAPE.test(normalized) && normalized.split(' ').length <= 8;
}

/**
 * The full two-layer decision. `ragActive` comes from `CallStateMachine.ragActive` (Layer 1); this
 * function owns Layer 2 and the flag check, so `agent.ts` reads one boolean and logs one reason.
 */
export function decideRetrieval(opts: {
  enabled: boolean;
  ragActive: boolean;
  transcript: string;
  /** Her previous turn, when known. Absent → the `answering_agent` rule simply does not apply. */
  lastAgentTurn?: string | null;
}): GateDecision {
  if (!opts.enabled) return { retrieve: false, reason: 'rag_disabled' };
  if (!opts.ragActive) return { retrieve: false, reason: 'phase_gate' };

  // Acknowledgements are checked FIRST, before the length guard. "כן" and "לא" are two characters, so
  // a length check placed first would swallow them and log `too_short` — the same decision for the
  // wrong reason, which is worse than useless when reading a call log to find out why a turn was not
  // grounded.
  if (isAcknowledgement(opts.transcript)) return { retrieve: false, reason: 'acknowledgement' };

  // What remains under three characters is a mid-word fragment; Soniox emits these between interim
  // results, and no Hebrew question is that short.
  if (normalize(opts.transcript).length < 3) return { retrieve: false, reason: 'too_short' };

  // R2.1 — the caller is handing over data, not asking for any.
  if (isContactData(opts.transcript)) return { retrieve: false, reason: 'contact_data' };

  // …and the same, established from context rather than shape: she just asked for a detail, so this
  // turn is the answer. Guarded on length, because "קורן. ומה המחיר?" is an answer AND a question,
  // and the question is the half that matters.
  if (opts.lastAgentTurn && ASKED_FOR_CONTACT.test(opts.lastAgentTurn)) {
    if (normalize(opts.transcript).split(' ').length <= 4) {
      return { retrieve: false, reason: 'answering_agent' };
    }
  }

  return { retrieve: true, reason: 'ok' };
}
