/**
 * SHE READ A TOOL CALL OUT LOUD, TO A REAL CALLER, FOR NINETEEN SECONDS.
 *
 * 2026-08-31 13:52 UTC, production build `d7da334`, at 196s of a 219s call. The final assistant
 * turn, verbatim from the transcript:
 *
 *     בסדר. to=functions.capture_lead_info 彩神争霸大发快json content={"name":"קורן","email":null,
 *     "phone":null,"business_type":"סוכנות לבניית אתרים","pain_point":"עונה בעצמו לכל השיחות
 *     בטלפון","budget":null,"timeline":null,"qualification":"warm","notes":"...","is_correction":
 *     false} אני מבינה.. . זה שואב המון זמן. כמה פניות בערך נכנסות אליךָ ביום?
 *
 * `spokeAtMs` 177392 → `spokeUntilMs` 196489. Cartesia read every character of it: the routing
 * header, a run of Chinese, and the caller's own business type, pain point and qualification —
 * back at him, as speech, instead of into the database. `toolCalls` in that report has ONE entry,
 * at 62s. The 196s capture never executed.
 *
 * WHAT THIS IS. Two artefacts name it precisely. `to=functions.<name>` is OpenAI's own
 * channel-routing syntax — the string a harmony-format model writes on the `commentary` channel to
 * address a tool — and `彩神争霸大发快` is a well-known glitch token. Neither is a string this
 * repository can construct. The model's output-channel routing broke down and the tool call landed
 * in the FINAL channel, which is the channel we speak.
 *
 * WHY THE FIX LIVES HERE AND NOT IN THE PROMPT. There is no instruction that reliably prevents it:
 * the model is not disobeying a rule, its decoder is emitting the wrong channel. And there is no
 * upstream parser to harden either — the SDK hands us a text stream, and by the time we see it the
 * damage is a string. So this is the same shape as every other rule in `speech-guard.ts`: a defect
 * a prompt cannot stop, stopped in code at the point where text becomes sound.
 *
 * THE ONE HARD RULE: nothing that looks like a tool call or a JSON payload may reach the TTS,
 * whatever the model does. `guardSpeech` calls this FIRST, before every other rule, so the booking
 * rewrite, the number speller and the niqqud strip never get to work on a payload — and because
 * `guardSpeech` runs inside `guardStream`, which runs inside `ttsNode`, this covers EVERY path
 * that produces sound: normal replies, preemptive drafts, and the fixed reflex lines that go out
 * through `session.say()` (the SDK routes `say()` through `agent.ttsNode` too —
 * `agent_activity.js` `ttsTask` → `performTTSInference((...args) => this.agent.ttsNode(...args))`).
 *
 * SALVAGE, DO NOT DROP. In the transcript above there is a perfectly good human sentence sitting
 * behind the payload — "אני מבינה.. . זה שואב המון זמן. כמה פניות בערך נכנסות אליךָ ביום?" — and
 * throwing the whole turn away would trade a leak for dead air. Only the payload span is removed.
 * When nothing usable is left the sentence is reported as `silent`, and the reply-level
 * `notifyIfSilent` → `onSilentReply` path already in the agent speaks `HOLD_CHECKBACK_HE` instead
 * of leaving the line dead. Silence is never the end state.
 *
 * Kill-switch: VOICE_TOOLCALL_LEAK_GUARD_ENABLED, default ON. It exists for symmetry with the rest
 * of the module, not because turning it off is ever a good idea — speaking JSON at a customer has
 * no acceptable version.
 */

/**
 * Payload markers, in the order they are searched for. Each returns the index at which the
 * poisoned region begins; everything before the earliest match is the caller's real sentence.
 */

/**
 * OpenAI harmony control tokens — `<|start|>`, `<|channel|>`, `<|message|>`, `<|constrain|>`,
 * `<|call|>`, `<|end|>`, `<|return|>`. Written as a shape rather than a list because the set is
 * the vendor's, not ours, and a token we have never seen is exactly the one that would slip past a
 * list. Nothing in Hebrew or English speech contains `<|`.
 */
const HARMONY_TOKEN = /<\|[A-Za-z0-9_]*\|>/u;

/**
 * The routing header itself: `to=functions.capture_lead_info`, `to = functions`, or a bare
 * `functions.book_meeting`.
 *
 * The bare form requires an identifier IMMEDIATELY after the dot, with no whitespace anywhere in
 * it, so the English sentence "We can walk through the functions. Then we book a demo." does not
 * match — its dot is followed by a space. That sentence was in the false-positive gate before this
 * pattern was tight enough, and it failed. In Hebrew the form cannot occur at all.
 */
const FUNCTIONS_MARKER = /\bto\s*=\s*functions\b(?:\.[A-Za-z_][A-Za-z0-9_]*)?|\bfunctions\.[A-Za-z_][A-Za-z0-9_]*/u;

