/**
 * What she says at the START of one inference step — and why a tool call changes the answer.
 *
 * THE BUG THIS EXISTS TO FIX (Koren, 2026-08-29, live PSTN call):
 *
 *     "אהה."   @ 29.3s        <- one word, alone
 *     ...5.4 seconds of nothing...
 *     "אוקיי. כמה פניות נכנסות אליךָ ביום..."   @ 34.7s
 *
 * He heard it as a script: "she stops after one word and then continue to the other word... it
 * sounds like she got something like script to say." Both of those words are ours. Neither is the
 * thinking filler — `"אהה."` and `"כן."` are members of ACKNOWLEDGEMENTS_HE, and the gap between
 * them is a TOOL CALL.
 *
 * THE MECHANISM, read out of the SDK rather than guessed (agent_activity.js `produceSegments`):
 * `startSegment()` — and therefore `ttsNode` — runs on the FIRST TEXT CHUNK of an inference step.
 * `llmNode` injects the acknowledgement before the model has written anything, so a step whose
 * only real output is a tool call still produces one spoken word. Then the tool runs
 * (capture_lead_info 1025ms, request_human_handoff 971ms), a SECOND inference step starts, and
 * that step injects its OWN acknowledgement in front of the actual sentence. One caller turn,
 * two receipts, a multi-second hole between them.
 *
 * THE RULE: the first step of a turn opens with a receipt ("I heard you"). A step that follows a
 * tool call opens with a HESITATION ("אממ...") instead — because by then the caller has already
 * been acknowledged, and what the moment actually calls for is the sound of someone still
 * working on it. A second receipt is the robot; a hesitation before the answer is a person.
 *
 * When the call has spent its filler budget the step opens with NOTHING. Silence is always an
 * acceptable answer here — it is the extra word that made her sound like a machine, never the
 * missing one.
 *
 * WHICH RECEIPT, added 2026-08-31: two of the five words in the wide bank ("טוב, הבנתי.",
 * "הבנתי אותך.") are not receipts at all — they claim to have UNDERSTOOD something, and the deck
 * spoke them after "מחר." and after questions. `callerShared` carries the one fact that makes the
 * claim true, and the ledger decides; this function still only decides WHETHER a receipt is the
 * right act for the step.
 *
 * AND THE THIRD CASE, added 2026-08-30: the caller is in the middle of reading out a phone number
 * or an email. A receipt there is an interruption — it closes a turn he has not finished — so the
 * step opens with a VOCAL NOD instead, drawn at random from `DICTATION_NODS` (Koren's round-11
 * verdict: `אֶמ.` · `אהם.` · `אָה.`), which says *still listening* and hands the floor straight
 * back. Koren heard the failure on a production call: he said "050-", she answered
 * "טוב, הבנתי.", and he then said the other seven digits into her sentence. See dictation.ts.
 */

import { ACKNOWLEDGEMENTS_HE_WIDE } from './prompts/acknowledgements.he.js';
import { THINKING_FILLERS_HE } from './prompts/thinking-fillers.he.js';
import { openerKey } from './spoken-openers.js';

export type TurnOpener =
  /** A receipt spoken before the model has written a word — the <1s mechanism. */
  | { kind: 'ack'; word: string }
  /** A hesitation covering a tool call that already interrupted her. */
  | { kind: 'hesitation'; word: string }
  /** A vocal nod while the caller is still reading out a number or an email. */
  | { kind: 'nod'; word: string }
  /** Say nothing at the start of this step. */
  | { kind: 'silent' };

