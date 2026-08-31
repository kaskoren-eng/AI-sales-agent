import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../tools/index.js';
import { ACKNOWLEDGEMENTS_HE } from './acknowledgements.he.js';
import {
  GREETING_HE,
  REGISTER_VOCABULARY,
  SPOKEN_REGISTER_SLANG,
  SYSTEM_PROMPT_HE,
  buildSystemPrompt,
} from './system-prompt.he.js';

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

  it('discovery questions are INTENTS with phrasing banks, never a fixed script (2026-08-27)', () => {
    // Humanization §4's top offenders: the name question and the discovery bank were bare
    // literals, so every call opened with the same sentences. Each intent now carries 5
    // phrasings and an explicit never-verbatim rule — the phrase ledger enforces it in code.
    expect(SYSTEM_PROMPT_HE).toMatch(/Each entry is an INTENT with example phrasings/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/never the same sentence twice in one call/u);
    // The name question kept its original phrasing as ONE of the bank's entries…
    expect(SYSTEM_PROMPT_HE).toMatch(/עם מי אני מדברת/u);
    // …alongside real variants, for both the name question and the discovery bank.
    expect(SYSTEM_PROMPT_HE).toContain('איך קוראים לך');
    expect(SYSTEM_PROMPT_HE).toContain('ספר לי קצת על העסק');
    expect(SYSTEM_PROMPT_HE).toContain('מאיפה מגיעות אליך רוב הפניות');
  });

  it('treats general uncertainty as an objection to handle, NOT a disqualifier', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/General uncertainty is not a disqualifier/u);
  });

  it('stops immediately on a hostile or opt-out request', () => {
    // The wording changed on 2026-08-30 and the promise did not. It used to be "לא נתקשר אליך יותר",
    // whose whole meaning hung on an unstressed לא — the particle that failed to reach a caller on
    // the 2026-08-29 call. An opt-out is the worst possible sentence to be heard inside out, so it
    // is now a positive statement of the same fact. See the negation-safety block at the bottom.
    expect(SYSTEM_PROMPT_HE).toMatch(/אני מסירה אותך מרשימת הפניות שלנו/u);
    expect(buildSystemPrompt({ toolsEnabled: true, negationSafety: false })).toMatch(
      /לא נתקשר אליך יותר/u,
    );
  });

  it('stays silent when the caller asks her to hold', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/NO_RESPONSE_NEEDED/u);
  });

  /**
   * THE RULE THAT MUTED HER FOR TWENTY SECONDS ON A LIVE CALL (2026-08-16).
   *
   * It used to read: if the lead says "רגע"/"שנייה"/"חכה", answer with NO_RESPONSE_NEEDED. The
   * caller said "רגע, מה..." — a QUESTION that happens to open with a hold word — and got silence.
   * He waited, asked "הלו, מישהו שם?", then told her "נעלמת לי ממש".
   *
   * `רגע` is one of the most common things an Israeli says mid-sentence, so a rule that matches it
   * anywhere in the turn mutes the agent on a large share of real calls. The scope ("the lead's
   * ENTIRE turn") and the tie-breaker ("if unsure, ANSWER IT") are the fix, and both are load
   * bearing — this test exists so neither is tidied away by someone shortening the prompt.
   */
  it('only holds when the hold request is the WHOLE turn, and answers when unsure', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/ENTIRE turn/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/NOT a hold request/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/unsure.*ANSWER IT/su);
    // The counter-example that actually happened, kept in the prompt so the model sees the shape.
    expect(SYSTEM_PROMPT_HE).toMatch(/רגע, מה אתם עושים/u);
  });
});

/**
 * ============================================================================================
 * BLOCKERS — the v2 prompt cannot go live until these are wired. It was written for the
 * previous voice platform.
 * ============================================================================================
 */
