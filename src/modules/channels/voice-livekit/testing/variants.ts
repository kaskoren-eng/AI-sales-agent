import type { PipelineSnapshot } from '../pipeline-observer.js';
import { ENV_KEYS } from '../../../../config/env.js';
/**
 * What an A/B "variant" is, and the checks that stop a run from lying about one.
 *
 * A variant is a NAME plus a set of env overrides. That is deliberately the whole of it: every
 * lever worth A/B-ing on this agent is already an env key — TTS speed/volume/voice/model,
 * endpointing and VAD timing, the LLM model / reasoning effort / service tier, and the switches
 * that change the system prompt itself (`VOICE_INSTANT_ACK`, `VOICE_SPOKEN_REGISTER_ENABLED`,
 * `VOICE_FACT_MEMORY_ENABLED`, `VOICE_NEGATION_SAFETY`, `VOICE_STATE_MACHINE_ENABLED` …). They
 * reach the agent through `env-overlay.ts`, which is the only mechanism in this repo that actually
 * survives `.env`'s dotenv override.
 *
 * NOT covered: free-text edits to the Hebrew system prompt. Those still need a code change, because
 * the prompt is built in TypeScript and its fixtures are pinned byte-for-byte. See the handoff.
 */
import { readFileSync } from 'node:fs';

export interface Variant {
  /** 'A', 'B', 'C' — short, because a human says it out loud when picking a winner. */
  key: string;
  /** What this variant is, in Hebrew or English. Shown on the page above every clip. */
  label: string;
  /** Env overrides. `{}` is legal and means "exactly what .env says" — the baseline. */
  env: Record<string, string>;
}

export interface VariantFile {
  /** Scenario name from `scenarios.ts`. Overridable on the command line. */
  scenario?: string;
  variants: Variant[];
}

export function loadVariantFile(path: string): VariantFile {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`${path}: expected a JSON object`);
  }
  const file = raw as { scenario?: unknown; variants?: unknown };
  if (!Array.isArray(file.variants) || file.variants.length === 0) {
    throw new Error(`${path}: "variants" must be a non-empty array`);
  }

  const variants: Variant[] = file.variants.map((entry, i) => {
    const v = entry as { key?: unknown; label?: unknown; env?: unknown };
    const key = typeof v.key === 'string' && v.key.trim() ? v.key.trim() : String.fromCharCode(65 + i);
    if (typeof v.label !== 'string' || v.label.trim() === '') {
      throw new Error(`${path}: variant ${key} needs a "label" — the page is unreadable without it`);
    }
    const env: Record<string, string> = {};
    for (const [k, val] of Object.entries((v.env ?? {}) as Record<string, unknown>)) {
      if (val === null || val === undefined) continue;
      env[k] = String(val);
    }
    return { key, label: v.label.trim(), env };
  });

  const keys = new Set<string>();
  for (const v of variants) {
    if (keys.has(v.key)) throw new Error(`${path}: duplicate variant key "${v.key}"`);
    keys.add(v.key);
  }
  return { ...(typeof file.scenario === 'string' ? { scenario: file.scenario } : {}), variants };
}

/**
 * THE CHECK THAT STOPS THE WORST FAILURE MODE OF THIS WHOLE FEATURE.
 *
 * Two variants that resolve to the same configuration produce two identical clips labelled A and
 * B, and a human then "picks a winner" between a thing and itself. That is worse than no A/B: it
 * manufactures a false result and there is nothing on the page to show it happened. So a run with
 * more than one variant must differ somewhere, before a single paid second of TTS is spent.
 *
 * This is the CHEAP, up-front half. The expensive, authoritative half runs after the calls, against
 * what the agent's own pipeline observer reported — see `assertPipelinesDiffer`.
 */
