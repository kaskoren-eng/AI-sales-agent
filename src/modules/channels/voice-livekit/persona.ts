/**
 * WHO THE AGENT IS, as data.
 *
 * The agent's identity used to be four hardcoded strings scattered across two files: the name and
 * company in the prompt's Role section, the Hebrew gender inflections in the Gender note, a founder
 * FAQ naming Koren, and `GREETING_HE`. That is fine for exactly one customer. It is a product
 * defect the moment there are two, because tenant #2's leads get greeted as "קרן from ClickScales"
 * and told that Koren will run their demo.
 *
 * CLAUDE.md makes this non-optional: every tenant names their own agent at onboarding, and
 * "KEREN" is ClickScales' own agent, not the product.
 *
 * ── The safety property this file is built around ──────────────────────────────────────────────
 *
 * `DEFAULT_PERSONA` reproduces today's hardcoded strings EXACTLY, as data. Every renderer is
 * written so that rendering `DEFAULT_PERSONA` yields byte-for-byte what the prompt contained
 * before this file existed, and `system-prompt.persona.test.ts` asserts precisely that.
 *
 * That equality is what makes this safe to ship. The Hebrew in the prompt is Koren's, tuned by ear
 * over months of real calls; the risk in parameterising it is not that customer #2 gets it wrong,
 * it is that customer #1 silently gets something slightly different and nobody hears it until a
 * lead does. So customer #1 runs the identical prompt, proven by test, and only a tenant who has
 * actually configured a persona takes the new path.
 *
 * Contract mirrors `readBusinessProfile`: pure, total, never throws, `unknown` in.
 */

/**
 * Hebrew inflects the speaker's gender into almost every sentence about themselves, so this one
 * field drives the prompt's grammar rules AND the greeting verb. They were separate before, which
 * is exactly how a female voice ends up delivering a masculine opening line — the two places to
 * change were never obviously the same decision.
 */
export type AgentGender = 'female' | 'male';

export interface PersonaFaqEntry {
  /** English label for the question, as it appears in the prompt's FAQ table. */
  topic: string;
  /** The answer, verbatim, in the language the agent speaks. */
  answer: string;
}

/**
 * Per-tenant voice. OPERATOR-MANAGED (see `settings-policy.ts`): a wrong `voiceId` is not a
 * cosmetic mistake, it is a silent empty audio stream on a live call — Cartesia and ElevenLabs
 * both fail that way rather than erroring. Tenants pick a voice by asking; they cannot type an id.
 */
export interface PersonaTts {
  provider?: 'cartesia' | 'deepdub' | 'elevenlabs';
  voiceId?: string;
  speed?: number;
  volume?: number;
}

export interface AgentPersona {
  /** What leads hear. Hebrew, usually. */
  agentName: string;
  /** Latin transliteration, rendered as "name (Latin)" in the prompt. Empty → name alone. */
  agentNameLatin: string;
  agentGender: AgentGender;
  companyName: string;
  /** The appositive after the company name: "an Israeli agency that builds…". Empty → omitted. */
  companyDescription: string;
  /** The human the demo is with. Empty → the prompt stops promising a named person. */
  handoffPerson: string;
  /** Free-text opening line. Empty → generated from name + company + gender by `buildGreeting`. */
  greeting: string;
  faq: PersonaFaqEntry[];
  /**
   * A paragraph disambiguating the agent's name from the handoff person's.
   *
   * This exists because "קרן" (the agent) and "קורן" (the founder) are one letter apart in Hebrew
   * and indistinguishable down an 8kHz phone line — a real failure on a real call. It is a field
   * rather than generated prose because whether two names are confusable is a judgement about
   * those specific names, and a generated version would either fire for every tenant or none.
   */
  nameDisambiguation: string;
  /**
   * How she answers the "an AI can't really do this job" objection (prompt Step 3).
   *
   * ClickScales' answer is a claim about ClickScales' product. Empty → a generic form that is true
   * for any tenant. Rendered as the middle of a sentence: "If you sense a mindset objection, ___
   * before treating it as a disqualifier."
   */
  mindsetRebuttal: string;
  tts: PersonaTts | null;
}

/** Used when a tenant has no rebuttal of their own — true regardless of what they sell. */
export const GENERIC_MINDSET_REBUTTAL = 'address it once using the relevant FAQ answer';

/**
 * ClickScales' own agent — today's hardcoded strings, moved here unchanged.
 *
 * Do not "tidy" any string in this object. Each one is asserted byte-for-byte against the prompt
 * this file replaced; an improvement to the wording is a change to the live agent's script and
 * belongs in a commit that says so.
 */
