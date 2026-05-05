import twilio from 'twilio';
import { randomBytes } from 'node:crypto';
import type { Database } from '../../db/client.js';
import type { Redis } from 'ioredis';
import type { Env } from '../../config/env.js';
import { callLearnings } from '../../db/schema/call-learnings.js';
import { ValidationError } from '../../shared/errors.js';

// Redis key prefix + TTL for conference → tenant mapping
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
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, BASE_URL } = this.env;

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
      throw new ValidationError('Twilio is not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER');
    }

    if (!BASE_URL) {
      throw new ValidationError('BASE_URL is required for recording callbacks');
    }

    // Generate a short unique conference name
    const conferenceName = `mtr-${randomBytes(8).toString('hex')}`;
    const recordingCallbackUrl = `${BASE_URL}/webhooks/voice/recording-status`;

    // TwiML that puts each caller into the named conference with recording
    const twiml = `<Response><Dial><Conference record="record-from-start" recordingStatusCallback="${recordingCallbackUrl}" recordingStatusCallbackMethod="POST" beep="false" startConferenceOnEnter="true" endConferenceOnExit="false">${conferenceName}</Conference></Dial></Response>`;

    // Insert DB record and Redis key before dialing — ensures the recording webhook
    // can always resolve the tenant even if one of the Twilio calls fails mid-flight.
    const [learning] = await this.db
      .insert(callLearnings)
      .values({ tenantId, conferenceName, label, status: 'pending' })
      .returning({ id: callLearnings.id });

    await this.redis.set(`${REDIS_PREFIX}${conferenceName}`, JSON.stringify({ tenantId }), 'EX', REDIS_TTL_SECS);

    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    // Dial both parties into the conference simultaneously
    const [userCall] = await Promise.all([
      client.calls.create({ to: userPhone, from: TWILIO_PHONE_NUMBER, twiml }),
      client.calls.create({ to: clientPhone, from: TWILIO_PHONE_NUMBER, twiml }),
    ]);

    return {
      learningId: learning.id,
      conferenceName,
      callSid: userCall.sid,
      status: 'dialing' as const,
    };
  }
}
