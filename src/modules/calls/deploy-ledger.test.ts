import { describe, expect, it } from 'vitest';
// Plain ESM operator script, no types. Tested here because it is the only thing standing between
// two sessions deploying to one shared agent and silently deleting each other's work.
// @ts-expect-error — untyped .mjs
import { checkLiveDrop, describeDrop, parseLiveVersion, refFor } from '../../../scripts/lib/deploy-ledger.mjs';

/**
 * ONE AGENT, SIX WORKTREES.
 *
 * `lk agent deploy` uploads whatever tree it is run from, and every session deploys to the same
 * CA_azGQ9uaLxpot. The existing guards catch a build that is BROKEN (missing DID routing) or behind
 * origin/main — neither can see a live build that came from another session's unmerged branch, which
 * on this machine is four branches carrying 33, 24, 16 and 4 voice commits.
 *
 * The ledger closes that by recording version -> commit as a git ref, so a deploy can ask whether it
 * is about to replace commits that are live. These tests pin the decision, not the plumbing: the
 * effects are injected so the refusal case is reachable without a cloud agent or a second worktree.
 */

const LIVE = { agentId: 'CA_azGQ9uaLxpot', version: 'q4ni9bwc7fsx', deployedAt: '2026-08-26T16:34:20Z' };
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('parseLiveVersion', () => {
  it('reads the deployed version out of `lk agent status --json`', () => {
    const stdout = JSON.stringify({
      agents: [{ agentId: LIVE.agentId, version: LIVE.version, deployedAt: LIVE.deployedAt }],
    });

    expect(parseLiveVersion(stdout)).toEqual(LIVE);
  });

  it('returns null rather than throwing when the CLI prints nothing useful', () => {
    // Offline, unauthenticated, or a CLI upgrade that changed the shape. None of those should stop
    // a deploy — the guard degrades to "unknown", which warns and proceeds.
    expect(parseLiveVersion('')).toBeNull();
    expect(parseLiveVersion('WARNING: config file should have permissions 600')).toBeNull();
    expect(parseLiveVersion('{"agents":[]}')).toBeNull();
  });
});

describe('refFor', () => {
  it('namespaces the ref outside refs/heads so it can never conflict with a branch', () => {
    expect(refFor(LIVE.version)).toBe('refs/deploys/agent/q4ni9bwc7fsx');
  });

  it('refuses a version id that could carry ref syntax', () => {
    // The version comes from an external CLI and is interpolated into a git ref that gets pushed.
    expect(() => refFor('../../heads/main')).toThrow(/unexpected version id/);
    expect(() => refFor('v1 --force')).toThrow(/unexpected version id/);
  });
});

describe('checkLiveDrop', () => {
  const lookup = (sha: string | null) => () => sha;

  it('passes when the live build is an ancestor of this tree', () => {
    const result = checkLiveDrop({
      live: LIVE,
      lookupSha: lookup(SHA),
      missingVoiceCommits: () => [],
    });

    expect(result).toMatchObject({ status: 'ok', version: LIVE.version, sha: SHA });
  });

  it('refuses when the live build has voice commits this tree lacks — the whole point', () => {
    // What deploying main over `feature/voice-rag-r1` looks like: routing is present, the markers
    // pass, tests pass, and 33 commits of tuning vanish with no error anywhere.
    const result = checkLiveDrop({
      live: LIVE,
      lookupSha: lookup(SHA),
      missingVoiceCommits: () => ['d6b904d tune rag', 'bb9755b rag retrieval'],
    });

    expect(result.status).toBe('drop');
    expect(result.missing).toHaveLength(2);
  });

  it('only counts voice-livekit commits, not any divergence', () => {
    // Every branch here diverges on dashboard/docs files constantly. Blocking on that would make the
    // guard noise, and noise gets overridden by reflex.
    const result = checkLiveDrop({
      live: LIVE,
      lookupSha: lookup(SHA),
      missingVoiceCommits: (sha: string) => {
        expect(sha).toBe(SHA);
        return [];
      },
    });

    expect(result.status).toBe('ok');
  });

  it('reports uncertainty when the live version was deployed without the ledger', () => {
    // Today's real state: nothing has ever been recorded. This must NOT hard-fail, or the first
    // deploy is blocked and --allow-drop becomes the habit before the ledger ever has an entry.
    const result = checkLiveDrop({
      live: LIVE,
      lookupSha: lookup(null),
      missingVoiceCommits: () => [],
    });

    expect(result.status).toBe('unknown');
    expect(result.reason).toMatch(/no recorded commit/);
  });

  it('reports uncertainty when LiveKit cannot be reached at all', () => {
    const result = checkLiveDrop({
      live: null,
      lookupSha: lookup(SHA),
      missingVoiceCommits: () => [],
    });

    expect(result.status).toBe('unknown');
  });
});

describe('describeDrop', () => {
  it('names the commits at risk and how to keep them', () => {
    // Whoever reads this is mid-deploy and will otherwise reach for the override. It has to make the
    // cost concrete and offer the merge that resolves it.
    const message = describeDrop({
      version: LIVE.version,
      sha: SHA,
      missing: ['d6b904d tune rag'],
    });

    expect(message).toMatch(/d6b904d tune rag/);
    expect(message).toMatch(/git merge a1b2c3d4e5f6/);
    expect(message).toMatch(/answers calls normally either way/);
    expect(message).toMatch(/--allow-drop/);
  });
});
