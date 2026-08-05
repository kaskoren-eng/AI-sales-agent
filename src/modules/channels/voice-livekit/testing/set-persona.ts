/**
 * Read or flip a tenant's `agent_persona` — the A/B switch, from a terminal.
 *
 * Validates through `assertAgentPersona`, the SAME function the settings API uses, so this cannot
 * write a value the voice pipeline would then silently drop. That is the whole reason this exists
 * rather than a hand-written `jsonb_set`: raw SQL bypasses every validator, and a bad value there
 * does not fail — it degrades to the env default and the only trace is a `warnings` line in the
 * call report.
 *
 * MERGES, never replaces. The persona is read, patched and written back, so flipping the model
 * cannot drop the voice id. Everything outside `agent_persona` is untouched.
 *
 * Usage (AGENT_DATABASE_URL overrides .env — the deployed agent's DB is not localhost):
 *   AGENT_DATABASE_URL=$(grep '^DATABASE_URL=' ../.agent-secrets.env | cut -d= -f2-) \
 *     npm run voice:persona -- --tenant <uuid>                        # show
 *     npm run voice:persona -- --tenant <uuid> --model sonic-3.5      # flip one field
 *     npm run voice:persona -- --tenant <uuid> --voice <id> --speed 0.9
 *     npm run voice:persona -- --tenant <uuid> --clear                # remove the key entirely
 */
import { eq } from 'drizzle-orm';
import { loadEnv } from '../../../../config/env.js';
import { createDatabase } from '../../../../db/client.js';
import { tenants } from '../../../../db/schema/index.js';
import { assertAgentPersona, resolveAgentPersona, AGENT_PERSONA_KEY } from '../tts/tts-settings.js';

const env = loadEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const tenantId = arg('tenant');
if (!tenantId) throw new Error('--tenant <uuid> is required');

// The agent's DB is not the one in .env (localhost). Explicit, because writing a persona into the
// wrong database looks exactly like the feature not working.
const url = process.env.AGENT_DATABASE_URL ?? env.DATABASE_URL;
const { db, pool } = createDatabase(url);

try {
  const rows = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (rows.length === 0) throw new Error(`no tenant ${tenantId}`);

  const settings = (rows[0]!.settings && typeof rows[0]!.settings === 'object' ? rows[0]!.settings : {}) as Record<
    string,
    unknown
  >;
  const current = settings[AGENT_PERSONA_KEY];

  const writes = ['model', 'voice', 'emotion', 'speed', 'volume', 'name', 'gender'].filter((f) => arg(f) !== undefined);

  if (!has('clear') && writes.length === 0) {
    console.log(`tenant    ${tenantId}`);
    console.log(`stored    ${current === undefined ? '(no agent_persona)' : JSON.stringify(current)}`);
    const resolved = resolveAgentPersona(settings, env);
    console.log(`effective ${JSON.stringify(resolved.overrides)}   (unset fields fall back to env)`);
    console.log(`sources   ${JSON.stringify(resolved.sources)}`);
    for (const w of resolved.warnings) console.warn(`WARNING   ${w}`);
    process.exit(0);
  }

  if (has('clear')) {
    delete settings[AGENT_PERSONA_KEY];
    await db.update(tenants).set({ settings, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
    console.log(`cleared agent_persona for ${tenantId} — every field now comes from env.`);
    process.exit(0);
  }

  // Patch onto what is already stored, so flipping the model cannot drop the voice.
  const base = (current && typeof current === 'object' ? current : {}) as Record<string, unknown>;
  const baseTts = (base.tts && typeof base.tts === 'object' ? base.tts : {}) as Record<string, unknown>;
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

  const patched = {
    ...base,
    ...(arg('name') !== undefined ? { name: arg('name') } : {}),
    ...(arg('gender') !== undefined ? { gender: arg('gender') } : {}),
    tts: {
      ...baseTts,
      ...(arg('model') !== undefined ? { model: arg('model') } : {}),
      ...(arg('voice') !== undefined ? { voiceId: arg('voice') } : {}),
      ...(arg('emotion') !== undefined ? { emotion: arg('emotion') } : {}),
      ...(arg('speed') !== undefined ? { speed: num(arg('speed')) } : {}),
      ...(arg('volume') !== undefined ? { volume: num(arg('volume')) } : {}),
    },
  };

  // Throws on anything Cartesia would reject — before it reaches the database.
  const persona = assertAgentPersona(patched);
  settings[AGENT_PERSONA_KEY] = persona;
  await db.update(tenants).set({ settings, updatedAt: new Date() }).where(eq(tenants.id, tenantId));

  console.log(`tenant    ${tenantId}`);
  console.log(`was       ${current === undefined ? '(no agent_persona)' : JSON.stringify(current)}`);
  console.log(`now       ${JSON.stringify(persona)}`);
  console.log('\nTakes effect on the NEXT call — the agent reads settings at pickup, per call.');
} finally {
  await pool.end();
}
process.exit(0);
