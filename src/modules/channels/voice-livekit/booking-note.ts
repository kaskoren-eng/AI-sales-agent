/**
 * WHAT IS ACTUALLY BOOKED, AND WHAT `book_meeting` STILL NEEDS — the call's booking truth.
 *
 * THE CALL THIS EXISTS TO FIX (Koren, 2026-08-31 16:51, live PSTN, build 7943a26). Four tool calls
 * on the whole call, in this order:
 *
 *      21s  capture_lead_info            name only
 *     210s  capture_lead_info            business/pain/timeline, qualification "warm"
 *     243s  check_calendar_availability  2026-09-01
 *     352s  end_call                     reason "callback_requested"
 *
 * `book_meeting` was never called. In between:
 *
 *     [273s] KEREN  "בסדר. קבענו לאחת עשרה. קורן, מה השם המלא שלךָ?"
 *     [312s] KEREN  "... כרגע חסר לי רק המייל כדי להמשיך."
 *     [331s] KEREN  "... כרגע חסר לי רק המייל כדי להתקדם. מה כתובת המייל שלךָ?"
 *     [347s] KEREN  "אוקי. יש לי מספיק כדי להעביר לצוות. הם יחזרו אליךָ עם הפרטים להמשך. יום טוב."
 *
 * Three false statements of fact, all of the same kind: she asserted the state of the booking. She
 * said a time was agreed when nothing had been booked; she said twice that the email was the only
 * thing missing when she had neither a phone number nor a confirmed surname; and she said she had
 * enough, with a first name and nothing else, and hung up on a lead who had agreed to a demo.
 *
 * ── Why a note and not a prompt line ──────────────────────────────────────────────────────────
 *
 * The prompt said all of this already. Step 4 rule 5: *"Make sure you have his confirmed name,
 * phone and email BEFORE you call book_meeting"*. The section heading two lines below it:
 * *"NEVER claim a meeting is booked before book_meeting returned success"*. Both were in the
 * context window for the whole call. This is the phrase-ledger lesson again — prompt instructions
 * degrade under context load, and by 273s that prompt was 13,000 tokens behind her.
 *
 * So this states the same facts from the only place that KNOWS them: the tool runtime. It is read
 * off `ToolRuntimeContext.bookingCompleted` and the identity fields `FactMemory` holds, at the
 * turn boundary, every turn, right next to her last words. Nothing here is a judgement — it is a
 * list of which required arguments of one function currently have values.
 *
 * ── Bounded, so it costs nothing on a call that never gets there ──────────────────────────────
 *
 * Silent until the booking phase actually starts (`check_calendar_availability` has run, or the
 * state machine has reached `scheduling`), and silent again the moment a booking succeeds — at
 * which point the truth is "you have booked it" and one line says so, because the OTHER failure
 * available here is her apologising for a booking that exists.
 *
 * ── What it deliberately does NOT do ──────────────────────────────────────────────────────────
 *
 * It does not block `end_call`. A caller who wants to hang up gets to hang up; a guard that
 * refused would trap a lead on a call he is trying to leave, which is a worse product than a lost
 * booking. The speech guard (`FALSE_BOOKING_WIDE`) is the hard half — it stops the words leaving —
 * and this is the half that tries to make the hard half unnecessary.
 */

/** The identity fields `book_meeting` cannot run without. Email is deliberately absent — it is
 * nullable by design (VOICE_BOOK_WITHOUT_EMAIL), and treating it as required is exactly the
 * confusion that ended the 2026-08-31 call. */
export const BOOKING_REQUIRED_FIELDS = ['name', 'phone'] as const;
export type BookingRequiredField = (typeof BOOKING_REQUIRED_FIELDS)[number];

export interface BookingNoteState {
  /** Has the booking phase begun? `check_calendar_availability` has run, or stage >= scheduling. */
  scheduling: boolean;
  /** Has `book_meeting` returned success on this call? (`ToolRuntimeContext.bookingCompleted`) */
  booked: boolean;
  /** Are the booking tools available at all? A no-tools call has nothing to say here. */
  toolsEnabled: boolean;
  /** What we hold for each required field right now — null when we do not have it. */
  name: string | null;
  phone: string | null;
  /** The number the lead is CALLING FROM, on an inbound call. Null for outbound / web calls. */
  callerPhone: string | null;
  /** Whether the caller-phone half of the note is switched on (VOICE_CALLER_PHONE_KNOWN_ENABLED). */
  offerCallerPhone: boolean;
}

