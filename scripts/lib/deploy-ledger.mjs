import { spawnSync } from 'node:child_process';

/**
 * REFUSE TO REPLACE A LIVE BUILD THAT CONTAINS WORK THIS TREE DOES NOT HAVE.
 *
 * There is ONE agent in LiveKit Cloud (CA_azGQ9uaLxpot) and six voice worktrees on this machine,
 * several carrying unmerged commits. `lk agent deploy` uploads whatever tree it is run from, so the
 * last deploy wins completely — including over another session's work that was never merged.
 *
 * The two guards in deploy-guard.mjs are both blind to this. `assertDeployableCode` asserts
 * CAPABILITIES, so it catches a tree with no DID routing but waves through a tree that has routing
 * and is missing 33 commits of someone else's tuning. `assertNotBehindMain` compares against
 * origin/main, and unmerged work is by definition not there.
 *
 * -- Why a git ref and not a file or a table ---------------------------------------------------
 *
 * The missing fact is "version q4ni9bwc7fsx is commit <sha>". `lk agent status` reports an opaque
 * version id that maps to nothing; on 2026-08-26 that is precisely what turned a one-line regression
 * into a day of diagnosis, because the only symptom was a log line that did not appear.
 *
 * A ledger FILE would have to live on a branch, and the sessions deploy from different branches, so
 * each would read a ledger missing the others' entries — the exact blindness being fixed. A DB table
 * needs Postgres from the deploy host, and Railway's TCP proxy is blocked outbound here.
 *
 * A ref under `refs/deploys/` is none of those things: it sits outside the branch namespace so it
 * can never conflict or need merging, every worktree reads it through the one remote, and pushing it
 * carries the commit objects — so the exact deployed tree survives even if that branch is never
 * pushed and even if the worktree is later deleted.
 *
 * -- What it can and cannot promise ------------------------------------------------------------
 *
 * It refuses only on EVIDENCE: a recorded live commit holding voice commits this tree lacks. If the
 * live version has no ref — deployed with a bare `lk agent deploy`, or before this existed — it
 * warns and proceeds, because a guard that blocked on ignorance would be overridden every time and
 * would teach people that --allow-drop is routine. Uncertainty is reported as uncertainty.
 */

/** Version ids are interpolated into a git ref, so they must not be able to carry ref syntax. */
const SAFE_VERSION = /^[A-Za-z0-9._-]+$/;

export function refFor(version) {
  if (!SAFE_VERSION.test(version)) {
    throw new Error(`refusing to build a git ref from an unexpected version id: ${version}`);
  }
  return `refs/deploys/agent/${version}`;
}

/** The currently deployed version, from `lk agent status --json`. Null when it cannot be read. */
export function parseLiveVersion(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const agent = parsed?.agents?.[0];
  if (!agent?.version) return null;
  return {
    agentId: agent.agentId ?? null,
    version: agent.version,
    deployedAt: agent.deployedAt ?? null,
  };
}

/**
 * Decide whether this deploy would drop live work.
 *
 * Pure: every effect is injected, so the interesting cases are testable without a cloud agent, a
 * remote, or a second worktree.
 *
 *   live                      {version, deployedAt} | null
 *   lookupSha(version)        recorded commit for a version, or null if never recorded
 *   missingVoiceCommits(sha)  voice-livekit commits in `sha` that HEAD does not contain
 */
export function checkLiveDrop({ live, lookupSha, missingVoiceCommits }) {
  if (!live) return { status: 'unknown', reason: 'the live agent version could not be read' };

  const sha = lookupSha(live.version);
  if (!sha) {
    return {
      status: 'unknown',
      version: live.version,
      reason: `version ${live.version} has no recorded commit — it was deployed without this ledger`,
    };
  }

  const missing = missingVoiceCommits(sha);
  if (missing.length === 0) return { status: 'ok', version: live.version, sha };
  return { status: 'drop', version: live.version, sha, missing };
}

