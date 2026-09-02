/**
 * THE PAGE KOREN OPENS AND LISTENS TO.
 *
 * Every number this harness produces is a proxy. The thing being optimised — "does she sound like
 * a human on the phone" — has no metric, and the person who can judge it is not a developer and
 * does not read a terminal. So a run ends in a browser page with the clips on it, laid out exactly
 * like `tests/hebrew-tts-niqqud-ab/index-round6.html`, which is the format that has actually
 * produced decisions in this project: one card per item, one column per variant, a radio to pick
 * the winner, a note field, and a "צור סיכום" button that emits a pasteable verdict.
 *
 * Two clips are written for every reply, and the PHONE one is the one to judge: a call is 8kHz
 * narrowband end to end, and a voice that is lovely at 24kHz can be unintelligible on a phone.
 * See wav.ts.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PipelineSnapshot } from '../pipeline-observer.js';
import { encodeWav, toPhoneRate } from './wav.js';
import { CAPTURE_RATE, type CallResult } from './synthetic-caller.js';
import { alignTranscript } from './transcript-align.js';
import { engineFromPipeline, engineSlug } from './tts-engine.js';

/** What the page says when the call report could not confirm which engine spoke. */
const UNVERIFIED = 'engine UNVERIFIED (no call report)';

const PHONE_RATE = 8_000;

export interface VariantSummary {
  /** 'A', 'B', … — the label a human uses when saying which one won. */
  key: string;
  /** What this variant IS, in words. Shown above every clip. */
  label: string;
  /** The env overrides that define it. */
  overrides: Record<string, string>;
  /**
   * What the agent's own pipeline observer said this call actually resolved to. Null when no call
   * report could be matched — in which case nothing here has been PROVEN and the page says so.
   */
  pipeline: PipelineSnapshot | null;
}

export interface TurnRow {
  said: string;
  agentSaid: string | null;
  deadAirMs: number | null;
  agentSpokeMs: number;
  cutOff: boolean;
  /**
   * THE PRIMARY PLAYER: the caller's line, then the real dead air, then her reply — 8kHz.
   *
   * A reply on its own cannot be judged. Koren's words after the first A/B page: "the other
   * variants started in the middle of the script — wasn't good for a test either." An exchange is
   * the smallest unit of conversation a human can score for naturalness, so it is the unit the
   * card plays.
   */
  exchangeWav: string | null;
  /** Her reply alone, 8kHz — for hearing the voice itself without the run-up. */
  phoneWav: string | null;
  /** Her reply alone, 24kHz studio. Not for judging phone quality. */
  studioWav: string | null;
}

export interface VariantRun {
  key: string;
  /** `lk.agent.name` of the worker that actually answered — the anti-"was this even my code" check. */
  agentName: string | null;
  /**
   * THE ENGINE THAT SPOKE HER HALF, read back off the agent's own call report. Null = the report
   * was not found, so it is UNVERIFIED and the page must say so rather than assume Cartesia.
   *
   * Rounds on this project have already been judged on Cartesia audio during the week we decided
   * to leave Cartesia. A clip whose engine is not on its face is a verdict waiting to be
   * misattributed, so this ends up in the filename, on the card, and in the pasteable summary.
   */
  agentEngine: string | null;
  /** The engine the SYNTHETIC CALLER spoke with — the other voice in every exchange clip. */
  callerEngine: string | null;
  /** Whole call, both voices, 8kHz — the one to judge. */
  callWav: string | null;
  /** Whole call at 24kHz. */
  callStudioWav: string | null;
  greetingWav: string | null;
  greetingStudioWav: string | null;
  greetingSaid: string | null;
  turns: TurnRow[];
  error?: string;
}

export interface PageInput {
  title: string;
  scenarioName: string;
  scenarioDescription: string;
  variants: VariantSummary[];
  runs: VariantRun[];
  /** Loud, red, at the top. Anything the run could not prove goes here. */
  warnings: string[];
  generatedAt: string;
}

// ------------------------------------------------------------------------------------------
// Artifacts
// ------------------------------------------------------------------------------------------

