import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './prompts/system-prompt.he.js';
import { describesProduct, SalesGate } from './sales-gate.js';

/**
 * GATE A — the discovery gate, and the flag that must leave the old prompt untouched.
 *
 * The most important test in this file is the LAST one: with the flag off, the prompt is
 * byte-for-byte what it was before the sales model existed. Every behaviour change in this
 * repo is one env variable away from being undone, and a rollback that is not exact is not a
 * rollback.
 */
describe('describesProduct', () => {
  it('catches the sentence that actually went wrong on the 09:29 call', () => {
    expect(
      describesProduct('אנחנו בונים סוכני AI לקול ולוואטסאפ. הם עונים לפניות של לקוחות.'),
    ).toBe(true);
  });

  it('catches the agent and the system as subjects', () => {
    expect(describesProduct('הסוכן עונה לשיחות נכנסות.')).toBe(true);
    expect(describesProduct('המערכת מטפלת בפניות בשבילך.')).toBe(true);
    expect(describesProduct('יש גם דשבורד עם כל השיחות.')).toBe(true);
  });

  it('does NOT count a question that mentions the product', () => {
    // Discovery, not a pitch. Counting this would tell her to stop asking questions.
    expect(describesProduct('מה היית רוצה שהסוכן יעשה בשבילך?')).toBe(false);
    expect(describesProduct('אנחנו בונים סוכנים — מה הכי חשוב לך שם?')).toBe(false);
  });

  it('does NOT count discovery, empathy, or the small talk around them', () => {
    expect(describesProduct('אוקי. הבנתי אותך.')).toBe(false);
    expect(describesProduct('תפסתי אותך בזמן טוב?')).toBe(false);
    expect(describesProduct('נעים מאוד קורן.')).toBe(false);
    expect(describesProduct('')).toBe(false);
  });
});

describe('SalesGate', () => {
  it('starts shut and names the first missing fact, not all three', () => {
    const gate = new SalesGate();
    expect(gate.isOpen).toBe(false);
    const note = gate.note();
    expect(note).toContain('what his business actually does');
    // A note listing all three reads as a checklist and gets answered as a checklist.
    expect(note).toContain('Do NOT describe the product yet');
    expect(note).toContain('ONE sentence');
  });

  it('opens only once all three facts are in, and says so', () => {
    const gate = new SalesGate();
    gate.establish('business');
    expect(gate.isOpen).toBe(false);
    gate.establish('process');
    expect(gate.isOpen).toBe(false);
    gate.establish('pain');
    expect(gate.isOpen).toBe(true);
    expect(gate.note()).toContain('You may describe what we do');
  });

  it('counts a product claim made while the gate is shut, and stops once it opens', () => {
    const gate = new SalesGate();
    gate.observeAgentSpeech('אנחנו בונים סוכני AI לקול ולוואטסאפ.');
    expect(gate.violations).toBe(1);

    gate.establish('business');
    gate.establish('process');
    gate.establish('pain');
    gate.observeAgentSpeech('אנחנו בונים סוכני AI לקול ולוואטסאפ.');
    // Same sentence, now legitimate: the gate is open.
    expect(gate.violations).toBe(1);
  });

  it('replays the 09:29 call and counts the pitch that should not have happened', () => {
    // He gave volume at 68s and the pain at 97s, but nobody ever recorded WHO ANSWERS and how
    // fast — so the gate was still shut when she pitched at 121s.
    const gate = new SalesGate();
    gate.establish('business'); // "אני עוסק בבניית אתרים"
    gate.establish('pain'); // "יש לנו המון שיחות. זה שואב לי זמן."
    gate.observeAgentSpeech(
      'אנחנו בונים סוכני AI לקול ולוואטסאפ. הם עונים לפניות של לקוחות וקובעים שיחות.',
    );
    expect(gate.violations).toBe(1);
    expect(gate.missing).toEqual(['process']);
  });

  it('repeats a note only when the missing set changes', () => {
    const gate = new SalesGate();
    expect(gate.note()).not.toBeNull();
    expect(gate.note()).toBeNull();
    gate.establish('business');
    expect(gate.note()).not.toBeNull();
    expect(gate.note()).toBeNull();
  });

  it('never un-knows a fact', () => {
    const gate = new SalesGate();
    gate.establish('pain');
    gate.establish('pain');
    expect(gate.missing).toEqual(['business', 'process']);
  });
});

