/**
 * WHEN HE SAID HE WANTS IT — the half of the call's memory that was missing, and the one that
 * ended the 2026-09-01 09:29 call.
 *
 * THE SEQUENCE (live PSTN, build ba01136). She asked which part of the day FOUR times in 140
 * seconds, after he had answered:
 *
 *     [161s] KEREN  "...אני יכולה לבדוק לךָ עכשיו מה פתוח — בוקר, או אחר הצהריים?"
 *     [174s] KEREN  "...מתי יותר נוח לךָ — בבוקר, או אחר הצהריים?"
 *     [177s] lead   "באיזה שעות בבוקר?"                          <- he has now said בבוקר
 *     [186s] KEREN  "...מחר בבוקר נוח לךָ יותר סביב תשע, או יותר לכיוון אחת עשרה?"
 *     [190s] lead   "11 יכול לעבוד טוב."                          <- and now he has named the hour
 *     [283s] lead   "דיברנו על. זה כבר, שיהיה נוח לי מחר בבוקר."   <- "we have been through this"
 *     [293s] KEREN  "...נוח לךָ יותר סביב עשר, או יותר לכיוון אחת עשרה?"
 *     [300s] lead   "טוב, אני לא יודע למה את שואלת על זה סתם שאלות כמה פעמים."
 *     [304s] lead   "נראה לי שאני אסיים פה את השיחה, זה פחות יכול לעבוד לי."
 *
 * ── WHY NOTHING CAUGHT IT, established rather than assumed ────────────────────────────────────
 *
 * `FactMemory` exists for exactly this and could not see it: its `FactField` union is
 * `'name' | 'phone' | 'email' | 'business'`. A TIME PREFERENCE is not a tracked fact — not tracked
 * and not consulted, so neither the ask counter nor the "already established" note had anything to
 * say. `bookingNote` is the other place that could have known, and its `BOOKING_REQUIRED_FIELDS`
 * is `['name', 'phone']`: it states what `book_meeting` still needs, and the slot is not on that
 * list because the model passes `slot_datetime` straight from `check_calendar_availability`.
 *
 * So the hole was structural, not a degraded instruction. This class is the missing field.
 *
 * ── THE OTHER BOOKING DIMENSIONS, since the question was asked ────────────────────────────────
 *
 *   - DAY and PART OF DAY and HOUR: tracked here. All three were re-asked on that call.
 *   - DURATION: never asked of the caller at all — `check_calendar_availability` chooses it and
 *     parks it on `ToolRuntimeContext.lastCheckedDurationMinutes`. No hole.
 *   - CHANNEL (Zoom / phone): never asked either; it is stated ("שיחת דמו קצרה בזום"). On the same
 *     call the LEAD asked her ("מה, לפגישה בזום?") and she answered once. No hole.
 *
 * ── Why a note and not a prompt line ─────────────────────────────────────────────────────────
 *
 * The same reason as FactMemory and the phrase ledger, and by now it is not a hypothesis: the
 * prompt's Call Memory section already said "do not ask for what he has given you", and by 293s it
 * was seventeen thousand tokens behind her. Prompt is guidance, code is enforcement.
 *
 * Kill-switch: VOICE_SLOT_MEMORY_ENABLED (default on). Off and nothing here runs.
 */

const NIQQUD = /[֑-ׇ]/gu;

function clean(text: string): string {
  return text.replace(NIQQUD, '').replace(/\s+/gu, ' ').trim();
}

/** The three things a caller can settle about WHEN, in the order she asks them. */
export type SlotDimension = 'day' | 'partOfDay' | 'hour';

export const SLOT_DIMENSIONS: readonly SlotDimension[] = ['day', 'partOfDay', 'hour'] as const;

const DIMENSION_LABEL: Record<SlotDimension, string> = {
  day: 'which DAY',
  partOfDay: 'MORNING or AFTERNOON',
  hour: 'which HOUR',
};

/**
 * What the CALLER says to settle each dimension.
 *
 * Written from his actual words on the 09:29 call plus the ordinary Hebrew alternatives, not from
 * a grammar. The hour list carries both digits and the spoken forms because
 * `VOICE_SPEECH_NUMBERS_ENABLED` only rewrites HER side — his arrives from Soniox as digits
 * ("11 יכול לעבוד טוב") or as words, depending on how he said it.
 */
