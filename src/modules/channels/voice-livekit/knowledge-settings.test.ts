import { describe, it, expect } from 'vitest';
import { readKnowledgeSettings } from './knowledge-settings.js';
import { CallStateMachine } from './call-state.js';
import { buildSystemPrompt } from './prompts/system-prompt.he.js';
import { KNOWLEDGE_MARKER } from './knowledge-injector.js';

describe('readKnowledgeSettings — absent or malformed means OFF', () => {
  it('is off for absent, null and non-object settings', () => {
    for (const input of [undefined, null, 'nope', 42, {}, { knowledge_base: null }]) {
      expect(readKnowledgeSettings(input).enabled, JSON.stringify(input)).toBe(false);
    }
  });

  it('requires enabled === true, not merely truthy', () => {
    // The string "false" is truthy. Operator-editable JSON must not be able to enable this by accident.
    expect(readKnowledgeSettings({ knowledge_base: { enabled: 'false' } }).enabled).toBe(false);
    expect(readKnowledgeSettings({ knowledge_base: { enabled: 1 } }).enabled).toBe(false);
    expect(readKnowledgeSettings({ knowledge_base: { enabled: true } }).enabled).toBe(true);
  });

  it('applies defaults when the tuning fields are absent', () => {
    const s = readKnowledgeSettings({ knowledge_base: { enabled: true } });
    expect(s).toEqual({ enabled: true, topK: 3, minScore: 0.3 });
  });

  it('clamps top_k rather than trusting it — a huge value is the prompt-stuffing RAG replaced', () => {
    expect(readKnowledgeSettings({ knowledge_base: { enabled: true, top_k: 500 } }).topK).toBe(8);
    expect(readKnowledgeSettings({ knowledge_base: { enabled: true, top_k: 0 } }).topK).toBe(1);
    expect(readKnowledgeSettings({ knowledge_base: { enabled: true, top_k: 'lots' } }).topK).toBe(3);
  });

  it('clamps min_score into [0,1]', () => {
    expect(readKnowledgeSettings({ knowledge_base: { enabled: true, min_score: 9 } }).minScore).toBe(1);
    expect(readKnowledgeSettings({ knowledge_base: { enabled: true, min_score: -1 } }).minScore).toBe(0);
    expect(readKnowledgeSettings({ knowledge_base: { enabled: true, min_score: 0.5 } }).minScore).toBe(0.5);
  });
});

describe('CallStateMachine.ragActive — the phase gate', () => {
  it('is off during the greeting', () => {
    expect(new CallStateMachine().ragActive).toBe(false);
  });

  it('is on through discovery and qualifying', () => {
    const m = new CallStateMachine();
    m.onUserTurn(); // opening → discovery
    expect(m.ragActive).toBe(true);
    m.onToolCall('capture_lead_info', true, { qualification: 'hot' }); // → qualifying
    expect(m.ragActive).toBe(true);
  });

  it('goes off the moment booking starts — those turns need speed, not prose', () => {
    const m = new CallStateMachine();
    m.onUserTurn();
    m.onToolCall('check_calendar_availability', true); // → scheduling
    expect(m.ragActive).toBe(false);
  });

  it('stays off while the booking is actively progressing', () => {
    const m = new CallStateMachine();
    m.onUserTurn();
    m.onToolCall('check_calendar_availability', true);
    m.onUserTurn(); // caller picks a slot — still booking
    expect(m.ragActive).toBe(false);
  });

  it('comes back on when the booking stalls — the abandoned-booking case', () => {
    const m = new CallStateMachine();
    m.onUserTurn();
    m.onToolCall('check_calendar_availability', true);
    m.onUserTurn();
    m.onUserTurn(); // two turns with no scheduling tool: he has gone back to asking questions
    expect(m.ragActive).toBe(true);
  });

  it('goes off again as soon as booking resumes', () => {
    const m = new CallStateMachine();
    m.onUserTurn();
    m.onToolCall('check_calendar_availability', true);
    m.onUserTurn();
    m.onUserTurn();
    expect(m.ragActive).toBe(true);
    m.onToolCall('book_meeting', true);
    expect(m.ragActive).toBe(false);
  });

  it('is off once the call is terminal', () => {
    const m = new CallStateMachine();
    m.onUserTurn();
    m.markTerminal();
    expect(m.ragActive).toBe(false);
  });

  /** The whole reason this is a derived getter: `stage` is an analytics contract and must stay monotonic. */
  it('never regresses the stage while re-enabling retrieval', () => {
    const m = new CallStateMachine();
    m.onUserTurn();
    m.onToolCall('check_calendar_availability', true);
    m.onUserTurn();
    m.onUserTurn();
    expect(m.ragActive).toBe(true);
    expect(m.stage).toBe('scheduling');
    expect(m.serialize().stage_history.map((e) => e.stage)).toEqual(['opening', 'discovery', 'scheduling']);
  });
});