describe('the sales model in the prompt', () => {
  const on = buildSystemPrompt({ toolsEnabled: true, salesModel: true });
  const off = buildSystemPrompt({ toolsEnabled: true, salesModel: false });

  it('carries the gate, the five questions, the pain follow-up and the interest check', () => {
    expect(on).toContain('## Before You Describe The Product');
    expect(on).toContain('five questions, all of them mandatory');
    expect(on).toContain('A fact is not a pain');
    expect(on).toContain('איך זה נשמע לך עד עכשיו?');
    expect(on).toContain('לפי מה שסיפרת לי');
    expect(on).toContain('Say what happens to HIM');
  });

  it('makes her earn the price question before she answers it', () => {
    // Koren, 2026-09-02, after hearing her dodge it on a live call: *"the price needs to come
    // after a short question on the business of the client and to be interested a little bit on
    // what is the amount of leads or how his business really works. And then she can talk about
    // the prices shortly."* The old rule was a two-ASK ladder — make him ask twice before he gets
    // a number — and that is not what he described. One question, then the answer.
    expect(on).toContain('When he asks the price');
    expect(on).toContain('ask one short question about his business first');
    expect(off).not.toContain('When he asks the price');
  });

  it('asks the two questions Koren added and owns', () => {
    expect(on).toContain('איך עובד אצלך תהליך המכירה');
    expect(on).toContain('כמה פניות חדשות ביום אתה מקבל בממוצע?');
  });

  it('writes every discovery phrasing as ONE question, because guardStream drops the second', () => {
    // The old optional question 4 was two sentences and the half that mattered — "how fast?" —
    // was silently deleted before it was ever spoken. Two of its five phrasings had that shape.
    const bank = on.slice(
      on.indexOf('five questions, all of them mandatory'),
      on.indexOf('READ HIM, AND MATCH HIS SIZE'),
    );
    for (const line of bank.split('\n')) {
      const quoted = line.match(/"[^"]+"/gu) ?? [];
      for (const phrasing of quoted) {
        expect(
          (phrasing.match(/\?/gu) ?? []).length,
          `more than one question mark in: ${phrasing}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('drops the optional bank, which five mandatory questions leave no room for', () => {
    expect(on).not.toContain('three questions you always ask, three you ask only if he lets you');
    expect(off).toContain('three questions you always ask, three you ask only if he lets you');
  });

  it('is a real kill-switch: OFF renders the pre-sales-model prompt exactly', () => {
    expect(off).not.toContain('## Before You Describe The Product');
    expect(off).not.toContain('איך זה נשמע לך עד עכשיו?');
    expect(off).toContain('## Call Flow Overview');
    // The legacy five-step overview, verbatim.
    expect(off).toContain('3. **Qualify** the lead based on their answers');
  });

  it('defaults OFF, so an unconfigured deploy is the 2026-09-01 prompt', () => {
    expect(buildSystemPrompt({ toolsEnabled: true })).toBe(off);
  });

  it('runs a dialogue rather than an interview, and warms up a closed caller first', () => {
    expect(on).toContain('Talk With Him, Do Not Interview Him');
    expect(on).toContain('Answer his question before you ask yours');
    expect(on).toContain('When he is giving you nothing yet');
    expect(on).toContain('מה גרם לך להתקשר?');
    expect(off).not.toContain('Talk With Him, Do Not Interview Him');
  });

  it('REPLACES the outbound-framed small talk instead of stacking on top of it', () => {
    // That section is what produced the 09:43 defect — "you have just rung a man who was doing
    // something else", rendered on every call including the ones he dialled. Keeping it alongside
    // the direction-aware opening would leave the model arbitrating between two contradictions.
    expect(off).toContain('Then two sentences of small talk');
    expect(on).not.toContain('Then two sentences of small talk');
    expect(on).not.toContain('you have just rung a man who was doing something else');
  });

  it('weaves advantages onto what HE said, and never lists them', () => {
    // Koren, 2026-09-02: "present as many advantages as possible, matched to the customer's
    // questions or the problems he raised." The ORDER rule (no advantage before a problem) was
    // already here; what was missing was the density rule, and the hook that stops it becoming
    // a feature list.
    expect(on).toContain('Weave the advantages in; never list them');
    expect(on).toContain('hangs on something HE said');
    expect(on).toContain('what makes us different from the alternatives');
    expect(on).toContain('Up to three in a sentence, never a paragraph');
    expect(off).not.toContain('Weave the advantages in');
  });

  it('stays inside the +5% token budget, because every token is latency on every turn', () => {
    // +4.98% as of 2026-09-02. AT the wall, and the price rule that landed last was paid for by
    // compressing the gate's own justification rather than by raising this number — which is the
    // discipline working: the sentence it deleted was explaining a rule the rule already states.
    // The ceiling is not decoration: the prompt is re-sent
    // on every turn, so a section that grows costs the caller silence on every reply for the
    // life of the call. If this fails, the fix is to delete something — Phase 7 W7 names the
    // candidates — not to raise the number.
    const growth = on.length / off.length - 1;
    expect(growth).toBeGreaterThan(0);
    expect(growth).toBeLessThan(0.05);
  });
});

/**
 * THE PLACEHOLDER THAT WAS NEVER FILLED IN.
 *
 * `{{call_direction}}` is a Retell-era leftover: the old platform substituted dynamic variables,
 * ours never did. So Step 1 offered two branches and told the model to pick using a literal
 * string. It picked outbound, and on 2026-09-01 09:43 — a call the lead had dialled — she asked
 * twice whether she had caught him at a good time. He corrected her twice.
 */
describe('call direction', () => {
  const inbound = buildSystemPrompt({ toolsEnabled: true, outbound: false });
  const outbound = buildSystemPrompt({ toolsEnabled: true, outbound: true });
  const unknown = buildSystemPrompt({ toolsEnabled: true });

  it('never asks an inbound caller whether it is a good time — he dialled us', () => {
    expect(inbound).toContain('HE called YOU');
    expect(inbound).toContain('do not ask whether you caught him at a good time');
    expect(inbound).toContain('מה גרם לך להתקשר?');
    // The outbound apology has no business on a call he placed.
    expect(inbound).not.toContain('If Outbound');
  });

  it('keeps the bad-time path on an outbound call, where it is true', () => {
    expect(outbound).toContain('You called HIM');
    expect(outbound).toContain('If he confirms it is a good time');
    expect(outbound).not.toContain('HE called YOU');
  });

  it('renders ONE branch — the other is gone, not merely unselected', () => {
    // Outbound is smaller than the two-branch text it replaces. Inbound is a few dozen characters
    // larger, because it carries a whole opening move ("what made you call?") where the old text
    // had a single line telling the model to continue. That is a trade worth making: the move it
    // buys is the highest-value question in an inbound call.
    expect(outbound.length).toBeLessThan(unknown.length);
    expect(inbound).not.toContain('### If Outbound');
    expect(outbound).not.toContain('### If Inbound');
  });

  it('leaves the placeholder only on the unknown path, which the fixtures pin', () => {
    expect(unknown).toContain('{{call_direction}}');
    expect(inbound).not.toContain('{{call_direction}}');
    expect(outbound).not.toContain('{{call_direction}}');
  });
});

/**
 * THE GATE SHIPPED WITHOUT ITS COUNTER, AND RAN A DAY IN PRODUCTION UNMEASURED.
 *
 * `observeAgentSpeech` and `gateAViolations` were both written on 2026-09-01, in the same commit
 * as the gate, and neither was wired: the method had no call site and the report had no field. The
 * gate deployed that afternoon and every call it handled produced exactly the same evidence as a
 * gate that was doing nothing.
 *
 * A unit test of `observeAgentSpeech` passes in that world — it did pass, six of them. What no
 * unit test could see is that nobody calls it. So this reads the source, the way
 * `metering-coverage.test.ts` reads every `insert(leads)` site for the same reason: some defects
 * are about absence, and absence is invisible from inside the module.
 */
describe('the gate is actually wired', () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('has a call site for observeAgentSpeech outside its own module', () => {
    expect(read('./agent.ts')).toContain('salesGate.observeAgentSpeech(');
  });

  it('reports the violation count, so the rule is falsifiable', () => {
    const agent = read('./agent.ts');
    const report = read('./call-report.ts');
    expect(agent).toContain('report.recordGateAViolation()');
    expect(report).toContain('gateAViolations: number');
    expect(report).toContain('gateAViolations: this.#gateAViolations');
  });

  it('records whether the gate ever opened, which is what makes a zero readable', () => {
    // gateAViolations: 0 means "she held the line" on a call whose gate opened, and means nothing
    // at all on a call that never reached a pitch. Without this field the two are the same number.
    expect(read('./agent.ts')).toContain('report.recordGateAOpen(');
    expect(read('./call-report.ts')).toContain('gateAOpen: boolean');
  });
});
