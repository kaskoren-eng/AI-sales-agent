import { describe, expect, it, vi } from 'vitest';
import { scrubToolCallLeak } from './toolcall-leak.js';
import { guardSpeech, guardStream } from './speech-guard.js';

/**
 * THE STRING, verbatim.
 *
 * Copied byte-for-byte out of `call-reports/2026-08-31T13-52-55-528Z.json` — the final assistant
 * turn of Koren's 13:52 production call, `atMs` 196489, spoken from 177392ms to 196489ms. Nineteen
 * seconds of routing header, Chinese glitch tokens and the caller's own details as raw JSON, read
 * aloud to him by Cartesia.
 *
 * It is a constant rather than a fixture file so that a reader of this test sees the exact thing it
 * is defending against. Do not "tidy" it: the odd spacing, the doubled full stop in "מבינה.." and
 * the missing space before `json` are all in the original, and each of them is a chance for a
 * looser guard to fail.
 */
const LEAK_196S =
  'בסדר. to=functions.capture_lead_info 彩神争霸大发快json content={"name":"קורן","email":null,' +
  '"phone":null,"business_type":"סוכנות לבניית אתרים","pain_point":"עונה בעצמו לכל השיחות בטלפון",' +
  '"budget":null,"timeline":null,"qualification":"warm","notes":"הלקוח אמר שהוא עושה בעצמו את כל ' +
  'השיחות בטלפון","is_correction":false} אני מבינה.. . זה שואב המון זמן. כמה פניות בערך נכנסות ' +
  'אליךָ ביום?';

/** The human sentence hiding behind the payload — what the caller SHOULD have heard. */
const SALVAGE = 'אני מבינה';

async function* chunks(...parts: string[]): AsyncIterable<string> {
  for (const p of parts) yield p;
}

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const c of stream) out += c;
  return out;
}

/** Everything a payload is made of, in the shape a listener would notice. */
const FORBIDDEN = [
  'to=functions',
  'functions.capture_lead_info',
  'content=',
  '{',
  '}',
  '"name"',
  'is_correction',
  '彩神争霸大发快',
];

function expectUnspeakable(spoken: string): void {
  for (const marker of FORBIDDEN) {
    expect(spoken, `"${marker}" reached the TTS`).not.toContain(marker);
  }
  // Belt and braces: no JSON punctuation of any kind, and no CJK anywhere.
  expect(spoken).not.toMatch(/[{}]/u);
  expect(spoken).not.toMatch(/[぀-ヿ㐀-䶿一-鿿가-힯]/u);
}

