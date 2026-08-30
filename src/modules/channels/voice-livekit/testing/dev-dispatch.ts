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

/**
 * The name a LOCAL worker registers under, resolved the same way the worker itself resolves it.
 *
 * Anything that wants to DISPATCH to a laptop worker (the browser session, `voice:test`) must ask
 * for exactly this name, or the room gets no agent at all.
 */
export function localAgentName(processEnv: NodeJS.ProcessEnv = process.env): string {
  const override = processEnv[DEV_AGENT_NAME_VAR]?.trim();
  return override && override.length > 0 ? override : DEV_AGENT_NAME;
}

// ---------------------------------------------------------------------------------------------
// Browser sessions: which agent answers a /web-call room
// ---------------------------------------------------------------------------------------------

/**
 * MUST be set on the API process before `/web-call` will dispatch to a laptop.
 *
 * Two locks, not one, and deliberately so. The request field alone would mean a stray `{"agent":
 * "local"}` from any authenticated client could aim a real tenant's browser session at whatever
 * laptop happens to be registered under `keren-dev`; the env switch alone would silently redirect
 * EVERY simulator session on that server. Production sets neither, so `agent:"local"` is refused
 * there with an explanation rather than quietly producing a call nobody answers.
 *
 * It is not in `src/config/env.ts` on purpose — the same reason `VOICE_TEST_OVERLAY` is not:
 * `dotenv.config({override:true})` lets `.env` beat the shell for any key `.env` defines, and a
 * dev switch you cannot turn on from the shell is a dev switch that will be got wrong.
 */
export const WEB_CALL_LOCAL_AGENT_VAR = 'VOICE_WEB_CALL_LOCAL_AGENT';

/** What a `/web-call` caller may ask for. Absent/`cloud` = today's behaviour, byte for byte. */
export type WebCallAgentTarget = 'cloud' | 'local';

/** What the room token ended up doing, echoed to the caller so the UI can say who will answer. */
export interface WebCallDispatch {
  /** `auto` = LiveKit picks from the default pool (production). `explicit` = one named worker. */
  mode: 'auto' | 'explicit';
  /** The worker dispatched by name, or null under auto-dispatch. */
  agentName: string | null;
  /**
   * The `lk.agent.name` participant attribute the answering agent should carry. `''` under
   * auto-dispatch — and on this project an empty name means the PRODUCTION cloud agent.
   */
  expectAgentName: string;
  /** One line, in plain words, for a human staring at a screen. */
  note: string;
}

export function webCallLocalAgentEnabled(processEnv: NodeJS.ProcessEnv = process.env): boolean {
  const v = processEnv[WEB_CALL_LOCAL_AGENT_VAR];
  return v === '1' || v === 'true';
}

/**
 * Decide which agent a browser session should be pointed at.
 *
 * Anything other than an explicit `local` — undefined, `cloud`, junk — returns the auto-dispatch
 * answer, which is what the route already did before this existed. Opting in cannot happen by
 * accident: it takes the request field AND the env switch.
 */
export function resolveWebCallDispatch(
  target: WebCallAgentTarget | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): { ok: true; dispatch: WebCallDispatch } | { ok: false; message: string } {
  if (target !== 'local') {
    return {
      ok: true,
      dispatch: {
        mode: 'auto',
        agentName: null,
        expectAgentName: '',
        note: 'auto-dispatch: whichever worker is in this LiveKit project\'s default pool answers — in production that is the deployed cloud agent',
      },
    };
  }
  if (!webCallLocalAgentEnabled(processEnv)) {
    return {
      ok: false,
      message:
        `agent:"local" was requested but ${WEB_CALL_LOCAL_AGENT_VAR} is not set on this server, ` +
        `so this API will not dispatch browser calls to a developer's laptop. Set ` +
        `${WEB_CALL_LOCAL_AGENT_VAR}=1 on a LOCAL api process only.`,
    };
  }
  const name = localAgentName(processEnv);
  return {
    ok: true,
    dispatch: {
      mode: 'explicit',
      agentName: name,
      expectAgentName: name,
      note: `explicit dispatch to "${name}" — the worker started by npm run voice:dev on this machine. No other worker can be handed this room.`,
    },
  };
}

/** One line at boot saying which pool this process joined. Silence here is how the hazard hid. */
export function describeDispatch(agentName: string): string {
  return agentName === ''
    ? 'dispatch=DEFAULT (auto-dispatched to every new room in this LiveKit project — production behaviour)'
    : `dispatch=EXPLICIT agentName="${agentName}" (this worker only gets jobs addressed to it by name; it CANNOT be handed a real inbound call)`;
}
