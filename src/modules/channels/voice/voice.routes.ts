import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import OpenAI from 'openai';
import { VoiceService } from './voice.service.js';
import { conversations, messages, callLearnings, leads, tenants } from '../../../db/schema/index.js';
import { enqueueCallAnalysis } from '../../../queues/call-analysis.queue.js';
import { enqueueFlowStep } from '../../../queues/flow-executor.queue.js';
import { GoogleCalendarProvider } from '../../scheduling/providers/google-calendar.provider.js';

export async function voiceRoutes(app: FastifyInstance) {
  const service = new VoiceService(app);

  /**
   * Retell AI webhook — receives call_started and call_analyzed events.
   *
   * Retell sends:
   *   Header: x-retell-signature: <hmac_sha256_hex>
   *   HMAC key: RETELL_API_KEY
   *   HMAC message: raw request body
   *
   * Configure in Retell dashboard → Agent settings → Webhook URL:
   *   https://<your-domain>/webhooks/voice/retell
   *
   * call_started  → create conversation record, link to lead by phone
   * call_analyzed → store transcript, update conversation, trigger post-call flow
   */
  app.post('/retell', async (request, reply) => {
    const apiKey = app.env.RETELL_API_KEY;

    // Fail closed: this webhook writes call transcripts/summaries to the DB and CRM
    // and feeds future agent prompts, so an unverified request must never be processed.
    if (!apiKey) {
      app.log.error('Retell webhook rejected: RETELL_API_KEY not configured');
      return reply.status(401).send({ error: 'Webhook not configured' });
    }

    const sig = request.headers['x-retell-signature'] as string | undefined;
    const rawBody = (request as any).rawBody as string | undefined;

    if (!sig || !rawBody) {
      app.log.warn('Retell webhook: missing signature or raw body');
      return reply.status(401).send({ error: 'Missing signature' });
    }

    if (!verifyRetellSignature(rawBody, sig, apiKey)) {
      app.log.warn('Retell webhook: invalid signature');
      return reply.status(401).send({ error: 'Invalid signature' });
    }

    const body = request.body as Record<string, any>;
    const event = body?.event as string | undefined;
    const call = body?.call as Record<string, any> | undefined;

    if (!event || !call) {
      return reply.status(400).send({ error: 'Invalid payload' });
    }

    const callId = call['call_id'] as string | undefined;
    if (!callId) {
      return reply.status(400).send({ error: 'Missing call_id' });
    }

    app.log.info({ event, callId }, 'Retell webhook received');

    // ----------------------------------------------------------------
    // call_started — create conversation record and link to lead
    // ----------------------------------------------------------------
    if (event === 'call_started') {
      const tenantId = app.env.VOICE_WEBHOOK_TENANT_ID;
      if (!tenantId) {
        app.log.warn('VOICE_WEBHOOK_TENANT_ID not set — skipping call_started');
        return reply.status(200).send({ ok: true });
      }

      const fromNumber = call['from_number'] as string | undefined;
      const toNumber = call['to_number'] as string | undefined;

      // For outbound calls our SIP number is from_number; the lead is to_number.
      // Detect by checking if from_number matches our configured outbound number.
      const ourNumber = app.env.ZADARMA_PHONE_NUMBER;
      const isOutbound = ourNumber && fromNumber === ourNumber;
      const leadPhone = isOutbound ? toNumber : fromNumber;

      // Find existing lead by phone number, or create a placeholder
      let leadId: string | null = null;
      if (leadPhone) {
        const [existingLead] = await app.db
          .select({ id: leads.id })
          .from(leads)
          .where(and(eq(leads.tenantId, tenantId), eq(leads.phone, leadPhone)))
          .limit(1);

        if (existingLead) {
          leadId = existingLead.id;
        } else {
          // Create placeholder lead so the conversation record is valid
          const [newLead] = await app.db
            .insert(leads)
            .values({ tenantId, phone: leadPhone, name: null, status: 'new' })
            .returning({ id: leads.id });
          leadId = newLead?.id ?? null;
        }
      }

      if (!leadId) {
        app.log.warn({ callId, tenantId }, 'Retell call_started: no phone number — skipping conversation creation');
        return reply.status(200).send({ ok: true });
      }

      await app.db
        .insert(conversations)
        .values({
          tenantId,
          leadId,
          channel: 'voice',
          channelRef: callId,
          status: 'active',
        })
        .onConflictDoNothing();

      app.log.info({ callId, tenantId, leadId }, 'Retell conversation record created');
      return reply.status(200).send({ ok: true });
    }

    // ----------------------------------------------------------------
    // call_analyzed — store transcript, update conversation, post-call flow
    // ----------------------------------------------------------------
    if (event === 'call_analyzed') {
      const transcriptObject = call['transcript_object'] as Array<Record<string, any>> | undefined;
      const callAnalysis = call['call_analysis'] as Record<string, any> | undefined;
      const durationMs = call['duration_ms'] as number | undefined;

      // Find conversation by Retell call_id
      const [convo] = await app.db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.channel, 'voice'),
            eq(conversations.channelRef, callId),
          ),
        )
        .limit(1);

      if (!convo) {
        app.log.warn({ callId }, 'Retell call_analyzed: no matching conversation record — skipping');
        return reply.status(200).send({ ok: true, skipped: true });
      }

      // Store transcript turns as messages
      if (transcriptObject?.length) {
        const turns = transcriptObject.map((turn, idx) => ({
          tenantId: convo.tenantId,
          conversationId: convo.id,
          direction: turn['role'] === 'agent' ? 'outbound' : 'inbound',
          role: turn['role'] === 'agent' ? 'agent' : 'lead',
          content: typeof turn['content'] === 'string' ? turn['content'] : '',
          contentType: 'transcript',
          metadata:
            durationMs && idx === transcriptObject.length - 1
              ? { call_duration_secs: Math.round(durationMs / 1000) }
              : {},
        }));

        await app.db.insert(messages).values(turns);
      }

      // Extract any live booking made during the call via /retell-tools before overwriting summary
      let bookingContext: { meetingLink?: string; meetingTime?: string; meetingDate?: string } = {};
      if (convo.summary?.startsWith('__booking__:')) {
        try {
          bookingContext = JSON.parse(convo.summary.slice('__booking__:'.length));
        } catch { /* malformed — ignore */ }
      }

      // Generate Hebrew summary from transcript using GPT
      let summary: string | undefined = callAnalysis?.['call_summary'];
      if (transcriptObject?.length) {
        const openaiKey = app.env.OPENAI_API_KEY;
        app.log.info({ hasKey: !!openaiKey, callId }, 'Attempting Hebrew summary generation');
        try {
          const transcriptText = transcriptObject
            .map(t => `${t['role'] === 'agent' ? 'סוכן' : 'לקוח'}: ${t['content']}`)
            .join('\n');
          const oai = new OpenAI({ apiKey: openaiKey! });
          const completion = await oai.chat.completions.create({
            model: app.env.AI_MODEL ?? 'gpt-4o',
            messages: [
              {
                role: 'system',
                content: 'אתה מסכם שיחות מכירה בעברית. כתוב סיכום קצר (2-3 משפטים) של השיחה הבאה. ציין מה הלקוח צריך, מה הוצע לו, ומה הצעד הבא. כתוב בעברית בלבד.',
              },
              { role: 'user', content: transcriptText },
            ],
          });
          const generated = completion.choices[0]?.message.content;
          if (generated) {
            summary = generated;
            app.log.info({ callId }, 'Hebrew summary generated successfully');
          }
        } catch (err) {
          app.log.warn({ err, callId }, 'Hebrew summary generation failed — using Retell summary');
        }
      }

      await app.db
        .update(conversations)
        .set({
          status: 'ended',
          ...(summary ? { summary } : {}),
          updatedAt: new Date(),
        } as any)
        .where(eq(conversations.id, convo.id));

      app.log.info(
        { callId, convoId: convo.id, turns: transcriptObject?.length ?? 0 },
        'Retell transcript stored',
      );

      // Trigger post-call flow if configured
      try {
        const [lead] = await app.db
          .select({ id: leads.id, phone: leads.phone, name: leads.name, email: leads.email })
          .from(leads)
          .where(and(eq(leads.id, convo.leadId), eq(leads.tenantId, convo.tenantId)))
          .limit(1);

        if (lead?.phone) {
          const [tenantRow] = await app.db
            .select({ settings: tenants.settings })
            .from(tenants)
            .where(eq(tenants.id, convo.tenantId))
            .limit(1);

          const postCallFlow = (tenantRow?.settings as Record<string, any> | null)?.flows?.['post-call'];
          if (postCallFlow?.enabled) {
            await enqueueFlowStep(
              app.queues.flowExecutor,
              {
                tenantId: convo.tenantId,
                leadId: convo.leadId,
                flowName: 'post-call',
                stepIndex: 0,
                leadPhone: lead.phone,
                leadName: lead.name ?? undefined,
                leadEmail: lead.email ?? undefined,
                flowContext: { callSummary: summary ?? '', ...bookingContext },
              },
              0,
            );
            app.log.info({ tenantId: convo.tenantId, leadId: convo.leadId, callId }, 'Post-call flow enqueued');
          }
        }
      } catch (err) {
        app.log.warn({ err, callId }, 'Post-call flow trigger failed — non-fatal');
      }

      return reply.status(200).send({ ok: true, turns: transcriptObject?.length ?? 0 });
    }

    // Unknown event — acknowledge without error
    return reply.status(200).send({ ok: true });
  });

  /**
   * Retell AI custom tool webhook — called synchronously during a live call when the agent
   * invokes a configured tool (e.g. book_appointment).
   *
   * Retell POSTs: { call_id, name, args: { lead_email, lead_name, timezone? } }
   * We must respond within ~15s with: { result: "<string the agent reads back>" }
   *
   * Configure in Retell dashboard → Agent → Tools → Add Custom Tool:
   *   Name: book_appointment
   *   Webhook URL: https://<your-domain>/webhooks/voice/retell-tools
   *   speak_during_execution: true
   */
  app.post('/retell-tools', async (request, reply) => {
    const apiKey = app.env.RETELL_API_KEY;

    // Fail closed: this tool webhook can book appointments and mutate data.
    if (!apiKey) {
      app.log.error('Retell tools webhook rejected: RETELL_API_KEY not configured');
      return reply.status(401).send({ error: 'Webhook not configured' });
    }

    const sig = request.headers['x-retell-signature'] as string | undefined;
    const rawBody = (request as any).rawBody as string | undefined;

    if (!sig || !rawBody) {
      app.log.warn('Retell tools webhook: missing signature or raw body');
      return reply.status(401).send({ error: 'Missing signature' });
    }

    if (!verifyRetellSignature(rawBody, sig, apiKey)) {
      app.log.warn('Retell tools webhook: invalid signature');
      return reply.status(401).send({ error: 'Invalid signature' });
    }

    const body = request.body as Record<string, any>;
    const callId = body?.call_id as string | undefined;
    const toolName = body?.name as string | undefined;
    const args = (body?.args ?? {}) as Record<string, string>;

    if (!callId || !toolName) {
      return reply.status(400).send({ result: 'Invalid tool call payload.' });
    }

    app.log.info({ callId, toolName }, 'Retell tool call received');

    if (toolName !== 'book_appointment') {
      app.log.warn({ callId, toolName }, 'Retell tool call: unknown tool name');
      return reply.status(200).send({ result: 'That tool is not available right now.' });
    }

    // Resolve conversation → lead
    const [convo] = await app.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.channel, 'voice'), eq(conversations.channelRef, callId)))
      .limit(1);

    if (!convo) {
      app.log.warn({ callId }, 'Retell tool call: no matching conversation');
      return reply.status(200).send({ result: 'I was unable to find your details. Please call back and we will book manually.' });
    }

    const [lead] = await app.db
      .select({ name: leads.name, email: leads.email })
      .from(leads)
      .where(and(eq(leads.id, convo.leadId), eq(leads.tenantId, convo.tenantId)))
      .limit(1);

    const { GOOGLE_CALENDAR_ID, GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL, GOOGLE_CALENDAR_PRIVATE_KEY } = app.env;

    if (!GOOGLE_CALENDAR_ID || !GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL || !GOOGLE_CALENDAR_PRIVATE_KEY) {
      app.log.warn({ callId }, 'Retell tool call: Google Calendar not configured');
      return reply.status(200).send({ result: 'Calendar booking is not set up yet. Our team will follow up to schedule.' });
    }

    const attendeeEmail = lead?.email ?? args['lead_email'];
    if (!attendeeEmail) {
      app.log.warn({ callId, leadId: convo.leadId }, 'Retell tool call: no email for booking');
      return reply.status(200).send({ result: 'I need your email address to send you a calendar invite. Could you share it with me?' });
    }

    try {
      const timezone = args['timezone'] ?? 'UTC';

      const provider = new GoogleCalendarProvider({
        calendarId: GOOGLE_CALENDAR_ID,
        serviceAccountEmail: GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL,
        privateKey: GOOGLE_CALENDAR_PRIVATE_KEY.replace(/\\n/g, '\n'),
        slotMinutes: app.env.GOOGLE_CALENDAR_SLOT_MINUTES ?? 30,
        workStart: app.env.GOOGLE_CALENDAR_WORK_START ?? '09:00',
        workEnd: app.env.GOOGLE_CALENDAR_WORK_END ?? '18:00',
      });

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const searchEnd = new Date(tomorrow);
      searchEnd.setDate(searchEnd.getDate() + 7);

      const slots = await provider.getAvailableSlots({
        startDate: tomorrow.toISOString().slice(0, 10),
        endDate: searchEnd.toISOString().slice(0, 10),
        serviceId: GOOGLE_CALENDAR_ID,
        timezone,
      });

      if (!slots.length) {
        app.log.warn({ callId }, 'Retell tool call: no available slots');
        return reply.status(200).send({ result: 'There are no open slots in the next 7 days. Our team will reach out to find a time.' });
      }

      const booking = await provider.createBooking({
        start: slots[0].start,
        serviceId: GOOGLE_CALENDAR_ID,
        attendee: {
          name: lead?.name ?? args['lead_name'] ?? 'Lead',
          email: attendeeEmail,
          timezone,
        },
        notes: `Booked via AI sales call (call_id: ${callId})`,
      });

      const startDt = new Date(booking.start);
      const meetingDate = startDt.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: timezone,
      });
      const meetingTime = startDt.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', timeZone: timezone,
      });
      const meetingLink = booking.meetLink ?? 'https://calendar.google.com/calendar/r';

      // Persist booking on the conversation so call_analyzed can forward it into the post-call flow
      await app.db
        .update(conversations)
        .set({ summary: `__booking__:${JSON.stringify({ meetingLink, meetingTime, meetingDate })}`, updatedAt: new Date() } as any)
        .where(eq(conversations.id, convo.id));

      app.log.info({ callId, convoId: convo.id, bookingUid: booking.uid, start: booking.start }, 'Live booking created via Retell tool call');

      return reply.status(200).send({
        result: `Perfect! I have booked your appointment for ${meetingDate} at ${meetingTime}. You will receive a calendar invite at ${attendeeEmail}. The meeting link is ${meetingLink}.`,
      });

    } catch (err) {
      app.log.error({ err, callId }, 'Retell tool call: booking failed');
      return reply.status(200).send({ result: 'I ran into a technical issue while booking. Our team will follow up by email to confirm a time.' });
    }
  });

  /**
   * Zadarma verification challenge — responds to GET ?zd_echo=<value> with the value as plain text.
   * Zadarma sends this when you first register a notification URL to confirm ownership.
   */
  app.get('/zadarma', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const echo = query['zd_echo'];
    if (echo) {
      return reply.status(200).type('text/plain').send(echo);
    }
    return reply.status(200).send({ ok: true });
  });

  /**
   * Zadarma notification webhook — fired when a monitored call ends and recording is ready.
   * Zadarma POSTs application/x-www-form-urlencoded with:
   *   call_id, disposition, recording (URL), from_number, called_number, duration
   *
   * Configure in Zadarma portal → My Notifications:
   *   https://<your-domain>/webhooks/voice/zadarma
   */
  app.post('/zadarma', async (request, reply) => {
    const params = request.body as Record<string, string>;
    const { call_id, disposition, recording, duration } = params;

    // Only process answered calls with a recording
    if (disposition !== 'answered' || !recording) {
      return reply.status(204).send();
    }

    app.log.info({ call_id, recording }, 'Zadarma recording notification received');

    if (!call_id) {
      app.log.warn({ params }, 'Zadarma notify: missing call_id');
      return reply.status(200).send({ ok: true, skipped: true });
    }

    // Resolve tenant from Redis mapping created when the monitor call was started
    const redisKey = `monitor_call:${call_id}`;
    const mapping = await app.redis.get(redisKey);
    if (!mapping) {
      app.log.warn({ call_id }, 'Zadarma notify: no tenant mapping found — not a monitored call');
      return reply.status(200).send({ ok: true, skipped: true });
    }

    const { tenantId } = JSON.parse(mapping) as { tenantId: string };

    // Update the learning record with recording details
    await app.db
      .update(callLearnings)
      .set({ recordingUrl: recording })
      .where(
        and(
          eq(callLearnings.tenantId, tenantId),
          eq(callLearnings.conferenceName, call_id),
        ),
      );

    // Fetch learning ID for the queue job
    const [row] = await app.db
      .select({ id: callLearnings.id })
      .from(callLearnings)
      .where(
        and(
          eq(callLearnings.tenantId, tenantId),
          eq(callLearnings.conferenceName, call_id),
        ),
      )
      .limit(1);

    if (!row) {
      app.log.warn({ call_id, tenantId }, 'Zadarma notify: learning record not found');
      return reply.status(200).send({ ok: true, skipped: true });
    }

    await enqueueCallAnalysis(app.queues.callAnalysis, {
      tenantId,
      learningId: row.id,
      recordingUrl: recording,
      recordingSid: call_id,
      durationSecs: duration ? parseInt(duration, 10) : 0,
    });

    app.log.info({ learningId: row.id, tenantId }, 'Call analysis job enqueued from Zadarma');
    return reply.status(200).send({ ok: true });
  });
}