describe('buildSystemPrompt — the grounding block', () => {
  it('adds nothing at all when RAG is off (the flag is a real rollback)', () => {
    const off = buildSystemPrompt({ toolsEnabled: true });
    const explicitlyOff = buildSystemPrompt({ toolsEnabled: true, ragEnabled: false });
    expect(off).toBe(explicitlyOff);
    expect(off).not.toContain(KNOWLEDGE_MARKER);
    expect(off).not.toContain('## KNOWLEDGE');
  });

  it('adds the grounding rules when RAG is on, and only appends', () => {
    const off = buildSystemPrompt({ toolsEnabled: true });
    const on = buildSystemPrompt({ toolsEnabled: true, ragEnabled: true });
    expect(on).toContain('## KNOWLEDGE');
    expect(on).toContain(KNOWLEDGE_MARKER);
    expect(on.length).toBeGreaterThan(off.length);
  });

  it('forbids guessing, and promises follow-up rather than a transfer we cannot do', () => {
    const on = buildSystemPrompt({ toolsEnabled: true, ragEnabled: true });
    expect(on).toMatch(/NEVER guess a price/);
    expect(on).toMatch(/team will follow up/);
    // We have no live-transfer feature; promising one would be an invented commitment.
    expect(on).not.toMatch(/transfer .*specialist/i);
  });

  it('forbids naming sources — she must not narrate the context she was handed', () => {
    const on = buildSystemPrompt({ toolsEnabled: true, ragEnabled: true });
    expect(on).toMatch(/Never mention documents, sources/);
  });

  it('names the same marker the injector actually writes', () => {
    // If these two drift apart, the grounding rules refer to a label that never appears and she has
    // no idea the facts in front of her are the ones she is allowed to use.
    expect(buildSystemPrompt({ toolsEnabled: true, ragEnabled: true })).toContain(KNOWLEDGE_MARKER);
  });
});

describe('buildSystemPrompt — slimKnowledge', () => {
  const profile = {
    companyName: 'ClickScales',
    description: 'סוכנת קולית',
    product: 'סוכנת קולית דיגיטלית',
    targetAudience: 'עסקים קטנים',
    pricing: 'חבילת בסיס 1,490 ש"ח לחודש',
    commonObjections: 'יקר לי',
    toneOfVoice: 'ישיר',
    language: 'he',
  };

  it('changes nothing when off — the default path is untouched', () => {
    expect(buildSystemPrompt({ toolsEnabled: true, slimKnowledge: false })).toBe(
      buildSystemPrompt({ toolsEnabled: true }),
    );
  });

  it('removes the FAQ bank and the objection playbook', () => {
    const full = buildSystemPrompt({ toolsEnabled: true });
    const slim = buildSystemPrompt({ toolsEnabled: true, ragEnabled: true, slimKnowledge: true });
    expect(full).toContain('## Objection Handling');
    expect(slim).not.toContain('## Objection Handling');
    expect(slim.length).toBeLessThan(full.length);
  });

  it('removes the per-tenant business facts, so pricing has ONE source of truth', () => {
    // The duplication this prevents: a price in settings.businessProfile AND in the knowledge base,
    // where the prompt copy is the one nobody remembers to update.
    const full = buildSystemPrompt({ toolsEnabled: true, businessProfile: profile });
    const slim = buildSystemPrompt({
      toolsEnabled: true,
      businessProfile: profile,
      ragEnabled: true,
      slimKnowledge: true,
    });
    expect(full).toContain('1,490');
    expect(slim).not.toContain('1,490');
    expect(slim).not.toContain('Business Context');
  });

  /**
   * THE TWO SECTIONS THAT MAY NEVER BE SLIMMED. The booking mechanics were written line by line after
   * real call failures, and the security rules are pinned by 20 injection tests. Together they are 844
   * of the prompt's words, which is why a 300-400 word prompt was never reachable.
   */
  it('keeps the security rules and the booking mechanics intact', () => {
    const slim = buildSystemPrompt({ toolsEnabled: true, ragEnabled: true, slimKnowledge: true });
    expect(slim).toContain('CRITICAL SECURITY RULES');
    expect(slim).toContain('Step 4');
    expect(slim).toContain('book_meeting');
    expect(slim).toMatch(/NEVER claim a meeting is booked/i);
    expect(slim).toContain('YOU MUST COLLECT HIS DETAILS BEFORE BOOKING');
  });

  it('keeps the call flow and her identity — slimming removes knowledge, not behaviour', () => {
    const slim = buildSystemPrompt({ toolsEnabled: true, ragEnabled: true, slimKnowledge: true });
    expect(slim).toContain('## Role');
    expect(slim).toContain('## Call Flow Overview');
    expect(slim).toContain('## Step 1');
    expect(slim).toContain('## Step 2');
    expect(slim).toContain('## Step 3');
  });

  it('still carries the grounding rules — the replacement for what it removed', () => {
    const slim = buildSystemPrompt({ toolsEnabled: true, ragEnabled: true, slimKnowledge: true });
    expect(slim).toContain('## KNOWLEDGE');
  });
});
