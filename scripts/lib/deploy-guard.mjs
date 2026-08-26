import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

/**
 * REFUSE TO SHIP CODE THAT IS MISSING A CAPABILITY THE FLEET DEPENDS ON.
 *
 * `lk agent deploy` uploads whatever tree it is run from, and this repo has six voice worktrees on
 * one machine. Three of them do not contain the DID-routing commit — including
 * `feature/crm-automation`, which CLAUDE.md calls the de-facto voice trunk. Deploying from one of
 * those replaces a working agent with one that has no `phone_numbers` lookup at all, so every
 * inbound call falls back to `VOICE_WEBHOOK_TENANT_ID`.
 *
 * That happened on 2026-08-26. The agent answered normally, sounded healthy, held a full five-minute
 * sales conversation in Hebrew, and filed a second tenant's lead into ClickScales. Nothing errored,
 * nothing alerted, and the only symptom was a log line that DIDN'T appear — which you can only
 * notice if you already know to expect it.
 *
 * `assertDeployableSecrets` in deploy-agent.mjs exists because a bad config is checkable. The
 * insight here is that the code is checkable the same way: assert the capabilities the fleet
 * depends on are present in what is being shipped, rather than trusting the right branch is
 * checked out.
 *
 * Markers are asserted against the STAGED directory — what actually goes into the image — rather
 * than the repo, because staging is where a wrong tree would already have been copied.
 *
 * If you rename one of these deliberately, update this list in the same commit. Being forced to
 * touch it is the point: it is how the guard stays true instead of quietly matching nothing.
 */
export const DEPLOY_MARKERS = [
  {
    file: 'src/modules/channels/voice-livekit/tools/tool-context.ts',
    pattern: /resolveCallIdentity/,
    capability: 'DID routing — resolve the tenant from the number that was dialled',
    consequence:
      'every inbound call falls back to VOICE_WEBHOOK_TENANT_ID, so one tenant receives the calls and leads belonging to every other tenant',
  },
  {
    file: 'src/modules/channels/voice-livekit/tools/tool-context.ts',
    pattern: /'call_identity'/,
    capability: 'the call_identity log line',
    consequence:
      'a mis-routed call leaves no trace of which tenant it resolved to, or how — this is the line whose absence diagnosed the 2026-08-26 incident',
  },
  {
    file: 'src/modules/channels/voice-livekit/agent.ts',
    pattern: /isDidRefusal/,
    capability: 'the fail-closed refusal for an unmapped number',
    consequence:
      'a call to a number belonging to nobody is answered as a real sales call instead of being refused',
  },
];

/** Does the build context contain the capabilities the deployed agent must have? */
export async function assertDeployableCode(stageDir) {
  const problems = [];

  for (const { file, pattern, capability, consequence } of DEPLOY_MARKERS) {
    let source;
    try {
      source = await readFile(`${stageDir}/${file}`, 'utf8');
    } catch {
      problems.push(`${file} is not in the build context at all`);
      continue;
    }
    if (!pattern.test(source)) {
      problems.push(`${file} is missing ${capability}\n      -> ${consequence}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      'This working tree is missing code the deployed agent depends on:\n' +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\n\nYou are probably deploying from the wrong worktree. `git worktree list` shows them;\n' +
        'deploy from one that is current with main.\n' +
        'If you renamed something deliberately, update DEPLOY_MARKERS in scripts/lib/deploy-guard.mjs.',
    );
  }
}

/**
 * Has main moved on in the agent's own code?
 *
 * Separate from the marker check because it is a different kind of claim: markers say "this build
 * is not broken", this says "this build is not a silent rollback". Only commits touching
 * voice-livekit count — a dashboard commit on main is no reason to block a voice deploy.
 *
 * No `shell: true`: `git` is a real executable, and passing args through a shell means they are
 * concatenated rather than escaped (DEP0190).
 */
export function assertNotBehindMain({ allowBehind = false, cwd } = {}) {
  const run = (args) => spawnSync('git', args, { encoding: 'utf8', timeout: 20_000, cwd });

  // Best-effort: an offline machine still gets the marker checks, and a stale ref is better than
  // a deploy that cannot run without network.
  run(['fetch', '--quiet', 'origin', 'main']);

  const behind = run([
    'log',
    '--oneline',
    'HEAD..origin/main',
    '--',
    'src/modules/channels/voice-livekit',
  ]);
  const missing = (behind.stdout ?? '').trim();
  if (!missing || allowBehind) return { behind: missing ? missing.split(/\r?\n/) : [] };

  throw new Error(
    'origin/main has agent commits this tree does not:\n' +
      missing
        .split(/\r?\n/)
        .map((l) => `  ${l}`)
        .join('\n') +
      '\n\nDeploying would roll those back on the live agent, silently — it answers calls normally\n' +
      'either way. Merge main, or pass --allow-behind if the rollback is intended.',
  );
}
