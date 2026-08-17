import { describe, expect, it } from 'vitest';
import { costOfCall, readUsageSummary, formatMilliAgorot, RATE_CARD, type RateCard } from './pricing.js';

/**
 * WHAT A CALL COST US.
 *
 * These tests pin the ARITHMETIC and the DEFENSIVENESS, not the rates — the rates in `RATE_CARD`
 * are unverified list prices by their own admission, and asserting on them would only freeze a
 * guess. A fixed test rate card is used instead, so the sums are checkable by hand and a rate
 * correction does not break the suite it is supposed to be validated by.
 */

// Deliberately round, so every expected value below can be computed in your head.
const RATES: RateCard = {
  version: 'test-1',
  ilsPerUsd: 4,
  llmInputPerMTokensUsd: 1,
  llmCachedInputPerMTokensUsd: 0.1,
  llmOutputPerMTokensUsd: 10,
  sttPerMinuteUsd: 0.006,
  ttsPerMCharsUsd: 100,
  platformPerMinuteUsd: 0.03,
};

// $1 = ₪4 = 400 agorot = 400,000 milli-agorot.
const MILLI_AGOROT_PER_USD = 400_000;

describe('costOfCall', () => {
  it('prices each component and sums them', () => {
    const cost = costOfCall(
      {
        llmPromptTokens: 1_000_000,
        llmPromptCachedTokens: 0,
        llmCompletionTokens: 100_000,
        sttAudioDurationMs: 600_000, // 10 minutes
        ttsCharactersCount: 10_000,
        durationSec: 600, // 10 minutes
      },
      RATES,
    );

    expect(cost.llmMilliAgorot).toBe(MILLI_AGOROT_PER_USD * (1 + 1)); // $1 in + $1 out
    expect(cost.sttMilliAgorot).toBe(MILLI_AGOROT_PER_USD * 0.06); // 10 min × $0.006
    expect(cost.ttsMilliAgorot).toBe(MILLI_AGOROT_PER_USD * 1); // 10k chars at $100/M
    expect(cost.platformMilliAgorot).toBe(MILLI_AGOROT_PER_USD * 0.3); // 10 min × $0.03
    expect(cost.totalMilliAgorot).toBe(
      cost.llmMilliAgorot + cost.sttMilliAgorot + cost.ttsMilliAgorot + cost.platformMilliAgorot,
    );
    expect(cost.rateVersion).toBe('test-1');
  });

  it('treats cached tokens as a SUBSET of prompt tokens, not an addition', () => {
    // THE ONE THAT WOULD SILENTLY INFLATE COST. LiveKit reports cached tokens as part of the
    // prompt total. Billing both at full rate overstates LLM cost by the cache-hit rate — and the
    // agent deliberately keeps that rate high, so the error would be largest exactly where the
    // system is working best, making a well-tuned agent look expensive.
    const cost = costOfCall(
      { llmPromptTokens: 1_000_000, llmPromptCachedTokens: 900_000, llmCompletionTokens: 0 },
      RATES,
    );
    // 100k fresh at $1/M + 900k cached at $0.10/M = $0.10 + $0.09 = $0.19
    expect(cost.llmMilliAgorot).toBe(Math.round(0.19 * MILLI_AGOROT_PER_USD));
  });

  it('does not let a cached count larger than the prompt count produce negative cost', () => {
    // A provider bug or a shape change must not yield a NEGATIVE cost, which would silently
    // subtract from the period total and make other calls look free.
    const cost = costOfCall({ llmPromptTokens: 1000, llmPromptCachedTokens: 999_999 }, RATES);
    expect(cost.llmMilliAgorot).toBeGreaterThanOrEqual(0);
    expect(cost.totalMilliAgorot).toBeGreaterThanOrEqual(0);
  });

  it('a call with no usage costs zero rather than throwing', () => {
    // Zero is the intended answer: it reads as "we did not measure this call". A fabricated
    // estimate would read as "this call was cheap" and nobody would investigate.
    expect(costOfCall({}, RATES).totalMilliAgorot).toBe(0);
  });

  it('ignores junk instead of producing NaN', () => {
    // NaN propagates into the period total and poisons every subsequent sum — one bad call would
    // make a whole month's cost unreadable.
    const cost = costOfCall(
      {
        llmPromptTokens: Number.NaN,
        llmCompletionTokens: -500,
        sttAudioDurationMs: Number.POSITIVE_INFINITY,
        ttsCharactersCount: undefined,
        durationSec: 60,
      },
      RATES,
    );
    expect(Number.isFinite(cost.totalMilliAgorot)).toBe(true);
    expect(cost.totalMilliAgorot).toBe(MILLI_AGOROT_PER_USD * 0.03);
  });

  it('rounds per component, at the end, so a short call is not rounded to nothing', () => {
    // Milli-agorot exist for this: a 30-second call is a fraction of an agora, and rounding to
    // agorot per call would floor most calls to zero and report the month as free.
    const cost = costOfCall({ durationSec: 30 }, RATES);
    expect(cost.platformMilliAgorot).toBe(Math.round(0.5 * 0.03 * MILLI_AGOROT_PER_USD));
    expect(cost.platformMilliAgorot).toBeGreaterThan(0);
  });

  it('uses the real rate card by default and produces a plausible per-minute cost', () => {
    // Not a rate assertion — a SANITY assertion. `docs/gtm/pricing-model.md` prices every package
    // against a $0.12/min ceiling. If a typo ever puts the estimate an order of magnitude either
    // side of that, the margin figures built on it are worthless and this catches it.
    const oneMinute = costOfCall({
      llmPromptTokens: 8_000,
      llmPromptCachedTokens: 6_000,
      llmCompletionTokens: 400,
      sttAudioDurationMs: 60_000,
      ttsCharactersCount: 600,
      durationSec: 60,
    });
    const usdPerMinute = oneMinute.totalMilliAgorot / 100_000 / RATE_CARD.ilsPerUsd;
    expect(usdPerMinute).toBeGreaterThan(0.005);
    expect(usdPerMinute).toBeLessThan(0.5);
  });
});

