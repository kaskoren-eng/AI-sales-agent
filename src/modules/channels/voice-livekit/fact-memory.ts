/**
 * WHAT SHE ALREADY KNOWS, AND WHAT SHE HAS ALREADY ASKED — the call's identity memory.
 *
 * THE CALL THIS EXISTS TO FIX (Koren, 2026-08-29 18:30, live PSTN):
 *
 *     16490  KEREN  "אהה. קודם כל — איך קוראים לךָ?"
 *     28895  KEREN  "… רק שאדע עם מי אני מדברת?"
 *     42176  KEREN  "… איך קוראים לךָ?"
 *     47019  lead   "אם דיברנו על זה כבר, קרן, אני קורן"      <- "we already covered this"
 *     54149  KEREN  "אוקיי. נעים מאוד, קורן."
 *     103531 lead   "טל, אוזן"                                 <- STT garbage, not a name
 *     109172 KEREN  "נעים מאוד, טל."                           <- she renamed the lead
 *
 * Two failures, one cause: nothing in the pipeline held the difference between a fact we HAVE and
 * a fact we WANT. So the same question could be asked a third time, and a bare noun in a garbled
 * turn could overwrite a name the caller had stated plainly and she had acknowledged.
 *
 * ── Why code and not a prompt line ────────────────────────────────────────────────────────────
 *
 * The prompt already said "if he already gave it at the start, just confirm it". It said that
 * during the call above. Prompt instructions degrade under context load — the same lesson that
 * produced the phrase ledger (prompt = guidance, code = enforcement). This is the enforcement
 * half; the prompt half lives in system-prompt.he.ts under "Call Memory".
 *
 * ── The asymmetry, which is the whole design ──────────────────────────────────────────────────
 *
 * SETTING a fact is cheap: the model calls capture_lead_info and we believe it. REPLACING an
 * established identity is not, and must not be, the same act:
 *
 *   - An identity is spoken aloud, constantly, from the moment it is learned. A wrong one is
 *     heard by the caller within seconds and cannot be taken back.
 *   - A wrong budget or timeline is silent bookkeeping. It is corrected by the next tool call and
 *     nobody hears it. So qualification fields stay freely overwritable — "call it again whenever
 *     a fact changes" is the right rule THERE.
 *   - The DB already refused the rename (`upsertLead` coalesces and never blanks), so the tool
 *     accepting it produced the worst of both worlds: the CRM kept קורן while she called him טל.
 *
 * So: name / phone / email may be ENRICHED (קורן → קורן שטרית) but never REPLACED, unless the
 * model explicitly asserts the lead corrected it (`is_correction`). A bare noun in a noisy turn
 * is not an explicit correction, which is exactly the property we needed.
 */

/** The facts worth remembering that we ask direct questions about. */
export type FactField = 'name' | 'phone' | 'email' | 'business';

/** The three that are the lead's IDENTITY — the ones that are hard to overwrite. */
export const IDENTITY_FIELDS = ['name', 'phone', 'email'] as const;
export type IdentityField = (typeof IDENTITY_FIELDS)[number];

/** How many times she may ask for one fact before the note tells her to stop and move on. */
export const MAX_ASKS_PER_FACT = 2;

const NIQQUD = /[֑-ׇ]/gu;