/** `01_A_phone.wav` etc. — sortable, and the variant key is readable at a glance in the folder. */
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Writes every WAV for one variant's call and returns the page rows that point at them.
 *
 * Transcript text comes from the AGENT's own call report, not from anything this harness can hear:
 * the harness has the audio but no idea what is in it. `alignTranscript` does the pairing.
 */
export async function writeRunArtifacts(args: {
  dir: string;
  key: string;
  call: CallResult;
  /** The agent's own words, already aligned to turns by `alignTranscript`. */
  transcript: { greeting: string | null; replies: Array<string | null> };
  /**
   * The agent's OWN pipeline snapshot, purely so the clips can name the engine that made them.
   * Absent/null → the files are stamped `engine-unverified`, which is the honest label for audio
   * whose engine nothing has confirmed.
   */
  pipeline?: PipelineSnapshot | null;
}): Promise<VariantRun> {
  const { dir, key, call, transcript } = args;
  await mkdir(dir, { recursive: true });

  const agentEngine = engineFromPipeline(args.pipeline ?? null);
  const stamp = engineSlug(agentEngine);

  const write = async (name: string, pcm: Int16Array): Promise<string | null> => {
    if (pcm.length === 0) return null;
    await writeFile(join(dir, name), encodeWav(pcm, CAPTURE_RATE));
    const phoneName = name.replace(/\.wav$/u, '_phone.wav');
    await writeFile(join(dir, phoneName), encodeWav(toPhoneRate(pcm, CAPTURE_RATE), PHONE_RATE));
    return phoneName;
  };

  const studioOf = (phoneName: string | null): string | null =>
    phoneName ? phoneName.replace(/_phone\.wav$/u, '.wav') : null;

  const greetingSaid = transcript.greeting;
  // EVERY FILENAME CARRIES THE ENGINE. These WAVs outlive the page they were written for — they
  // get copied into chats, re-listened to weeks later, and compared against clips from other
  // rounds. The engine has to travel with the audio, not sit only in the HTML beside it.
  const greetingWav = await write(`call_${key}_${stamp}_greeting.wav`, call.greetingPcm);
  const callWav = await write(`call_${key}_${stamp}_full.wav`, call.mixedPcm);

  const turns: TurnRow[] = [];
  for (const [i, turn] of call.turns.entries()) {
    const base = `${pad(i + 1)}_${key}_${stamp}`;
    const phone = await write(`${base}.wav`, turn.agentPcm);
    const exchange = await write(
      `${base}_exchange.wav`,
      buildExchange(turn.callerPcm, turn.responseLatencyMs, turn.agentPcm),
    );
    turns.push({
      said: turn.said,
      agentSaid: transcript.replies[i] ?? null,
      deadAirMs: turn.responseLatencyMs,
      agentSpokeMs: turn.agentSpokeMs,
      cutOff: turn.interruptedCaller,
      exchangeWav: exchange,
      phoneWav: phone,
      studioWav: studioOf(phone),
    });
  }

  return {
    key,
    agentName: call.agentName,
    agentEngine,
    callerEngine: call.callerEngine.label,
    callWav,
    callStudioWav: studioOf(callWav),
    greetingWav,
    greetingStudioWav: studioOf(greetingWav),
    greetingSaid,
    turns,
    ...(call.error ? { error: call.error } : {}),
  };
}

/**
 * The run's own machine-readable record, written beside the page.
 *
 * The HTML is for a human; this is for everything else — a later script, a diff between two runs,
 * or a reader asking six weeks from now "which engine made THIS file". Every clip is listed with
 * the engine that produced it, so the answer never depends on remembering.
 */