export const DEFAULT_PERSONA: AgentPersona = {
  agentName: 'קרן',
  agentNameLatin: 'Keren',
  agentGender: 'female',
  companyName: 'ClickScales',
  companyDescription:
    'an Israeli agency that builds AI voice and WhatsApp sales agents for small and medium businesses',
  handoffPerson: 'קורן',
  // Discloses that she is an AI, in the opening line. See buildGreeting's header: this was measured
  // as NOT SAID on 10 of 10 real calls while it was merely a prompt instruction. The wording is the
  // smallest change to Koren's tuned greeting that carries it — "מ-ClickScales" became
  // "העוזרת הדיגיטלית של ClickScales", four extra syllables, same rhythm.
  //
  // ── THE TWO COMMAS ARE GONE, BY HIS EAR (round 13, card `g1`, 2026-08-31) ────────────────────
  //
  // Three variants of this exact sentence were synthesized on sonic-3.5 at the production speed and
  // played to him: A with today's two commas, B with none, C with none AND the mid-sentence full
  // stop replaced by an em-dash. **He chose B** — no commas, and the full stop KEPT.
  //
  // Not one word changed. This is the first line of every inbound call and it is Koren's own tuned
  // Hebrew; the edit is two commas, and it is his, not ours. It is also the first time the greeting
  // fixture has moved: `__fixtures__/greeting-default.txt` was regenerated in the same commit for
  // this reason and no other, and `system-prompt.persona.test.ts` pins the new bytes.
  //
  // WHY IT SOUNDS BETTER, measured rather than guessed: on sonic-3.5 a comma buys about 0.18s and
  // can vanish once the text is streamed, while a full stop survives every time. Two commas in a
  // ten-word sentence are therefore two pauses that may or may not arrive — which is exactly the
  // "רובוטי" reading he keeps giving this line. The full stop in the middle stays because it is the
  // one pause that reliably lands.
  greeting: 'שלום מדברת קרן העוזרת הדיגיטלית של ClickScales. איך אני יכולה לעזור?',
  faq: [
    {
      topic: 'Does the agent sound robotic?',
      answer: 'לא, אנחנו בונים סוכנים שמדברים ונשמעים כמו בני אדם ממש - לא תסריט קבוע.',
    },
    {
      topic: "What if the agent doesn't know an answer?",
      answer: 'הסוכן יגיד בכנות שאין לו את המידע הדרוש כדי לענות על השאלה הזו.',
    },
    {
      topic: 'How long does setup take?',
      answer:
        'ההקמה לוקחת שבוע עד שבועיים. התהליך כולל onboarding מותאם אישית שמתחיל בהבנת הצרכים והרכיבים של העסק שלך, ומסתיים בבניית סוכן ייעודי בשבילך.',
    },
    {
      topic: 'Does it connect to a CRM?',
      answer: 'כן, הסוכן מתחבר ל-CRM שלך ומגיע גם עם דשבורד מלא לצפייה בכל השיחות והלידים.',
    },
    {
      topic: 'What about privacy and data?',
      answer: 'הסוכן נבנה רק על סמך המידע שאתה בוחר לחשוף לו - אתה קובע כמה ואיזה מידע הוא רואה.',
    },
    {
      topic: 'Who will the demo be with? / Who is Koren?',
      answer: 'קורן הוא המייסד של ClickScales, והוא זה שיעביר את הדמו.',
    },
  ],
  mindsetRebuttal:
    'address it once (e.g. explain that ClickScales builds agents that sound and act human, per the FAQ answer)',
  nameDisambiguation:
    '**קרן is you. קורן is the founder.** They are one letter apart in Hebrew and nearly identical on a phone line, so be explicit. You are קרן, the AI agent. קורן (with a vav) is a person — the founder — and he is who the demo is with. If the lead asks to speak to קורן, he means the founder, not you. When the lead asks "עם מי תהיה השיחה?", the answer is קורן — never say you do not know.',
  tts: null,
};

/**
 * The Hebrew that changes with the agent's gender.
 *
 * Both the prompt's grammar rules and the greeting verb read from here, which is the entire point:
 * one setting, one table, no way to set a female voice and a masculine greeting.
 */