/** Comparison form: niqqud, punctuation and case are not part of "is this the same name". */
function normalize(value: string): string {
  return value
    .replace(NIQQUD, '')
    .replace(/[.,!?…׃:;()"'«»״׳-]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

/**
 * Is `offered` the same identity as `established`, only fuller?
 *
 * "קורן" → "קורן שטרית" is a person giving his surname, not a different person, and refusing it
 * would make the guard block the very thing Step 4 asks her to collect ("full name"). Token
 * containment in EITHER direction counts: a model that shortens "קורן שטרית" to "קורן" has also
 * not renamed anybody.
 */
function isEnrichment(established: string, offered: string): boolean {
  const a = normalize(established).split(' ').filter(Boolean);
  const b = normalize(offered).split(' ').filter(Boolean);
  if (a.length === 0 || b.length === 0) return false;
  const [shortSide, longSide] = a.length <= b.length ? [a, b] : [b, a];
  return shortSide.every((token) => longSide.includes(token));
}

/**
 * The Hebrew she actually says when she asks for each fact.
 *
 * Matched against her COMMITTED utterances, so this reads what was really spoken rather than
 * trying to predict what the model intends to say. Every pattern below is lifted from the
 * prompt's own example phrasings (Step 2's name bank, Step 4's collection script) plus the three
 * variants she improvised on the 2026-08-29 call — which is the point: the bank is examples, she
 * varies them, and a detector built only from the bank would have missed two of her three asks.
 *
 * Deliberately UNDER-inclusive on `business`: "מה אתה מוכר" is also how she asks a follow-up about
 * a product she already knows about, and a false "you already asked this" is worse than a missed
 * one — it would silence a legitimate question.
 */
const ASK_PATTERNS: Record<FactField, RegExp[]> = {
  name: [
    /איך\s+קוראים\s+ל/u,
    /מה\s+ה?שם(\s+המלא)?/u,
    /מה\s+שמ(ך|ךָ|ך\?)/u,
    /עם\s+מי\s+אני\s+מדבר(ת)?/u,
    /לא\s+תפסתי\s+את\s+ה?שם/u,
    /רק\s+שאדע.{0,20}(שם|מי)/u,
    /אפשר\s+לדעת\s+עם\s+מי/u,
  ],
  phone: [/מספר\s+ה?טלפון/u, /מה\s+ה?טלפון/u, /מספר\s+ל?חזור/u],
  email: [/כתובת\s+ה?מייל/u, /מה\s+ה?מייל/u, /ה?אימייל/u],
  business: [/איזה\s+(סוג\s+)?עסק/u, /במה\s+אתה\s+עוסק/u, /מה\s+ה?עסק\s+של(ך|ךָ)/u],
};

/** English labels for the note — the note is read by the model, whose instructions are English. */
const FIELD_LABEL: Record<FactField, string> = {
  name: "the lead's name",
  phone: 'his phone number',
  email: 'his email address',
  business: 'what his business is',
};

export interface CaptureVerdict {
  /** The identity values that may be written, after the guard. */
  accepted: { name?: string; email?: string; phone?: string };
  /** Values refused because they would have REPLACED an established identity. */
  refused: Array<{ field: IdentityField; kept: string; offered: string }>;
}

export class FactMemory {
  readonly #known = new Map<FactField, string>();
  readonly #asks = new Map<FactField, number>();
  /** Committed utterances already counted, so the preemptive-draft echo cannot double-count an
   * ask. Same 20s rule and the same reason as PhraseLedger.observe / CallReport.recordTranscript. */
  #seen: Array<{ text: string; at: number }> = [];

  /** What we hold for a field, or null. */
  get(field: FactField): string | null {
    return this.#known.get(field) ?? null;
  }

  /** How many times she has asked for it on this call. */
  asks(field: FactField): number {
    return this.#asks.get(field) ?? 0;
  }

  /** Everything established so far — for the note, and for tests. */
  snapshot(): Partial<Record<FactField, string>> {
    return Object.fromEntries(this.#known) as Partial<Record<FactField, string>>;
  }

  /** Records a fact as established. Blank values never erase what we hold (coalesce, don't blank). */
  establish(field: FactField, value: string | null | undefined): void {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) return;
    this.#known.set(field, trimmed);
  }

  /**
   * One committed agent utterance — counts the questions inside it.
   *
   * At most ONE ask per field per utterance: "רק שאדע, איך קוראים לך?" matches two name patterns
   * and is still one question.
   */
  observeAgentUtterance(text: string, at: number = Date.now()): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.#seen.some((s) => s.text === trimmed && at - s.at < 20_000)) return;
    this.#seen.push({ text: trimmed, at });

    for (const [field, patterns] of Object.entries(ASK_PATTERNS) as Array<[FactField, RegExp[]]>) {
      if (patterns.some((p) => p.test(trimmed))) {
        this.#asks.set(field, this.asks(field) + 1);
      }
    }
  }

  /**
   * May capture_lead_info write these identity values?
   *
   * Enrichment yes, replacement no — see the header. `isCorrection` is the model asserting that
   * the LEAD corrected the value out loud; only that unlocks a replacement, and it also
   * re-establishes the new value so a second garbled turn cannot walk it back again.
   */
  guardIdentity(
    offered: { name?: string | null; email?: string | null; phone?: string | null },
    isCorrection: boolean,
  ): CaptureVerdict {
    const accepted: CaptureVerdict['accepted'] = {};
    const refused: CaptureVerdict['refused'] = [];

    for (const field of IDENTITY_FIELDS) {
      const raw = offered[field];
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value) continue;

      const held = this.#known.get(field);
      if (!held || normalize(held) === normalize(value) || isEnrichment(held, value) || isCorrection) {
        accepted[field] = value;
        this.establish(field, value);
        continue;
      }
      refused.push({ field, kept: held, offered: value });
    }

    return { accepted, refused };
  }

  /**
   * The turn-boundary reminder, or null when there is nothing worth spending tokens on.
   *
   * Two jobs, one note: stop asking for what you have, and stop asking for what he will not give.
   * It is APPENDED at the tail like the phrase note, never folded into the instructions — the
   * prompt-cache prefix must not move (see injectCoachNote in agent.ts).
   */
  note(): string | null {
    const known = [...this.#known.entries()].map(
      ([field, value]) => `${FIELD_LABEL[field]} = «${value}»`,
    );
    const exhausted = (Object.keys(ASK_PATTERNS) as FactField[]).filter(
      (field) => !this.#known.has(field) && this.asks(field) >= MAX_ASKS_PER_FACT,
    );
    if (known.length === 0 && exhausted.length === 0) return null;

    const parts = ['[Call memory — automatic reminder]'];
    if (known.length > 0) {
      parts.push(
        `Already established on this call: ${known.join('; ')}. Do NOT ask for any of these ` +
          'again — you already have them, use them. Treat an established name as settled: only ' +
          'change it if the lead explicitly corrects you out loud.',
      );
    }
    if (exhausted.length > 0) {
      parts.push(
        `You have already asked ${MAX_ASKS_PER_FACT}+ times for: ` +
          `${exhausted.map((f) => FIELD_LABEL[f]).join(', ')}. Do not ask again — asking a third ` +
          'time is the moment a caller decides he is talking to a machine. Continue without it.',
      );
    }
    return parts.join(' ');
  }
}
