/**
 * Mint a browser voice session WITHOUT booting the API server.
 *
 * `POST /voice/web-call` does this already, but reaching it needs the Fastify app, Redis, the six
 * workers and a tenant API key — a lot of moving parts to stand up for one microphone test. This
 * mints the identical token (same metadata contract, so the agent's tool gate resolves the same
 * tenant) and prints a ready-to-open LiveKit client URL.
 *
 *   npx tsx --env-file=.env scripts/mint-web-call.ts [tenantId]
 *
 * The agent worker must already be running (`npm run voice:dev`); it auto-dispatches into the new
 * room exactly as it does for a SIP call.
 */
import { randomUUID } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { loadEnv } from '../src/config/env.js';
import { tenants } from '../src/db/schema/index.js';
import { sanitizeSettingsForAgent } from '../src/modules/channels/voice-livekit/voice-livekit.service.js';
import { createVoiceConversation, ensureWebCallPlaceholderLead } from '../src/modules/channels/voice-livekit/call-record.js';

const env = loadEnv();
const tenantId = process.argv[2] ?? env.PLATFORM_TENANT_ID;
if (!tenantId) throw new Error('No tenant: pass one as argv[2] or set PLATFORM_TENANT_ID');

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = env;
if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) throw new Error('LiveKit is not configured');

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const db = drizzle(pool);

const rows = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
if (!rows[0]) throw new Error(`Tenant ${tenantId} not found`);
const gateSettings = sanitizeSettingsForAgent(rows[0].settings);

const roomName = `web-call-${randomUUID()}`;
let conversationId: string | undefined;
try {
  const leadId = await ensureWebCallPlaceholderLead(db, tenantId);
  conversationId = await createVoiceConversation(db, { tenantId, leadId, roomName });
} catch (err) {
  console.warn('could not create conversation row (call still proceeds):', err instanceof Error ? err.message : err);
}

const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
  identity: `web-${randomUUID().slice(0, 8)}`,
  ttl: 60 * 60,
  metadata: JSON.stringify({
    tenantId,
    direction: 'web',
    ...(gateSettings ? { settings: gateSettings } : {}),
    ...(conversationId ? { conversationId } : {}),
  }),
});
token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
const jwt = await token.toJwt();

console.log('\nroom:   ' + roomName);
console.log('tenant: ' + tenantId);
console.log('gate:   ' + JSON.stringify(gateSettings));
console.log('\nOpen this, allow the microphone, and start talking:\n');
console.log(`https://meet.livekit.io/custom?liveKitUrl=${encodeURIComponent(LIVEKIT_URL)}&token=${jwt}\n`);

await pool.end();
