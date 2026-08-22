import { type Tiktoken, getEncoding } from 'js-tiktoken';

/**
 * One token estimator, shared by ingestion and the voice hot path.
 *
 * It was previously private to `chunker.ts`. It moved here when the R2.1 context diet needed the same
 * count at CALL time — to size the per-turn knowledge slot against a budget, and to report how large
 * the whole context has grown. Two estimators would eventually disagree, and the disagreement would
 * show up as a slot that fits at ingest and overflows at call time.
 *
 * `cl100k_base` is not gpt-5.4's tokenizer. That is deliberate and it is fine: this sizes budgets, it
 * does not bill anyone. It is also CONSERVATIVE for our case — Hebrew fragments into more tokens under
 * cl100k than under newer vocabularies, so a slot that fits here fits in the real request too.
 *
 * ⚠️ DO NOT CALL THIS ON RETRIEVED CHUNKS DURING A CALL. Chunks carry `tokenCount` from ingest
 * (`knowledge_chunks.token_count`), and the retrieval query selects it precisely so the voice path
 * spends no CPU re-tokenizing text whose size is already known. This function is for text that has no
 * stored count — the assembled context, a one-off block.
 */
let encoder: Tiktoken | null = null;

/** Loaded once and memoised: constructing it parses a sizeable ranks table. */
export function countTokens(text: string): number {
  encoder ??= getEncoding('cl100k_base');
  return encoder.encode(text).length;
}
