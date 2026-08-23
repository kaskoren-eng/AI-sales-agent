/**
 * The conversation state machine — Keren's "awareness layer" for a single call.
 *
 * ADVISORY, not a script. It does NOT drive what she says (the LLM still speaks freely from the one
 * static prompt). It tracks, in code, three things the pipeline is otherwise blind to:
 *   1. STAGE — a coarse, signal-backed sense of where the call is (opening → … → terminal).
 *   2. WORKING MEMORY — "what we know so far": the facts capture_lead_info gathered, mirrored here as
 *      a tidy snapshot. This is a MIRROR for guardrails/analytics/dashboard — it is NEVER re-fed into
 *      the prompt mid-call (that would move the cache prefix and kill the 92% prompt-cache +
 *      preemptive generation; see agent.ts trimHistory). capture_lead_info stays the source of truth.
 *   3. SITUATIONS — a log of the reflex-worthy events that happened (silence, barge-in, voicemail,
 *      objection).
 *
 * Transitions are INFERRED from signals only (turns + tool calls) — no new LLM tool, no burden on
 * her. Stage rank is monotonic: a late signal (e.g. a `check_calendar` after `closing`) can never
 * regress the stage. `terminal` always wins.
 *
 * Pure and clock-injectable so it unit-tests deterministically (the repo forbids ambient Date.now()
 * in modules that must stay reproducible; the clock is a constructor seam instead).
 */

export type CallStage =
  | 'opening'
  | 'discovery'
  | 'qualifying'
  | 'scheduling'
  | 'closing'
  | 'terminal';

export type SituationType = 'silence' | 'barge_in' | 'voicemail' | 'objection';

/** Monotonic ordering — a stage may only advance to a higher rank. */
const STAGE_RANK: Record<CallStage, number> = {
  opening: 0,
  discovery: 1,
  qualifying: 2,
  scheduling: 3,
  closing: 4,
  terminal: 5,
};

/** How many user turns in `discovery` before we assume qualification has begun (fallback signal —
 * a `capture_lead_info` qualification read is the primary one). */
const DISCOVERY_TO_QUALIFYING_TURNS = 4;

/** Committed user turns without a scheduling-path tool before RAG is allowed back on. Two, not one:
 * a single turn is the caller answering "which slot suits you?", which is still booking. */
const BOOKING_STALL_TURNS = 2;

/** "What we know so far" — mirrors the sales-relevant fields of capture_lead_info. */
export interface KnownFacts {
  name?: string;
  businessType?: string;
  painPoint?: string;
  budget?: string;
  timeline?: string;
  qualification?: string; // hot | warm | cold
  /** Contact details. Mirrored here for the SAME reason as the rest: so she stops asking twice.
   * On the 2026-08-22 call the phone was asked four times and the email three, and both were
   * missing from this interface — captured by the tool, invisible to everything downstream. */
  phone?: string;
  email?: string;
}

/**
 * What she already knows, as one line for the model.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 *
 * `capture_lead_info` wrote into working memory and NOTHING read it back. The state machine is
 * advisory: it watched the call and told the model nothing. So her only record of what had been
 * asked was the transcript — and phone audio through Soniox garbles exactly the answers that matter.
 *
 * Measured on 2026-08-23: she asked "what business do you run?", the caller answered, the tool
 * captured `businessType: "חנות דיגיטלית"`, and 16 seconds later she asked what business he runs.
 * The answer was in memory the whole time. Same root cause as the phone asked 4x and the email 3x.
 *
 * SELF-DESCRIBING ON PURPOSE. The instruction rides with the data instead of living in the system
 * prompt, so a call that has captured nothing costs zero tokens and the prompt needs no new section
 * to explain a marker. Returns null when there is nothing to say.
 */
export function formatKnownFacts(facts: KnownFacts): string | null {
  const parts: string[] = [];
  const add = (label: string, value?: string) => {
    if (value && value.trim()) parts.push(`${label}=${value.trim()}`);
  };
  add('name', facts.name);
  add('business', facts.businessType);
  add('phone', facts.phone);
  add('email', facts.email);
  add('need', facts.painPoint);
  add('budget', facts.budget);
  add('timing', facts.timeline);
  if (parts.length === 0) return null;
  return (
    `[KNOWN] Already captured from this caller — do NOT ask for any of these again, ` +
    `and do not ask them to repeat or confirm unless they bring it up: ${parts.join('; ')}`
  );
}

export interface StageEntry {
  stage: CallStage;
  atMs: number;
}

export interface SituationEntry {
  type: SituationType;
  atMs: number;
  detail?: string;
}

export interface CallStateSnapshot {
  final_stage: CallStage;
  stage_history: StageEntry[];
  situations: SituationEntry[];
  working_memory: KnownFacts;
}