export function chooseTurnOpener(input: {
  /** True when the PREVIOUS inference step of this same reply emitted a tool call. */
  afterToolCall: boolean;
  /** `VOICE_THINKING_FILLER_MS !== 0` — the existing thinking-filler kill-switch. */
  fillersEnabled: boolean;
  /**
   * True when the turn she is answering was the caller READING SOMETHING OUT — a phone number
   * mid-dictation, an email being spelled. See dictation.ts for why this is a classifier over the
   * caller's utterance rather than a state machine, and for the call it comes from.
   *
   * `VOICE_DICTATION_NOD_ENABLED=false` makes the agent pass `false` here always, which restores
   * the 2026-08-30 behaviour exactly: a full receipt in the middle of a phone number.
   */
  midDictation?: boolean;
  /**
   * The nods to draw from when `midDictation` — Koren's round-11 bank, `DICTATION_NODS`.
   * Injectable for the same reason it always was: the pick lives in dictation.ts next to the
   * verdict that produced it, not as literals buried in a branch here.
   */
  nods?: readonly string[];
  /** Injectable so the random draw is deterministic in tests. Production uses Math.random. */
  random?: () => number;
  /**
   * Where the next receipt comes from. A SUPPLIER rather than a word, because the choice is now a
   * per-call decision the agent owns: an AcknowledgementLedger deck when VOICE_ACK_LEDGER_ENABLED
   * is on, `pickAcknowledgement(lastAck)` when it is off. This function only decides WHETHER a
   * receipt is the right sound for this step.
   */
  nextAck: (opts: { earned: boolean; avoid: string | null }) => string;
  /**
   * The head-word of the PREVIOUS reply as the caller heard it, or null to disable the rule
   * (`VOICE_OPENER_NO_REPEAT_ENABLED=false`, and always on the first step of a call).
   *
   * Koren, 2026-08-31: *"צריך לוודא שהסוכן לא חוזר על אותה מילה כל פעם בתחילת המשפט ('אוקיי')."*
   * The acknowledgement deck was measured innocent of this — see spoken-openers.ts — and the
   * repeats came from the three producers it cannot see. This is where they are reconciled: every
   * opening sound the agent CHOOSES is checked against the last one the caller actually heard,
   * whichever mechanism said it.
   */
  avoidOpener?: string | null;
  /**
   * True when the caller's last turn actually TOLD her something — see `callerSharedSubstance`
   * in engagement.ts. It only decides whether the supplier may reach for a comprehension claim
   * ("הבנתי אותך.") instead of a plain receipt ("אוקיי."); a receipt is correct either way, which
   * is why the default is false and why nothing downstream has to handle a missing signal.
   *
   * Koren, 2026-08-31: *"לא סתם להגיד 'טוב, הבנתי' על כל דבר."*
   */
  callerShared?: boolean;
  /**
   * Does this turn actually need the time a receipt buys? Koren's twelfth conclusion, 2026-09-01:
   * *"make that rule weakened … better to instruct the agent to use it on every long thinking turn
   * or a complex answer."*
   *
   * True (the default, and what a missing signal means) → the receipt is spoken, exactly as it was.
   * False → this step opens with NOTHING and she simply answers. See `callerTurnNeedsThinkingTime`
   * in engagement.ts for the predicate and for the replay of the 19:54 call that set its threshold.
   *
   * It sits AFTER the tool and dictation branches on purpose. Both of those are decisions Koren
   * judged by ear (round 7's hesitation pair, round 11's nod bank) and neither is about frequency:
   * a step behind a tool call is already silent-or-hesitation, and mid-dictation the nod is the
   * right sound however short his turn was.
   *
   * `VOICE_ACK_ONLY_WHEN_NEEDED=false` makes the agent pass `true` always, which restores the
   * every-turn receipt exactly.
   */
  needsThinkingTime?: boolean;
  /** The call's filler budget — `ThinkingFillerLedger.offer()`. Returns null when spent. */
  offerFiller: () => string | null;
}): TurnOpener {
  const avoid = input.avoidOpener ?? null;
  const repeats = (word: string): boolean => avoid !== null && openerKey(word) === openerKey(avoid);

  if (input.afterToolCall) {
    // She has already been heard on this turn. A second "אוקיי." is the duplicate receipt Koren
    // heard; the honest sound here is hesitation, or nothing.
    if (!input.fillersEnabled) return { kind: 'silent' };
    const filler = input.offerFiller();
    // `pickThinkingFiller` already refuses a word this call has spent, so the only way a filler
    // repeats is against a head-word some OTHER mechanism said. Silence rather than the repeat —
    // the filler is not charged unless it is spoken, so the budget survives for a later turn.
    return filler && !repeats(filler) ? { kind: 'hesitation', word: filler } : { kind: 'silent' };
  }
  // Checked AFTER the tool branch on purpose: a step resuming behind a tool call is not answering
  // a caller turn at all, so "was he dictating?" is not the question being asked there.
  //
  // The nod is NOT drawn from the acknowledgement deck, and it does not spend it. It is a
  // different act — "still listening" rather than "I have it" — and a deck word here would both
  // say the wrong thing and thin out the receipts for the turns that need them.
  if (input.midDictation && input.nods && input.nods.length > 0) {
    // AT RANDOM, out of the bank, and never the sound he just heard.
    //
    // This branch used to hold ONE constant, and that was the defect `spoken-openers.ts` names:
    // the nod was "the one opening sound with no rotation of its own", so a phone number followed
    // by an email said the same sound twice by construction, and the only repair available was to
    // fall SILENT on the second one. Koren's round-11 verdict on card `n1` was three sounds, used
    // randomly, which removes the cause rather than the symptom.
    //
    // The no-repeat filter is the SAME one every other opening sound goes through — `avoidOpener`,
    // fed by SpokenOpenerTracker — and not a parallel mechanism. That matters beyond tidiness:
    // `openerKey` strips niqqud, so the nod `אֶמ.` and the receipt `אמ.` are ONE key, and a receipt
    // on the previous turn correctly blocks that nod on this one. They are the same sound.
    //
    // The silence fallback is kept for the case where every member is blocked — unreachable with
    // three distinct keys and a window of one, reachable again if the bank is ever cut to a single
    // string. Silence rather than a receipt, because a receipt mid-dictation is the very
    // interruption the nod exists to prevent (he said "050-", she said "טוב, הבנתי.").
    const free = input.nods.filter((word) => !repeats(word));
    if (free.length === 0) return { kind: 'silent' };
    const random = input.random ?? Math.random;
    return { kind: 'nod', word: free[Math.floor(random() * free.length)] ?? free[0]! };
  }
  // KOREN'S CONCLUSION 12 — the receipt is for a turn that needs one, not for every turn.
  //
  // Last of the branches, so it can never take a step away from the two he judged by ear. Silence
  // is the module's standing safe answer ("it is the extra word that made her sound like a machine,
  // never the missing one"), and here it is also the FAST answer: on a turn whose reply is one
  // short line there is no thinking to cover, and the receipt only delayed the line.
  //
  // The deck is deliberately NOT spent on a silent step. A word handed out and not spoken would
  // bend the ledger's flat distribution against the turns that do get one, and `#last` would then
  // block a sound the caller never heard.
  if (input.needsThinkingTime === false) return { kind: 'silent' };

  return {
    kind: 'ack',
    word: input.nextAck({ earned: input.callerShared === true, avoid }),
  };
}

