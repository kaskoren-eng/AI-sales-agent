import type { llm } from '@livekit/agents';
import type { ToolRuntimeContext } from './tool-context.js';

/**
 * The agent's Phase 4 tools, built per call around a {@link ToolRuntimeContext}.
 *
 * WHY HERE AND NOT agent.config.ts (the phase-4 doc says "wire via agent.config.ts"): tools are
 * per-call and tenant-gated — the tenant is only known after `waitForParticipant()`, inside
 * `entry()`. `buildSessionComponents()` is a per-process factory that benches and tests import
 * without a database; putting a DB-backed tool set in it would poison every consumer. The tools
 * attach on the `Agent` instance instead (`AgentOptions.tools`), which is the supported per-agent
 * path in @livekit/agents 1.5.1.
 *
 * Closure factory, not `session.userData`: the runtime holds live objects (pg pool, provider
 * factory, CallReport) and mutable per-call state (`bookingCompleted`). Closing over one object
 * beats threading a UserData generic through Agent/AgentSession/RunContext.
 *
 * NOTE ON maxToolSteps: AgentSession defaults to 3 chained tool calls per turn. Our flow fires
 * check → book → end on SEPARATE turns (the lead speaks in between), so 3 is plenty. If a chain
 * ever hits the cap, this is the comment to find.
 */

/** Exact tool names the LLM sees — the system prompt's regression tests import this. */
export const TOOL_NAMES = [
  'check_calendar_availability',
  'book_meeting',
  'end_call',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function buildAgentTools(rt: ToolRuntimeContext): llm.FunctionTool[] {
  // Populated tool by tool across Phase 4 commits: check_calendar_availability → book_meeting →
  // end_call. Empty means the gate is wired but no capability is exposed yet.
  void rt;
  return [];
}
