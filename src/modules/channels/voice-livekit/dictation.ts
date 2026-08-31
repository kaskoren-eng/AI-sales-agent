/**
 * IS THE CALLER IN THE MIDDLE OF READING SOMETHING OUT? — and why that changes what she says.
 *
 * THE CALL THIS EXISTS TO FIX (Koren, 2026-08-30 04:56 production call, verbatim):
 *
 *     169.5s  lead   "050-"
 *     172.5s  KEREN  "טוב, הבנתי."
 *     172.6s  lead   "9788845."
 *     175.0s  KEREN  "הבנתי אותךָ."
 *
 * He gave the number in two breaths, as everyone does, and she answered the first half with a
 * complete sentence. His note: *"הסוכן לא צריך לדחוף את זה בכל מקום במיוחד לא כמו במהלך שהוא לוקח
 * מספר טלפון מהלקוח. במהלך דבר כזה הוא צריך להגיד 'אה אה..' כמו הנהון קולי שהוא קיבל את המספר
 * ומסמן ללקוח להמשיך"* — while a number or an email is being dictated the right sound is a short
 * VOCAL NOD meaning *got it, keep going*, not a receipt.
 *
 * The distinction is not stylistic. A receipt is a complete conversational move: it closes the
 * caller's turn and claims the floor. Mid-dictation that is an interruption — he has not finished
 * the number, and she has just told him she has it. A nod does the opposite: it says *still
 * listening*, and hands the floor straight back.
 *
 * ── Why a pure function of the caller's last utterance ────────────────────────────────────────
 *
 * The obvious design is a state machine — arm when she asks for the phone, disarm when she reads
 * it back. It is also the design that gets STUCK: a call where the read-back never happens (he
 * changes the subject, the tool fails, the STT garbles it) leaves her nodding at everything for
 * the rest of the call, and nothing in the transcript would say why. A classifier over the turn
 * she is answering cannot get stuck, is testable in one line per case, and is wrong for at most
 * one turn.
 *
 * So the signal is the DICTATION ITSELF, not the intent behind it: three or more digits, the
 * spoken furniture of an email address (שטרודל / ג'ימייל / נקודה קום / @), or letters being
 * spelled out one at a time. All three are things a person only does when reading something out.
 *
 * ── What it deliberately does NOT catch ───────────────────────────────────────────────────────
 *
 * A short fragment during the same exchange ("כמו סלטה.") reads as dictation to a human and not
 * to this classifier, and that is the accepted cost of having no state. A wrong receipt on one
 * turn is the bug we already have; a nod on every turn of a call would be a worse one.
 *
 * Also excluded: anything with a question mark. "כמה זה עולה, 500?" carries digits and is not
 * dictation — he is asking, and a nod would leave him waiting.
 */

/**
 * The nod itself.
 *
 * ⚠️ STILL PROVISIONAL, AND NOW PROVISIONAL ON THE RECORD. This is Koren's own spelling ("אה אה"),
 * never screened. Round 6 offered five spellings and he could not play a single clip (every WAV in
 * rounds 1–8 carried a broken header). Round 10, 2026-08-31, card `n1`, finally played: four
 * spellings — `אה אה.` · `אהה.` · `אה-אה.` · `אַה אַה.` — and **he chose NONE of them.** So this
 * constant is unchanged not because it passed but because nothing beat it.
 *
 * That is the hardest card in the set and the reason is structural: the nod is the one sound in the
 * agent's vocabulary spoken ALONE, with no carrier sentence to lend it context, while the caller is
 * mid-way through reading out a phone number. Round 11
 * (`tests/hebrew-tts-niqqud-ab/round11.py`) is built for exactly this position, with candidates
 * that are not spellings of `אה` at all — the Israeli back-channels `אהם` / `אהא` / `הממ`, and the
 * two sounds he DID pick in round 10 (`אמ`, `אֶה`), which he has never heard alone. When he picks,
 * change this one constant.
 *
 * If he rejects the whole set again, the honest conclusion is that there is no good nod and the
 * right move is silence mid-dictation, not a fifth guess. That would be a change to
 * `chooseTurnOpener` (which today falls back to a RECEIPT when the nod is absent — the very
 * interruption the nod exists to prevent), not to this string.
 */
export const DICTATION_NOD = 'אה אה.';

/**
 * A number being READ OUT, as opposed to a number being mentioned.
 *
 * Soniox writes spoken digits back as digits (its inverse text normalisation — known-issues §10),
 * so this reads the caller's transcript directly. The three shapes are the ones dictation makes
 * and conversation does not:
 *   - four or more digits running          "9788845"
 *   - two groups of digits with a break     "052 345 6789"
 *   - a three-digit group left hanging      "050-"   <- the exact turn that produced the bug
 *
 * Deliberately NOT `\d{3,}`: "זה בערך 500 שקל" is a price, not a dictation, and "24/7" and
 * "20 אלף" must stay conversation. A missed nod costs one ordinary receipt; a nod at a man
 * discussing his budget costs the appearance of listening.
 */
const DIGITS = /\d{4,}|\d{2,}[\s.,-]+\d{2,}|\d{3}\s*[-–—]/u;

/**
 * The spoken furniture of an email address, in the Hebrew people actually say on the phone.
 * ג'ימייל / גימייל cover Soniox's two spellings of the same word; שטרודל is "@" said aloud.
 */
const EMAIL_SPOKEN = /שטרודל|ג'?ימייל|נקודה\s*קום|dot\s*com|@|\.(?:com|co\.il|net|org)\b/iu;

/**
 * Letters being spelled out — "זה K-A-S", "K-O-R-E-N", "ק' ו' ר' ן'". Two or more single
 * characters separated by a dash or spaces. Requires the separators: a bare "AI" is a word we say
 * constantly and must not read as spelling.
 */
const SPELLED_OUT = /(?:\b[A-Za-z]\b[\s.-]+){2,}\b[A-Za-z]\b|(?:[א-ת]['׳][\s-]*){3,}/u;

/** He is asking, not dictating — a question is never a turn to nod through. */
const QUESTION = /[?؟]/u;

/**
 * Is the caller reading something out to be written down?
 *
 * Fed the caller's last COMMITTED utterance (the ConversationItemAdded hook, the same source the
 * gender tracker reads), so it judges what she actually heard rather than what the model guessed.
 */
export function isDictationTurn(utterance: string | null | undefined): boolean {
  if (!utterance) return false;
  const text = utterance.trim();
  if (!text) return false;
  if (QUESTION.test(text)) return false;
  return DIGITS.test(text) || EMAIL_SPOKEN.test(text) || SPELLED_OUT.test(text);
}
