import { describe, expect, it } from 'vitest';
import {
  DEV_AGENT_NAME,
  describeDispatch,
  resolveWebCallDispatch,
  resolveWorkerAgentName,
} from './dev-dispatch.js';

/**
 * THE PRODUCTION-SAFETY TEST. Getting this wrong in one direction lets a laptop answer a paying
 * customer's phone call; getting it wrong in the other direction stops inbound calls being
 * answered at all. Both halves are asserted here, and the cloud half is asserted against the exact
 * argv the container uses (`Dockerfile.agent`: `node dist/.../agent.js start`).
 */
describe('resolveWorkerAgentName', () => {
  const argv = (...rest: string[]) => ['node', 'agent.js', ...rest];

  it('gives the CLOUD path an empty name — the SDK branch the previous code took', () => {
    // `''` is falsy, so the SDK falls through to LIVEKIT_AGENT_NAME exactly as it did when no
    // agentName was passed at all. This is the assertion that says "production is unchanged".
    expect(resolveWorkerAgentName(argv('start'), {})).toBe('');
  });

  it('leaves download-files and a bare invocation on default dispatch', () => {
    expect(resolveWorkerAgentName(argv('download-files'), {})).toBe('');
    expect(resolveWorkerAgentName(argv(), {})).toBe('');
  });

  it('names a laptop worker for dev / connect / console', () => {
    expect(resolveWorkerAgentName(argv('dev'), {})).toBe(DEV_AGENT_NAME);
    expect(resolveWorkerAgentName(argv('connect', '--room', 'x'), {})).toBe(DEV_AGENT_NAME);
    expect(resolveWorkerAgentName(argv('console', '--connect-addr', 'a:1'), {})).toBe(DEV_AGENT_NAME);
  });

  it('still finds the subcommand when an option VALUE comes first', () => {
    // `--log-level debug dev` — reading only the first non-flag token gives "debug", which is not
    // a local command, which would silently put this laptop back in the production pool.
    expect(resolveWorkerAgentName(argv('--log-level', 'debug', 'dev'), {})).toBe(DEV_AGENT_NAME);
  });

  it('does not mistake `start --simulation` for a local command', () => {
    expect(resolveWorkerAgentName(argv('start', '--simulation'), {})).toBe('');
  });

  it('lets a second session pick its own worker name', () => {
    expect(resolveWorkerAgentName(argv('dev'), { VOICE_DEV_AGENT_NAME: 'keren-koren' })).toBe(
      'keren-koren',
    );
    // Whitespace-only is not a name; fall back rather than register as " ".
    expect(resolveWorkerAgentName(argv('dev'), { VOICE_DEV_AGENT_NAME: '  ' })).toBe(DEV_AGENT_NAME);
  });

  it('has an explicit, loud escape back into the default pool', () => {
    expect(resolveWorkerAgentName(argv('dev'), { VOICE_DEV_DEFAULT_DISPATCH: '1' })).toBe('');
    expect(resolveWorkerAgentName(argv('dev'), { VOICE_DEV_DEFAULT_DISPATCH: 'true' })).toBe('');
    // Anything else is NOT an escape — a stray value must not silently rejoin the prod pool.
    expect(resolveWorkerAgentName(argv('dev'), { VOICE_DEV_DEFAULT_DISPATCH: '0' })).toBe(
      DEV_AGENT_NAME,
    );
  });

  it('says out loud which pool it joined', () => {
    expect(describeDispatch('')).toContain('DEFAULT');
    expect(describeDispatch('keren-dev')).toContain('CANNOT be handed a real inbound call');
  });
});

/**
 * THE OTHER HALF OF THE SAME SAFETY PROPERTY: which agent answers a BROWSER session.
 *
 * The failure this guards against is not a laptop taking a customer call — it is the reverse, a
 * tenant's simulator session being quietly redirected to somebody's laptop, and its mirror image,
 * Koren tuning a prompt locally while listening to production. Two independent locks, so neither a
 * stray request field nor a stray env var is enough on its own.
 */
describe('resolveWebCallDispatch', () => {
  const ok = (r: ReturnType<typeof resolveWebCallDispatch>) => {
    if (!r.ok) throw new Error(`expected ok, got: ${r.message}`);
    return r.dispatch;
  };

  it('defaults to auto-dispatch — the token this route has always minted', () => {
    for (const target of [undefined, 'cloud' as const]) {
      const d = ok(resolveWebCallDispatch(target, { VOICE_WEB_CALL_LOCAL_AGENT: '1' }));
      expect(d.mode).toBe('auto');
      expect(d.agentName).toBeNull();
      expect(d.expectAgentName).toBe('');
    }
  });

  it('refuses agent:"local" unless the server opted in', () => {
    const r = resolveWebCallDispatch('local', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('VOICE_WEB_CALL_LOCAL_AGENT');
  });

  it('dispatches the local worker by name when BOTH locks are open', () => {
    const d = ok(resolveWebCallDispatch('local', { VOICE_WEB_CALL_LOCAL_AGENT: '1' }));
    expect(d.mode).toBe('explicit');
    expect(d.agentName).toBe(DEV_AGENT_NAME);
    // The browser compares this against the answering participant's lk.agent.name.
    expect(d.expectAgentName).toBe(DEV_AGENT_NAME);
  });

  it('uses the same worker name the worker itself resolved', () => {
    const envs = { VOICE_WEB_CALL_LOCAL_AGENT: 'true', VOICE_DEV_AGENT_NAME: 'keren-koren' };
    expect(ok(resolveWebCallDispatch('local', envs)).agentName).toBe('keren-koren');
    expect(resolveWorkerAgentName(['node', 'agent.js', 'dev'], envs)).toBe('keren-koren');
  });

  it('treats a junk switch value as OFF', () => {
    expect(resolveWebCallDispatch('local', { VOICE_WEB_CALL_LOCAL_AGENT: '0' }).ok).toBe(false);
    expect(resolveWebCallDispatch('local', { VOICE_WEB_CALL_LOCAL_AGENT: 'yes' }).ok).toBe(false);
  });
});