export async function writeManifest(args: {
  dir: string;
  scenarioName: string;
  generatedAt: string;
  runs: VariantRun[];
  variants: VariantSummary[];
  warnings: string[];
}): Promise<string> {
  const byKey = new Map(args.variants.map((v) => [v.key, v]));
  const manifest = {
    generatedAt: args.generatedAt,
    scenario: args.scenarioName,
    warnings: args.warnings,
    variants: args.runs.map((run) => ({
      key: run.key,
      label: byKey.get(run.key)?.label ?? null,
      overrides: byKey.get(run.key)?.overrides ?? {},
      answeredBy: run.agentName,
      /** What SHE spoke with. null = not confirmed by a call report; do not assume. */
      agentEngine: run.agentEngine,
      /** What the fake caller spoke with — the other voice in every `_exchange` clip. */
      callerEngine: run.callerEngine,
      clips: [
        run.callWav,
        run.callStudioWav,
        run.greetingWav,
        run.greetingStudioWav,
        ...run.turns.flatMap((t) => [t.exchangeWav, t.phoneWav, t.studioWav]),
      ].filter((c): c is string => Boolean(c)),
    })),
  };
  const path = join(args.dir, 'manifest.json');
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

/**
 * One card = one exchange: what the caller said, the silence that actually followed, then the
 * reply. The gap is reproduced at its MEASURED length rather than trimmed to something tidy —
 * the pause is half of what is being judged, and a card that deletes it flatters the agent.
 */
export function buildExchange(
  callerPcm: Int16Array,
  deadAirMs: number | null,
  agentPcm: Int16Array,
): Int16Array {
  if (callerPcm.length === 0 && agentPcm.length === 0) return new Int16Array(0);
  // No reply: play the question and let the silence stand for itself, bounded so the clip ends.
  const gapMs = deadAirMs ?? 1_500;
  const gap = Math.max(0, Math.round((gapMs / 1000) * CAPTURE_RATE));
  const out = new Int16Array(callerPcm.length + gap + agentPcm.length);
  out.set(callerPcm, 0);
  out.set(agentPcm, callerPcm.length + gap);
  return out;
}

// ------------------------------------------------------------------------------------------
// Call-report lookup
// ------------------------------------------------------------------------------------------

export interface MatchedReport {
  path: string;
  pipeline: PipelineSnapshot | null;
  /** What she said before the caller's first utterance. */
  agentGreeting: string | null;
  /** What she said in reply to caller turn N. `null` = she said nothing for that turn. */
  agentReplies: Array<string | null>;
  /** The agent's OWN dead-air measurements, which do not include our transport overhead. */
  deadAirMs: number[];
}


/**
 * Finds the call report the agent wrote for a given room.
 *
 * Matching is on the room name rather than on "the newest file", because a run spawns and kills a
 * worker per variant and the reports land in one shared directory. `sinceMs` bounds the scan so an
 * old report for a re-used room name can never be picked up.
 */
export async function findCallReport(
  dir: string,
  room: string,
  sinceMs: number,
): Promise<MatchedReport | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of names.filter((n) => n.endsWith('.json')).sort().reverse()) {
    const path = join(dir, name);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.room !== room) continue;
    const startedAt = Date.parse(String(parsed.startedAt ?? ''));
    if (Number.isFinite(startedAt) && startedAt < sinceMs - 60_000) continue;

    const transcript = (Array.isArray(parsed.transcript) ? parsed.transcript : []).filter(
      (l): l is { role: string; text: string } => {
        const line = l as { role?: unknown; text?: unknown };
        return typeof line.role === 'string' && typeof line.text === 'string';
      },
    );
    const { greeting, replies } = alignTranscript(transcript);
    const deadAir = (parsed.summary as { deadAirMs?: unknown } | undefined)?.deadAirMs;
    return {
      path,
      pipeline: (parsed.pipeline as PipelineSnapshot | null) ?? null,
      agentGreeting: greeting,
      agentReplies: replies,
      deadAirMs: Array.isArray(deadAir) ? (deadAir as number[]) : [],
    };
  }
  return null;
}

// ------------------------------------------------------------------------------------------
// HTML
// ------------------------------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

const ms = (v: number | null): string => (v === null ? '—' : `${v}ms`);

/**
 * The whole page, as one string. No build step, no CDN, no fonts to fetch — it has to open off a
 * local filesystem on a laptop with no dev server running, because that is how it will be used.
 */