/**
 * WHAT KIND OF SOUND IS THIS — read out of the banks, never out of a hand-written list.
 *
 * The two banks are the only screened vocabulary the agent has. `ACKNOWLEDGEMENTS_HE_WIDE` is what
 * she says to mean *I heard you*; `THINKING_FILLERS_HE` is what she says to mean *I am still
 * working on it*. Everything else — a nod, a word the model wrote — is classified by the same
 * lookup rather than by a parallel table, so a word can never be in a bank and in the wrong
 * category at the same time.
 *
 * Matching is on the FIRST token with punctuation AND NIQQUD stripped, because that is the unit a
 * listener hears: `"טוב, הבנתי."` opens with `טוב` and `"אֶה..."` opens with `אה`. A mark is a
 * pronunciation instruction to Cartesia, not a different sound — `guardSpeech` strips every one of
 * them before the voice sees the text and this file's own `openerKey` has always ignored them, so a
 * classifier that did not would be the only thing in the module treating `אֶה` and `אה` as two
 * words.
 *
 * ⚠️ THAT STRIP IS NOT COSMETIC, IT IS WHY ROUND 10 DID NOT SILENTLY BREAK THE NOD. Three of the
 * four thinking fillers gained a niqqud mark on 2026-08-31 (`אה...` → `אֶה...`). `dictation.ts`'s
 * nod `"אה אה."` was classified as a hesitation only because its lead token `אה` was a member of
 * `THINKING_FILLERS_HE`; with the marks left in, that membership disappears and the nod silently
 * becomes `unscreened`. Nothing would have failed — `mayPairInOneBreath` refuses both categories —
 * and the nod would have quietly stopped being screened vocabulary. `turn-opener.test.ts` pins it.
 */
export type OpeningSoundCategory = 'acknowledgement' | 'hesitation' | 'unscreened';