/**
 * A JSON object literal. `{` has no place in anything she says: the prompt's `{agentName}`
 * placeholders are interpolated long before the TTS, so a brace arriving here is already a defect
 * whether or not it turns out to be a tool payload. Removing it is strictly better than reading
 * it aloud.
 */
const BRACE = /\{/u;

/**
 * The argument names of our own tools — the last line of defence, for a payload whose opening
 * brace was lost upstream (re-chunked away, or eaten by an earlier sentence split).
 *
 * Deliberately a literal list rather than an import from `tools/`: this module must keep working
 * if a tool is renamed and nobody updates it, and a stale entry here costs nothing while an import
 * cycle into the tool registry would cost the whole guard. Extend it when a tool gains an argument;
 * `toolcall-leak.test.ts` pins the 196s string against it.
 */
const TOOL_ARG_KEY =
  /"(?:name|email|phone|business_type|pain_point|budget|timeline|qualification|notes|is_correction|reason|date|time|slot|starts_at|duration_minutes|message|summary|outcome|full_name|company)"\s*:/u;

/**
 * CJK and Hangul. Handled separately from the payload scan because it is not a payload boundary —
 * it is text that CANNOT BE SPOKEN by a Hebrew voice under any circumstances, wherever it appears.
 *
 * `彩神争霸大发快` is the specific glitch token this call produced, but the rule is general: this
 * agent speaks Hebrew and English, sonic-3.5 is asked for `language: "he"`, and a Han character
 * reaching Cartesia produces either noise or nothing. Stripping it is never worse than speaking
 * it, and its presence in a Hebrew call is itself strong evidence that the decoder has come off
 * the rails — which is why it is counted as a leak rather than as tidying.
 */
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/gu;

/** Any Hebrew letter — the marker for "the model is back to writing speech". */
const HEBREW = /[֐-׿]/u;

/**
 * How far past a routing header we will keep eating junk while looking for the payload's brace.
 *
 * The observed leak put `彩神争霸大发快json content=` between the header and the `{`. A bound is
 * needed so that a header with no payload behind it removes the header alone and never swallows a
 * real reply; 400 characters is comfortably longer than any header-plus-junk we have seen and far
 * shorter than one of her sentences plus an answer.
 */
const JUNK_SCAN_LIMIT = 400;

export interface LeakScrub {
  /** What is safe to speak. May be '' when the whole input was payload. */
  text: string;
  /** True when anything at all was removed — the thing the call report counts. */
  leaked: boolean;
  /** Which markers fired, for the log line and the report. Stable strings, safe to grep. */
  reasons: string[];
  /**
   * A payload was opened in this text and never closed.
   *
   * `guardStream` splits on sentence terminators, and a JSON payload can straddle one: a value
   * like `"date":"2026-09-01. "` carries a full stop followed by a space, which is exactly what
   * `sentenceEnd` looks for. So the stream asks this question BEFORE it cuts, and holds the buffer
   * rather than flushing half a payload — see `openPayloadStraddles` in speech-guard.ts.
   *
   * Holding is the right trade over resuming mid-payload on the next chunk, which is what the first
   * version did and got wrong: resuming needs the brace depth AND whether the cut fell inside a
   * JSON string literal, and losing the second one made a Hebrew note containing a full stop
   * swallow the rest of the reply. A reply carrying a `{` is already broken; a few hundred
   * milliseconds of buffering on that one reply costs nothing, and nothing is ever lost — the tail
   * flush scrubs whatever never closed and speaks the sentence behind it.
   */
  open: boolean;
}

const CLEAN = (text: string): LeakScrub => ({ text, leaked: false, reasons: [], open: false });

/**
 * Is there ANY sign of a payload in this text? Used by `guardStream` to decide whether to hold.
 *
 * WHY HOLDING, AND WHY ON THE FIRST SIGN RATHER THAN ON AN UNCLOSED BRACE. `sentenceEnd` treats
 * the END OF THE BUFFER as a sentence terminator, so a chunk that happens to end on a full stop is
 * flushed immediately — and OpenAI tokenises `to=functions.capture_lead_info` with a boundary
 * right after that dot. The header would then leave as its own "sentence", get scrubbed correctly,
 * and the ENTIRE payload behind it would arrive next with no marker in front of it and be spoken.
 * That is not a theoretical split: it is how the token stream is actually shaped, and the
 * character-by-character case in `toolcall-leak.test.ts` pins it.
 *
 * So the rule is not "hold an unclosed brace" but "hold from the first sign of a payload until the
 * reply ends", and then scrub the whole thing in one piece with all of it in hand. A reply carrying
 * a marker is already broken; buffering it costs that one reply some milliseconds and loses
 * nothing, because the tail flush speaks whatever human sentence was behind the payload.
 *
 * The `includes` short-circuits keep the common path free: an ordinary Hebrew reply answers false
 * after two substring scans, so a clean call pays nothing per sentence.
 */
export function hasLeakMarker(text: string): boolean {
  if (text.includes('{') || text.includes('<|')) return true;
  if (text.includes('functions')) return FUNCTIONS_MARKER.test(text);
  if (text.includes('"')) return TOOL_ARG_KEY.test(text);
  return false;
}

/** Removes every tool-call / JSON payload from one piece of text, keeping the human sentence. */
export function scrubToolCallLeak(text: string): LeakScrub {
  if (!text) return CLEAN(text);

  const reasons: string[] = [];
  let out = '';
  let rest = text;
  let open = false;

  for (;;) {
    const start = firstMarker(rest);
    if (start === null) {
      out += rest;
      break;
    }
    out += rest.slice(0, start.index);
    reasons.push(start.reason);

    const end = payloadEnd(rest, start);
    if (end === null) {
      // Opened and never closed: everything from here on is payload, and so is the next chunk.
      open = true;
      break;
    }
    rest = rest.slice(end);
  }

  // Independent of the payload scan: unspeakable script anywhere in what survived.
  const despatched = out.replace(CJK, ' ');
  if (despatched !== out) {
    reasons.push('cjk_run');
    out = despatched;
  }

  const cleaned = tidy(out);
  const leaked = reasons.length > 0;
  return { text: cleaned, leaked, reasons: dedupe(reasons), open };
}

interface Marker {
  index: number;
  /** Where the marker's own text ends — the scan for a payload brace starts here. */
  after: number;
  reason: string;
  kind: 'brace' | 'header' | 'key';
}

/** The earliest payload marker in `text`, or null. */
function firstMarker(text: string): Marker | null {
  const candidates: Marker[] = [];
  const push = (re: RegExp, reason: string, kind: Marker['kind']): void => {
    const m = re.exec(text);
    if (m) candidates.push({ index: m.index, after: m.index + m[0].length, reason, kind });
  };
  push(HARMONY_TOKEN, 'harmony_token', 'header');
  push(FUNCTIONS_MARKER, 'functions_route', 'header');
  push(BRACE, 'json_object', 'brace');
  push(TOOL_ARG_KEY, 'tool_argument_key', 'key');
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.index < a.index ? b : a));
}