/**
 * Verify a Retell webhook signature.
 *
 * Matches the official algorithm in RetellAI/retell-typescript-sdk (src/lib/webhook_auth.ts):
 *   - Header `x-retell-signature` has the form `v=<epoch_ms>,d=<hmac_sha256_hex>`
 *   - digest = HMAC-SHA256(apiKey, rawBody + <epoch_ms>) as hex  ← body THEN timestamp
 *   - reject if the timestamp is more than 5 minutes from now (replay protection)
 *
 * NOTE: the earlier implementation hashed `timestamp + body` (wrong order), which never
 * matched a real Retell request — that is why verification was previously bypassed.
 */
export function verifyRetellSignature(rawBody: string, signature: string, apiKey: string): boolean {
  try {
    const match = /^v=(\d+),d=(.+)$/.exec(signature);
    if (!match) return false;

    const [, tsStr, receivedD] = match;
    const ts = Number(tsStr);

    // Replay protection: reject requests outside a 5-minute window.
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) return false;

    // Retell signs the raw body concatenated with the timestamp.
    const expected = createHmac('sha256', apiKey).update(rawBody + tsStr, 'utf8').digest('hex');

    const expBuf = Buffer.from(expected, 'utf8');
    const gotBuf = Buffer.from(receivedD, 'utf8');
    return expBuf.length === gotBuf.length && timingSafeEqual(expBuf, gotBuf);
  } catch {
    return false;
  }
}
