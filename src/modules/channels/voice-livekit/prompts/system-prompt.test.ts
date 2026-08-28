import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../tools/index.js';
import { GREETING_HE, SYSTEM_PROMPT_HE, buildSystemPrompt } from './system-prompt.he.js';

const TOOLS_PROMPT = buildSystemPrompt({ toolsEnabled: true });

/**
 * Prompt regression tests for the Keren v2 prompt (ported from docs/archive/system-prompt-keren-v2.md).
 *
 * Required by `docs/voice-agent-development-methodology.md` principle #1: never edit the system
 * prompt without a test proving the fix works and old behaviour still holds.
 *
 * READ THE `it.todo` BLOCK AT THE BOTTOM. The v2 prompt DROPS eight guards that the previous prompt
 * carried, and every one of them was added because of a failure on a real call — not because
 * somebody thought it might be nice. They are recorded as todos rather than deleted, so the suite
 * stays green while the losses stay loud.
 */

describe('Keren v2 — identity and gender', () => {
  it('names her קרן', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/קרן \(Keren\)/u);
  });

  it('states she is female', () => {
    // Hebrew inflects by gender and there is no neutral option, so a female voice using masculine
    // verbs is instantly, glaringly wrong to an Israeli ear. v1 of the original prompt did exactly
    // that and greeted every caller with a man's verb.
    expect(SYSTEM_PROMPT_HE).toMatch(/You are female/u);
  });

  it('gives feminine first-person examples she can actually copy', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/אני יכולה/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/מצטערת/u);
  });

  it('tells her the COMPANY is masculine plural, not feminine', () => {
    // The bug this exists for: "speak about yourself in the feminine" leaked into the first-person
    // PLURAL, and she said "אנחנו מספקות" about ClickScales. A company is not a woman, and the
    // feminine plural sounds flatly wrong. Three persons, three genders.
    expect(SYSTEM_PROMPT_HE).toMatch(/masculine plural/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/אנחנו בונים|אנחנו מציעים/u);
  });

  it('greets in the feminine (the Cartesia voice is female)', () => {
    expect(GREETING_HE).toMatch(/יכולה/u);
    expect(GREETING_HE).not.toMatch(/אני יכול(?!ה)/u);
  });

  it('introduces herself by name, anchored to the company', () => {
    // "קרן" and "קורן" are one letter apart and the phone line eats that letter. The company name
    // is the only thing in the sentence that tells a caller which one he is talking to.
    expect(GREETING_HE).toMatch(/קרן/u);
    expect(GREETING_HE).toMatch(/ClickScales|קליקסקיילס/u);
  });
});

describe('Keren v2 — what the business is', () => {
  it('states the business rather than leaving the model to infer it', () => {
    // NOTE: v2 CHANGES THE BUSINESS. The previous prompt said ClickScales is a digital marketing
    // agency ("סוכנות שיווק דיגיטלי"). This one says it builds AI voice and WhatsApp sales agents.
    // That is not a rewording — it is what she will now tell every caller.
    expect(SYSTEM_PROMPT_HE).toMatch(/builds AI voice and WhatsApp sales agents/u);
  });

  it('refuses to answer what it was not told, rather than inventing', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/אין לי כרגע את המידע הזה/u);
  });

  it('does not guess missing lead details — it asks', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/do not guess/u);
  });

  it('admits to being an AI when the caller asks for a human', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/אני סוכנת AI/u);
  });
});

describe('Keren v2 — the call flow', () => {
  it('opens without re-greeting (session.say already spoke the opening line)', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/do not repeat or re-say a greeting/u);
  });

  it('asks discovery questions one at a time', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/one question at a time/u);
  });

  it('treats general uncertainty as an objection to handle, NOT a disqualifier', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/General uncertainty is not a disqualifier/u);
  });

  it('stops immediately on a hostile or opt-out request', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/לא נתקשר אליך יותר/u);
  });

  it('stays silent when the caller asks her to hold', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/NO_RESPONSE_NEEDED/u);
  });
});