export class CallStateMachine {
  private _stage: CallStage = 'opening';
  private _userTurns = 0;
  private _agentTurns = 0;
  private _silenceStrikes = 0;
  /** User-turn count when a scheduling-path tool last fired — the seam `ragActive` uses to
   * notice an abandoned booking without regressing the monotonic stage. */
  private _userTurnsAtLastSchedulingTool = 0;
  private readonly _facts: KnownFacts = {};
  private readonly _stageHistory: StageEntry[];
  private readonly _situations: SituationEntry[] = [];
  private readonly startedAtMs: number;
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now;
    this.startedAtMs = this.now();
    this._stageHistory = [{ stage: 'opening', atMs: 0 }];
  }

  get stage(): CallStage {
    return this._stage;
  }
  get userTurns(): number {
    return this._userTurns;
  }
  get silenceStrikes(): number {
    return this._silenceStrikes;
  }
  /** A copy of the working memory, so callers can't mutate internal state. */
  get facts(): KnownFacts {
    return { ...this._facts };
  }
  isTerminal(): boolean {
    return this._stage === 'terminal';
  }

  /**
   * Phase gate for voice RAG (Layer 1 of the two-layer gate): should knowledge retrieval run now?
   *
   * DERIVED, NEVER STORED, and deliberately NOT a second stage field. `stage` is monotonic and is now
   * an analytics contract persisted to `call_learnings.analysis`; implementing the RAG plan's "return
   * to discovery if the booking is abandoned" by regressing `stage` would corrupt every stage_history
   * this machine writes. So the re-entry lives here, as a read-only view over the same signals.
   *
   *  - `opening` — off. She is greeting; there is no question yet, and a DB hit buys nothing.
   *  - `discovery` / `qualifying` — ON. This is where callers ask what it does and what it costs.
   *  - `scheduling` / `closing` — off while the booking is live: those turns collect a date, a name and
   *    an email, and injected product prose both dilutes them and slows the turns that most need speed.
   *  - ...unless the booking has STALLED — no scheduling-path tool for two committed user turns. That
   *    is the abandoned-booking case: the caller has gone back to asking questions, and refusing to
   *    answer them because a `check_calendar_availability` once fired would be perverse.
   *  - `terminal` — off. The call is over.
   */
  get ragActive(): boolean {
    switch (this._stage) {
      case 'opening':
      case 'terminal':
        return false;
      case 'discovery':
      case 'qualifying':
        return true;
      case 'scheduling':
      case 'closing':
        return this._userTurns - this._userTurnsAtLastSchedulingTool >= BOOKING_STALL_TURNS;
    }
  }

  /** A committed user (caller) turn. First one leaves the greeting; enough of them imply qualifying. */
  onUserTurn(): void {
    this._userTurns += 1;
    if (this._stage === 'opening') {
      this.advanceTo('discovery');
    } else if (this._stage === 'discovery' && this._userTurns >= DISCOVERY_TO_QUALIFYING_TURNS) {
      this.advanceTo('qualifying');
    }
  }

  /** A committed agent (Keren) turn. Counted for analytics; drives no stage change today. */
  onAgentTurn(): void {
    this._agentTurns += 1;
  }

  /**
   * A tool finished. Only successful calls move the stage. `facts` (capture_lead_info only) is merged
   * into the working memory; a qualification read also advances discovery→qualifying.
   */
  onToolCall(name: string, ok: boolean, facts?: Partial<KnownFacts>): void {
    if (!ok) return;
    switch (name) {
      case 'capture_lead_info':
        if (facts) this.mergeFacts(facts);
        if (facts?.qualification) this.advanceTo('qualifying');
        // R2.1: once booking has started, capturing a detail IS booking progress and must reset the
        // stall counter.
        //
        // It did not, and the 2026-08-22 real call shows the cost: between check_calendar_availability
        // and book_meeting there were ~10 turns of collecting a name, a phone number (asked four
        // times) and an email (asked three times). Each fired capture_lead_info and none fired a
        // SCHEDULING tool, so after two turns `ragActive` decided the booking had been abandoned and
        // reopened retrieval — 14 lookups during scheduling, on turns that were pure data entry.
        //
        // The phase gate was working. Its definition of "stalled" was wrong: it meant "no scheduling
        // tool recently" when it should mean "no progress toward the booking recently". A caller who
        // has genuinely gone back to asking questions does not hand over his email address.
        if (this._stage === 'scheduling' || this._stage === 'closing') {
          this._userTurnsAtLastSchedulingTool = this._userTurns;
        }
        break;
      case 'check_calendar_availability':
        this._userTurnsAtLastSchedulingTool = this._userTurns;
        this.advanceTo('scheduling');
        break;
      case 'book_meeting':
        this._userTurnsAtLastSchedulingTool = this._userTurns;
        this.advanceTo('closing');
        break;
      case 'end_call':
        this.advanceTo('terminal');
        break;
      default:
        break;
    }
  }

  /** Record one silence strike, log it, and return the running count so the caller can escalate. */
  onSilenceStrike(): number {
    this._silenceStrikes += 1;
    this.noteSituation('silence');
    return this._silenceStrikes;
  }

  noteSituation(type: SituationType, detail?: string): void {
    this._situations.push({ type, atMs: this.atMs(), ...(detail ? { detail } : {}) });
  }

  /** Force the terminal stage (voicemail / silence-exhausted / any code-driven end). */
  markTerminal(): void {
    this.advanceTo('terminal');
  }

  serialize(): CallStateSnapshot {
    return {
      final_stage: this._stage,
      stage_history: this._stageHistory.map((e) => ({ ...e })),
      situations: this._situations.map((e) => ({ ...e })),
      working_memory: { ...this._facts },
    };
  }

  // ---- internals ----

  private atMs(): number {
    return this.now() - this.startedAtMs;
  }

  private advanceTo(target: CallStage): void {
    if (STAGE_RANK[target] <= STAGE_RANK[this._stage]) return; // monotonic — never regress
    this._stage = target;
    this._stageHistory.push({ stage: target, atMs: this.atMs() });
  }

  /** Coalesce: a present, non-empty value updates the memory; a blank/absent one never erases it. */
  private mergeFacts(facts: Partial<KnownFacts>): void {
    for (const key of Object.keys(facts) as Array<keyof KnownFacts>) {
      const value = facts[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        this._facts[key] = value.trim();
      }
    }
  }
}
