import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain ESM operator script, no types. Tested here because it is the guard that
// stands between a wrong worktree and every tenant's calls landing in one account.
import { assertDeployableCode, DEPLOY_MARKERS } from '../../../scripts/lib/deploy-guard.mjs';

/**
 * THE GUARD THAT WOULD HAVE CAUGHT 2026-08-26.
 *
 * `lk agent deploy` uploads whatever tree it is run from, and this repo has six voice worktrees on
 * one machine. Three of them — including `feature/crm-automation`, which CLAUDE.md calls the
 * de-facto voice trunk — do not contain the DID-routing commit. Deploying from one replaces a
 * working agent with one that has no `phone_numbers` lookup, so every inbound call falls back to
 * `VOICE_WEBHOOK_TENANT_ID`.
 *
 * What made it expensive is that nothing looked wrong. The agent answered, sounded healthy, held a
 * full 5-minute sales conversation in Hebrew, and filed a second tenant's lead into ClickScales.
 * No error, no alert, no refusal. The only symptom was a log line that did NOT appear, and finding
 * that meant knowing which line to expect.
 *
 * A bad config was already checkable — `assertDeployableSecrets` refuses a laptop DATABASE_URL. The
 * insight here is that the code is checkable the same way: assert the capabilities the fleet depends
 * on are present in the build context, rather than trusting that the right branch was checked out.
 */

const TOOL_CONTEXT = 'src/modules/channels/voice-livekit/tools/tool-context.ts';
const AGENT = 'src/modules/channels/voice-livekit/agent.ts';

let dir: string;

/** A build context containing the given file bodies. */
async function stage(files: Record<string, string>) {
  const root = await mkdtemp(join(dir, 'stage-'));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body, 'utf8');
  }
  return root;
}

const GOOD = {
  [TOOL_CONTEXT]: `
    import { resolveCallIdentity } from './x.js';
    console.log('call_identity', JSON.stringify({ tenantId, source }));
  `,
  [AGENT]: `if (isDidRefusal(disabledReason)) { await hangUp(); }`,
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deploy-guard-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('assertDeployableCode', () => {
  it('accepts a tree that has every capability', async () => {
    const root = await stage(GOOD);

    await expect(assertDeployableCode(root)).resolves.toBeUndefined();
  });

  it('refuses a tree with no DID routing — the actual incident', async () => {
    // What `feature/crm-automation` looks like: an agent that answers normally and routes every
    // caller to whichever tenant VOICE_WEBHOOK_TENANT_ID happens to name.
    const root = await stage({
      [TOOL_CONTEXT]: 'export function buildToolRuntime() { return env.VOICE_WEBHOOK_TENANT_ID; }',
      [AGENT]: 'const caller = readSipCaller(participant);',
    });

    await expect(assertDeployableCode(root)).rejects.toThrow(/DID routing/);
  });

  it('names the consequence, not just the missing symbol', async () => {
    // Whoever hits this is mid-deploy and will otherwise reach for --allow-behind. The message has
    // to make the cost obvious enough to stop them.
    const root = await stage({ ...GOOD, [TOOL_CONTEXT]: 'nothing useful here' });

    await expect(assertDeployableCode(root)).rejects.toThrow(/VOICE_WEBHOOK_TENANT_ID/);
    await expect(assertDeployableCode(root)).rejects.toThrow(/wrong worktree/);
  });

  it('refuses a tree missing the fail-closed refusal', async () => {
    // Without it, a call to a number belonging to nobody gets a real sales conversation.
    const root = await stage({ ...GOOD, [AGENT]: 'const caller = readSipCaller(participant);' });

    await expect(assertDeployableCode(root)).rejects.toThrow(/unmapped number/);
  });

  it('refuses a build context that is missing the file entirely', async () => {
    const root = await stage({ [AGENT]: GOOD[AGENT] });

    await expect(assertDeployableCode(root)).rejects.toThrow(/not in the build context/);
  });

  it('checks the tool-context file for both of its markers', async () => {
    // Two separate capabilities live in one file; a fix that satisfies one must not mask the other.
    expect(DEPLOY_MARKERS.filter((m: { file: string }) => m.file === TOOL_CONTEXT)).toHaveLength(2);
  });
});