/**
 * ============================================================================================
 * BLOCKERS — the v2 prompt cannot go live until these are wired. It was written for RETELL.
 * ============================================================================================
 */
describe('Keren v2 — DEPLOY BLOCKERS', () => {
  it('KNOWN (no-tools variant only): still instructs her to call tools that DO NOT EXIST in that mode', () => {
    // The gate-closed prompt is the pre-Phase-4 one, Retell names and all. An LLM told to call a
    // tool it has not been given does not fail cleanly: it improvises. The speech-guard is what
    // stands between that improvisation and the caller's ear in no-tools mode.
    expect(SYSTEM_PROMPT_HE).toMatch(/end_call/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/check_availability_cal/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/book_appointment_cal/u);
  });

  it('KNOWN: contains template variables that NOTHING substitutes (both variants)', () => {
    // Retell interpolates these. LiveKit does not. As shipped, the model literally reads
    // "Lead name: {{lead_name}}" and will reason about it as though that were his name.
    for (const v of ['{{lead_name}}', '{{company_name}}', '{{industry}}', '{{opening_line}}', '{{call_direction}}']) {
      expect(SYSTEM_PROMPT_HE).toContain(v);
      expect(TOOLS_PROMPT).toContain(v);
    }
  });
});

/**
 * ============================================================================================
 * PHASE 4 — the tools-mode prompt. Built ONLY when the per-tenant gate (voice_engine='livekit'
 * AND functions_enabled=true) opened and buildAgentTools() actually attached the tools.
 * The prompt and the tool set must agree — these tests are the lockstep check.
 * ============================================================================================
 */