describe('Keren v2 — DEPLOY BLOCKERS', () => {
  it('KNOWN (no-tools variant only): still instructs her to call tools that DO NOT EXIST in that mode', () => {
    // The gate-closed prompt is the pre-Phase-4 one, legacy tool names and all. An LLM told to call a
    // tool it has not been given does not fail cleanly: it improvises. The speech-guard is what
    // stands between that improvisation and the caller's ear in no-tools mode.
    expect(SYSTEM_PROMPT_HE).toMatch(/end_call/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/check_availability_cal/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/book_appointment_cal/u);
  });

  it('KNOWN: contains template variables that NOTHING substitutes (both variants)', () => {
    // The previous platform interpolated these. Our stack does not. As shipped, the model literally reads
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

  it('contains NO stale legacy-era tool names', () => {
    expect(TOOLS_PROMPT).not.toMatch(/check_availability_cal/u);
    expect(TOOLS_PROMPT).not.toMatch(/book_appointment_cal/u);
  });

  it('collects and confirms details BEFORE calling book_meeting — they are its arguments', () => {
    const details = TOOLS_PROMPT.indexOf('YOU MUST COLLECT HIS DETAILS BEFORE BOOKING');
    const book = TOOLS_PROMPT.indexOf('name, phone and email (see above) BEFORE you call `book_meeting`');
    expect(details).toBeGreaterThan(-1);
    expect(book).toBeGreaterThan(-1);
    expect(details).toBeLessThan(book);
  });

  it('day-first booking flow: offer TOMORROW, then the day, then the free RANGE', () => {
    // The flow Koren specified 2026-07-29: default to tomorrow, pick a day together if not, then
    // offer the calendar's free hours as a RANGE ("יש לי פנוי מעשר עד שלוש"), not a slot list.
    expect(TOOLS_PROMPT).toMatch(/Offer TOMORROW first/u);
    expect(TOOLS_PROMPT).toMatch(/for THAT DAY ONLY/u);
    expect(TOOLS_PROMPT).toMatch(/Offer the free RANGE/u);
    expect(TOOLS_PROMPT).toContain('יש לי פנוי מעשר עד שלוש');
  });

  it('hours are spoken as colloquial words, never digits (Koren, 2026-08-27)', () => {
    // The speech-guard normalizer is the safety net; the prompt is the first line. The range
    // example itself models the colloquial form — a digit example here would teach the opposite.
    expect(TOOLS_PROMPT).toMatch(/Say hours the way people say them/u);
    expect(TOOLS_PROMPT).toContain('ארבע וחצי');
    expect(TOOLS_PROMPT).toContain('רבע לחמש');
    // The banned forms are NAMED as anti-examples exactly once each, in the rule itself.
    expect(TOOLS_PROMPT).toMatch(/never raw digits \("16:30"\)/u);
    expect(TOOLS_PROMPT).toMatch(/שש עשרה ושלושים/u);
  });

  it('carries the objection-handling playbook (tools variant), absent from the legacy variant', () => {
    // Koren's content (OBJECTION_PLAYBOOK_HE) — the semantic reflex the code can't type. It rides in
    // the prompt on the tools variant only; the deprecated no-tools prompt stays byte-stable.
    expect(TOOLS_PROMPT).toContain('## Objection Handling');
    // 2026-08-31: the playbook used to OPEN with "first ACKNOWLEDGE the concern in one short
    // sentence", which is the generator of "מחיר זה חשוב" — Koren's note 9. It now says the
    // opposite, and the price play says it twice because that is the one he heard.
    expect(TOOLS_PROMPT).toMatch(/\*\*Go straight to the answer\*\*/u);
    expect(TOOLS_PROMPT).not.toMatch(/ACKNOWLEDGE the concern/u);
    expect(TOOLS_PROMPT).not.toContain('הכירי בכך שתקציב חשוב');
    expect(TOOLS_PROMPT).toMatch(/מחיר|נשמע רובוטי|אני צריך להתייעץ/u);
    expect(SYSTEM_PROMPT_HE).not.toContain('## Objection Handling');
  });

  it('omits the objection playbook when the advisory layer is off (objectionHandling: false)', () => {
    // The state-machine kill-switch (VOICE_STATE_MACHINE_ENABLED=false) drops the objection section
    // even on a tools-enabled call, so an A/B run is the pre-state-machine prompt on that axis.
    const noObjection = buildSystemPrompt({ toolsEnabled: true, objectionHandling: false });
    expect(noObjection).not.toContain('## Objection Handling');
    // Everything else about the tools prompt is unchanged — the tools are still present.
    expect(noObjection).toContain('check_calendar_availability');
  });

  it('anti-hallucination survives the range flow: exact slot_datetime, never adjust a time', () => {
    expect(TOOLS_PROMPT).toMatch(/EXACT slot_datetime value/u);
    expect(TOOLS_PROMPT).toMatch(/never invent, guess, round or adjust a time/u);
    // She books the slot whose time MATCHES what he said — not a time she made up.
    expect(TOOLS_PROMPT).toMatch(/whose time MATCHES what he said/u);
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

  it('forbids her own opener when VOICE_INSTANT_ACK speaks one for her', () => {
    // Both rules on is what the 2026-08-17 call sounded like: our acknowledgement, then hers, then
    // a third from the reply itself — "בסדר. שומעת מצוין. כן, אני שומעת אותכה טוב." Three receipts
    // before a single fact. The short-first-sentence rule survives; the reaction word does not.
    const acked = buildSystemPrompt({ toolsEnabled: true, instantAck: true });

    expect(acked).toMatch(/NEVER an acknowledgment/u);
    expect(acked).toMatch(/Do NOT begin your reply with an acknowledgment/u);
    expect(acked).toMatch(/SHORT/u); // the latency rule it replaces must not be lost with it
    expect(acked).not.toMatch(/2 to 4 words/u); // …and the old instruction must be GONE, not merely contradicted
  });

  it('quotes the acknowledgements we ACTUALLY speak — the list is not decoration', () => {
    // It tells her which words are already taken. "כן." was dropped from the bank on 2026-08-29
    // (it answered "מה המצב, קרן?" with "yes"), and a prompt still promising it would be lying
    // about what the caller just heard.
    const acked = buildSystemPrompt({ toolsEnabled: true, instantAck: true });
    const quoted = /A brief acknowledgment \(([^)]*)\)/u.exec(acked)?.[1] ?? '';
    for (const ack of ACKNOWLEDGEMENTS_HE) {
      expect(quoted).toContain(ack);
    }
    expect(quoted).not.toContain('"כן."');
  });

  // The seventh tool (2026-08-28). Sales objection #1 is "what if the customer wants a human?" —
  // before this the agent had no answer and improvised one. The escalation LADDER is the product
  // decision worth pinning: one honest attempt to help, then hand off without arguing.
  describe('human handoff — the escalation ladder', () => {
    it('names the tool and the four triggers a lead actually uses', () => {
      expect(TOOLS_PROMPT).toMatch(/`request_human_handoff`/u);
      expect(TOOLS_PROMPT).toMatch(/בן אדם/u); // "a human being" — the phrase Israeli leads say
      expect(TOOLS_PROMPT).toMatch(/EXPLICITLY insists on a human/u);
      expect(TOOLS_PROMPT).toMatch(/refuses to continue with an AI/u);
      expect(TOOLS_PROMPT).toMatch(/asks for a person a SECOND time/u);
      expect(TOOLS_PROMPT).toMatch(/אפשר לדבר עם מישהו/u); // the mild first ask, quoted
    });

    it('tries ONCE before escalating — a mild first ask is not a handoff', () => {
      // Firing on the first "אפשר לדבר עם מישהו?" burns a lead who only wanted their question
      // answered; refusing to ever escalate is how the agent argues with a person. Both are bugs.
      expect(TOOLS_PROMPT).toMatch(/Try this exactly ONCE/u);
      expect(TOOLS_PROMPT).toMatch(/do not argue and do not try to convince again/u);
    });

    it('asks ONE question about what they want to discuss — then hands off either way', () => {
      // Koren, 2026-08-29: "she needs to ask the user why and what he needs and what he wants to
      // say or talk with the human." The trap this pins shut is the obvious over-correction — an
      // interrogation, or worse, a handoff that waits for an answer. She asks once. The tool runs
      // regardless.
      expect(TOOLS_PROMPT).toMatch(/Ask ONE short question/u);
      expect(TOOLS_PROMPT).toMatch(/על מה תרצה לדבר איתו/u);
      expect(TOOLS_PROMPT).toMatch(/ONE question, and the handoff happens either way/u);
      expect(TOOLS_PROMPT).toMatch(/call the tool IMMEDIATELY/u);
      expect(TOOLS_PROMPT).toMatch(/Never ask twice/u);
      expect(TOOLS_PROMPT).toMatch(/A person who wants a human gets a human/u);
    });

    it('tells her to fill the summary from the WHOLE call, not the last sentence', () => {
      // The owner alert is only worth reading if it says who called, what they want, and what is
      // already established — see request-human-handoff.tool.ts.
      for (const field of ['`reason`', '`wants`', '`context`']) {
        expect(TOOLS_PROMPT).toContain(field);
      }
      expect(TOOLS_PROMPT).toMatch(/does not start from zero/u);
    });

    it('never promises a live transfer — the human CALLS BACK', () => {
      // There is no SIP REFER path (post-launch). A promise to "connect you now" is a lie the
      // lead hears within seconds.
      expect(TOOLS_PROMPT).toMatch(/NEVER promise to transfer or connect them right now/u);
      expect(TOOLS_PROMPT).toMatch(/CALL THEM BACK/u);
    });

    it('the no-tools variant keeps the old message-relay answer and names NO tool', () => {
      // Tool-gated-off calls must not be told to call a tool they do not have.
      expect(SYSTEM_PROMPT_HE).not.toMatch(/request_human_handoff/u);
      expect(SYSTEM_PROMPT_HE).toMatch(/אני סוכנת AI, אבל אני יכולה להעביר הודעה לצוות שלנו/u);
      // …and the tools variant must NOT still carry the old relay script.
      expect(TOOLS_PROMPT).not.toMatch(/יכולה להעביר הודעה לצוות שלנו שיחזרו אליך/u);
    });

    it('the handoff does not leak into the ordinary end_call vocabulary', () => {
      // handoff_requested is set by the TOOL, never self-selected by the model in end_call.
      expect(TOOLS_PROMPT).not.toMatch(/end_call` with reason "handoff_requested"/u);
    });
  });

  it('shared guarantees hold in BOTH variants', () => {
    for (const prompt of [SYSTEM_PROMPT_HE, TOOLS_PROMPT]) {
      expect(prompt).toMatch(/קרן \(Keren\)/u);
      expect(prompt).toMatch(/ASK HIS NAME FIRST/u);
      expect(prompt).toMatch(/address the lead in the MASCULINE/iu);
      expect(prompt).toMatch(/קורן הוא המייסד/u);
      expect(prompt).toMatch(/אני סוכנת AI/u);
      // The opt-out promise, in its negation-safe wording (2026-08-30). Both variants carry it.
      expect(prompt).toMatch(/אני מסירה אותך מרשימת הפניות שלנו/u);
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

describe('Keren — emotional color (round 4, 2026-08-26)', () => {
  // Cartesia's emotion tags do NOTHING on Hebrew (verified by ear: [laughter]/[sigh] silently
  // ignored on sonic-3.5 — tests/hebrew-tts-niqqud-ab round 4). Emotion therefore travels in the
  // TEXT: sonic reads emotional subtext from wording and punctuation. Koren's verdicts picked
  // exactly three devices; the prompt teaches those and nothing else.

  it('teaches ONLY devices that won a listening verdict, in both prompt variants', () => {
    for (const prompt of [SYSTEM_PROMPT_HE, TOOLS_PROMPT]) {
      expect(prompt).toMatch(/Emotional Color/u);
      expect(prompt).toMatch(/וואו, מעולה!/u); // r4 p1=C: interjection + exclamation
      expect(prompt).toMatch(/אני מבינה\.\.\. זה באמת מתסכל/u); // r4 p2=B: ellipsis for empathy
      expect(prompt).toMatch(/בבוקר, או אחר הצהריים/u); // r4 p3=C: either/or question melody
      expect(prompt).toMatch(/איזה כיף/u); // r4b w5 ok: joy
      expect(prompt).toMatch(/וואלה\?/u); // r4b w6 ok: surprise
      expect(prompt).toMatch(/אוף\.\.\./u); // r4b w3 ok: the shared sigh
    }
  });

  it('BANS written laughter — sonic-3.5 reads חח as the letter khet, not a laugh (r4b w1/w2)', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/You CANNOT laugh/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/do not write it, ever/u);
  });

  it('anchors the color to BEATS — the 2026-08-26 evening call used one device in 32 turns', () => {
    // "Sparingly, at most one per reply" made the model play it safe to the point of silence:
    // a whole call with a single emotional touch, copied verbatim from the example. The section
    // now names the moments that ALWAYS deserve color and demands the model's own words.
    expect(SYSTEM_PROMPT_HE).toMatch(/These beats always deserve emotional color/iu);
    expect(SYSTEM_PROMPT_HE).toMatch(/never copy these examples verbatim/iu);
    expect(SYSTEM_PROMPT_HE).toMatch(/acknowledge the feeling first/iu);
    expect(SYSTEM_PROMPT_HE).not.toMatch(/at most one emotional touch per reply/iu);
  });

  it('keeps the color out of the opener slot — the instant-ack double-receipt bug must not return', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/never as another opener/iu);
  });

  it('bans bracketed stage-direction tags — they are silently ignored on Hebrew, dead words in a transcript', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/never stage directions or bracketed tags/iu);
    // And the section itself must not demonstrate one, or the model will copy it.
    expect(SYSTEM_PROMPT_HE).not.toMatch(/\[laughter\]|\[sigh\]/u);
  });
});

/**
 * The spoken register (2026-08-27). Koren's third live-call complaint: her Hebrew is too formal
 * and scripted. Simple spoken Hebrew + LIGHT slang (סבבה/אחלה level), heavy street slang
 * explicitly out. Same discipline as EMOTIONAL_COLOR: devices + beats, one touch per reply,
 * never verbatim. Kill-switch: VOICE_SPOKEN_REGISTER_ENABLED → spokenRegister option.
 */
describe('Keren — spoken register (2026-08-27)', () => {
  it('carries the Spoken Register section by default, in BOTH variants', () => {
    expect(SYSTEM_PROMPT_HE).toContain('## Spoken Register');
    expect(buildSystemPrompt({ toolsEnabled: true })).toContain('## Spoken Register');
  });

  it('the kill-switch drops the section entirely — the pre-register prompt on that axis', () => {
    const off = buildSystemPrompt({ toolsEnabled: true, spokenRegister: false });
    expect(off).not.toContain('## Spoken Register');
    expect(off).not.toContain('סבבה');
  });

  it('bans the bookish lexemes and puts structure FIRST', () => {
    // The corpus scan found the formality lives in sentence structure, not fancy words — so the
    // section leads with structure rules; the word list is the guard-rail.
    expect(SYSTEM_PROMPT_HE).toMatch(/Structure first/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/לפיכך, בכדי, ברצוני, אודות, הנני, כמו כן/u);
  });

  it('one slang touch per reply MAX, varied — the same word every reply is the new robot', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/At most ONE slang touch per reply/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/if you used a word recently, pick another/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/never copy these verbatim/u);
  });

  // ── 2026-08-29: the section was PRESENT and she still used none of it ────────────────────────
  //
  // VOICE_SPOKEN_REGISTER_ENABLED defaults on and is not overridden in the cloud, so the section
  // was in the prompt for the whole 194-second call — and her Hebrew came out correct-but-formal,
  // zero slang. Koren: "I didn't hear the saying any slang words." Round 5 (17/17) scored TTS
  // samples, not live LLM turns, which is the gap. So this is prompt STRENGTH, not a switch.

  it('makes the register a QUOTA, not a permission — "welcome" was read as "optional"', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/EXPECTED, not merely permitted/u);
    // Tightened 2026-08-27 → 2026-08-30. "Roughly every second or third reply" produced two touches
    // in eight turns, and the person on the call perceived none of them, so the quota now names a
    // floor and a countable trigger the model can apply to itself between turns. The code-side
    // enforcement is register-tracker.ts — same guidance/enforcement split as the phrase ledger.
    expect(SYSTEM_PROMPT_HE).toMatch(/At least one of them in every second reply/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/never fewer than one in three/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/two replies in a row went by/u);
  });

  it('BOUNDS the vocabulary — a word nobody screened can fail silently on a phone line', () => {
    // Nine since 2026-08-31 — Koren added `סגור` himself. The COUNT and the list must move
    // together, or the prompt tells her a number that does not match the words in front of it.
    expect(SYSTEM_PROMPT_HE).toMatch(/These nine are the whole vocabulary/u);
    expect(REGISTER_VOCABULARY).toHaveLength(9);
    // Both banks are named in the section, so "the register vocabulary" has ONE meaning. וואלה was
    // reported as an invented word; it is in EMOTIONAL_COLOR and passed round 4b.
    for (const word of REGISTER_VOCABULARY) expect(SYSTEM_PROMPT_HE).toContain(word);
  });

  it('resolves the conflict with the Speech Rhythm rule that was silently suppressing it', () => {
    // THE ACTUAL ROOT CAUSE. With VOICE_INSTANT_ACK on, the Speech Rhythm section forbids opening a
    // reply with a reaction word — and every example the register used to give ("סבבה, אז נתקדם.")
    // was exactly such an opener. The model was obeying the stronger, more emphatic prohibition and
    // dropping the slang entirely. The section now says where the word goes instead.
    const acked = buildSystemPrompt({ toolsEnabled: true, instantAck: true });
    expect(acked).toMatch(/Never as the first word/u);
    expect(acked).toMatch(/INSIDE the sentence/u);
    // ...and with the ack OFF she writes her own short opener, which IS a good home for one. One
    // static paragraph cannot be right in both configurations, so the placement follows the flag.
    expect(SYSTEM_PROMPT_HE).not.toMatch(/Never as the first word/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/your short opening sentence is a natural home/u);
    // No example may itself be an opener, or the conflict comes straight back.
    const section = SYSTEM_PROMPT_HE.slice(SYSTEM_PROMPT_HE.indexOf('## Spoken Register'));
    for (const word of SPOKEN_REGISTER_SLANG) {
      expect(section).not.toContain(`"${word},`); // e.g. "סבבה, אז נתקדם."
    }
  });

  it('gives her a concrete way to catch her own formality', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/formal email/u);
  });

  it('heavy street slang is banned BY NAME — Koren\'s explicit choice', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/NO heavy street slang/u);
    // The banned words appear exactly once each — inside the ban itself, never as examples.
    for (const banned of ['אין מצב', 'וואי', 'פצצה']) {
      const hits = SYSTEM_PROMPT_HE.split(banned).length - 1;
      expect(hits, `${banned} must appear exactly once (in the ban)`).toBe(1);
    }
  });

  it('every slang-bank word is in the prompt, and the ledger tracks the same list', () => {
    // SPOKEN_REGISTER_SLANG is consumed by the PhraseLedger (agent.ts) — the bank and the
    // tracked-word list must never drift apart, and every entry passed round-5 screening.
    // `סגור` is Koren's own 2026-08-31 addition. Screened before it was committed, not after:
    // roundtrip7.ts, 3/3 carriers came back as `סגור` through the 8kHz phone band.
    expect(SPOKEN_REGISTER_SLANG).toEqual(['סבבה', 'אחלה', 'מעולה', 'בקטנה', 'על הדרך', 'סגור']);
    for (const word of SPOKEN_REGISTER_SLANG) {
      expect(SYSTEM_PROMPT_HE).toContain(word);
    }
  });
});

/**
 * P0-1, the prompt half. The enforcement half is fact-memory.ts and its own test file; these two
 * must be gated by the SAME switch, or the instructions and the guard describe different rules and
 * the model is told one thing while the tool does another.
 */
describe('Call Memory — the 2026-08-29 identity failure, in the prompt', () => {
  it('forbids asking twice for a fact he already gave', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/## Call Memory/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/Never ask for it a second time/u);
  });

  it('caps an UNANSWERED question at one repeat — the third ask is what he reacted to', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/ask at most ONE more time/u);
  });

  it('says a stray noun in a later turn is a mishearing, not a new name', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/mishearing, not a new name/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/ONLY an explicit correction out loud/u);
  });

  it('the tools variant tells her which tool field carries a correction', () => {
    const tools = buildSystemPrompt({ toolsEnabled: true });
    expect(tools).toMatch(/`is_correction`/u);
    // ...and it is the exception to "call it again whenever a fact changes", stated next to it.
    expect(tools).toMatch(/His NAME, phone and email are the exception/u);
  });

  it('the kill-switch removes the section entirely, and nothing else', () => {
    const on = buildSystemPrompt({ toolsEnabled: true });
    const off = buildSystemPrompt({ toolsEnabled: true, factMemory: false });
    expect(off).not.toMatch(/## Call Memory/u);
    // Additive by construction: deleting the section's own block from the ON prompt reproduces the
    // OFF prompt byte for byte, so the switch can never quietly reshape anything around it. (The
    // `is_correction` sentence is deliberately NOT gated — the tool field exists either way.)
    const start = on.indexOf('---\n\n## Call Memory');
    const end = on.indexOf('---', on.indexOf('## Call Memory'));
    expect(on.slice(0, start) + on.slice(end)).toBe(off);
  });
});

