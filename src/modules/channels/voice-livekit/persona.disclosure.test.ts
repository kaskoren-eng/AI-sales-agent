import { describe, expect, it } from 'vitest';
import { buildGreeting, DEFAULT_PERSONA, readAgentPersona, type AgentPersona } from './persona.js';
import { hasAiDisclosure } from './compliance/ai-disclosure.js';

/**
 * EVERY CALLER LEARNS THEY ARE TALKING TO AN AI, IN THE FIRST SENTENCE.
 *
 * `docs/risk/measured-findings-from-call-reports.md` measured the disclosure as NOT SPOKEN on 10 of
 * 10 real calls. Everything needed to say it existed — a detector, a report field, an end-of-call
 * instruction — and the instrumentation faithfully recorded its own 100% failure rate. The reason
 * is the whole lesson: the disclosure was a REQUEST TO THE MODEL ("include this in your goodbye"),
 * and when no caller asked and no goodbye ran, nothing said it.
 *
 * It now lives in the greeting, which `agent.ts` speaks verbatim via `session.say()`. A model can
 * skip an instruction; a fixed line cannot be skipped.
 *
 * These tests are the standing proof of that, across every persona shape a tenant can produce —
 * because the guarantee has to survive customer #2 renaming the agent and choosing a male voice.
 */

function persona(overrides: Partial<AgentPersona> = {}): AgentPersona {
  return { ...DEFAULT_PERSONA, ...overrides };
}

describe('every greeting discloses the agent is an AI', () => {
  it('the default persona — the live ClickScales agent', () => {
    const greeting = buildGreeting(DEFAULT_PERSONA);
    expect(hasAiDisclosure(greeting)).toBe(true);
    // Pinned, because this is the first thing every lead hears and it should never change by
    // accident. Changing it deliberately means changing this line and saying so in the commit.
    expect(greeting).toBe('שלום, מדברת קרן, העוזרת הדיגיטלית של ClickScales. איך אני יכולה לעזור?');
  });

  it('a renamed female agent at another company', () => {
    const greeting = buildGreeting(persona({ agentName: 'שרה', companyName: 'אלפא', greeting: '' }));
    expect(hasAiDisclosure(greeting)).toBe(true);
    expect(greeting).toBe('שלום, מדברת שרה, העוזרת הדיגיטלית של אלפא. איך אני יכולה לעזור?');
  });

  it('a MALE agent discloses in masculine Hebrew', () => {
    // The detector was feminine-only. A male agent could disclose perfectly and still be reported
    // as `missed` — a compliance report wrong in the direction of alarm, which is how a real
    // finding later gets waved away as a known false positive.
    const greeting = buildGreeting(persona({ agentName: 'דניאל', agentGender: 'male', companyName: 'אלפא', greeting: '' }));
    expect(hasAiDisclosure(greeting)).toBe(true);
    expect(greeting).toBe('שלום, מדבר דניאל, העוזר הדיגיטלי של אלפא. איך אני יכול לעזור?');
    // And no feminine leakage in a masculine greeting.
    expect(greeting).not.toMatch(/מדברת|יכולה|הדיגיטלית/u);
  });

  it("a tenant's own greeting that already discloses is left EXACTLY as written", () => {
    // Their words, their call. Appending a second disclosure would make the agent sound broken.
    const custom = 'היי! אני מיכל, הסוכנת הוירטואלית של בטא. במה אפשר לעזור?';
    expect(buildGreeting(persona({ greeting: custom }))).toBe(custom);
  });

  it("a tenant's own greeting that does NOT disclose gets one sentence appended", () => {
    const custom = 'היי, מדברת מיכל מבטא. במה אפשר לעזור?';
    const greeting = buildGreeting(persona({ greeting: custom, companyName: 'בטא' }));

    expect(greeting.startsWith(custom)).toBe(true); // their wording survives, unedited
    expect(hasAiDisclosure(greeting)).toBe(true);
    expect(greeting).toBe(`${custom} אני העוזרת הדיגיטלית של בטא.`);
  });

  it('appending is not silent — the dashboard preview renders the same string the agent speaks', () => {
    // The seam is meant to be visible. A tenant who dislikes it can fold the disclosure into their
    // own sentence and the appended one disappears; that is a better outcome than either silently
    // rewriting their words or silently dropping the disclosure.
    const custom = 'שלום מחברת גמא.';
    const once = buildGreeting(persona({ greeting: custom, companyName: 'גמא' }));
    const twice = buildGreeting(persona({ greeting: once, companyName: 'גמא' }));
    expect(twice).toBe(once); // idempotent — it never stacks up
  });

  it('holds for every gender × custom-greeting combination', () => {
    for (const agentGender of ['female', 'male'] as const) {
      for (const greeting of ['', 'שלום, מה שלומך?', 'היי מ-דלתא.']) {
        const built = buildGreeting(persona({ agentGender, greeting, agentName: 'אלכס', companyName: 'דלתא' }));
        expect(hasAiDisclosure(built), `gender=${agentGender} greeting=${JSON.stringify(greeting)}`).toBe(true);
      }
    }
  });

  it('holds for a persona read from raw tenant settings, including junk', () => {
    // The real entry point. `readAgentPersona` takes `unknown` from a jsonb column, so the
    // guarantee has to survive whatever is actually in there.
    for (const settings of [null, undefined, {}, { agent_persona: {} }, { agent_persona: { greeting: 42 } }, { agent_persona: { greeting: '   ' } }]) {
      expect(hasAiDisclosure(buildGreeting(readAgentPersona(settings)))).toBe(true);
    }
  });
});

describe('the two disclosure pattern lists agree', () => {
  it('anything persona.ts considers a disclosure, the runtime detector does too', () => {
    // `persona.ts` has its own copy of the patterns (it must not import the voice runtime into the
    // settings API). If the copies drift, a greeting could be built with a disclosure the call
    // report does not recognise — and the compliance field would report `missed` on a call that
    // actually complied.
    const samples = [
      'אני סוכנת AI של ClickScales',
      'אני סוכן AI של אלפא',
      'העוזרת הדיגיטלית של בטא',
      'העוזר הדיגיטלי של בטא',
      'העוזרת האוטומטית של גמא',
      'העוזר האוטומטי של גמא',
      'הסוכנת הוירטואלית של דלתא',
      'הסוכן הוירטואלי של דלתא',
      'אני בינה מלאכותית',
    ];
    for (const sample of samples) {
      expect(hasAiDisclosure(sample), sample).toBe(true);
      // …and the greeting builder agrees, by leaving a disclosing greeting untouched.
      expect(buildGreeting(persona({ greeting: sample }))).toBe(sample);
    }
  });

  it('neither list fires on an ordinary sentence', () => {
    // A false positive is worse than a false negative here: it would mark a call compliant when
    // nothing was disclosed, which is the exact failure the measurement caught.
    for (const sample of ['שלום, מדברת קרן מ-ClickScales. איך אני יכולה לעזור?', 'אני אשמח לעזור לך היום', 'תרצה לקבוע פגישה?']) {
      expect(hasAiDisclosure(sample), sample).toBe(false);
    }
  });
});