describe('readUsageSummary', () => {
  it('reads the shape LiveKit sends today', () => {
    const parsed = readUsageSummary(
      { llmPromptTokens: 100, llmPromptCachedTokens: 50, llmCompletionTokens: 20, ttsCharactersCount: 300, sttAudioDurationMs: 4000 },
      42,
    );
    expect(parsed).toEqual({
      llmPromptTokens: 100,
      llmPromptCachedTokens: 50,
      llmCompletionTokens: 20,
      ttsCharactersCount: 300,
      sttAudioDurationMs: 4000,
      durationSec: 42,
    });
  });

  it('unwraps a nested `usage` property, since the event is sometimes the wrapper', () => {
    const parsed = readUsageSummary({ usage: { llmPromptTokens: 7 } });
    expect(parsed.llmPromptTokens).toBe(7);
  });

  it('degrades to zeros on an unrecognised shape rather than throwing', () => {
    // `UsageSummary` is already marked @deprecated in the installed SDK in favour of per-model
    // collectors, so a shape change is a matter of when. This runs inside a shutdown handler:
    // throwing here would take the call report and the call_learnings row with it.
    for (const junk of [null, undefined, 'nonsense', 42, [], { totally: { different: true } }]) {
      const parsed = readUsageSummary(junk);
      expect(costOfCall(parsed).totalMilliAgorot).toBe(0);
    }
  });
});

describe('formatMilliAgorot', () => {
  it('renders shekels for humans', () => {
    expect(formatMilliAgorot(100_000)).toBe('₪1.00');
    expect(formatMilliAgorot(123_456)).toBe('₪1.23');
    expect(formatMilliAgorot(0)).toBe('₪0.00');
  });
});
