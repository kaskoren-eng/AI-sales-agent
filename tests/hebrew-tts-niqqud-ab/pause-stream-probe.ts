/**
 * Round 6, item 6 — does the STREAMING path pause where the one-shot path pauses?
 *
 * Koren: "השימוש בפסיקים ונקודות כדי לעצור באמצע משפט לא עובד כמו שצריך, הזרימה של הדיבור לא
 * מספיק טובה במיוחד בתחילת השיחה." Before changing a single comma we have to know WHICH of two
 * very different things is failing, because the fixes are opposites:
 *
 *   1. sonic-3.5 under-realises Hebrew punctuation even with the whole sentence in hand — then the
 *      lever is the TEXT (a period instead of a comma, a split sentence), which round6.py's `ps`
 *      cards test by ear.
 *   2. sonic-3.5 pauses correctly on a one-shot request and loses it when the text arrives as a
 *      websocket stream — then no amount of comma-editing helps, and the lever is the REQUEST.
 *
 * Two facts make (2) a live possibility, both read out of the shipped plugin rather than guessed
 * (node_modules/@livekit/agents-plugin-cartesia/dist/tts.js):
 *
 *   - `max_buffer_delay_ms: 0` is HARDCODED at line 567. Cartesia's buffer delay is what lets the
 *     model see more text before it commits to audio; at 0 it plans prosody with no lookahead.
 *   - the plugin re-splits our text with LiveKit's `basic.SentenceTokenizer` (minSentenceLength 8
 *     CHARACTERS) and sends each piece as its own `transcript` with `continue: true`. So a short
 *     clause is glued to the next one, and every piece is a separate generation request stitched
 *     into one context.
 *
 * This script synthesizes the same `ps` sentences through `synthesizeHebrew`, which is the agent's
 * OWN Cartesia stream (same plugin, same options, same speed/volume from env) — so the resulting
 * wav is what the caller hears, not what /tts/bytes returns. pause_probe.py then measures the
 * silences in both and prints them side by side.
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/pause-stream-probe.ts
 *
 * Writes r6_<card>_<variant>S.wav next to the REST clips; the page shows them as extra variants.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../../src/config/env.js';
import { ensureLogger, synthesizeHebrew } from '../../src/modules/channels/voice-livekit/testing/speech.js';
import { toStudioWav } from '../../src/modules/channels/voice-livekit/testing/wav.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Only the pacing cards — the streaming question is about prosody, not about a vowel mark. */
const SECTIONS = new Set(['ps']);

interface Card {
  id: string;
  section: string;
  variants: Array<{ key: string; text: string; file: string }>;
}

async function main(): Promise<void> {
  ensureLogger();
  const env = loadEnv();
  const data = JSON.parse(await readFile(join(HERE, 'round6.json'), 'utf-8')) as { cards: Card[] };

  for (const card of data.cards) {
    if (!SECTIONS.has(card.section)) continue;
    for (const v of card.variants) {
      const frames = await synthesizeHebrew(env, v.text);
      const wav = toStudioWav(frames);
      const out = join(HERE, `r6_${card.id}_${v.key}S.wav`);
      await writeFile(out, wav);
      console.log(`${card.id}_${v.key}S  ${wav.length} bytes  "${v.text.slice(0, 48)}"`);
    }
  }
  console.log('\nNow: python tests/hebrew-tts-niqqud-ab/pause_probe.py');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