const GENDER_FORMS: Record<AgentGender, {
  english: string;
  forms: string;
  selfExamples: string;
  selfList: string;
  /** "מדברת" / "מדבר" — the greeting's first verb. */
  speaking: string;
  /** "יכולה" / "יכול" — "how can I help". */
  can: string;
  /**
   * "העוזרת הדיגיטלית" / "העוזר הדיגיטלי" — the AI disclosure, inside the greeting.
   *
   * The disclosure lives in the GREETING rather than in a prompt instruction because a model can
   * skip an instruction and a spoken line cannot. See `compliance/ai-disclosure.ts`.
   */
  digitalAssistant: string;
}> = {
  female: {
    english: 'female',
    forms: 'feminine',
    selfExamples: '"אני שמחה", "מצטערת", "אני יכולה", "אני סוכנת"',
    selfList: 'feminine singular: "אני יכולה", "מצטערת", "אני סוכנת"',
    speaking: 'מדברת',
    can: 'יכולה',
    digitalAssistant: 'העוזרת הדיגיטלית',
  },
  male: {
    english: 'male',
    forms: 'masculine',
    selfExamples: '"אני שמח", "מצטער", "אני יכול", "אני סוכן"',
    selfList: 'masculine singular: "אני יכול", "מצטער", "אני סוכן"',
    speaking: 'מדבר',
    can: 'יכול',
    digitalAssistant: 'העוזר הדיגיטלי',
  },
};

/**
 * The prompt's Role section — who she is, who she works for, and the three-way Hebrew gender rule.
 *
 * The gender rule is not decoration. Hebrew inflects three different persons in the same sentence
 * (herself, the company, the lead) and gpt-5.4 holds all three only because it is told to; a
 * cheaper model tested here broke them within one call. Keep the instruction, vary only the forms.
 */
export function renderIdentity(persona: AgentPersona): string {
  const g = GENDER_FORMS[persona.agentGender];
  const name = persona.agentNameLatin
    ? `**${persona.agentName} (${persona.agentNameLatin})**`
    : `**${persona.agentName}**`;
  const description = persona.companyDescription ? `, ${persona.companyDescription}` : '';

  return `You are ${name}, an AI sales representative for **${persona.companyName}**${description}. Your job is to run first-touch sales calls with leads: introduce yourself and ${persona.companyName}, ask discovery questions to qualify the lead, answer questions about the product, and book a demo call for qualified leads.

**Gender note (critical for Hebrew grammar):** You are ${g.english}. All first-person verbs, adjectives, and possessives about yourself use ${g.forms} forms (e.g. ${g.selfExamples}). When speaking on behalf of ${persona.companyName} as a company, use masculine plural ("אנחנו בונים", "אנחנו מציעים", "נשמח לדבר") — this is standard Hebrew business voice regardless of the speaker's gender.

**Addressing the LEAD:** The lead's gender is HIS, not yours. Most leads are men — address the lead in the MASCULINE unless you know otherwise ("אתה רוצה", "תוכל", "אתה מנהל"). Write natural Hebrew; do not avoid any word.

Three genders, three different persons, and you must not mix them up:
- **Yourself** — ${g.selfList}
- **${persona.companyName}** — masculine plural: "אנחנו בונים", "אנחנו מציעים"
- **The lead** — HIS gender, not yours`;
}

/** The FAQ table plus, when the tenant has one, the name-disambiguation paragraph. */
export function renderFaq(persona: AgentPersona): string {
  const rows = persona.faq
    .filter((entry) => entry.topic.trim().length > 0 && entry.answer.trim().length > 0)
    .map((entry) => `| ${entry.topic.trim()} | ${entry.answer.trim()} |`);

  const table = ['| Question Topic | Answer |', '|---|---|', ...rows].join('\n');
  const disambiguation = persona.nameDisambiguation.trim();
  return disambiguation ? `${table}\n\n${disambiguation}` : table;
}

/**
 * The opening line, spoken verbatim before the LLM's first turn.
 *
 * An explicit `greeting` wins — a tenant who wrote their own line means it. Otherwise it is
 * generated from name, company and gender, which is what keeps a male agent from opening with
 * "מדברת".
 *
 * ── EVERY GREETING DISCLOSES THAT SHE IS AN AI ────────────────────────────────────────────────
 *
 * `docs/risk/measured-findings-from-call-reports.md` measured the disclosure as NOT SPOKEN on 10
 * of 10 real calls. The machinery was all there — a detector, a report field, an end-of-call
 * instruction — and it faithfully recorded its own 100% failure rate, because the disclosure was
 * only ever a request to the model: say this in your goodbye. When nobody asked, nothing said it.
 *
 * So it moved here, into the one line that is not generated but SPOKEN VERBATIM. A model can skip
 * an instruction; `session.say()` cannot. That is the whole fix, and it is why enforcement lives
 * in the greeting builder rather than in a validator: a validator guards one write path, while
 * every call on every code path goes through this function.
 *
 * The disclosure is also EARLY rather than at the goodbye, which is what the EU AI Act (Art. 50)
 * and California SB 1001 require and what the website's Voice-AI disclosure page already promises.
 * Israel has no statute yet, so this was defensible before; the exposure was the gap between the
 * published promise and the measurement.
 */