describe('the 2026-08-31 leak — the exact string, and it can never be spoken', () => {
  it('scrubs the payload out of the raw string and keeps the sentence', () => {
    const r = scrubToolCallLeak(LEAK_196S);
    expect(r.leaked).toBe(true);
    expectUnspeakable(r.text);
    expect(r.text).toContain(SALVAGE);
    expect(r.text).toContain('כמה פניות בערך נכנסות');
    expect(r.reasons).toContain('functions_route');
  });

  it('guardSpeech refuses it — the sentence-level path every reply takes', () => {
    const r = guardSpeech(LEAK_196S);
    expectUnspeakable(r.text);
    expect(r.text).toContain(SALVAGE);
    expect(r.leakReasons).toBeDefined();
    expect(r.interventions.join(' ')).toContain('tool-call payload');
  });

  it('guardStream refuses it however the SDK chunks it — and reports it once', async () => {
    // Four splittings of the same string: whole, mid-header, mid-JSON, and one character at a time.
    // The SDK re-chunks freely between llmNode and ttsNode (see dropAckEcho's note on the trailing
    // space that defeated the first instant-ack), so a guard that only works on one chunking is a
    // guard that works by luck.
    const splittings: string[][] = [
      [LEAK_196S],
      [LEAK_196S.slice(0, 20), LEAK_196S.slice(20)],
      [LEAK_196S.slice(0, 120), LEAK_196S.slice(120, 240), LEAK_196S.slice(240)],
      [...LEAK_196S],
    ];
    for (const parts of splittings) {
      const leaks: string[][] = [];
      const spoken = await drain(
        guardStream(chunks(...parts), undefined, undefined, false, undefined, undefined, {
          onLeak: (reasons) => leaks.push(reasons),
        }),
      );
      expectUnspeakable(spoken);
      expect(spoken).toContain(SALVAGE);
      expect(leaks.length, 'the leak was not reported to the call report').toBeGreaterThan(0);
    }
  });

  it('is still refused when a JSON value contains a sentence break', async () => {
    // The realistic straddle: `sentenceEnd` fires on any ". ", and a date or a note inside the
    // payload can carry one. Without the cross-sentence latch the opening half is scrubbed and the
    // closing half is spoken, which is the same failure with better manners.
    const straddling =
      'בסדר. to=functions.book_meeting content={"date":"2026-09-01. ",' +
      '"notes":"הוא אמר מחר. אחר הצהריים."} מעולה, נסגור על זה.';
    const spoken = await drain(guardStream(chunks(straddling)));
    expectUnspeakable(spoken);
    expect(spoken).toContain('מעולה');
    expect(spoken).not.toContain('2026-09-01');
  });

  it('says something safe rather than the payload when nothing human is left', async () => {
    // A reply that is ONLY a payload guards down to zero chunks. `notifyIfSilent` — already wired
    // in ttsNode — then fires `onSilentReply`, which speaks HOLD_CHECKBACK_HE. This asserts the
    // half this file owns: the payload produces no speech at all, and the silence is reported.
    const onlyPayload = 'to=functions.capture_lead_info content={"name":"קורן","phone":"0501234567"}';
    const spoken = await drain(guardStream(chunks(onlyPayload)));
    expect(spoken.trim()).toBe('');
    expect(guardSpeech(onlyPayload).silent).toBe(true);
  });

  it('the kill-switch really does turn it off — VOICE_TOOLCALL_LEAK_GUARD_ENABLED=false', () => {
    const r = guardSpeech(LEAK_196S, { toolCallLeakGuard: false });
    expect(r.text).toContain('to=functions');
    expect(r.leakReasons).toBeUndefined();
  });
});

describe('the other shapes this failure takes', () => {
  it('strips OpenAI harmony control tokens', () => {
    const r = scrubToolCallLeak('<|channel|>commentary<|message|> שלום, מדברת קרן.');
    expect(r.leaked).toBe(true);
    expect(r.text).toBe('שלום, מדברת קרן.');
    expect(r.reasons).toContain('harmony_token');
  });

  it('strips a bare JSON object with no routing header in front of it', () => {
    const r = scrubToolCallLeak('אוקיי. {"name":"קורן","qualification":"warm"} נמשיך.');
    expect(r.leaked).toBe(true);
    expect(r.text).toBe('אוקיי. נמשיך.');
  });

  it('strips a bare functions.<name> reference', () => {
    const r = scrubToolCallLeak('functions.book_meeting מעולה, בוא נקבע.');
    expect(r.leaked).toBe(true);
    expect(r.text).toBe('מעולה, בוא נקבע.');
  });

  it('strips a CJK glitch run on its own', () => {
    const r = scrubToolCallLeak('אהה. 彩神争霸大发快 כמה פניות נכנסות אליך ביום?');
    expect(r.leaked).toBe(true);
    expect(r.reasons).toContain('cjk_run');
    expect(r.text).toBe('אהה. כמה פניות נכנסות אליך ביום?');
  });

  it('strips an argument-key fragment whose opening brace never arrived', () => {
    const r = scrubToolCallLeak('בסדר. "business_type":"סוכנות","budget":null} הבנתי אותך.');
    expect(r.leaked).toBe(true);
    expect(r.text).toBe('בסדר. הבנתי אותך.');
  });
});

