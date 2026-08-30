/**
 * WHICH WORKER POOL THIS PROCESS REGISTERS INTO — the difference between a laptop that can answer
 * a paying customer's phone call and one that cannot.
 *
 * THE HAZARD THIS FIXES. `WorkerOptions` with no `agentName` registers into the DEFAULT DISPATCH
 * POOL of the LiveKit project, and LiveKit auto-dispatches every new room in that project to one
 * worker from that pool. The production cloud agent (`CA_azGQ9uaLxpot`) registers with an EMPTY
 * dispatch name — verified with `lk agent list`, whose "Dispatch Name" column is blank — so it and
 * a laptop running `npm run voice:dev` sit in the SAME pool. An inbound customer call is then
 * handed to whichever of the two LiveKit picks. That is why the standing rule was "never leave
 * voice:dev registered", and that rule makes an all-day A/B session impossible.
 *
 * It cuts the other way too, and this half was invisible: a synthetic-caller room was ALSO
 * auto-dispatched, so `npm run voice:test` was frequently answered by the CLOUD agent — measuring
 * production instead of the local change under test. Measured directly (2026-08-30): a bare room
 * created in this project had `agent-AJ_gpfEGSfDUepp` with `lk.agent.name: ""` in it within ~2s.
 *
 * THE FIX. A LOCAL worker (`dev` / `connect` / `console`) registers under an explicit agent name,
 * which switches it to EXPLICIT DISPATCH: LiveKit sends it a job only when something asks for it
 * by name (`AgentDispatchClient.createDispatch`, or `RoomConfiguration.agents` on the room-creating
 * token — see `synthetic-caller.ts`). It can no longer be handed a real call.
 *
 * WHAT MAKES THE CLOUD PATH PROVABLY UNCHANGED. The cloud image runs
 * `node dist/.../agent.js start` (Dockerfile.agent, last line). `start` is not a local command, so
 * this returns `''` — and `''` is falsy, which is the SAME branch the SDK took before this file
 * existed. From `@livekit/agents/dist/worker.js`, the constructor resolves the name as:
 *
 *     LIVEKIT_AGENT_NAME_OVERRIDE ?? (agentName || LIVEKIT_AGENT_NAME) ?? ''
 *
 * and the previous code passed no `agentName` at all, i.e. the default parameter `agentName = ""`.
 * Passing `''` explicitly lands on the identical branch, so the env precedence and the final
 * registered name are byte-identical in production.
 */

/** The name a laptop worker registers under. Nothing dispatches to it by accident. */
export const DEV_AGENT_NAME = 'keren-dev';

/**
 * CLI subcommands that mean "this is a developer's machine". Everything else — `start`,
 * `download-files`, no subcommand at all — is treated as production and keeps default dispatch.
 * Opt-in rather than opt-out on purpose: a subcommand nobody thought of must not silently take a
 * laptop out of the pool that answers customers, nor silently put one into it.
 */
const LOCAL_COMMANDS = new Set(['dev', 'connect', 'console']);

/**
 * Deliberate escape hatch: set `VOICE_DEV_DEFAULT_DISPATCH=1` to put a local worker BACK into the
 * default pool — i.e. to let it answer a real inbound call, which is occasionally what you want
 * when debugging a live number. It is loud, explicit, and off by default.
 */
export const DEFAULT_DISPATCH_ESCAPE = 'VOICE_DEV_DEFAULT_DISPATCH';

/** Override the dev worker's name — useful when two sessions run workers on the same machine. */
export const DEV_AGENT_NAME_VAR = 'VOICE_DEV_AGENT_NAME';

/**
 * The `agentName` to hand `WorkerOptions`.
 *
 * `''` = default dispatch (auto-dispatched to every new room; the production behaviour).
 * Anything else = explicit dispatch only.
 */
export function isLocalCommand(argv: readonly string[] = process.argv): boolean {
  return argv
    .slice(2)
    .filter((arg) => !arg.startsWith('-'))
    .some((word) => LOCAL_COMMANDS.has(word));
}

/**
 * True inside the per-job child process the worker forks.
 *
 * The child re-imports this whole agent file, so `cli.runApp()` runs there too. It registers
 * NOTHING — the SDK's default command action declines to start a second worker — but the child's
 * argv carries no subcommand, so anything reading argv there concludes "production", and a boot
 * banner printed in the child says `dispatch=DEFAULT` on a laptop, which reads exactly like the
 * safety fix having failed.
 *
 * Detected from argv[1], which for a job child is the SDK's fork entry point
 * (`ipc/job_proc_lazy_main.js`; `ipc/job_main.js` in older versions, hence the prefix match). If the
 * SDK renames it, this returns false and the only consequence is one confusing extra log line — so
 * it must never gate anything that matters.
 */
export function isJobChildProcess(argv: readonly string[] = process.argv): boolean {
  return /[/\\]agents[/\\]dist[/\\]ipc[/\\]job_/u.test(argv[1] ?? '');
}

export function resolveWorkerAgentName(
  argv: readonly string[] = process.argv,
  processEnv: NodeJS.ProcessEnv = process.env,
): string {
  if (!isLocalCommand(argv)) return '';

  const escape = processEnv[DEFAULT_DISPATCH_ESCAPE];
  if (escape === '1' || escape === 'true') return '';

  const override = processEnv[DEV_AGENT_NAME_VAR]?.trim();
  return override && override.length > 0 ? override : DEV_AGENT_NAME;
}

/** One line at boot saying which pool this process joined. Silence here is how the hazard hid. */
export function describeDispatch(agentName: string): string {
  return agentName === ''
    ? 'dispatch=DEFAULT (auto-dispatched to every new room in this LiveKit project — production behaviour)'
    : `dispatch=EXPLICIT agentName="${agentName}" (this worker only gets jobs addressed to it by name; it CANNOT be handed a real inbound call)`;
}
