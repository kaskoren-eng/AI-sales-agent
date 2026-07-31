import { describe, expect, it } from 'vitest';
import { CallStateMachine } from './call-state.js';

/** A clock we control: returns whatever the array says, advancing one step per call. */
function fakeClock(times: number[]): () => number {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
}

describe('CallStateMachine — stages', () => {
  it('starts in opening with an opening entry at 0', () => {
    const m = new CallStateMachine({ now: fakeClock([1000]) });
    expect(m.stage).toBe('opening');
    expect(m.serialize().stage_history).toEqual([{ stage: 'opening', atMs: 0 }]);
  });

  it('first user turn leaves the greeting → discovery', () => {
    const m = new CallStateMachine({ now: fakeClock([0, 500]) });
    m.onUserTurn();
    expect(m.stage).toBe('discovery');
  });

  it('reaches qualifying after enough discovery turns (fallback signal)', () => {
    const m = new CallStateMachine({ now: fakeClock([0, 1, 2, 3, 4, 5]) });
    m.onUserTurn(); // →discovery
    m.onUserTurn();
    m.onUserTurn();
    expect(m.stage).toBe('discovery');
    m.onUserTurn(); // 4th → qualifying
    expect(m.stage).toBe('qualifying');
  });

  it('a qualification read advances discovery→qualifying immediately', () => {
    const m = new CallStateMachine({ now: fakeClock([0, 1, 2]) });
    m.onUserTurn(); // →discovery
    m.onToolCall('capture_lead_info', true, { qualification: 'hot' });
    expect(m.stage).toBe('qualifying');
  });

  it('check_calendar → scheduling, book_meeting success → closing', () => {
    const m = new CallStateMachine({ now: fakeClock([0, 1, 2, 3]) });
    m.onUserTurn();
    m.onToolCall('check_calendar_availability', true);
    expect(m.stage).toBe('scheduling');
    m.onToolCall('book_meeting', true);
    expect(m.stage).toBe('closing');
  });

  it('end_call → terminal, and isTerminal reports it', () => {
    const m = new CallStateMachine({ now: fakeClock([0, 1]) });
    m.onToolCall('end_call', true);
    expect(m.stage).toBe('terminal');
    expect(m.isTerminal()).toBe(true);
  });

  it('is monotonic — a late signal never regresses the stage', () => {
    const m = new CallStateMachine({ now: fakeClock([0, 1, 2, 3]) });
    m.onToolCall('book_meeting', true); // →closing
    m.onToolCall('check_calendar_availability', true); // would be scheduling — ignored
    expect(m.stage).toBe('closing');
  });

  it('a failed tool call does not advance the stage', () => {
    const m = new CallStateMachine({ now: fakeClock([0, 1]) });
    m.onUserTurn(); // discovery
    m.onToolCall('check_calendar_availability', false);
    expect(m.stage).toBe('discovery');
  });

  it('markTerminal forces terminal from anywhere', () => {
    const m = new CallStateMachine({ now: fakeClock([0, 1]) });
    m.onUserTurn();
    m.markTerminal();
    expect(m.stage).toBe('terminal');
  });
});

describe('CallStateMachine — working memory', () => {
  it('merges captured facts and coalesces (a blank never erases a known value)', () => {
    const m = new CallStateMachine({ now: fakeClock([0, 1, 2]) });
    m.onToolCall('capture_lead_info', true, { name: 'Dana', businessType: 'מכון כושר' });
    m.onToolCall('capture_lead_info', true, { businessType: '  ', budget: '5000₪' }); // blank businessType
    expect(m.facts).toEqual({ name: 'Dana', businessType: 'מכון כושר', budget: '5000₪' });
  });

  it('exposes facts as a copy (callers cannot mutate internal state)', () => {
    const m = new CallStateMachine({ now: fakeClock([0, 1]) });
    m.onToolCall('capture_lead_info', true, { name: 'Dana' });
    const f = m.facts;
    f.name = 'Someone else';
    expect(m.facts.name).toBe('Dana');
  });
});

describe('CallStateMachine — situations + serialize', () => {
  it('logs silence strikes, increments, and returns the running count', () => {
    const m = new CallStateMachine({ now: fakeClock([0, 100, 200]) });
    expect(m.onSilenceStrike()).toBe(1);
    expect(m.onSilenceStrike()).toBe(2);
    expect(m.silenceStrikes).toBe(2);
    const sits = m.serialize().situations;
    expect(sits).toHaveLength(2);
    expect(sits[0]).toMatchObject({ type: 'silence' });
  });

  it('notes a situation with detail and a timestamp from the clock', () => {
    const m = new CallStateMachine({ now: fakeClock([1000, 1250]) }); // start=1000, then 1250
    m.noteSituation('barge_in', 'false_interruption');
    expect(m.serialize().situations[0]).toEqual({ type: 'barge_in', atMs: 250, detail: 'false_interruption' });
  });

  it('serialize() carries final_stage, history, situations and working_memory', () => {
    const m = new CallStateMachine({ now: fakeClock([0, 1, 2, 3, 4]) });
    m.onUserTurn(); // →discovery
    m.onToolCall('capture_lead_info', true, { qualification: 'warm', painPoint: 'לידים אבודים' }); // →qualifying
    m.noteSituation('objection');
    const snap = m.serialize();
    expect(snap.final_stage).toBe('qualifying');
    expect(snap.stage_history.map((e) => e.stage)).toEqual(['opening', 'discovery', 'qualifying']);
    expect(snap.working_memory).toEqual({ qualification: 'warm', painPoint: 'לידים אבודים' });
    expect(snap.situations).toEqual([{ type: 'objection', atMs: expect.any(Number) }]);
  });
});
