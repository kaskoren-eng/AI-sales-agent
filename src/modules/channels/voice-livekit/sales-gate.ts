/**
 * GATE A — she does not describe the product until she has discovered three things.
 *
 * THE CALL THIS EXISTS TO FIX (Koren, 2026-09-01 09:29, live PSTN):
 *
 *      68s  lead   "15"                                             <- volume, given freely
 *      97s  lead   "יש לנו המון שיחות. זה שואב לי זמן."              <- the pain, handed over
 *     104s  KEREN  "אוף.. זה באמת שואב. כן, בדיוק בשביל זה זה קיים."
 *     121s  KEREN  "אנחנו בונים סוכני AI לקול ולוואטסאפ. הם עונים…"   <- the generic feature list
 *
 * Both facts were already hers. Nothing was missing from her memory. What was missing was the
 * rule that says to USE them — which is why this is a gate and not a paragraph of advice. Advice
 * about pain deepening would have been just as true on that call, and just as unused.
 *
 * ── Why code and not a prompt line ────────────────────────────────────────────────────────────
 *
 * The same reason `fact-memory.ts` exists. The prompt already said to qualify before pitching, in
 * several places, on the call above. Prompt instructions degrade under context load; a note
 * appended at the tail of the turn does not. The prompt half is `SALES_GATE` in
 * system-prompt.he.ts and both halves move on `VOICE_SALES_MODEL_ENABLED` together.
 *
 * ── What this deliberately does NOT do ────────────────────────────────────────────────────────
 *
 * It does not block, rewrite, or delete anything she says. A guard that silenced a product
 * sentence would leave the caller listening to a gap in the middle of an answer, and the honest
 * response to "what do you do?" before the gate opens is ONE sentence — not silence. So the
 * enforcement is a note that names the missing fact, plus a counter on the call report
 * (`gateAViolations`) that makes the rule falsifiable.
 *
 * That counter is not optional bookkeeping. This repo has now had three separate metrics stay
 * green through the exact defect they existed to catch — `repeatedPhraseCount` on 2026-08-30,
 * `duplicateReplies` on the 09:29 call, and the repeat counter generally. A gate with no counter
 * would be the fourth, and nobody would know for a month.
 */

/** The three facts that open the gate. Ordered as she asks for them. */
export const GATE_FACTS = ['business', 'process', 'pain'] as const;
export type GateFact = (typeof GATE_FACTS)[number];

/** What each missing fact is called in the note — her words, not the field name. */
const FACT_LABEL: Record<GateFact, string> = {
  business: 'what his business actually does',
  process: 'who answers his enquiries today and how fast',
  pain: 'the one thing HE said is not working',
};

/** The question to ask next, when that fact is the one missing. */
const FACT_ASK: Record<GateFact, string> = {
  business: 'Ask what his business does.',
  process: 'Ask who answers enquiries today and how fast — one sentence, one question mark.',
  pain: 'Ask what frustrates him most about it, then make it cost him something.',
};

/**
 * Does this text describe the product?
 *
 * Deliberately UNDER-inclusive, and the asymmetry is the design. A false positive tells her to
 * stop doing something she was right to do, mid-call, and that is worse than a missed count: the
 * note is advice she will follow. So the patterns match only the shape that actually went wrong —
 * a first-person-plural claim about what we build or what the agent does — and not the honest one
 * sentence the prompt explicitly permits when he asks early.
 *
 * "אנחנו בונים" is the exact opening of the 121s sentence above.
 *
 * NO `\b` ANCHORS. Hebrew letters are not `\w`, so `\bאנחנו` can never match at the start of a
 * sentence — it demands a word character before a class that contains none. Every pattern here
 * silently matched nothing until the tests caught it. `register-tracker.ts` already carries this
 * scar ("substring, not `\b`, because Hebrew glues prefixes"); it is worth writing down twice,
 * because a guard that matches nothing looks exactly like a guard that works.
 */
const PRODUCT_CLAIM = [
  /אנחנו\s+(בונים|מפתחים|מקימים|מספקים|עושים)/u,
  /ה?סוכן\s+(עונה|מתחבר|מטפל|קובע|אוסף|מסנן)/u,
  /ה?מערכת\s+(עונה|מתחברת|מטפלת|קובעת|אוספת|מסננת)/u,
  /סוכני\s+AI/u,
  /יש\s+(גם\s+)?דשבורד/u,
];

/** Is this sentence a question? A question that mentions the product is discovery, not a pitch. */
const ASKS = /\?/u;

export function describesProduct(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (ASKS.test(trimmed)) return false;
  return PRODUCT_CLAIM.some((re) => re.test(trimmed));
}

/**
 * The gate for one call.
 *
 * Facts are established from `capture_lead_info`, the same source of truth the rest of the call
 * uses — never from her own speech. A fact she claimed and the tool never recorded is a fact the
 * CRM will not have either, and the gate should agree with the CRM.
 */
export class SalesGate {
  readonly #known = new Set<GateFact>();
  #violations = 0;
  #notedMissing: string | null = null;

  /** Record a fact as discovered. Idempotent; a fact never becomes un-known. */
  establish(fact: GateFact): void {
    this.#known.add(fact);
  }

  /** Facts still missing, in ask order — so the note names the one she should ask next. */
  get missing(): GateFact[] {
    return GATE_FACTS.filter((f) => !this.#known.has(f));
  }

  get isOpen(): boolean {
    return this.missing.length === 0;
  }

  /** How many times she described the product before the gate opened. Read by the call report. */
  get violations(): number {
    return this.#violations;
  }

  /**
   * Observe something she actually said. Counts a violation when the gate is shut.
   *
   * Called with her COMMITTED utterances, not drafts — a sentence that was generated and then
   * thrown away by preemptive generation was never heard by anybody, and counting it would
   * inflate the metric in exactly the direction that makes it useless.
   */
  observeAgentSpeech(text: string): void {
    if (this.isOpen) return;
    if (describesProduct(text)) this.#violations += 1;
  }

  /**
   * The advisory line, or null when nothing has changed since the last one.
   *
   * Says what to DO and names ONE missing fact — the next one to ask for. A note listing all
   * three reads as a checklist and gets answered as a checklist, which is the questionnaire
   * failure this whole model exists to undo.
   */
  note(): string | null {
    if (this.isOpen) {
      if (this.#notedMissing === 'open') return null;
      this.#notedMissing = 'open';
      return (
        '[Discovery — automatic] You now have his business, his current process and his pain. ' +
        'You may describe what we do — one sentence, tied to the pain he named, then ask how it ' +
        'sounds to him.'
      );
    }
    const missing = this.missing;
    const key = missing.join(',');
    if (key === this.#notedMissing) return null;
    this.#notedMissing = key;
    const next = missing[0]!;
    const rest =
      missing.length > 1
        ? ` Still missing after that: ${missing.slice(1).map((f) => FACT_LABEL[f]).join(', ')}.`
        : '';
    return (
      `[Discovery — automatic] You do not yet know ${FACT_LABEL[next]}. ` +
      `Do NOT describe the product yet — if he asks, ONE sentence, then a question back. ` +
      `${FACT_ASK[next]}${rest}`
    );
  }
}
