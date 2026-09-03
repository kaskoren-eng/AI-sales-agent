import type { llm } from '@livekit/agents';
import { bookMeetingTool } from './book-meeting.tool.js';
import { captureLeadInfoTool } from './capture-lead-info.tool.js';
import { checkCalendarAvailabilityTool } from './check-calendar-availability.tool.js';
import { endCallTool } from './end-call.tool.js';
import { requestHumanHandoffTool } from './request-human-handoff.tool.js';
import { CALLBACK_TOOL_NAME, scheduleCallbackTool } from './schedule-callback.tool.js';
import {
  sendEmailConfirmationTool,
  sendWhatsappConfirmationTool,
} from './send-confirmation.tools.js';
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

/**
 * Exact tool names the LLM sees AND THE PROMPT DESCRIBES — the system prompt's regression tests
 * import this and assert every entry appears in TOOLS_PROMPT.
 *
 * ⚠️ `schedule_callback` IS DELIBERATELY ABSENT. It ships dark behind `VOICE_CALLBACK_TOOL`: the
 * prompt does not mention it (that is F1.7, and it needs a listening round before any Hebrew about
 * callbacks reaches a lead's ear), so adding it here would break the lockstep test with no way to
 * fix it except writing the prompt section this branch is not allowed to write. Its name lives in
 * `CALLBACK_TOOL_NAME`; move it into this list in the same commit that teaches the prompt about it.
 */
export const TOOL_NAMES = [
  'check_calendar_availability',
  'book_meeting',
  'end_call',
  'capture_lead_info',
  'send_whatsapp_confirmation',
  'send_email_confirmation',
  'request_human_handoff',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Re-exported so a caller needs one import for "what tools can this agent have". */
export { CALLBACK_TOOL_NAME } from './schedule-callback.tool.js';

export function buildAgentTools(rt: ToolRuntimeContext): llm.FunctionTool[] {
  return [
    checkCalendarAvailabilityTool(rt),
    bookMeetingTool(rt),
    endCallTool(rt),
    captureLeadInfoTool(rt),
    sendWhatsappConfirmationTool(rt),
    sendEmailConfirmationTool(rt),
    requestHumanHandoffTool(rt),
    // THE 8TH TOOL, BEHIND A FLAG — and OFF means it is not in the array at all, so the model is
    // never shown the name and cannot call it. That is stronger than a handler that refuses (which
    // still costs prompt tokens, still invites a call, and still has to explain itself in Hebrew),
    // and it is provable by RUNNING this function rather than by reading it. This repo has shipped
    // a flag that silently did nothing; the tests for this one emit the OFF path.
    ...(rt.env.VOICE_CALLBACK_TOOL ? [scheduleCallbackTool(rt)] : []),
  ] as llm.FunctionTool[];
}

/** What `buildAgentTools` will actually attach for this runtime. Used by the tests and the logs. */
export function activeToolNames(rt: ToolRuntimeContext): string[] {
  return [...TOOL_NAMES, ...(rt.env.VOICE_CALLBACK_TOOL ? [CALLBACK_TOOL_NAME] : [])];
}