export function assertVariantsDiffer(variants: Variant[]): void {
  if (variants.length < 2) return;
  const seen = new Map<string, string>();
  for (const v of variants) {
    const fingerprint = JSON.stringify(
      Object.fromEntries(Object.entries(v.env).sort(([a], [b]) => a.localeCompare(b))),
    );
    const previous = seen.get(fingerprint);
    if (previous !== undefined) {
      throw new Error(
        `variants "${previous}" and "${v.key}" have IDENTICAL env overrides (${fingerprint}). ` +
          'They would produce two identical clips labelled A and B — refusing to run.',
      );
    }
    seen.set(fingerprint, v.key);
  }
}

/**
 * Every env key mentioned by any variant. These are the keys the post-run proof looks at.
 */
export function variantKeys(variants: Variant[]): string[] {
  return [...new Set(variants.flatMap((v) => Object.keys(v.env)))].sort();
}

/**
 * Rejects env keys the app has never heard of.
 *
 * A typo like `VOICE_TTS_SPEEED` applies cleanly to `process.env`, is ignored by the Zod schema,
 * and produces a variant identical to the baseline — the silent no-op again, one layer up.
 *
 * Checked against the SCHEMA (`ENV_KEYS`), not against `.env.example`. The example file documents
 * only about half the keys — `VOICE_TTS_SPEED` and `VOICE_TTS_VOLUME`, the two most obvious things
 * to A/B, are both missing from it — so validating against it rejects valid variants and teaches
 * whoever hits that to reach for --allow-unknown-keys, which disarms the check for real typos too.
 */
export function unknownEnvKeys(keys: string[], known: readonly string[] = ENV_KEYS): string[] {
  const set = new Set(known);
  return keys.filter((k) => !set.has(k));
}

export interface PipelineProof {
  key: string;
  overrides: Record<string, string>;
  pipeline: PipelineSnapshot | null;
}

/**
 * THE AUTHORITATIVE PROOF that each variant actually ran the configuration it claimed.
 *
 * For every key a variant DECLARES, compare the declared value against what the agent's own
 * `describePipeline()` recorded on that call — read back off the live session after `start()` and
 * stamped into `call-reports/*.json`. If they disagree, the override did not take effect and the
 * whole comparison is void.
 *
 * DECLARED vs OBSERVED, not variant-A vs variant-B. The first version compared the two variants'
 * observed values and flagged them when they matched, which fired on the very first real run for a
 * variant that had deliberately set a key to the value `.env` already had — a false alarm that
 * would train whoever sees it to ignore the one warning that must never be ignored. Comparing each
 * variant against its own declaration has no such blind spot in either direction.
 *
 * Warnings prefixed IDENTICAL make the runner exit non-zero.
 */
export function assertPipelinesDiffer(summaries: PipelineProof[], declaredKeys: string[]): string[] {
  const out: string[] = [];

  for (const summary of summaries) {
    for (const key of declaredKeys) {
      const declared = summary.overrides[key];
      if (declared === undefined) continue; // this variant takes the .env value; nothing to prove

      const observed = summary.pipeline?.configured[key]?.value;
      if (observed === undefined) {
        out.push(
          `variant ${summary.key}: ${key} is not in the call report's pipeline snapshot, so the ` +
            `override could NOT be verified. (pipeline-observer only records its OBSERVED_ENV_KEYS; ` +
            `a missing call report does the same thing.)`,
        );
        continue;
      }
      if (observed !== declared) {
        out.push(
          `IDENTICAL: variant ${summary.key} asked for ${key}=${declared} but the agent reported ` +
            `"${observed}" on the call. The override did not take effect — this comparison is void.`,
        );
      }
    }
  }

  // Every variant identical on every declared key means nothing was being compared at all.
  if (summaries.length > 1 && declaredKeys.length > 0) {
    const fingerprints = summaries.map((s) =>
      declaredKeys.map((k) => `${k}=${s.pipeline?.configured[k]?.value ?? '?'}`).join('|'),
    );
    if (new Set(fingerprints).size === 1 && summaries.every((s) => s.pipeline !== null)) {
      out.push(
        `IDENTICAL: every variant resolved to the same values for ${declaredKeys.join(', ')} ` +
          `(${fingerprints[0]}). There is nothing being compared here.`,
      );
    }
  }
  return out;
}
