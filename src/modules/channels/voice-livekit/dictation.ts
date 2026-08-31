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
 * THE NOD BANK — three sounds, chosen by ear, spoken one at a time.
 *
 * Koren, 2026-08-31, round-11 card `n1`, verbatim: *"אופציות מעולות שאני רוצה שנשתמש בכל אחת מהם
 * באופן רנדומלי: C, F, L"* — C = `אֶמ.`, F = `אהם.`, L = `אָה.`. All three are good and he wants
 * all three, picked at random.
 *
 * ── WHY A BANK AND NOT A CONSTANT ─────────────────────────────────────────────────────────────
 *
 * This used to be one string, and that was named as a defect before it was fixed: `spoken-openers.ts`
 * lists it as one of the four things that can occupy the head of a reply, and the only one "with no
 * rotation at all, so two dictation turns running (a phone number, then an email) produce the same
 * sound twice by construction". `SpokenOpenerTracker` papered over it by turning the second nod into
 * SILENCE. His verdict removes the cause: with three sounds and a window of one, a second dictation
 * turn has two legal answers left and does not have to fall silent.
 *
 * ── WHY THE NIQQUD IS NOT DECORATION, AND WHY TWO OF THESE WOULD DIE WITHOUT speech-guard.ts ──
 *
 * `guardSpeech` strips every Hebrew point before the text reaches Cartesia, because MODEL-emitted
 * pointing is unreliable (known-issues §13). The nod is injected by `llmNode` into the reply stream,
 * so it meets that strip like any other text — and two of these three carry marks:
 *
 *   `אֶמ.`  stripped → `אמ.`   and **`אמ.` synthesized ALONE is silence.** Measured on round 11:
 *                              0.16s, peak 49 of 32767. Koren heard clip `n1_A` and rejected it.
 *                              The segol is the difference between 0.16s of nothing and 1.04s of a
 *                              nod. Without the exemption in speech-guard.ts this bank member is
 *                              INAUDIBLE and no test anywhere would notice.
 *   `אָה.`  stripped → `אה.`   a different vowel, and one that collides with nothing.
 *   `אהם.`  carries no mark and needs no protection.
 *
 * So `speech-guard.ts` exempts these exact strings from the strip. It CANNOT be done the way the
 * round-10 fillers were done — a `PRONUNCIATION_FIXES` row keyed on the unpointed text — because
 * `אֶמ.` strips to `אמ.`, which is byte-identical to the RECEIPT `אמ.` he chose on round-10 card
 * `f1`, and guardStream hands both to the guard as their own standalone sentence. There is no
 * context to scope on: a rule that repointed the nod would repoint the receipt too, reverting a
 * verdict he never gave. The exemption keys on the mark itself, which only our own constants carry.
 *
 * ── WHAT IS AND IS NOT SETTLED ────────────────────────────────────────────────────────────────
 *
 * All three were chosen BY EAR through the 8kHz phone band, spoken alone, in the position they are
 * used in. None has been heard on a live call. The Soniox round trip heard `אה.` from C, `אהה.`
 * from F and `אה.` from L — which is weak evidence about a filler and was labelled as such on the
 * page; nobody needs to transcribe a hesitation, and his ear decided.
 *
 * ⚠️ ADDING A FOURTH IS NOT A CODE CHANGE. An unscreened Hebrew interjection fails SILENTLY
 * (written laughter comes back as spelled letters, `אוו` vanished entirely). A candidate goes
 * through a listening round first, and if it carries niqqud it must be added here AND covered by
 * the speech-guard exemption in the same commit, or it goes out unpointed with every test green.
 */
export const DICTATION_NODS = ['אֶמ.', 'אהם.', 'אָה.'] as const;

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