/**
 * `+972509788845` → `0509788845` — the number in the form she has to SAY.
 *
 * ── THE DIGIT THAT WENT MISSING (Koren, 2026-09-01) ──────────────────────────────────────────
 *
 * LiveKit hands us E.164 off the SIP participant, and this note used to paste that straight into
 * the prompt: *"he is calling from +972509788845"*. Nothing then converted it, so the MODEL did —
 * in its head, mid-call, in Hebrew — and on the 15:02 call it dropped a digit:
 *
 *     [389s] KEREN  "חוזרת על המספר — אפס חמש אפס, תשע שבע שמונה שמונה, ארבע חמש. נכון?"
 *
 * That is `050-978845`. NINE digits, read back to the man whose number it is. Proven rather than
 * guessed: `normalizeSpokenNumbers('050-978845')` reproduces that sentence exactly, digit for
 * digit and group for group, while the correct `0509788845` yields "…שמונה, שמונה ארבע חמש". The
 * speech layer spoke faithfully what it was handed; the loss happened one layer up. (She got it
 * right twelve seconds later, unprompted, which is what a guess looks like when it is a guess.)
 *
 * Two smaller hazards died with it: a model that copies the E.164 verbatim would have her say a
 * literal "+972509788845" (`PHONE_RE` requires a leading 0, so the speech normaliser leaves it
 * alone), and `book_meeting` takes `phone` from the model — so a dropped digit was also the number
 * saved against the booking, i.e. a demo call to a number that does not exist.
 *
 * Conversion, not arithmetic, is the whole point: she now COPIES digits instead of transforming
 * them. Anything unrecognised is returned untouched rather than reshaped on a guess — a foreign
 * caller's number is better spoken oddly than spoken wrong.
 */
export function toSpokenIsraeliNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('972')) return `0${digits.slice(3)}`;
  if (digits.startsWith('0')) return digits;
  // A bare Israeli mobile with no trunk prefix, as some carriers send it.
  if (/^5\d{8}$/.test(digits)) return `0${digits}`;
  return raw;
}

const FIELD_LABEL: Record<BookingRequiredField, string> = {
  name: 'his full name',
  phone: 'his phone number',
};

/**
 * The turn-boundary booking note, or null when there is nothing worth spending tokens on.
 *
 * APPENDED at the tail with the other coach notes (see injectCoachNote) — the prompt-cache prefix
 * must not move.
 */
export function bookingNote(state: BookingNoteState): string | null {
  if (!state.toolsEnabled) return null;

  if (state.booked) {
    // The mirror-image failure, and it has its own cost: a meeting that EXISTS, described to the
    // lead as a request that will be passed on. He then does not turn up to a call in his diary.
    return (
      '[Booking state — automatic reminder] `book_meeting` has SUCCEEDED on this call. The meeting ' +
      'is real and it is in the calendar. Say so plainly, do not hedge it, and do not offer to ' +
      'pass anything to the team as though nothing had been booked.'
    );
  }

  if (!state.scheduling) return null;

  const missing = BOOKING_REQUIRED_FIELDS.filter((f) => !state[f]);

  const parts = [
    '[Booking state — automatic reminder] NOTHING HAS BEEN BOOKED YET. `book_meeting` has not been ' +
      'called on this call, so no meeting exists, no time is held, and nothing is in any calendar. ' +
      'Checking availability is not booking. Do not say or imply that a time is settled — not ' +
      '"קבענו", not "קבעתי", not "סגרנו", not "שריינתי" — until `book_meeting` has returned success.',
  ];

  if (missing.length > 0) {
    parts.push(
      `To call it you still need: ${missing.map((f) => FIELD_LABEL[f]).join(' and ')}. ` +
        'Never tell the lead that one particular detail is "the only thing missing" unless that is ' +
        'true of this list. The email is NOT on it — it may be null.',
    );
  } else {
    parts.push(
      'You now have everything `book_meeting` requires. Call it — do not collect anything further ' +
        'first, and do not end the call without it.',
    );
  }

  // THE FIELD WE ALREADY HAVE AND WERE ASKING HIM TO DICTATE.
  //
  // On the 2026-08-31 call she asked for the phone number twice, got nothing, and ended the call
  // partly for want of it — while the number he was ringing from sat in the tool runtime the whole
  // time (`+972509788845`, in the call report's `callerPhone`). `book_meeting` takes `phone` from
  // the model, so nothing downstream could supply it for her.
  //
  // Deliberately a CONFIRMATION and not a substitution: a man may want the demo call on a
  // different number than the one he happens to be ringing from, and only he knows that. Gated
  // (VOICE_CALLER_PHONE_KNOWN_ENABLED) because it changes what she says on every inbound call.
  if (state.offerCallerPhone && !state.phone && state.callerPhone) {
    parts.push(
      `You already have a number for him: he is calling from ${toSpokenIsraeliNumber(state.callerPhone)}. ` +
        'Those digits are exact — read them back EXACTLY as given, and do not reformat, regroup, ' +
        'drop or add a single digit. Do not make him dictate it — read them back and ask him to ' +
        'confirm it is the right mobile, a natural variation of "המספר שאתה מתקשר ממנו, זה הנייד הנכון?" — and if ' +
        'he says yes, that is the value you pass to `book_meeting`. Only if he gives you a ' +
        'different number do you take one down.',
    );
  }

  parts.push(
    'A lead who has agreed to a time and leaves with no booking is the worst outcome on this call. ' +
      'It is worse than an awkward question and much worse than a missing email.',
  );

  return parts.join(' ');
}