/**
 * P0-2. She said "ועוזרים לא לפספס לידים"; the lead's next words were "מה עוזרים לו לפספס?".
 *
 * NOTHING HERE CAN PROVE THE FIX. The transcript was always correct — the inversion happens between
 * the TTS and the caller's ear, where no test reaches. What these DO prove is that the rule is
 * present, that the fixed lines carry no single-particle meaning any more, and that a future edit
 * cannot quietly reintroduce one. The sweep is the part that keeps earning its keep.
 */
describe('negation safety — a sentence must not be able to invert', () => {
  const speakableLines = (prompt: string): string[] =>
    prompt
      .split('\n')
      .filter((line) => line.startsWith('> '))
      .map((line) => line.slice(2));

  it('THE SWEEP: no line she is told to say verbatim rests on a bare unstressed particle', () => {
    // Blockquote lines are HER lines — every one is "respond exactly with" or "a natural variation
    // of". Inline quotes elsewhere are the LEAD's words (objection labels, hold examples, the
    // "אני לא בטוח" she is answering), which she never speaks and must not be rewritten.
    //
    // `אין` is excluded on purpose: it is a full stressed word, and dropping it leaves
    // ungrammatical noise ("לי בדיוק את הזמן הזה פנוי") rather than a clean, plausible opposite.
    for (const variant of [SYSTEM_PROMPT_HE, buildSystemPrompt({ toolsEnabled: true })]) {
      for (const line of speakableLines(variant)) {
        expect(line, `spoken line relies on a bare particle: ${line}`).not.toMatch(
          /(^|\s)(לא|אל|בלי)\s/u,
        );
      }
    }
  });

  it('the five reworded lines say the positive version of the same fact', () => {
    const tools = buildSystemPrompt({ toolsEnabled: true });
    expect(tools).toContain('אני מסירה אותך מרשימת הפניות שלנו'); // was: לא נתקשר אליך יותר
    expect(tools).toContain('נראה שהתזמון פחות מתאים כרגע'); // was: נראה שזה לא הכיוון המתאים
    expect(tools).toContain('מצטערת על התזמון'); // was: שתפסתי אותך לא בזמן
    expect(tools).toContain('אגב, אשמח לדעת את השם שלך'); // was: לא תפסתי את השם שלך
    expect(tools).toContain('מה גורם לך להרגיש ככה?'); // was: שזה לא מתאים?
    expect(tools).toContain('זה מחוץ למה שאני עושה כאן'); // was: אני לא יכולה לעזור עם זה
  });

  it('teaches the rule with the real sentence that failed, not an invented one', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/## Say It So It Cannot Be Misheard/u);
    expect(SYSTEM_PROMPT_HE).toContain('ועוזרים לא לפספס לידים');
    expect(SYSTEM_PROMPT_HE).toContain('מה עוזרים לו לפספס?');
    // The positive replacement she should reach for instead.
    expect(SYSTEM_PROMPT_HE).toContain('דואגים שכל פנייה מקבלת מענה');
  });

  it('gives her a way to keep a negative when she means one — mark it twice', () => {
    expect(SYSTEM_PROMPT_HE).toContain('אף פנייה לא נופלת');
  });

  it('the kill-switch restores the previous wording exactly, section and lines together', () => {
    const off = buildSystemPrompt({ toolsEnabled: true, negationSafety: false });
    expect(off).not.toMatch(/## Say It So It Cannot Be Misheard/u);
    expect(off).toContain('לא נתקשר אליך יותר');
    expect(off).toContain('אני לא יכולה לעזור עם זה');
    expect(off).toContain('לא תפסתי את השם שלך');
  });
});