export function buildGreeting(persona: AgentPersona): string {
  const g = GENDER_FORMS[persona.agentGender];
  const explicit = persona.greeting.trim();
  if (!explicit) {
    // NO COMMAS — the same edit Koren made to the ClickScales greeting by ear on round-13 card
    // `g1`, applied to the template every OTHER tenant's agent opens with. It is literally the same
    // sentence with a different name in it, and his verdict was about the punctuation rather than
    // about the words: two commas in a ten-word line are two pauses that sonic-3.5 may or may not
    // deliver, while the full stop in the middle lands every time. Leaving them here would mean
    // ClickScales' agent sounds better than every other tenant's for no reason anybody could state.
    return `שלום ${g.speaking} ${persona.agentName} ${g.digitalAssistant} של ${persona.companyName}. איך אני ${g.can} לעזור?`;
  }

  // A tenant's own line is kept as written — unless it does not disclose, in which case one short
  // sentence is appended. Appending is deliberately visible and slightly blunt: the dashboard
  // preview renders exactly this, so a tenant who dislikes the seam can fold the disclosure into
  // their own wording and the appended sentence disappears. Silently rewriting their sentence
  // would be worse; silently omitting the disclosure is not an option.
  if (discloses(explicit)) return explicit;
  return `${explicit} אני ${g.digitalAssistant} של ${persona.companyName}.`;
}

/**
 * Does this text disclose that the speaker is an AI?
 *
 * Duplicated from `compliance/ai-disclosure.ts` rather than imported: that module belongs to the
 * voice runtime and importing it here would drag call-report types into the settings API, which
 * reads personas to render a preview. The two lists are pinned to each other by
 * `persona.disclosure.test.ts` — if they ever diverge, that test fails rather than a live call
 * silently going undisclosed.
 */
function discloses(text: string): boolean {
  return DISCLOSURE_PATTERNS.some((p) => p.test(text));
}

const DISCLOSURE_PATTERNS: RegExp[] = [
  /סוכנת\s+AI/u,
  /סוכן\s+AI/u,
  /עוזרת\s+ה?דיגיטלית/u,
  /עוזר\s+ה?דיגיטלי(?!ת)/u,
  /עוזרת\s+ה?אוטומטית/u,
  /עוזר\s+ה?אוטומטי(?!ת)/u,
  /סוכנת\s+ה?וירטואלית/u,
  /סוכן\s+ה?וירטואלי(?!ת)/u,
  /בינה\s+מלאכותית/u,
  /(?<![֐-׿])AI(?![֐-׿A-Za-z])\s+(של|מ)/u,
];

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function readFaq(value: unknown): PersonaFaqEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries = value
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    .map((row) => ({ topic: str(row.topic), answer: str(row.answer) }))
    .filter((entry) => entry.topic.length > 0 && entry.answer.length > 0);
  // An empty array is a real choice ("this tenant has no FAQ"); a malformed one is not.
  return entries.length === value.length ? entries : entries.length > 0 ? entries : null;
}

function readTts(value: unknown): PersonaTts | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const provider = str(raw.provider);
  const voiceId = str(raw.voiceId);
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const tts: PersonaTts = {
    ...(provider === 'cartesia' || provider === 'deepdub' || provider === 'elevenlabs'
      ? { provider }
      : {}),
    ...(voiceId ? { voiceId } : {}),
    ...(num(raw.speed) !== undefined ? { speed: num(raw.speed) } : {}),
    ...(num(raw.volume) !== undefined ? { volume: num(raw.volume) } : {}),
  };
  return Object.keys(tts).length > 0 ? tts : null;
}