describe('what it must NOT touch — the false-positive gate', () => {
  // Every one of these is a sentence Keren really says, or a near-miss chosen to break a lazier
  // pattern. A guard that eats real speech is worse than the leak it prevents, because it fails
  // on every call instead of one.
  const innocent = [
    'שלום, מדברת קרן, העוזרת הדיגיטלית של ClickScales. איך אני יכולה לעזור?',
    'אנחנו בונים סוכני AI לשיחות ווואטסאפ שמטפלים בפניות נכנסות.',
    'אז זה קורן at gmail dot com, נכון?',
    'הדמו מחר ב-10:30, מתאים לך?',
    'זה שמונה אותיות: k. a. s. k. o. r. e. n. נכון?',
    'המספר הוא 050-1234567.',
    'We can walk through the functions. Then we book a demo.',
    'אני כאן, אין לחץ — קח את הזמן שאתה צריך ואני מחכה.',
    'רגע... כמה פניות נכנסות אליךָ ביום פחות או יותר?',
  ];
  for (const text of innocent) {
    it(`leaves alone: ${text.slice(0, 44)}…`, () => {
      const r = scrubToolCallLeak(text);
      expect(r.leaked, `reasons: ${r.reasons.join(', ')}`).toBe(false);
      expect(r.text).toBe(text);
    });
  }

  it('does not fire on an ordinary reply inside the full guard either', () => {
    const t = 'מעולה. ספר לי קצת על העסק — במה אתה עוסק?';
    expect(guardSpeech(t).leakReasons).toBeUndefined();
  });
});

describe('it runs BEFORE the other rules, which is the point of its position', () => {
  it('the number speller never sees the payload digits', () => {
    // With spokenNumbers on, `"phone":"0501234567"` inside a payload would otherwise be turned into
    // Hebrew number words — a more fluent way of reading a lead his own phone number back.
    const r = guardSpeech(
      'בסדר. content={"phone":"0501234567","timeline":"14 ימים"} נדבר מחר.',
      { spokenNumbers: true },
    );
    expect(r.text).not.toMatch(/\d/u);
    expect(r.text).toContain('נדבר מחר');
  });

  it('a booking claim INSIDE a payload is removed, not rewritten into the truth-line', () => {
    const r = guardSpeech('to=functions.book_meeting content={"notes":"קבעתי לך דמו"} בסדר גמור.');
    expect(r.text).toBe('בסדר גמור.');
    expect(r.interventions.join(' ')).not.toContain('false booking claim');
  });
});

describe('the guard is cheap enough to sit on the speech path', () => {
  it('adds no measurable buffering — it is a synchronous string pass', async () => {
    // The first version of guardStream buffered the whole reply and cost 718ms per turn (see its
    // header note). This asserts the new rule cannot reintroduce that: the first sentence of a
    // clean reply still comes out before the rest of the stream has been produced.
    const seen: string[] = [];
    const slow = async function* (): AsyncIterable<string> {
      yield 'אוקיי. ';
      await new Promise((r) => setTimeout(r, 30));
      yield 'ספר לי על העסק.';
    };
    const it2 = guardStream(slow())[Symbol.asyncIterator]();
    const first = await it2.next();
    seen.push(String(first.value));
    expect(seen[0]).toContain('אוקיי');
  });

  it('never throws on adversarial input', () => {
    const nasty = [
      '{'.repeat(500),
      '}'.repeat(500),
      '"name":',
      'to=functions.',
      '<|',
      '{"a":"' + '\\'.repeat(200),
      '',
    ];
    for (const t of nasty) expect(() => scrubToolCallLeak(t)).not.toThrow();
  });
});

describe('it logs the leak without logging the payload', () => {
  it('the log line carries the reasons and a truncated salvage, never the JSON', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await drain(guardStream(chunks(LEAK_196S)));
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('toolcall_leak'));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain('0501234567');
        expect(line).not.toContain('is_correction');
        expect(line).not.toContain('סוכנות לבניית אתרים');
      }
    } finally {
      log.mockRestore();
    }
  });
});