describe('Keren Phase 4 — tools-mode prompt', () => {
  it('references EXACTLY the tools the agent actually has (imported from tools/index.ts)', () => {
    for (const name of TOOL_NAMES) {
      expect(TOOLS_PROMPT).toContain(`\`${name}\``);
    }
  });

  it('contains NO stale Retell-era tool names', () => {
    expect(TOOLS_PROMPT).not.toMatch(/check_availability_cal/u);
    expect(TOOLS_PROMPT).not.toMatch(/book_appointment_cal/u);
  });

  it('collects and confirms details BEFORE calling book_meeting — they are its arguments', () => {
    const details = TOOLS_PROMPT.indexOf('YOU MUST COLLECT HIS DETAILS BEFORE BOOKING');
    const book = TOOLS_PROMPT.indexOf('Call `book_meeting` with his confirmed name');
    expect(details).toBeGreaterThan(-1);
    expect(book).toBeGreaterThan(-1);
    expect(details).toBeLessThan(book);
  });

  it('anti-hallucination: only offers times the tool returned, slot_datetime passed verbatim', () => {
    expect(TOOLS_PROMPT).toMatch(/OFFER ONLY TIMES THE TOOL RETURNED/u);
    expect(TOOLS_PROMPT).toMatch(/NEVER invent, guess, round or adjust a time/u);
    expect(TOOLS_PROMPT).toMatch(/EXACT slot_datetime value/u);
  });

  it('קבעתי לך is allowed ONLY after book_meeting succeeded — and failure is never papered over', () => {
    // The old blanket ban is gone from THIS variant (the tool makes the claim true)...
    expect(TOOLS_PROMPT).not.toMatch(/DO NOT SAY THE MEETING IS BOOKED/u);
    // ...replaced by the success-conditioned rule.
    expect(TOOLS_PROMPT).toMatch(/NEVER claim a meeting is booked before `book_meeting` returned success/u);
    expect(TOOLS_PROMPT).toMatch(/never pretend the booking worked/u);
    // And the no-tools variant KEEPS the blanket ban — she still cannot book there.
    expect(SYSTEM_PROMPT_HE).toMatch(/DO NOT SAY THE MEETING IS BOOKED/u);
  });

  it('capture_lead_info: save-as-you-learn instruction in the tools variant ONLY, silent by rule', () => {
    expect(TOOLS_PROMPT).toMatch(/call `capture_lead_info` to save them/u);
    expect(TOOLS_PROMPT).toMatch(/never announce it, never invent values/u);
    // The no-tools variant must not instruct a tool that doesn't exist there.
    expect(SYSTEM_PROMPT_HE).not.toMatch(/capture_lead_info/u);
  });

  it('confirmations: a channel is mentioned ONLY when its tool returned success', () => {
    expect(TOOLS_PROMPT).toMatch(/send_whatsapp_confirmation/u);
    expect(TOOLS_PROMPT).toMatch(/send_email_confirmation/u);
    expect(TOOLS_PROMPT).toMatch(/ONLY if the matching tool returned success/u);
    expect(TOOLS_PROMPT).toMatch(/you say NOTHING about that channel/u);
    expect(SYSTEM_PROMPT_HE).not.toMatch(/send_whatsapp_confirmation/u);
  });

  it('every end_call carries a reason the analytics can read', () => {
    expect(TOOLS_PROMPT).toMatch(/end_call` with reason "meeting_booked"/u);
    expect(TOOLS_PROMPT).toMatch(/end_call` with reason "not_qualified"/u);
    expect(TOOLS_PROMPT).toMatch(/end_call` with reason "opt_out"/u);
    expect(TOOLS_PROMPT).toMatch(/end_call` with reason "callback_requested"/u);
    expect(TOOLS_PROMPT).toMatch(/end_call` with reason "bad_time"/u);
  });

  it('opens every reply with a SHORT first sentence — the latency rule (both variants)', () => {
    // The voice starts only after the FIRST SENTENCE completes (guardStream flushes per sentence),
    // so a long first sentence is pure dead air. Measured 2026-07-20: the tail of sentence-1
    // generation was worth 300-500ms per turn. If this rule is ever dropped, that time comes back.
    for (const prompt of [SYSTEM_PROMPT_HE, TOOLS_PROMPT]) {
      expect(prompt).toMatch(/SHORT first sentence/u);
      expect(prompt).toMatch(/2 to 4 words/u);
    }
  });

  it('shared guarantees hold in BOTH variants', () => {
    for (const prompt of [SYSTEM_PROMPT_HE, TOOLS_PROMPT]) {
      expect(prompt).toMatch(/קרן \(Keren\)/u);
      expect(prompt).toMatch(/ASK HIS NAME FIRST/u);
      expect(prompt).toMatch(/address the lead in the MASCULINE/iu);
      expect(prompt).toMatch(/קורן הוא המייסד/u);
      expect(prompt).toMatch(/אני סוכנת AI/u);
      expect(prompt).toMatch(/לא נתקשר אליך יותר/u);
      expect(prompt).toMatch(/NO_RESPONSE_NEEDED/u);
    }
  });
});

/**
 * ============================================================================================
 * GUARDS DROPPED BY v2 — each was added because of a REAL failure on a REAL call.
 *
 * Recorded as todos rather than deleted, so the suite stays green while the losses stay visible.
 * If any of these behaviours reappears in production, this is the list to work through.
 * ============================================================================================
 */
describe('Keren v2 — guards the previous prompt had and this one does not', () => {
  // She is קרן. The founder is קורן. One vav apart, and she books meetings WITH him — so both names
  // occur in the same sentence, down an 8kHz line that strips exactly the sound separating them.
  // v2 never mentions the founder at all, so "אני רוצה לדבר עם קורן" now meets a model with no rule.
  it.todo('should disambiguate קרן (her) from קורן (the founder)');

  // The model once reasoned "ClickScales" -> "scales" -> מאזניים and told real callers we sell
  // weighing equipment. An LLM given no facts invents plausible ones; v1 had to forbid the
  // inference BY NAME. v2 states the business but never blocks the inference.
  it.todo('should explicitly deny the "scales/מאזניים" inference from the company name');

  // On a phone a long reply is worse than a slow one — the caller cannot skim, and cannot tell when
  // she is finished. v2 has no length limit anywhere, and its FAQ answers are long.
  it.todo('should cap replies at two sentences');

  // Added TODAY, because on a real call Koren said to her: "סיימת? אני פשוט לא מדבר, אני מחכה
  // שתסיימי." He could not tell when she had stopped talking, so he sat in silence. v2 has no rule
  // about ending a turn, and its FAQ answers end on flat statements that invite nobody to speak.
  it.todo('should end every turn clearly, preferring a question, and never on a list');

  // Hebrew addresses the listener by HIS gender, not the speaker's. v1 had her applying her own
  // gender to callers. v2 says nothing about the caller's gender at all.
  it.todo("should not apply her own gender to the caller");
});

/**
 * Fixes from Koren's first Keren-v2 call. Every one of these is a thing she actually did wrong.
 */
describe('Keren v2.1 — fixes from the first live call', () => {
  it('asks the caller his NAME before anything else', () => {
    // She never asked. A sales call where you did not learn who you were speaking to is not a
    // sales call — and his name is usually the only clue to his gender, which she also got wrong.
    expect(SYSTEM_PROMPT_HE).toMatch(/עם מי אני מדברת/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/ASK HIS NAME FIRST/u);
  });

  it('addresses the LEAD in the masculine by default — not in her own gender', () => {
    // Koren, on the call: "אני גבר, לא אישה." He had to correct her.
    expect(SYSTEM_PROMPT_HE).toMatch(/address the lead in the MASCULINE/iu);
  });

  it('does NOT try to fix the pronunciation bug in the prompt — that belongs in the pipeline', () => {
    // TWO DEAD ENDS, both tried and both rejected by Koren on real calls:
    //
    //   1. NIQQUD (שֶׁלְּךָ). Cartesia accepts it and still mispronounces.
    //      "אותה מילה, פעם זכר פעם נקבה, אין משהו אחיד."
    //
    //   2. BANNING the words with a table of replacements.
    //      "אל תגדיר אותם כמילים אסורות, זה לא פתרון." He is right — crippling her vocabulary to
    //      work around a TTS bug makes her speak like a foreigner.
    //
    // The fix lives in speech-guard.ts (forceMasculineAddress), which rewrites the SOUND in the few
    // milliseconds between the LLM and the speaker. She writes natural Hebrew and never knows.
    // This test exists so nobody puts it back in the prompt.
    expect(SYSTEM_PROMPT_HE).not.toMatch(/שֶׁלְּךָ/u);
    expect(SYSTEM_PROMPT_HE).not.toMatch(/FORBIDDEN WORDS/u);
    // What the prompt SHOULD say: address him in the masculine, and write normal Hebrew.
    expect(SYSTEM_PROMPT_HE).toMatch(/address the lead in the MASCULINE/iu);
    expect(SYSTEM_PROMPT_HE).toMatch(/do not avoid any word/iu);
  });

  it('MUST collect name, phone and email before the call ends', () => {
    // She let him hang up without them. He had to prompt her: "רגע, את צריכה את הפרטים שלי?"
    expect(SYSTEM_PROMPT_HE).toMatch(/COLLECT HIS DETAILS BEFORE THE CALL ENDS/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/מה מספר הטלפון/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/כתובת המייל/u);
  });

  it('FORBIDS claiming the meeting is booked — it is not, and she said it was', () => {
    // Verbatim, on the call: "קבעתי לך שיחת דמו למחר". No calendar exists. He would have hung up
    // expecting a demo at 10 that nobody had arranged.
    expect(SYSTEM_PROMPT_HE).toMatch(/DO NOT SAY THE MEETING IS BOOKED/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/אעביר את הבקשה לצוות/u);
  });

  it('knows קורן is the founder and the one giving the demo', () => {
    // Asked "עם מי אמורה להיות השיחה?", she answered "אין לי כרגע את המידע הזה."
    expect(SYSTEM_PROMPT_HE).toMatch(/קורן הוא המייסד/u);
  });
});