/**
 * The index just past the end of the payload that starts at `marker`, or null when it never closes.
 *
 * A brace payload ends at its matching close. A ROUTING HEADER is followed by junk of unknown shape
 * (`彩神争霸大发快json content=`), so the scan runs forward to the first `{` — consuming the junk —
 * and then balances it; if it meets Hebrew first, or runs past JUNK_SCAN_LIMIT, only the header
 * itself is removed and the sentence behind it survives untouched. A bare argument key with no
 * brace anywhere is treated as running to the end of the text, because there is nothing else it
 * could be and speaking half a JSON object is no better than speaking all of it.
 */
function payloadEnd(text: string, marker: Marker): number | null {
  if (marker.kind === 'brace') return consumeBraced(text, marker.index, 0);

  if (marker.kind === 'key') {
    const close = text.indexOf('}', marker.after);
    return close === -1 ? null : close + 1;
  }

  const limit = Math.min(text.length, marker.after + JUNK_SCAN_LIMIT);
  for (let i = marker.after; i < limit; i++) {
    const ch = text[i]!;
    if (ch === '{') {
      const closed = consumeBraced(text, i, 0);
      return closed; // null → unclosed, the caller latches `open`
    }
    // SHE IS WRITING HEBREW AGAIN — the payload is over and her sentence resumes here.
    //
    // Everything between the header and this letter goes with the header, not just the header
    // itself. `<|channel|>commentary<|message|> שלום` is the case that forced it: dropping the two
    // tokens alone left the word "commentary" standing in the middle of a Hebrew reply, which
    // Cartesia would have read out in English. The junk between a routing header and the next
    // Hebrew letter is never speech.
    if (HEBREW.test(ch)) return i;
  }
  return limit;
}

/**
 * Index just past the brace that closes the object starting at `from`, or null if it never closes.
 *
 * `depth` is the depth already open on entry — 0 when `text[from]` is the opening `{`, 1 when we
 * are resuming inside a payload a sentence split cut in half (and `from` is then just an offset).
 * Braces inside JSON string literals are skipped, because `"notes":"{הוא אמר}"` is one value and
 * not two objects.
 */
function consumeBraced(text: string, from: number, depth: number): number | null {
  let level = depth;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') level++;
    else if (ch === '}') {
      level--;
      if (level <= 0) return i + 1;
    }
  }
  return null;
}

/**
 * What is left after a payload is cut out of the middle of a sentence.
 *
 * Collapses the whitespace the removal leaves, and drops a leading orphan of punctuation — the
 * `content=` case leaves `= ` behind when the brace never arrives. Returns '' when nothing but
 * punctuation survives, which `guardSpeech` renders as a silent sentence.
 */
function tidy(text: string): string {
  const out = text.replace(/\s{2,}/gu, ' ').replace(/^[\s=:,.;·]+/u, '').trim();
  return /^[\s.,!?…׃—–\-=:;{}[\]"']*$/u.test(out) ? '' : out;
}

function dedupe(reasons: string[]): string[] {
  return [...new Set(reasons)];
}
