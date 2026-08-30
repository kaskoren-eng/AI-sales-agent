/**
 * TALK TO THE AGENT RUNNING ON YOUR OWN LAPTOP, FROM A BROWSER.
 *
 *   npm run voice:dev        # terminal 1 — the agent under test
 *   npm run voice:session    # terminal 2 — opens a page; click, talk
 *
 * WHY THIS EXISTS. The dashboard's Simulator (`/simulator`) mints its room token with no
 * `RoomConfiguration`, i.e. it relies on AUTO-DISPATCH. Since `main@c731321` a laptop worker
 * registers under an explicit name (`keren-dev`) and is deliberately NOT in the auto-dispatch pool
 * — that fix is what stops a laptop being handed a real customer's inbound call, and it must not be
 * undone. The side effect is that `/simulator` against a local worker is simply never answered, so
 * hearing a prompt change meant a deploy or a phone call. This closes that loop: a page, a mic, and
 * the worker running in the other terminal.
 *
 * WHAT IT IS NOT. It is not part of the API. It is a script you run, it binds to 127.0.0.1 only,
 * and it exits when you close it. There is no route to leave switched on by accident in production;
 * the equivalent capability in the API (`POST /web-call` with `{"agent":"local"}`) needs both that
 * field AND `VOICE_WEB_CALL_LOCAL_AGENT=1`, and resolves through the SAME function this script uses
 * (`resolveWebCallDispatch`) so there is exactly one place where "which agent answers" is decided.
 *
 * WHO ANSWERED IS THE POINT. Tuning a laptop while unknowingly talking to production has already
 * happened on this project — `voice:test` rooms used to be auto-dispatched to the cloud agent. The
 * page reads `lk.agent.name` off whoever picks up and says, in a green or red banner, whether it
 * was your machine. Believe the banner, not the terminal you happen to be looking at.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import { AccessToken } from 'livekit-server-sdk';
import { loadEnv } from '../../../../config/env.js';
import {
  resolveWebCallDispatch,
  WEB_CALL_LOCAL_AGENT_VAR,
  type WebCallAgentTarget,
} from './dev-dispatch.js';
import { renderLocalSessionPage } from './local-session-page.js';

/** Same major/minor the dashboard pins, so the two browser paths behave the same. */
const LIVEKIT_CLIENT_VERSION = '2.20.1';
const LIVEKIT_CLIENT_URL = `https://cdn.jsdelivr.net/npm/livekit-client@${LIVEKIT_CLIENT_VERSION}/dist/livekit-client.umd.js`;
/**
 * Cached after the first run so the loop keeps working on a plane / a flaky hotel wifi. Under
 * `node_modules/` because that is already ignored by git and by every editor's search.
 */
const CLIENT_CACHE = resolve(
  process.cwd(),
  'node_modules/.cache/keren-voice',
  `livekit-client-${LIVEKIT_CLIENT_VERSION}.umd.js`,
);

const DEFAULT_PORT = 3010;

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const port = Number(value('port') ?? process.env.VOICE_SESSION_PORT ?? DEFAULT_PORT);

// This process IS the laptop, by construction — it binds to localhost and dies with the terminal.
// Setting the API's switch on ourselves means the local path and the /web-call path share one
// resolver instead of drifting apart, which is how the two dispatch behaviours got out of step in
// the first place.
if (!flag('cloud')) process.env[WEB_CALL_LOCAL_AGENT_VAR] = '1';
const target: WebCallAgentTarget | undefined = flag('cloud') ? 'cloud' : 'local';

const resolved = resolveWebCallDispatch(target);
if (!resolved.ok) {
  console.error(resolved.message);
  process.exit(2);
}
const dispatch = resolved.dispatch;

const env = loadEnv();
const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = env;
if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error('LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET must be set in .env');
  process.exit(2);
}

/**
 * Whose agent you are talking to. Without a tenant the agent falls back to env defaults and the
 * tool gate closes, so the rehearsal stops resembling a real call — better to refuse than to hand
 * back a session that quietly is not the product.
 */
const tenantId =
  value('tenant') ??
  process.env.VOICE_SESSION_TENANT_ID ??
  // The tenant that already answers this machine's inbound calls is the right default — it is the
  // one whose persona, voice and tool gate you are actually tuning.
  env.VOICE_WEBHOOK_TENANT_ID ??
  env.PLATFORM_TENANT_ID;