function leadToken(sound: string): string {
  const cleaned = sound
    .replace(/[֑-ׇ]/gu, '')
    .replace(/[.,!?…׃]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned.split(' ')[0] ?? '';
}

const ACKNOWLEDGEMENT_TOKENS: ReadonlySet<string> = new Set(
  ACKNOWLEDGEMENTS_HE_WIDE.map(leadToken),
);
const HESITATION_TOKENS: ReadonlySet<string> = new Set(THINKING_FILLERS_HE.map(leadToken));

export function openingSoundCategory(sound: string): OpeningSoundCategory {
  const token = leadToken(sound);
  if (!token) return 'unscreened';
  // Hesitations are checked first only so the ordering is explicit; the two token sets are
  // disjoint, and a test asserts they stay that way when either bank gains a word.
  if (HESITATION_TOKENS.has(token)) return 'hesitation';
  if (ACKNOWLEDGEMENT_TOKENS.has(token)) return 'acknowledgement';
  return 'unscreened';
}

/**
 * MAY THESE TWO SOUNDS SHARE ONE BREATH?
 *
 * Koren, 2026-08-31, on the doubled filler: *"מילת מילוי צריכה להגיע באופן חד פעמי בכל משפט."* We
 * read that as a hard cap of one sound per breath and shipped it. **He then listened to the audio
 * and picked the DOUBLE** (round-7 card `n4a`, variant A — `"אהה. רגע... בוא נבדוק…"`) over the
 * single we had built, and said why:
 *
 *     "אהה ורגע יכולים להתאים ביחד, אבל רגע ושניה או רגע וחכה זה מילים שלא יכולות ללכת ביחד"
 *
 * So the rule was never a cap, it is a COMPATIBILITY rule between the two positions. A receipt
 * followed by a hesitation is a person taking in what you said and then thinking about it — two
 * different acts, and they read as one natural breath. Two hesitations in a row are the same act
 * twice, and that is the stutter he heard.
 *
 * FAIL-CLOSED ON ANYTHING UNSCREENED. A sound that is in neither bank is refused rather than
 * paired: the module's standing rule is that an unscreened Hebrew interjection fails silently
 * (written laughter comes back as spelled letters, "אוו" vanished entirely), and pairing one with
 * a screened word would put a sound on the line that nobody has ever heard through the phone band.
 *
 * ── AND ONE THING THE CATEGORIES CANNOT SEE (round 10, 2026-08-31) ────────────────────────────
 *
 * Koren's rule is *two of the same SOUND may not share a breath*, and until round 10 "same sound"
 * and "same category" happened to coincide. They no longer do. He replaced the receipt `אהה.` with
 * `אמ.` and the hesitation `אממ...` with `אֶממ...` — a receipt and a hesitation, so the category
 * test says the pair is fine, and the caller would hear **"אמ. אֶממ..."**: the same closed-lip
 * hum twice, which is the exact stutter he ruled out in round 7.
 *
 * So a pair is also refused when one lead token is a prefix of the other. It is not a new
 * preference of ours — it is his stated rule applied to a case a category lookup is blind to — and
 * it only ever REMOVES a sound, which this module treats as always acceptable ("silence is always
 * an acceptable answer here"; an unspoken filler is not charged and survives for a later turn).
 * `VOICE_FILLER_PAIRING_ENABLED=false` is still the coarse switch and is strictly more restrictive
 * than this, so it remains an exact rollback of the pairing behaviour as a whole.
 *
 * ⚠️ IT WAS A PREDICTION WHEN IT SHIPPED. IT IS NOW HIS VERDICT, AND HE ARRIVED AT IT TWICE.
 *
 * Round-11 card `p1` put the blocked pair `"אמ. אֶממ... בוא נבדוק…"` (A) against the pair this rule
 * ALLOWS, `"אמ. רֶגַע... בוא נבדוק…"` (B), and against what the code produces today, `"אמ. בוא
 * נבדוק…"` (C). He first picked **A** — and then reversed himself, unprompted, in his own words:
 *
 *     "My bad, it's better if the agent will reply 'אמ. רגע..' better than that option I've
 *      picked, because that option can cause potential problems."
 *
 * So the verdict is **B**, the pair the rule already permits, and the rule stays exactly as it
 * shipped in `fa2cb68`. The invitation that used to be here — *if a listening round says the pair
 * is fine, delete the check* — is spent, and deleting it now would be undoing a verdict.
 *
 * The round trip agrees with him, for once in the same direction: A came back from the 8kHz band as
 * a single collapsed `"אממ."` — the two sounds MERGED into one — while B came back as
 * `"אממ, רגע,"` with both intact. That merge is the "potential problem" he means, and it is the
 * round-7 stutter wearing a new face. His ear decided; the transcript is corroboration, not proof.
 */
export function mayPairInOneBreath(first: string, second: string): boolean {
  const a = openingSoundCategory(first);
  const b = openingSoundCategory(second);
  if (a === 'unscreened' || b === 'unscreened') return false;
  if (a === b) return false;
  return !sharesStem(leadToken(first), leadToken(second));
}

/** Two opening sounds one of which is the other with a letter added — "אמ" and "אממ". */
function sharesStem(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * MAY THE ARMED HESITATION ALSO LAND ON THIS STEP?
 *
 * The transcript that started this (Koren, 2026-08-31):
 *
 *     [21s]  KEREN  "טוב,"
 *     [23s]  KEREN  "אהה. רגע..."
 *
 * Two separate mechanisms writing to the same position. `llmNode` injects the opener at the head of
 * the reply stream; the 2.5-second think-timer arms a hesitation that `ttsNode` glues to the front
 * of the model's first words, and `withFiller`'s `leadIn` lets the opener through in front of it.
 *
 * What was wrong was not that BOTH fired — his ear says `אהה` + `רגע` is fine — it is that nothing
 * asked whether the two sounds go together. `mayPairInOneBreath` asks:
 *
 *   - `silent` opener → the head of the breath is free, any armed filler may take it.
 *   - `ack` opener → a receipt, so a hesitation behind it is a different act. Allowed.
 *   - `hesitation` opener → the same act twice (`רגע` then `שנייה`). Refused, always.
 *   - `nod` opener → refused ALWAYS, and refused on the OPENER KIND rather than on the sound.
 *     Mid-dictation the floor belongs to the caller: he is halfway through a phone number, and a
 *     second noise on top of the nod is the interruption the nod exists to prevent.
 *
 *     ⚠️ This used to be an accident and it was one turn away from breaking. `"אה אה."` was
 *     refused because its lead token `אה` happened to be a member of THINKING_FILLERS_HE, i.e.
 *     because the nod classified as a hesitation. Koren's round-11 bank has three members and they
 *     land in three DIFFERENT categories — `אֶמ.` leads on `אמ` (a receipt, so `acknowledgement`),
 *     `אָה.` leads on `אה` (`hesitation`), `אהם.` is in no bank at all (`unscreened`) — so the
 *     coincidence is gone and one of the three would have started allowing a filler behind it,
 *     with nothing failing. The category lookup answers "what act is this sound"; only `kind`
 *     knows the sound is being used to hold the floor open. `turn-opener.test.ts` pins all three.
 *
 * `pairing: false` (VOICE_FILLER_PAIRING_ENABLED=false) restores the hard one-sound cap shipped in
 * `2dcb23d` exactly — only a `silent` opener leaves the position free.
 *
 * DROPPING IT COSTS NOTHING: an armed filler is only CHARGED when it is spoken, so the call keeps
 * its three for a turn that genuinely opens with nothing. See ThinkingFillerLedger.
 */
export function allowsArmedFiller(
  opener: TurnOpener,
  armedFiller: string | null,
  opts: { pairing?: boolean } = {},
): boolean {
  if (armedFiller === null || armedFiller === '') return false;
  if (opener.kind === 'silent') return true;
  // The caller is still reading out his number. Nothing stacks on a nod — see the note above on
  // why this is decided by the opener's KIND and not by the category its sound happens to fall in.
  if (opener.kind === 'nod') return false;
  if (opts.pairing === false) return false;
  return mayPairInOneBreath(opener.word, armedFiller);
}

/**
 * Does this LLM chunk carry a tool call?
 *
 * The SDK hands `llmNode` a union: our own injected strings, flush sentinels, and the model's
 * `ChatChunk`s. Only the last kind can carry `delta.toolCalls` — that is the field
 * `performLLMInference` itself reads to feed the tool executor (generation.js:394), so this asks
 * the same question of the same field rather than inferring from timing.
 */
export function chunkCallsTool(chunk: unknown): boolean {
  if (typeof chunk !== 'object' || chunk === null) return false;
  const delta = (chunk as { delta?: { toolCalls?: unknown } }).delta;
  if (!delta || typeof delta !== 'object') return false;
  return Array.isArray(delta.toolCalls) && delta.toolCalls.length > 0;
}
