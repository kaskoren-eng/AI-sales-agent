import { createHash, createHmac } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import type { Database } from '../../db/client.js';
import type { Redis } from 'ioredis';
import type { Env } from '../../config/env.js';
import { callLearnings } from '../../db/schema/call-learnings.js';
import { ValidationError } from '../../shared/errors.js';

const ZADARMA_API_BASE = 'https://api.zadarma.com';
// Redis key prefix + TTL for call_id → tenant mapping
const REDIS_PREFIX = 'monitor_call:';
const REDIS_TTL_SECS = 86_400; // 24 hours

export interface CreateMonitorCallParams {
  tenantId: string;
  userPhone: string;
  clientPhone: string;
  label?: string;
}

export class MonitorCallService {
  constructor(
    private db: Database,
    private redis: Redis,
    private env: Env,
  ) {}

  async createMonitoredCall(params: CreateMonitorCallParams) {
    const { tenantId, userPhone, clientPhone, label } = params;
    const { ZADARMA_API_KEY, ZADARMA_API_SECRET } = this.env;

    if (!ZADARMA_API_KEY || !ZADARMA_API_SECRET) {
      throw new ValidationError('Zadarma is not configured — set ZADARMA_API_KEY and ZADARMA_API_SECRET');
    }

    // Use a stable identifier for this call session; Zadarma returns their own call_id
    // but we need to track it before the call completes.
    const sessionId = `mtr-${randomBytes(8).toString('hex')}`;

    // Insert placeholder DB record before dialing — ensures the recording webhook
    // can always resolve the tenant even if the Zadarma call fails mid-flight.
    const [learning] = await this.db
      .insert(callLearnings)
      .values({ tenantId, conferenceName: sessionId, label, status: 'pending' })
      .returning({ id: callLearnings.id });

    // Initiate callback via Zadarma: calls userPhone first, then connects to clientPhone
    const callParams = {
      from: userPhone,
      to: clientPhone,
    };

    const auth = buildZadarmaAuth(ZADARMA_API_KEY, ZADARMA_API_SECRET, callParams);

    const body = new URLSearchParams(callParams);
    const res = await fetch(`${ZADARMA_API_BASE}/v1/request/callback/`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Zadarma callback failed: HTTP ${res.status} — ${err}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const zadarmaCallId = (data['call_id'] as string | undefined) ?? sessionId;

    // Store mapping: zadarma call_id → tenantId so the NOTIFY_END webhook can look it up
    await this.redis.set(
      `${REDIS_PREFIX}${zadarmaCallId}`,
      JSON.stringify({ tenantId }),
      'EX',
      REDIS_TTL_SECS,
    );

    // Also store the session → zadarma call_id mapping for lookup
    if (zadarmaCallId !== sessionId) {
      await this.redis.set(
        `${REDIS_PREFIX}${sessionId}`,
        JSON.stringify({ tenantId }),
        'EX',
        REDIS_TTL_SECS,
      );
      // Update the DB record conferenceName to the actual Zadarma call_id
      await this.db
        .update(callLearnings)
        .set({ conferenceName: zadarmaCallId })
        .where(
          (await import('drizzle-orm').then(({ eq }) => eq))(callLearnings.id, learning.id),
        );
    }

    return {
      learningId: learning.id,
      callId: zadarmaCallId,
      status: 'dialing' as const,
    };
  }
}

/**
 * Build Zadarma API Authorization header value.
 * Format: "{api_key}:{base64(hmac_sha1(md5(params_sorted), api_secret))}"
 */
function buildZadarmaAuth(apiKey: string, apiSecret: string, params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const md5 = createHash('md5').update(sorted).digest('hex');
  const sig = createHmac('sha1', apiSecret).update(md5).digest('base64');
  return `${apiKey}:${sig}`;
}