if (!tenantId) {
  console.error(
    'No tenant to run this session as. Set VOICE_WEBHOOK_TENANT_ID or PLATFORM_TENANT_ID in .env, ' +
      'or pass --tenant=<uuid>.\n' +
      'The agent resolves its persona, voice and tool gate from the tenant, so a session without ' +
      'one is not a rehearsal of anything.',
  );
  process.exit(2);
}

const clientJs = await loadLivekitClient();

const page = renderLocalSessionPage({
  expectAgentName: dispatch.expectAgentName,
  mode: dispatch.mode,
  tenantId,
  note: dispatch.note,
  clientSrc: '/livekit-client.js',
});

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (req.method === 'POST' && url === '/token') {
    void mintToken()
      .then((body) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      })
      .catch((err: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end((err as Error).message);
      });
    return;
  }
  if (url === '/livekit-client.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    res.end(clientJs);
    return;
  }
  if (url === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
    return;
  }
  res.writeHead(404).end('not found');
});

// 127.0.0.1 ONLY. This endpoint mints a LiveKit room token with no authentication of any kind —
// which is fine for a process that only your own machine can reach, and would not be fine for one
// reachable from the network.
server.listen(port, '127.0.0.1', () => {
  const href = `http://localhost:${port}/`;
  console.log(`\n  ${href}`);
  console.log(`  ${dispatch.note}`);
  if (dispatch.mode === 'auto') {
    console.log(
      '  ⚠ --cloud: this session is auto-dispatched. The DEPLOYED agent will answer it, not your laptop.',
    );
  } else {
    console.log('  Make sure `npm run voice:dev` is running in another terminal, then click.');
  }
  console.log('  Ctrl+C to stop.\n');
  if (!flag('no-open')) openBrowser(href);
});

// ---------------------------------------------------------------------------------------------

async function mintToken(): Promise<{
  url: string;
  token: string;
  roomName: string;
  dispatch: typeof dispatch;
}> {
  const roomName = `local-session-${randomUUID()}`;
  const at = new AccessToken(LIVEKIT_API_KEY!, LIVEKIT_API_SECRET!, {
    identity: `local-${randomUUID().slice(0, 8)}`,
    ttl: 60 * 60,
    // The same metadata channel the outbound dialer and the /web-call route use. No `settings`
    // block: the agent then reads them from the database itself, which is the documented fallback
    // and is fast when the database is on the same laptop's network as the worker.
    metadata: JSON.stringify({ tenantId, direction: 'web' }),
  });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  if (dispatch.agentName) {
    at.roomConfig = new RoomConfiguration({
      agents: [new RoomAgentDispatch({ agentName: dispatch.agentName })],
    });
  }
  console.log(`  → room ${roomName} (${dispatch.mode}${dispatch.agentName ? ` → ${dispatch.agentName}` : ''})`);
  return { url: LIVEKIT_URL!, token: await at.toJwt(), roomName, dispatch };
}

/** Cached-then-network, so the second run of this script needs no internet for the page itself. */
async function loadLivekitClient(): Promise<string> {
  try {
    return await readFile(CLIENT_CACHE, 'utf8');
  } catch {
    /* not cached yet */
  }
  try {
    const res = await fetch(LIVEKIT_CLIENT_URL);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const js = await res.text();
    await mkdir(dirname(CLIENT_CACHE), { recursive: true });
    await writeFile(CLIENT_CACHE, js);
    console.log(`  cached livekit-client@${LIVEKIT_CLIENT_VERSION} → ${CLIENT_CACHE}`);
    return js;
  } catch (err) {
    console.error(
      `Could not fetch livekit-client from ${LIVEKIT_CLIENT_URL}: ${(err as Error).message}\n` +
        'Run this once with an internet connection; after that it is cached.',
    );
    process.exit(2);
  }
}

function openBrowser(href: string): void {
  const cmd =
    process.platform === 'win32' ? ['cmd', '/c', 'start', '', href]
    : process.platform === 'darwin' ? ['open', href]
    : ['xdg-open', href];
  try {
    spawn(cmd[0]!, cmd.slice(1), { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* the URL is printed above; opening it is a convenience, not a requirement */
  }
}
