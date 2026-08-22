import { DEFAULT_KNOWLEDGE_TOKEN_BUDGET } from './knowledge-injector.js';
/**
 * Reads `tenants.settings.knowledge_base` for the voice agent.
 *
 * Defensive by construction: this key is operator-editable JSON, so every field is validated and a
 * malformed value falls back to OFF rather than to a default that would silently start injecting
 * knowledge into live calls. "Absent or broken → disabled" is the only safe direction here.
 */

export interface KnowledgeBaseSettings {
  enabled: boolean;
  topK: number;
  minScore: number;
  /**
   * Per-turn token budget for the rolling knowledge slot (R2.1).
   *
   * Clamped like `topK`, and for the same reason: this is operator-editable JSON, and the failure it
   * guards against is a large number quietly restoring the unbounded context R2.1 exists to fix.
   */
  maxTokens: number;
}

/** Matches RetrievalService's own defaults — three chunks of ~250 tokens is the per-turn budget. */
/**
 * Ceiling on the slot budget. 4,000 tokens is four times the default and well past the point where a
 * voice turn benefits from more context; above it is a misconfiguration, not a choice.
 */
const MAX_SLOT_TOKENS = 4000;

const DEFAULT_TOP_K = 3;
const DEFAULT_MIN_SCORE = 0.3;

/** Above this, a "top_k" stops being a focused answer and becomes the prompt-stuffing RAG replaced. */
const MAX_TOP_K = 8;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function readKnowledgeSettings(settings: unknown): KnowledgeBaseSettings {
  const off: KnowledgeBaseSettings = {
    enabled: false,
    topK: DEFAULT_TOP_K,
    minScore: DEFAULT_MIN_SCORE,
    maxTokens: DEFAULT_KNOWLEDGE_TOKEN_BUDGET,
  };
  if (!settings || typeof settings !== 'object') return off;

  const raw = (settings as Record<string, unknown>)['knowledge_base'];
  if (!raw || typeof raw !== 'object') return off;

  const kb = raw as Record<string, unknown>;
  // Strictly `=== true`. A truthy string ("false"!) or a 1 must not enable this.
  if (kb['enabled'] !== true) return off;

  return {
    enabled: true,
    topK: Math.round(clampNumber(kb['top_k'], DEFAULT_TOP_K, 1, MAX_TOP_K)),
    minScore: clampNumber(kb['min_score'], DEFAULT_MIN_SCORE, 0, 1),
    maxTokens: Math.round(clampNumber(kb['max_tokens'], DEFAULT_KNOWLEDGE_TOKEN_BUDGET, 100, MAX_SLOT_TOKENS)),
  };
}