/**
 * The 2026-08-30 production calls — the prompt half of Koren's seven notes on how she SOUNDS.
 * Every assertion here is a sentence he reacted to, not a style preference.
 */
describe('the 2026-08-30 calls — greeting once, joy in proportion, pauses that work', () => {
  const tools = buildSystemPrompt({ toolsEnabled: true });

  it('says "נעים מאוד" belongs to the introduction and nowhere else', () => {
    // 35s: right. 164s, after a surname landed: "אהה. נעים מאוד. רק לוודֵא — קורן שטרית, נכון?"
    expect(SYSTEM_PROMPT_HE).toContain('"נעים מאוד" belongs to the introduction and nowhere else');
    expect(SYSTEM_PROMPT_HE).toMatch(/Learning his surname later.*is not a new introduction/su);
  });

  it('keeps the big joy for a booking that actually landed', () => {
    // It fired on a flat "אה, סבבה" — agreement in principle — and read as performed.
    expect(SYSTEM_PROMPT_HE).toMatch(/A booking actually LANDS.*איזה כיף/su);
    expect(SYSTEM_PROMPT_HE).toMatch(/agrees in principle.*match his size/su);
  });

  it('tells her which punctuation actually pauses, with the measured numbers', () => {
    // "השימוש בפסיקים ונקודות כדי לעצור באמצע משפט לא עובד כמו שצריך". Measured on sonic-3.5 at
    // the production speed: pause_probe.py. A rule without the numbers is a preference.
    expect(SYSTEM_PROMPT_HE).toContain('a comma is the weakest one you have');
    expect(SYSTEM_PROMPT_HE).toMatch(/0\.18s/u);
    expect(SYSTEM_PROMPT_HE).toContain('END THE SENTENCE');
  });

  it('does not open both read-backs with the same three words', () => {
    // "רק לוודֵא — קורן, נכון?" at 153.7s and "רק לוודֵא — קורן שטרית, נכון?" at 163.8s.
    // 2026-08-31 supersedes the wording: Koren's own edit made the phone read-back
    // "חוזרת על המספר", and his note 1 removed the preamble from the name read-back entirely.
    expect(tools).toContain('חוזרת על המספר — אפס חמש אפס');
    expect(tools).toContain('**Read it back with no preamble in front of it.**');
    expect(tools).toMatch(/Vary the second one\./u);
  });

  it('tells her not to answer a half-finished dictation', () => {
    // The code half is the mid-dictation nod (dictation.ts); this is the guidance half.
    expect(tools).toContain('While he is READING SOMETHING OUT, do not answer him');
    expect(tools).toMatch(/never acknowledge a half-finished number/u);
  });
});