const CALLER_SAYS: Record<SlotDimension, RegExp> = {
  day: /(?:^|\s)(מחרתיים|מחר|היום|יום\s+(?:ראשון|שני|שלישי|רביעי|חמישי|שישי)|בראשון|בשני|בשלישי|ברביעי|בחמישי)(?:\s|$|[,.!?])/u,
  partOfDay: /(?:^|\s)(ב?בוקר|אחר\s*ה?צהריים|אחה"?צ|בצהריים|ב?ערב|לפנות\s+ערב)(?:\s|$|[,.!?])/u,
  hour: /(?:^|\s)(\d{1,2}(?::\d{2})?(?:\s+ו?חצי)?|תשע|עשר|אחת\s+עשרה|שתים\s+עשרה|שתיים\s+עשרה|שמונה|שבע)(?:\s+ו?חצי)?(?:\s|$|[,.!?])/u,
};

/**
 * What SHE says when she asks for each one.
 *
 * Lifted from her own four asks on that call plus the Step 4 script, and deliberately narrow: a
 * false "you already asked this" would silence a question she genuinely has to ask, and a missed
 * one only costs the strong wording in the note.
 */
const AGENT_ASKS: Record<SlotDimension, RegExp[]> = {
  day: [/נוח\s+לך[ָ]?\s+מחר/u, /איזה\s+יום/u, /באיזה\s+יום/u, /מתי\s+נוח\s+לך/u],
  partOfDay: [
    /בבוקר\s*,?\s*או\s+אחר\s*ה?צהריים/u,
    /בוקר\s*,?\s*או\s+אחר\s*ה?צהריים/u,
    /מתי\s+יותר\s+נוח\s+לך[ָ]?\s*—?\s*ב?בוקר/u,
  ],
  hour: [/איזו?\s+שעה/u, /באיזו?\s+שעה/u, /סביב\s+\S+\s*,?\s*או\s+יותר\s+לכיוון/u, /לשעה\s+מדויקת/u],
};

/**
 * The moment the call is ABOUT scheduling.
 *
 * A caller says "מחר" for all sorts of reasons, and reading every one of them as a booking
 * preference would put a note in front of the model claiming he had settled a day he never
 * mentioned. So a preference is only recorded once she has asked about timing at least once —
 * from that point the conversation is in the scheduling frame — or when his own sentence carries
 * an unmistakable scheduling marker of its own.
 */
const SCHEDULING_MARKER =
  /(?:נוח|מתאים\s+לי|יכול\s+לעבוד|בוא\s+נקבע|תקבעי|שנקבע|נעשה\s+את\s+זה|מעדיף|עדיף\s+לי)/u;

export interface SlotSnapshot {
  day: string | null;
  partOfDay: string | null;
  hour: string | null;
  /** The whole caller sentence the most recent value came from — quoted into the note. */
  saidIt: string | null;
  asks: Record<SlotDimension, number>;
}

export class SlotMemory {
  readonly #known = new Map<SlotDimension, string>();
  readonly #asks = new Map<SlotDimension, number>();
  #saidIt: string | null = null;
  #schedulingFrame = false;
  /** Committed utterances already counted — the preemptive-draft echo must not double-count an
   * ask. Same 20s rule and the same reason as PhraseLedger.observe and FactMemory. */
  readonly #seen: Array<{ text: string; at: number }> = [];

  get(dimension: SlotDimension): string | null {
    return this.#known.get(dimension) ?? null;
  }

  asks(dimension: SlotDimension): number {
    return this.#asks.get(dimension) ?? 0;
  }

  snapshot(): SlotSnapshot {
    return {
      day: this.get('day'),
      partOfDay: this.get('partOfDay'),
      hour: this.get('hour'),
      saidIt: this.#saidIt,
      asks: {
        day: this.asks('day'),
        partOfDay: this.asks('partOfDay'),
        hour: this.asks('hour'),
      },
    };
  }

  /** One committed AGENT utterance — counts the timing questions inside it. */
  observeAgentUtterance(text: string, at: number = Date.now()): void {
    const trimmed = clean(text);
    if (!trimmed || this.#isEcho(trimmed, at)) return;
    for (const dimension of SLOT_DIMENSIONS) {
      if (AGENT_ASKS[dimension].some((p) => p.test(trimmed))) {
        this.#asks.set(dimension, this.asks(dimension) + 1);
        this.#schedulingFrame = true;
      }
    }
  }

  /** One committed CALLER utterance — records what he settled, if anything. */
  observeCallerUtterance(text: string, at: number = Date.now()): void {
    const trimmed = clean(text);
    if (!trimmed || this.#isEcho(trimmed, at)) return;
    if (!this.#schedulingFrame && !SCHEDULING_MARKER.test(trimmed)) return;

    let recorded = false;
    for (const dimension of SLOT_DIMENSIONS) {
      const match = CALLER_SAYS[dimension].exec(trimmed);
      const value = match?.[1]?.trim();
      if (!value) continue;
      this.#known.set(dimension, value);
      recorded = true;
    }
    if (recorded) this.#saidIt = trimmed;
  }

  #isEcho(text: string, at: number): boolean {
    if (this.#seen.some((s) => s.text === text && at - s.at < 20_000)) return true;
    this.#seen.push({ text, at });
    return false;
  }

  /**
   * The turn-boundary reminder, or null when he has not settled anything yet.
   *
   * APPENDED at the tail with the other coach notes (see injectCoachNote) — the prompt-cache prefix
   * must not move.
   *
   * His OWN SENTENCE is quoted rather than only the extracted value, deliberately. The extraction
   * is a handful of regexes over Soniox output on a phone line and it will sometimes read a day out
   * of a sentence that was about something else; quoting the source lets the model see that for
   * itself instead of being told a fact it cannot check. The instruction that follows is the part
   * that must be obeyed either way: do not ask the same question again.
   */
  note(): string | null {
    const settled = SLOT_DIMENSIONS.filter((d) => this.#known.has(d));
    if (settled.length === 0) return null;

    const values = settled.map((d) => `${DIMENSION_LABEL[d]} = «${this.#known.get(d)}»`).join('; ');
    const parts = [
      `[Slot memory — automatic reminder] The lead has ALREADY told you when he wants the meeting: ${values}.`,
    ];
    if (this.#saidIt) parts.push(`His own words: «${this.#saidIt}».`);

    const reAsked = settled.filter((d) => this.asks(d) >= 1);
    if (reAsked.length > 0) {
      parts.push(
        `You have already asked him ${reAsked
          .map((d) => `${DIMENSION_LABEL[d]} ${this.asks(d)} time(s)`)
          .join(' and ')} on this call.`,
      );
    }
    parts.push(
      'Do NOT ask any of these again — not as a re-check, not as an offer of two options, not ' +
        'rephrased. Asking a man for a time he has already given you is what made the caller on ' +
        '2026-09-01 say "אני לא יודע למה את שואלת על זה סתם שאלות כמה פעמים" and end the call. ' +
        'Take what he said as settled: call `check_calendar_availability` for that window if you ' +
        'have not, then NAME one specific time inside it and ask him to confirm THAT.',
    );
    return parts.join(' ');
  }
}
