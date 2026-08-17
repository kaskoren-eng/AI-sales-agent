/**
 * WHAT A CALL COST US. Never what a customer is charged — see `billing.ts`'s header.
 *
 * ⚠️ THE RATES BELOW ARE LIST PRICES, NOT MEASURED ONES. `docs/gtm/pricing-model.md` flags in bold
 * that real cost-per-minute has never been measured, and prices every package against a
 * conservative $0.12/min ceiling for exactly that reason. This module is how that ⚠️ finally gets
 * resolved: once a month of `usage_events` exists, the measured total can be held against the
 * actual provider invoices, and these constants corrected from evidence.
 *
 * Until then, treat the output as an ESTIMATE WITH A KNOWN SHAPE rather than a fact. The shape is
 * the valuable part — it is per-call, per-tenant, and attributable to a component, so when the
 * number is wrong it is wrong in a way you can chase.
 *
 * ── Why the rate card is versioned ──
 * Rates change, and a cost figure with no record of the rates used to produce it cannot be
 * explained or re-derived six months later. Every priced event stores `rateVersion`, so an old row
 * remains interpretable and a corrected rate card can re-price history rather than invalidate it.
 * CHANGING A RATE MEANS BUMPING THE VERSION — a silent edit makes two incomparable numbers share a
 * label, which is worse than either number alone.
 */

export interface RateCard {
  /** Bump on ANY rate change. Stored on every event. */
  version: string;
  /** Israeli new shekels per US dollar. Also a rate, also changes, also versioned. */
  ilsPerUsd: number;
  /** USD per 1,000,000 LLM tokens. */
  llmInputPerMTokensUsd: number;
  llmCachedInputPerMTokensUsd: number;
  llmOutputPerMTokensUsd: number;
  /** USD per minute of audio transcribed. */
  sttPerMinuteUsd: number;
  /** USD per 1,000,000 characters synthesised. */
  ttsPerMCharsUsd: number;
  /** USD per minute of session, covering LiveKit media plus the SIP leg. */
  platformPerMinuteUsd: number;
}

/**
 * List prices as advertised in August 2026. Every one of these is a number to CHECK against an
 * invoice, not a number to trust.
 */
export const RATE_CARD: RateCard = {
  version: '2026-08-list',
  ilsPerUsd: 3.7,
  llmInputPerMTokensUsd: 2.5,
  llmCachedInputPerMTokensUsd: 0.25,
  llmOutputPerMTokensUsd: 10,
  sttPerMinuteUsd: 0.0025,
  ttsPerMCharsUsd: 65,
  platformPerMinuteUsd: 0.012,
};

/**
 * The provider usage LiveKit tallies for us, as `SessionUsageUpdated` delivers it.
 *
 * Every field optional and every field validated at the door: this arrives from a third-party SDK
 * event at call teardown, and a shape change upstream must degrade the cost estimate, never throw
 * inside a shutdown handler.
 */
export interface CallUsageInput {
  llmPromptTokens?: number;
  llmPromptCachedTokens?: number;
  llmCompletionTokens?: number;
  ttsCharactersCount?: number;
  sttAudioDurationMs?: number;
  /** Wall-clock call length, for the platform/SIP leg, which is billed on connected time. */
  durationSec?: number;
}

export interface CostBreakdown {
  llmMilliAgorot: number;
  sttMilliAgorot: number;
  ttsMilliAgorot: number;
  platformMilliAgorot: number;
  totalMilliAgorot: number;
  rateVersion: string;
}

/** A finite, non-negative number, or 0. Guards against nulls, NaN and negative junk from the SDK. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * USD → milli-agorot. 1 ILS = 100 agorot = 100,000 milli-agorot.
 *
 * Rounded, not truncated, and only at the very END of each component — rounding intermediate terms
 * would systematically bias the total downward, and the bias compounds over thousands of calls in
 * exactly the direction that flatters the margin.
 */
function usdToMilliAgorot(usd: number, ilsPerUsd: number): number {
  return Math.round(usd * ilsPerUsd * 100_000);
}

/**
 * What one call cost, in milli-agorot, split by component.
 *
 * Total, never throws. A call whose usage never arrived costs 0 — which is visibly wrong in a
 * report, and that is the intended failure: a zero row says "we didn't measure this call", whereas
 * a fabricated estimate says "this call was cheap" and nobody investigates.
 */
export function costOfCall(usage: CallUsageInput, rates: RateCard = RATE_CARD): CostBreakdown {
  const promptTokens = num(usage.llmPromptTokens);
  const cachedTokens = Math.min(num(usage.llmPromptCachedTokens), promptTokens);
  // Cached tokens are a SUBSET of prompt tokens, not an addition to them. Billing both at full
  // rate would overstate LLM cost by the cache-hit rate — which the agent deliberately keeps high,
  // so the error would be largest exactly where the system is working best.
  const freshTokens = promptTokens - cachedTokens;

  const llmUsd =
    (freshTokens / 1_000_000) * rates.llmInputPerMTokensUsd +
    (cachedTokens / 1_000_000) * rates.llmCachedInputPerMTokensUsd +
    (num(usage.llmCompletionTokens) / 1_000_000) * rates.llmOutputPerMTokensUsd;

  const sttUsd = (num(usage.sttAudioDurationMs) / 60_000) * rates.sttPerMinuteUsd;
  const ttsUsd = (num(usage.ttsCharactersCount) / 1_000_000) * rates.ttsPerMCharsUsd;
  const platformUsd = (num(usage.durationSec) / 60) * rates.platformPerMinuteUsd;

  const llmMilliAgorot = usdToMilliAgorot(llmUsd, rates.ilsPerUsd);
  const sttMilliAgorot = usdToMilliAgorot(sttUsd, rates.ilsPerUsd);
  const ttsMilliAgorot = usdToMilliAgorot(ttsUsd, rates.ilsPerUsd);
  const platformMilliAgorot = usdToMilliAgorot(platformUsd, rates.ilsPerUsd);

  return {
    llmMilliAgorot,
    sttMilliAgorot,
    ttsMilliAgorot,
    platformMilliAgorot,
    totalMilliAgorot: llmMilliAgorot + sttMilliAgorot + ttsMilliAgorot + platformMilliAgorot,
    rateVersion: rates.version,
  };
}

/**
 * Pull the usage numbers out of whatever LiveKit handed us.
 *
 * `SessionUsageUpdated` has been through at least one shape change already — `UsageSummary` is
 * marked `@deprecated` in the installed SDK in favour of per-model collectors — so this reads
 * defensively rather than casting. An unrecognised shape yields zeros, and a zero-cost call is a
 * visible "not measured", not a silent "free".
 */
export function readUsageSummary(raw: unknown, durationSec?: number): CallUsageInput {
  const u = (raw ?? {}) as Record<string, unknown>;
  const summary = (typeof u.usage === 'object' && u.usage !== null ? u.usage : u) as Record<string, unknown>;
  return {
    llmPromptTokens: num(summary.llmPromptTokens),
    llmPromptCachedTokens: num(summary.llmPromptCachedTokens),
    llmCompletionTokens: num(summary.llmCompletionTokens),
    ttsCharactersCount: num(summary.ttsCharactersCount),
    sttAudioDurationMs: num(summary.sttAudioDurationMs),
    ...(durationSec !== undefined ? { durationSec: num(durationSec) } : {}),
  };
}

/** Milli-agorot → a shekel string for humans. `₪1.23`. Display only; never feeds another sum. */
export function formatMilliAgorot(milliAgorot: number): string {
  return `₪${(milliAgorot / 100_000).toFixed(2)}`;
}
