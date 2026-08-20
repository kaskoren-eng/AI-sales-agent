import type { CallStage } from './call-state.js';

/**
 * Progressive disclosure of the playbook: Steps 2-4 leave the static prompt and are delivered when the
 * call actually reaches the phase that needs them.
 *
 * ── WHY THIS IS NOT RAG ─────────────────────────────────────────────────────────────────────────
 * These packs are selected by STAGE, never by similarity. That distinction is the whole safety
 * argument. A retrieval query is the caller's own utterance, so anything gated behind similarity is
 * gated behind something the caller controls: phrase your turn so it doesn't match the booking chunk
 * and the booking rules are simply absent. Stage transitions come from tool results
 * (`check_calendar_availability` fired, `capture_lead_info` returned a qualification), which the
 * caller cannot spoof into silence.
 *
 * So: knowledge (FAQ, objections, business facts) is retrieved because a miss costs one un-answered
 * question. Procedure (how to qualify, how to book) is phase-delivered because a miss costs a meeting
 * booked without an email address.
 *
 * ── WHY THE SECURITY RULES ARE NOT IN HERE ──────────────────────────────────────────────────────
 * They are resident, permanently, and that is deliberate. A defence that is only present when
 * something matched is not a defence — and the phase gate would leave `opening` unprotected, which is
 * precisely where an injection attempt arrives. Moving them into a delivered message instead of the
 * system prompt would shrink the "prompt word count" without changing one token the model reads, and
 * that is a number improving rather than a system improving.
 *
 * ── WHY SPLIT THE ASSEMBLED PROMPT INSTEAD OF AUTHORING PACKS SEPARATELY ─────────────────────────
 * One source of truth. The pack text is cut out of the very prompt `buildSystemPrompt` produces, so it
 * is byte-identical to what the agent reads today and cannot drift from it. Authoring the same
 * procedure twice would guarantee that one copy is eventually edited and the other is not.
 */

export interface PlaybookPack {
  /** Delivered once the call has reached this stage (or any later one). */
  stage: CallStage;
  /** The section heading, for logging and tests. */
  heading: string;
  /** The section text, verbatim from the assembled prompt. */
  content: string;
}

export interface SplitPrompt {
  /** What stays resident for the whole call. */
  core: string;
  /** What is delivered on arrival at each stage. */
  packs: PlaybookPack[];
}

/**
 * Which sections leave the resident prompt, and when they come back.
 *
 * Step 4 is delivered at `qualifying`, one stage EARLY, and that is not an oversight. The rules it
 * carries — collect his details before booking, never claim a meeting is booked before `book_meeting`
 * returned — must already be in context when she decides to start booking, not when the booking tool
 * has fired. `scheduling` is entered BY `check_calendar_availability` succeeding, which is too late.
 */
const PACKED_SECTIONS: Array<{ prefix: string; stage: CallStage }> = [
  { prefix: 'Step 2:', stage: 'discovery' },
  { prefix: 'Step 3:', stage: 'qualifying' },
  { prefix: 'Step 4:', stage: 'qualifying' },
];

/** `## ` at line start. `### ` does not match — the third `#` fails the literal space. */
const SECTION_RE = /^## (?<heading>.+)$/gm;

/**
 * Cut the packed sections out of an assembled prompt.
 *
 * Returns the core with those sections removed (and the `---` rules they sat between tidied up), plus
 * the packs in the order they will be needed.
 */
export function splitPrompt(prompt: string): SplitPrompt {
  const marks: Array<{ heading: string; start: number; bodyStart: number }> = [];
  for (const m of prompt.matchAll(SECTION_RE)) {
    marks.push({
      heading: m.groups!.heading!.trim(),
      start: m.index!,
      bodyStart: m.index! + m[0].length,
    });
  }

  const packs: PlaybookPack[] = [];
  // Cut from the end so earlier offsets stay valid.
  let core = prompt;
  const cuts: Array<{ start: number; end: number }> = [];

  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i]!;
    const packed = PACKED_SECTIONS.find((p) => mark.heading.startsWith(p.prefix));
    if (!packed) continue;

    const end = i + 1 < marks.length ? marks[i + 1]!.start : prompt.length;
    packs.push({
      stage: packed.stage,
      heading: mark.heading,
      content: `## ${mark.heading}\n${prompt.slice(mark.bodyStart, end)}`.trimEnd(),
    });
    cuts.push({ start: mark.start, end });
  }

  for (const cut of [...cuts].reverse()) {
    core = core.slice(0, cut.start) + core.slice(cut.end);
  }

  // Removing a section leaves the horizontal rules that framed it stacked together.
  core = core.replace(/(?:\n---\n)(?:\s*\n---\n)+/g, '\n---\n').replace(/\n{3,}/g, '\n\n').trimEnd();

  return { core, packs };
}

/** Stage ordering, mirroring CallStateMachine's monotonic ranks. */
const STAGE_RANK: Record<CallStage, number> = {
  opening: 0,
  discovery: 1,
  qualifying: 2,
  scheduling: 3,
  closing: 4,
  terminal: 5,
};

/**
 * Tracks which packs have been handed over. Delivery is once-only and monotonic-safe: a pack whose
 * stage was skipped entirely (a caller who jumps straight to booking) is still delivered, because the
 * test is "have we reached AT LEAST this stage", not "are we exactly in it".
 */
export class PlaybookDeliverer {
  private readonly delivered = new Set<string>();

  constructor(private readonly packs: PlaybookPack[]) {}

  /** Packs now due and not yet delivered. Marks them delivered — call it once per check. */
  due(stage: CallStage): PlaybookPack[] {
    const rank = STAGE_RANK[stage];
    const out = this.packs.filter((p) => STAGE_RANK[p.stage] <= rank && !this.delivered.has(p.heading));
    for (const p of out) this.delivered.add(p.heading);
    return out;
  }

  get deliveredCount(): number {
    return this.delivered.size;
  }
}

/**
 * Render packs as one message. Labelled so she can tell procedure from the `[KNOWLEDGE]` facts —
 * these are instructions to follow, not content to quote.
 */
export const PLAYBOOK_MARKER = '[PLAYBOOK]';

export function formatPlaybookMessage(packs: PlaybookPack[]): string {
  return `${PLAYBOOK_MARKER}\n${packs.map((p) => p.content).join('\n\n---\n\n')}`;
}