export function describeDrop({ version, sha, missing }) {
  const short = sha.slice(0, 12);
  return (
    'This deploy would DELETE agent work that is live right now.\n\n' +
    `  live version ${version} = commit ${short}\n` +
    `  it contains ${missing.length} voice-livekit commit(s) this tree does not:\n` +
    missing.map((l) => `    ${l}`).join('\n') +
    '\n\nThe agent answers calls normally either way, so nothing will alert you to the loss.\n' +
    'Another session very likely deployed that build from its own worktree.\n\n' +
    `  git log ${short} -- src/modules/channels/voice-livekit   # see what is live\n` +
    `  git merge ${short}                                       # keep it, then deploy\n\n` +
    'Pass --allow-drop only if replacing that work is the point.'
  );
}

const git = (args, cwd) => spawnSync('git', args, { encoding: 'utf8', timeout: 30_000, cwd });

/** Ask LiveKit which version is deployed. Never throws: a CLI problem must not block a deploy. */
export function readLiveVersion() {
  try {
    // One static command string rather than args + shell:true — `lk` needs a shell on Windows, and
    // the array form under a shell is concatenated rather than escaped (DEP0190). Nothing here is
    // interpolated, so a fixed string is both safe and quiet.
    const r = spawnSync('lk agent status --json -q', {
      encoding: 'utf8',
      timeout: 60_000,
      shell: true,
    });
    return parseLiveVersion(r.stdout ?? '');
  } catch {
    return null;
  }
}

/** The real guard: read what is live, resolve its commit from the remote, compare, refuse or warn. */
export function assertNotDroppingLiveWork({ cwd, allowDrop = false } = {}) {
  const result = checkLiveDrop({
    live: readLiveVersion(),
    lookupSha: (version) => {
      const ref = refFor(version);
      const sha = (git(['ls-remote', 'origin', ref], cwd).stdout ?? '').trim().split(/\s+/)[0];
      if (!sha) return null;
      // ls-remote reports a sha the local object store may not have; fetch it before asking git
      // questions about it, or every comparison silently answers "nothing missing".
      git(['fetch', '--quiet', 'origin', ref], cwd);
      return git(['cat-file', '-e', `${sha}^{commit}`], cwd).status === 0 ? sha : null;
    },
    missingVoiceCommits: (sha) => {
      const out = (
        git(['log', '--oneline', `HEAD..${sha}`, '--', 'src/modules/channels/voice-livekit'], cwd)
          .stdout ?? ''
      ).trim();
      return out ? out.split(/\r?\n/) : [];
    },
  });

  if (result.status === 'drop' && !allowDrop) throw new Error(describeDrop(result));
  if (result.status === 'drop') {
    console.warn(`\n!! --allow-drop: replacing ${result.missing.length} live commit(s)\n`);
  } else if (result.status === 'unknown') {
    console.warn(
      `\n!! Cannot verify this deploy is safe: ${result.reason}.\n` +
        '   Proceeding — this deploy WILL be recorded, so the next one can be checked.\n',
    );
  } else {
    console.log(`ok: live version ${result.version} is an ancestor of this tree`);
  }
  return result;
}

/**
 * Record what was just deployed. Best-effort by design: the deploy already happened, so a failure
 * here must report itself loudly and never masquerade as a failed deploy.
 */
export function recordDeploy({ cwd } = {}) {
  const live = readLiveVersion();
  if (!live) {
    console.warn('!! deployed, but the new version id could not be read — nothing recorded');
    return null;
  }

  // A dirty voice tree means the image and the commit differ, and a ref claiming otherwise is worse
  // than no ref at all: the next deploy would trust it.
  const dirty = (
    git(['status', '--porcelain', '--', 'src/modules/channels/voice-livekit'], cwd).stdout ?? ''
  ).trim();
  if (dirty) {
    console.warn(
      `!! voice-livekit had uncommitted changes at deploy time, so version ${live.version} matches\n` +
        '   no commit. Not recording — commit and redeploy to restore the ledger.',
    );
    return null;
  }

  const head = (git(['rev-parse', 'HEAD'], cwd).stdout ?? '').trim();
  const push = git(['push', 'origin', `HEAD:${refFor(live.version)}`], cwd);
  if (push.status !== 0) {
    console.warn(`!! could not record the deploy: ${(push.stderr ?? '').trim()}`);
    return null;
  }
  console.log(`recorded: version ${live.version} = ${head.slice(0, 12)}`);
  return { version: live.version, sha: head };
}