export function renderPage(input: PageInput): string {
  const multi = input.variants.length > 1;
  const runByKey = new Map(input.runs.map((r) => [r.key, r]));
  const turnCount = Math.max(0, ...input.runs.map((r) => r.turns.length));

  const warnings = input.warnings.length
    ? `<div class="warn"><b>לא הוכח / שים לב</b><ul>${input.warnings
        .map((w) => `<li>${esc(w)}</li>`)
        .join('')}</ul></div>`
    : '';

  // Every key ANY variant touches, so the baseline column shows what it ran too. Listing only a
  // variant's own overrides leaves the baseline's "agent reported" line blank, which is exactly
  // the value you need in order to know what the change was measured against.
  const comparedKeys = [...new Set(input.variants.flatMap((v) => Object.keys(v.overrides)))].sort();

  // One line naming every engine on the page, so the header answers "what am I listening to"
  // before anyone scrolls to a column.
  const enginesLine = esc(
    input.runs
      .map((r) => `${r.key}: ${r.agentEngine ?? UNVERIFIED} (caller: ${r.callerEngine ?? 'unknown'})`)
      .join('  ·  ') || 'no runs',
  );

  // THE WHOLE CALL, FIRST. Judging a conversation from isolated replies does not work; this is the
  // only player on the page that lets you hear the thing end to end, so it goes above everything.
  const fullCalls = input.variants
    .map((v) => {
      const run = runByKey.get(v.key);
      return `<div class="col">
        <div class="vhead"><span class="vkey">${esc(v.key)}</span><span class="vlabel">${esc(v.label)}</span></div>
        <div class="engine">🔊 ${esc(run?.agentEngine ?? UNVERIFIED)}</div>
        <div class="meas">קול הלקוח המלאכותי: ${esc(run?.callerEngine ?? 'unknown')}</div>
        ${run?.error ? `<div class="meas none">${esc(run.error)}</div>` : ''}
        ${
          run?.callWav
            ? `<div class="meas">כל השיחה, שני הצדדים, 8kHz כמו בטלפון:</div>
               <audio controls preload="none" src="${esc(run.callWav)}"></audio>`
            : '<div class="meas none">אין הקלטה של השיחה המלאה</div>'
        }
        ${
          run?.greetingWav
            ? `<div class="meas">הפתיח בלבד: ${esc(run.greetingSaid ?? '')}</div>
               <audio controls preload="none" src="${esc(run.greetingWav)}"></audio>`
            : ''
        }
        ${
          run?.callStudioWav
            ? `<details><summary class="meas">גרסאות אולפן 24kHz (לא לשיפוט איכות טלפון)</summary>
                 <audio controls preload="none" src="${esc(run.callStudioWav)}"></audio>
                 ${run.greetingStudioWav ? `<audio controls preload="none" src="${esc(run.greetingStudioWav)}"></audio>` : ''}
               </details>`
            : ''
        }
      </div>`;
    })
    .join('');

  const variantLegend = input.variants
    .map((v) => {
      const run = runByKey.get(v.key);
      const overrides = Object.entries(v.overrides);
      const resolved = v.pipeline
        ? comparedKeys
            .map((k) => {
              const c = v.pipeline!.configured[k];
              return c ? `${k}=${c.value} (${c.source})` : `${k}=NOT OBSERVED`;
            })
            .join(' · ') || '(no keys compared)'
        : 'אין דוח שיחה — לא אומת';
      return `<div class="col">
        <div class="vhead"><span class="vkey">${esc(v.key)}</span><span class="vlabel">${esc(v.label)}</span></div>
        <div class="engine">🔊 ${esc(run?.agentEngine ?? UNVERIFIED)}</div>
        <div class="meas">asked for: ${esc(overrides.map(([k, val]) => `${k}=${val}`).join(' · ') || '(baseline — .env as-is)')}</div>
        <div class="meas">agent reported: ${esc(resolved)}</div>
        <div class="meas">answered by: ${esc(run?.agentName ?? 'unknown')}</div>
        <div class="meas">caller voice: ${esc(run?.callerEngine ?? 'unknown')}</div>
      </div>`;
    })
    .join('');

  const cards: string[] = [];
  for (let i = 0; i < turnCount; i++) {
    const id = `t${i + 1}`;
    const said = input.runs.map((r) => r.turns[i]?.said).find((s) => s !== undefined) ?? '';
    const cols = input.variants
      .map((v) => {
        const turn = runByKey.get(v.key)?.turns[i];
        if (!turn) {
          return `<div class="col"><div class="vhead"><span class="vkey">${esc(v.key)}</span></div><div class="meas none">אין הקלטה לתור הזה</div></div>`;
        }
        const flags = [
          turn.cutOff ? 'CUT THE CALLER OFF' : null,
          turn.deadAirMs !== null && turn.deadAirMs > 1200 ? 'DEAD AIR > 1.2s' : null,
          turn.deadAirMs === null ? 'NO REPLY' : null,
        ].filter(Boolean);
        const pick = multi
          ? `<div class="psrow"><label class="lbl"><input type="radio" name="pick_${id}" value="${esc(v.key)}"> זה הכי טוב</label></div>`
          : '';
        // The exchange is the primary player; the reply on its own is one click away for anyone
        // who wants to hear the timbre without sitting through the question again.
        const primary = turn.exchangeWav
          ? `<div class="meas">הלקוח → השתיקה → התשובה שלה:</div>
             <audio controls preload="none" src="${esc(turn.exchangeWav)}"></audio>`
          : turn.phoneWav
            ? `<audio controls preload="none" src="${esc(turn.phoneWav)}"></audio>`
            : '<div class="meas none">אין אודיו</div>';
        const extras = [
          turn.phoneWav ? `<audio controls preload="none" src="${esc(turn.phoneWav)}"></audio>` : '',
          turn.studioWav
            ? `<audio controls preload="none" src="${esc(turn.studioWav)}"></audio>`
            : '',
        ]
          .filter(Boolean)
          .join('');
        return `<div class="col">
          <div class="vhead"><span class="vkey">${esc(v.key)}</span><span class="vlabel">${esc(v.label)}</span>
            <span class="tag">${esc(ms(turn.deadAirMs))}</span>
            <span class="engine inline">🔊 ${esc(runByKey.get(v.key)?.agentEngine ?? UNVERIFIED)}</span></div>
          <div class="he" dir="rtl">${esc(turn.agentSaid ?? '(הטקסט לא נמצא בדוח השיחה)')}</div>
          ${primary}
          <div class="meas">שקט לפני התשובה ${esc(ms(turn.deadAirMs))} · דיברה ${turn.agentSpokeMs}ms${flags.length ? ` · <span class="none">${esc(flags.join(', '))}</span>` : ''}</div>
          ${extras ? `<details><summary class="meas">רק התשובה שלה (8kHz, ואז 24kHz אולפן)</summary>${extras}</details>` : ''}
          ${pick}
        </div>`;
      })
      .join('');

    // Turn 1 of any run carries the worker's cold start (first job process, first STT stream,
    // first LLM connection). Measured on a warm local worker: turn 1 ~600ms slower than turn 2,
    // and on a freshly booted one the agent needs seconds just to join. Saying so on the card is
    // cheaper and more honest than spending an extra paid turn to warm it up.
    const coldNote =
      i === 0
        ? '<span class="tag warmup">תור ראשון — כולל התחממות של העובד, לא להשוות לפיו</span>'
        : '';

    cards.push(`<div class="card" data-id="${id}">
      <div class="chead"><span class="cid" dir="rtl">${esc(said)}</span><span class="tag">${id} · מה שהלקוח אמר</span>${coldNote}</div>
      <div class="cols">${cols}</div>
      <div class="psrow">${multi ? `<label class="lbl none"><input type="radio" name="pick_${id}" value="none"> אף אחד לא טוב</label>` : ''}
        <input type="text" class="note" name="note_${id}" dir="rtl" placeholder="מה שמעת?">
      </div>
    </div>`);
  }

  const table = renderLatencyTable(input, runByKey, turnCount);

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)}</title>
<style>
  :root { --bg:#0e1116; --card:#171b22; --line:#252b36; --txt:#e6e9ef; --dim:#9aa4b2; --acc:#3b82f6; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font-family:"Segoe UI",Arial,sans-serif; }
  header, main { max-width:1200px; margin:0 auto; padding:0 20px; }
  header { padding-top:26px; }
  h1 { margin:0 0 6px; font-size:22px; }
  h2 { font-size:18px; margin:34px 0 2px; }
  .sub { color:var(--dim); font-size:14px; margin:4px 0 10px; line-height:1.55; }
  .warn { border:1px solid #7a4a2a; background:#20160f; border-radius:10px; padding:12px 16px; margin:14px 0; font-size:14px; }
  .warn ul { margin:8px 0 0; padding-inline-start:20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin:14px 0; }
  .chead { display:flex; align-items:center; gap:10px; margin-bottom:10px; flex-wrap:wrap; }
  .cid { font-weight:700; font-size:19px; }
  .tag { font-size:12px; color:var(--dim); font-family:monospace; }
  .warmup { border:1px solid #7a4a2a; background:#20160f; border-radius:6px; padding:2px 8px; font-family:inherit; }
  .cols { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:10px; }
  .col { border:1px solid var(--line); border-radius:10px; padding:12px; background:#0f131a; }
  .col:has(input:checked) { border-color:var(--acc); }
  .vhead { display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap; }
  .vkey { font-family:monospace; font-weight:700; color:var(--acc); font-size:16px; }
  .vlabel { font-size:13px; color:var(--dim); }
  .lbl { font-size:13px; color:var(--dim); display:inline-flex; align-items:center; gap:6px; cursor:pointer; }
  /* The engine that made the audio in this column. Deliberately loud: a clip judged against the
     wrong engine is worse than a clip not judged at all. */
  .engine { font-family:monospace; font-size:12px; color:#cbd5e1; background:#1d2430;
            border:1px solid var(--line); border-radius:6px; padding:3px 8px; margin:4px 0;
            display:inline-block; direction:ltr; }
  .engine.inline { margin:0; padding:2px 6px; font-size:11px; }
  .none { color:#e0a0a0; }
  .he { font-size:18px; margin-bottom:8px; line-height:1.5; }
  .meas { font-family:monospace; font-size:12px; color:var(--dim); margin:6px 0; word-break:break-word; }
  audio { width:100%; height:34px; }
  details { margin-top:6px; }
  .psrow { display:flex; gap:14px; align-items:center; margin-top:10px; flex-wrap:wrap; }
  .note { flex:1; min-width:220px; background:#0e1116; border:1px solid var(--line); border-radius:8px;
           color:var(--txt); padding:8px 10px; font-size:14px; }
  table { border-collapse:collapse; width:100%; font-family:monospace; font-size:13px; margin:10px 0 0; }
  th, td { border:1px solid var(--line); padding:6px 10px; text-align:start; }
  th { color:var(--dim); font-weight:600; }
  #summary { width:100%; min-height:200px; background:#0f131a; color:var(--txt); border:1px solid var(--line);
              border-radius:10px; padding:12px; font-family:monospace; font-size:13px; direction:ltr; }
  button { background:var(--acc); border:0; color:#fff; border-radius:8px; padding:10px 18px;
            font-size:14px; cursor:pointer; margin:10px 0; }
</style>
</head>
<body>
<header>
  <h1>${esc(input.title)}</h1>
  <p class="sub">תרחיש <b>${esc(input.scenarioName)}</b> — ${esc(input.scenarioDescription)}<br>
    נוצר ${esc(input.generatedAt)}</p>
  <div class="warn"><b>המספרים כאן הם כלי השוואה, לא מדידת מוצר.</b>
    ה"שקט לפני התשובה" שנמדד כאן גבוה ב־1 עד 1.5 שניות מהאמת, כי הוא כולל גם את הרשת ואת
    ה־jitter buffer של המאזין. להשוות בעזרתו A מול B — אבל לעולם לא לצטט אותו כזמן התגובה של המוצר.
    הזמן האמיתי נמדד מהשיחה עצמה (<code>latency eou/llm/tts</code> בדוח השיחה).<br>
    לשפוט לפי הנגן הראשי בכל עמודה — הוא 8kHz, כמו טלפון. גרסת האולפן היא לעיון בלבד.</div>
  <div class="warn"><b>המנוע שהשמיע כל עמודה כתוב עליה, וגם על שם הקובץ.</b>
    כל פסק דין כאן תקף רק למנוע שכתוב בעמודה — קליפ של מנוע אחד לא מעיד על מנוע אחר.
    <div class="meas">${enginesLine}</div></div>
  ${warnings}
</header>
<main>
<h2>השיחות המלאות — להתחיל מכאן</h2>
<p class="sub">שיחה שלמה מקצה לקצה. אי אפשר לשפוט טבעיות מתשובה בודדת — קודם מקשיבים לשיחה, ורק אחר כך יורדים לתור בודד למטה.</p>
<div class="cols">${fullCalls}</div>

<h2>הווריאנטים</h2>
<div class="cols">${variantLegend}</div>

<h2>טבלת זמנים</h2>
${table}

<h2>תור אחרי תור</h2>
${cards.join('\n')}

<h2>סיכום</h2>
<button id="btn">צור סיכום</button>
<textarea id="summary" readonly placeholder="הסיכום יופיע כאן"></textarea>
</main>
<script>
const KEY = ${JSON.stringify(`voice-ab-${input.scenarioName}-${input.generatedAt}`)};
const state = JSON.parse(localStorage.getItem(KEY) || '{}');
document.querySelectorAll('input').forEach(el => {
  if (el.type === 'radio' && state[el.name] === el.value) el.checked = true;
  if (el.type === 'text' && state[el.name]) el.value = state[el.name];
  el.addEventListener(el.type === 'text' ? 'input' : 'change', () => {
    state[el.name] = el.value;
    localStorage.setItem(KEY, JSON.stringify(state));
  });
});
document.getElementById('btn').addEventListener('click', () => {
  // THE ENGINE GOES INTO THE PASTED VERDICT. This textarea is what gets copied into a chat and
  // acted on days later; a verdict that does not name the engine is the exact artefact that gets
  // re-applied to a different one.
  const lines = [${JSON.stringify(input.title)}, ${JSON.stringify(
    input.variants.map((v) => `${v.key} = ${v.label}`).join(' | '),
  )}, ${JSON.stringify(
    input.runs
      .map((r) => `${r.key} engine: ${r.agentEngine ?? UNVERIFIED} · caller: ${r.callerEngine ?? 'unknown'}`)
      .join(' | '),
  )}, ''];
  document.querySelectorAll('.card').forEach(card => {
    const id = card.dataset.id;
    const said = card.querySelector('.cid').textContent.trim();
    const pick = state['pick_' + id] || '-';
    const note = state['note_' + id] ? '  note: ' + state['note_' + id] : '';
    lines.push(id + ' "' + said + '": ' + pick + note);
  });
  const box = document.getElementById('summary');
  box.value = lines.join('\\n');
  box.select();
});
</script>
</body>
</html>
`;
}

function renderLatencyTable(
  input: PageInput,
  runByKey: Map<string, VariantRun>,
  turnCount: number,
): string {
  const head = ['תור', ...input.variants.map((v) => v.key)];
  const rows: string[] = [];
  for (let i = 0; i < turnCount; i++) {
    const cells = input.variants.map((v) => {
      const t = runByKey.get(v.key)?.turns[i];
      return t ? ms(t.deadAirMs) : '—';
    });
    rows.push(`<tr><td>${i + 1}</td>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`);
  }
  const stat = (fn: (values: number[]) => number | null, label: string): string => {
    const cells = input.variants.map((v) => {
      const values = (runByKey.get(v.key)?.turns ?? [])
        .map((t) => t.deadAirMs)
        .filter((n): n is number => n !== null);
      const out = fn(values);
      return out === null ? '—' : `${out}ms`;
    });
    return `<tr><th>${esc(label)}</th>${cells.map((c) => `<td><b>${esc(c)}</b></td>`).join('')}</tr>`;
  };
  const median = (v: number[]): number | null =>
    v.length === 0 ? null : [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
  const worst = (v: number[]): number | null => (v.length === 0 ? null : Math.max(...v));

  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
<tbody>${rows.join('')}${stat(median, 'חציון')}${stat(worst, 'הגרוע ביותר')}</tbody></table>`;
}