/**
 * Pulls the persona out of raw per-tenant settings, filling every unset field from
 * `DEFAULT_PERSONA`.
 *
 * FIELD-LEVEL fallback, not object-level, and the distinction matters: a tenant who sets only
 * `agentName` gets their name with sensible defaults, rather than a half-empty prompt.
 *
 * ── Which defaults are safe to inherit, and which are not ─────────────────────────────────────
 *
 * `DEFAULT_PERSONA` is not a neutral template — it is one specific company's script. Several of
 * its fields are ABOUT ClickScales, and inheriting those is how tenant #2's leads get told who
 * ClickScales' founder is. This was a real bug in the first version of this function, caught by
 * the leak test rather than by reading it: renaming the agent left the six-row FAQ intact,
 * including "קורן הוא המייסד של ClickScales".
 *
 * So each ClickScales-specific field is tied to the thing it actually describes:
 *
 *   the AGENT'S NAME  → `agentNameLatin`, `nameDisambiguation`
 *   the COMPANY       → `companyDescription`, `handoffPerson`, `faq`, `mindsetRebuttal`
 *
 * Change the name and the name-specific defaults drop. Change the company and the company-specific
 * ones do. ClickScales renaming its own agent keeps its own FAQ, which is the case a blanket
 * "any override drops everything" rule would have got wrong.
 */
export function readAgentPersona(settings: unknown): AgentPersona {
  if (!settings || typeof settings !== 'object') return DEFAULT_PERSONA;
  const raw = (settings as Record<string, unknown>).agent_persona;
  if (!raw || typeof raw !== 'object') return DEFAULT_PERSONA;
  const p = raw as Record<string, unknown>;

  const agentName = str(p.agentName) || DEFAULT_PERSONA.agentName;
  const companyName = str(p.companyName) || DEFAULT_PERSONA.companyName;
  const gender = p.agentGender === 'male' || p.agentGender === 'female' ? p.agentGender : null;

  const renamedAgent = agentName !== DEFAULT_PERSONA.agentName;
  const differentCompany = companyName !== DEFAULT_PERSONA.companyName;

  /** Inherit a ClickScales-specific default only while it is still ClickScales'. */
  const own = (value: string, fallback: string, isForeign: boolean): string =>
    value || (isForeign ? '' : fallback);

  return {
    agentName,
    agentNameLatin: own(str(p.agentNameLatin), DEFAULT_PERSONA.agentNameLatin, renamedAgent),
    agentGender: gender ?? DEFAULT_PERSONA.agentGender,
    companyName,
    companyDescription: own(str(p.companyDescription), DEFAULT_PERSONA.companyDescription, differentCompany),
    handoffPerson: own(str(p.handoffPerson), DEFAULT_PERSONA.handoffPerson, differentCompany),
    // Not inherited at all: a stale explicit greeting would out-rank a changed name or gender, so
    // the agent would keep introducing itself by the name the tenant just changed. Absent means
    // "generate it", which stays correct by construction.
    greeting: str(p.greeting),
    faq: readFaq(p.faq) ?? (differentCompany ? [] : DEFAULT_PERSONA.faq),
    nameDisambiguation: own(str(p.nameDisambiguation), DEFAULT_PERSONA.nameDisambiguation, renamedAgent),
    mindsetRebuttal: own(str(p.mindsetRebuttal), DEFAULT_PERSONA.mindsetRebuttal, differentCompany),
    tts: readTts(p.tts),
  };
}

/**
 * Is this persona the platform default in every respect the PROMPT cares about?
 *
 * Used by the agent to decide whether it is worth building anything per-tenant at all. TTS is
 * excluded deliberately — a custom voice is a separate decision handled by the TTS override path.
 */
export function isDefaultPersona(persona: AgentPersona): boolean {
  return (
    persona.agentName === DEFAULT_PERSONA.agentName &&
    persona.agentNameLatin === DEFAULT_PERSONA.agentNameLatin &&
    persona.agentGender === DEFAULT_PERSONA.agentGender &&
    persona.companyName === DEFAULT_PERSONA.companyName &&
    persona.companyDescription === DEFAULT_PERSONA.companyDescription &&
    persona.handoffPerson === DEFAULT_PERSONA.handoffPerson &&
    persona.nameDisambiguation === DEFAULT_PERSONA.nameDisambiguation &&
    persona.mindsetRebuttal === DEFAULT_PERSONA.mindsetRebuttal &&
    buildGreeting(persona) === DEFAULT_PERSONA.greeting &&
    persona.faq.length === DEFAULT_PERSONA.faq.length &&
    persona.faq.every(
      (entry, i) =>
        entry.topic === DEFAULT_PERSONA.faq[i]?.topic && entry.answer === DEFAULT_PERSONA.faq[i]?.answer,
    )
  );
}