/**
 * THE 2026-08-31 PRODUCTION CALL — Koren's nine notes, in the prompt.
 *
 * Ten minutes, no booking despite the lead agreeing to a time. Measured: repeatedPhraseCount 34,
 * repeatedOpenerCount 4, fragmentedTurns 8, duplicateReplies 1. Four of the nine (1, 3, 6, 9) turned
 * out to be ONE habit — she performs a receipt before nearly every sentence — so they are tested as
 * one section with his four examples as the cases, not as four independent string assertions.
 *
 * ⚠️ NONE OF THIS PROVES THE BEHAVIOUR CHANGED. These prove the instruction is present and says what
 * he asked for. Whether the model obeys it is observable only on a call.
 */
describe('the 2026-08-31 call — the receipt ritual, and what must survive it', () => {
  const tools = buildSystemPrompt({ toolsEnabled: true });
  const acked = buildSystemPrompt({ toolsEnabled: true, instantAck: true });

  it('names the habit ONCE, as a habit, rather than banning four phrases', () => {
    expect(SYSTEM_PROMPT_HE).toContain('## No Preamble');
    expect(SYSTEM_PROMPT_HE).toMatch(/It is ONE habit, not four/u);
    expect(SYSTEM_PROMPT_HE).toContain('**Start with the substance.**');
    // Present in BOTH speech-rhythm configurations — the ritual is not a property of who writes
    // the opener.
    expect(acked).toContain('## No Preamble');
  });

  it('note 1 — every variant of the verification preamble is named and banned', () => {
    for (const preamble of ['רק לוודא', 'רק שאדע', 'רק שאדייק', 'אני רוצה לוודא']) {
      expect(SYSTEM_PROMPT_HE, preamble).toContain(preamble);
    }
    // …and none of them is ever shown IN USE. A banned phrase that is also still offered as an
    // example is how this one survived the last edit: the model copies examples. In the ban each
    // is a bare quoted item ("רק לוודא", "רק שאדע"); in use it is followed by the thing it
    // introduces — "רק לוודא — קורן שטרית, נכון?" or "רק שאדע, איך קוראים לך?".
    for (const preamble of ['רק לוודא', 'רק שאדע', 'רק שאדייק', 'אני רוצה לוודא']) {
      expect(tools, `${preamble} must never appear in use`).not.toMatch(
        new RegExp(`${preamble}\\s*[—–,-]`, 'u'),
      );
    }
    // Why it can never be re-spelled instead: it does not survive the phone band.
    expect(SYSTEM_PROMPT_HE).toContain('רק לוועדה');
  });

  it('note 3 — his own words handed back, with a compliment on top', () => {
    // 44s: "בניית אתרים זה תחום מעניין." — a near-verbatim copy of the Emotional Color surprise
    // beat, fired on a man answering what he does for a living.
    expect(SYSTEM_PROMPT_HE).toContain('בניית אתרים זה תחום מעניין');
    expect(SYSTEM_PROMPT_HE).toMatch(/His line of work is not a surprise/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/A compliment — on his work, on his business, or on his question/u);
    // The generator itself is scoped now, not merely counter-instructed.
    expect(SYSTEM_PROMPT_HE).not.toContain('The caller shares something impressive or unexpected →');
  });

  it('note 6 — "הבנתי" is earned, and the prompt half says what the code half does', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/\*\*"הבנתי" has to be earned\.\*\*/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/Never two replies in a row/u);
  });

  it('note 9 — nothing in front of a price answer telling him prices matter', () => {
    // 281s: "בסדר. מחיר זה חשוב." · 301s: "תקציב זה חשוב."
    expect(SYSTEM_PROMPT_HE).toContain('מחיר זה חשוב');
    expect(SYSTEM_PROMPT_HE).toContain('תקציב זה חשוב');
    expect(SYSTEM_PROMPT_HE).toMatch(/A statement that his topic matters/u);
  });

  it('note 2 — a short set phrase carries no comma inside it', () => {
    expect(SYSTEM_PROMPT_HE).toContain('נעים מאוד קורן');
    expect(SYSTEM_PROMPT_HE).toMatch(/do not put a comma inside it/u);
    // The two places that used to DEMONSTRATE the comma version — Call Memory and Step 2 — both
    // showed it in parentheses as the thing to say. The comma form now survives only inside the
    // rule that forbids it (`never "נעים מאוד, קורן"`), which is why this is shape-specific.
    expect(SYSTEM_PROMPT_HE).not.toMatch(/\("נעים מאוד, קורן"/u);
    expect(SYSTEM_PROMPT_HE).not.toMatch(/Examples:.*"מעולה, קורן\."/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/\("נעים מאוד קורן"/u);
  });

  it('note 4 — one opening sound per reply, never two stacked', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/keep exactly one thought per opening/u);
    expect(SYSTEM_PROMPT_HE).toContain('אהה. רגע...');
  });

  it('note 7 — small talk before business, and why it is NOT the preamble', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/two sentences of small talk, BEFORE any business question/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/Small talk is an EXCHANGE/u);
    // The distinction is the hard part, so his own bad example is quoted inside the rule.
    expect(SYSTEM_PROMPT_HE).toMatch(
      /If your small talk turns out to be a compliment about his line of work, it is a preamble/u,
    );
    expect(SYSTEM_PROMPT_HE).toMatch(/One exchange, two sentences at the outside/u);
  });

  it('note 8 — three mandatory questions, three optional, and a rule for choosing', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/\*\*MANDATORY — all three, on every call/u);
    expect(SYSTEM_PROMPT_HE).toMatch(
      /\*\*OPTIONAL — only when he is giving you more than short answers/u,
    );
    expect(SYSTEM_PROMPT_HE).toMatch(/READ HIM, AND MATCH HIS SIZE/u);
    // Every one of the six original intents survived the split — none was lost in the reorder.
    for (const probe of [
      'איזה עסק יש לך ומה אתה מוכר בדיוק?',
      'כמה פניות נכנסות אליך ביום, פחות או יותר?',
      'יש משהו שהיית רוצה לשפר בנושא הזה?',
      'מי מטפל בפניות היום, ותוך כמה זמן חוזרים ללקוח?',
      'איך מגיעים אליך לקוחות היום?',
      'מה בעצם המוצר או השירות המרכזי שלך?',
    ]) {
      expect(SYSTEM_PROMPT_HE, probe).toContain(probe);
    }
    // The prompt and the code half must name the same thing, or the injected note is noise.
    expect(SYSTEM_PROMPT_HE).toContain('Caller engagement — automatic');
  });

  it('NOTE 5 — the two things he asked to KEEP are still here, and protected by name', () => {
    // "הבעת רגש… כשקורה איזשהו אירוע של דחייה של הסוכן או כשלקוח מציין משהו ממש מבאס. זה גם נקודה
    // לשימור, כי הסוכנת עשתה את זה טוב… נקודה נוספת לשימור: השימוש היה נכון בסלנג בתחילת השיחה."
    expect(SYSTEM_PROMPT_HE).toContain('אוף... זה באמת מבאס.');
    expect(SYSTEM_PROMPT_HE).toContain('אני מבינה... זה באמת מתסכל.');
    expect(SYSTEM_PROMPT_HE).toMatch(/Real feeling, when the moment carries it/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/The everyday register, including at the start of the call/u);
    // …and the No Preamble section must not have quietly banned them on its way past.
    expect(SYSTEM_PROMPT_HE).toMatch(
      /a feeling he actually expressed, not the mere existence of his topic/u,
    );
    expect(SYSTEM_PROMPT_HE).toContain('## Emotional Color');
    expect(SYSTEM_PROMPT_HE).toContain('## Spoken Register');
    for (const word of REGISTER_VOCABULARY) expect(SYSTEM_PROMPT_HE, word).toContain(word);
  });

  it('the kill-switch removes the section and NOTHING else', () => {
    const off = buildSystemPrompt({ toolsEnabled: true, noPreamble: false });
    expect(off).not.toContain('## No Preamble');
    // Everything the section protects lives in other sections and must survive its removal.
    expect(off).toContain('## Emotional Color');
    expect(off).toContain('## Spoken Register');
    expect(off).toContain('אוף... זה באמת מבאס.');
    expect(off).toMatch(/two sentences of small talk/u);
    expect(off).toMatch(/MANDATORY — all three/u);
  });
});

