/**
 * Regenerates the golden prompt fixtures — DELIBERATELY, never as a reflex.
 *
 * Read the provenance note at the top of system-prompt.persona.test.ts first. The question is
 * never "update the fixture", it is "which live call did I just change" — and the answer belongs
 * in the commit message and in that note, in the same commit as the new bytes.
 *
 * Run: npx tsx scripts/regen-prompt-fixtures.mts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSystemPrompt } from '../src/modules/channels/voice-livekit/prompts/system-prompt.he.js';

const dir = fileURLToPath(
  new URL('../src/modules/channels/voice-livekit/prompts/__fixtures__/', import.meta.url),
);

const files: Array<[string, string]> = [
  ['prompt-default-notools.txt', buildSystemPrompt({ toolsEnabled: false })],
  ['prompt-default-tools.txt', buildSystemPrompt({ toolsEnabled: true })],
  [
    'prompt-default-tools-noobjection.txt',
    buildSystemPrompt({ toolsEnabled: true, objectionHandling: false }),
  ],
];

for (const [name, content] of files) {
  writeFileSync(dir + name, content);
  console.log(`wrote ${name} (${content.length} bytes)`);
}
console.log('greeting-default.txt is NOT regenerated here — it is persona-owned and must not move.');