/**
 * THE EMAIL — the field that has now cost two bookings.
 *
 * 2026-08-31 production call: the demo was agreed at 450s; the call ended at 602s with no booking,
 * having spent its last 54 seconds on this one field, and `book_meeting` was never called. His
 * address is `kaskoren@gmail.com`; she converged on `koren@gmail.com` and read it back in Latin
 * letters inside a Hebrew sentence.
 *
 * `email-dictation.ts` and `fact-memory.ts` carry the runtime half (stitch the letters, never save
 * a rejected value). Neither can change what she SAYS. This is the durable half.
 */
describe('the email collection method', () => {
  const BOTH = [SYSTEM_PROMPT_HE, TOOLS_PROMPT];

  it('is present on both the tools and the no-tools prompt', () => {
    for (const p of BOTH) expect(p).toContain('### The email address');
  });

  it('names the Latin-letter read-back as the thing that ended a call', () => {
    for (const p of BOTH) {
      expect(p).toMatch(/k o r e n at gmail dot com/u);
      expect(p).toMatch(/hardest thing there is to verify/u);
    }
  });

  it('asks for the local part alone, as one word, and the domain separately', () => {
    for (const p of BOTH) {
      expect(p).toMatch(/תגיד לי את החלק שלפני השטרודל, כמילה אחת/u);
      expect(p).toMatch(/The domain is a separate question/u);
    }
  });

  it('reads it back in Hebrew as a WORD, and spells in HEBREW letter names only on a miss', () => {
    for (const p of BOTH) {
      expect(p).toMatch(/לפני השטרודל — קאסקורן\. ואחריו ג'ימייל נקודה קום\. נכון\?/u);
      expect(p).toMatch(/HEBREW letter names/u);
      expect(p).toMatch(/never the English ones/u);
    }
  });

  it('treats letters spread over several turns as ONE address, and bans the competing-options line', () => {
    // Verbatim from the call: "שמעתי גם k a f וגם k o r e n" — she handed him her own job.
    for (const p of BOTH) {
      expect(p).toMatch(/ONE address, not several versions of it/u);
      expect(p).toMatch(/שמעתי גם \.\.\. וגם \.\.\./u);
    }
  });

  it('forbids a rejected value from ever coming back — the model half of fact-memory reject()', () => {
    for (const p of BOTH) {
      expect(p).toMatch(/never spoken again and never saved/u);
      expect(p).toMatch(/a reading that comes out the same is a reading you have got wrong/u);
    }
  });

  it('does not smuggle a banned verification preamble back in with the new wording', () => {
    for (const banned of ['רק לוודא', 'רק שאדע', 'רק שאדייק', 'אני רוצה לוודא']) {
      const section = TOOLS_PROMPT.slice(
        TOOLS_PROMPT.indexOf('### The email address'),
        TOOLS_PROMPT.indexOf('### Booking mechanics'),
      );
      expect(section).not.toContain(banned);
    }
  });
});

/**
 * RULE 5 — not phrasing, permission. The commercially important half, and the one that is paired
 * with a tool change: `book_meeting`'s `email` is nullable behind the SAME flag, so she can never
 * be told to make a call the tool would refuse.
 */
describe('rule 5 — abandon the field, keep the meeting', () => {
  it('gives explicit permission to book with a null email after two failed read-backs', () => {
    expect(TOOLS_PROMPT).toMatch(/After two read-backs have failed, let the field go and keep the meeting/u);
    expect(TOOLS_PROMPT).toMatch(/`email` set to \*\*null\*\*/u);
    expect(TOOLS_PROMPT).toMatch(/This is allowed and it is what you should do/u);
  });

  it('names the loss in the booking mechanics too, where the tool order is decided', () => {
    expect(TOOLS_PROMPT).toMatch(/The email is the ONE argument that may be \*\*null\*\*/u);
    // Name and phone stay mandatory — book_meeting still requires both.
    expect(TOOLS_PROMPT).toMatch(/Name and phone are always required/u);
  });

  it('promises NO channel — the WhatsApp confirmation is blocked for a cold caller today', () => {
    // Established 2026-08-31 from whatsapp-window.ts + outbound-sender.worker.ts: no open 24h
    // window and no approved `meeting_confirmation` template → whatsapp_send_blocked, job dropped,
    // job returns success. So "אשלח לך אישור בוואטסאפ" is a promise the system cannot keep.
    const rule5 = TOOLS_PROMPT.slice(
      TOOLS_PROMPT.indexOf('5. **After two read-backs have failed'),
      TOOLS_PROMPT.indexOf('### Booking mechanics'),
    );
    expect(rule5).toMatch(/do not promise him a message on any channel/u);
    expect(rule5).not.toMatch(/וואטסאפ/u);
    expect(rule5).toMatch(/הצוות יחזור אליך עם הפרטים/u);
  });

  it('its spoken line breaks none of the rules the persona merge just landed', () => {
    const line = 'יש לי את הנייד שלךָ וזה מספיק — הצוות יחזור אליך עם הפרטים';
    expect(TOOLS_PROMPT).toContain(line);
    // No slang opener (Spoken Register forbids a first-word reaction under VOICE_INSTANT_ACK)...
    for (const slang of SPOKEN_REGISTER_SLANG) expect(line.startsWith(slang)).toBe(false);
    // ...no verification preamble, and no bare unstressed לא, which an 8kHz line drops.
    expect(line).not.toMatch(/רק לוודא|רק שאדע|רק שאדייק/u);
    expect(line).not.toMatch(/(^|\s)לא(\s|$)/u);
    // ...and it does not claim a booking before book_meeting returned.
    expect(line).not.toMatch(/קבעתי|סגרתי/u);
  });

  it('KILL-SWITCH: bookWithoutEmail=false removes rule 5 and NOTHING else', () => {
    const off = buildSystemPrompt({ toolsEnabled: true, bookWithoutEmail: false });
    expect(off).not.toMatch(/let the field go and keep the meeting/u);
    expect(off).not.toMatch(/The email is the ONE argument that may be/u);
    // Rules 1–4 are right either way and must survive.
    expect(off).toContain('### The email address');
    expect(off).toMatch(/לפני השטרודל — קאסקורן/u);
    expect(off).toMatch(/ONE address, not several versions of it/u);
    expect(off).toMatch(/never spoken again and never saved/u);
    // And the hard requirement is back, unqualified.
    expect(off).toMatch(/name, phone and email \(see above\) BEFORE you call `book_meeting`/u);
  });
});
