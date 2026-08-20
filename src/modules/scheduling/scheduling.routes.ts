import type { FastifyInstance } from 'fastify';
import { getTenantId } from '../../shared/tenant-context.js';
import { GoogleCalendarProvider } from './providers/google-calendar.provider.js';
import { resolveCalendarAuth } from '../integrations/google-calendar/resolve-calendar-auth.js';
import { scheduledCalls, leads } from '../../db/schema/index.js';
import { eq, and, gte, asc, desc, count } from 'drizzle-orm';
import { cancelMeetingReminders } from '../../queues/meeting-reminders.queue.js';

/**
 * The calendar THIS tenant books into.
 *
 * This function used to read `GOOGLE_CALENDAR_*` straight out of env and hand every caller the
 * same service-account client, pinned to `GOOGLE_CALENDAR_ID`. Those env vars are ClickScales'
 * own credentials — they only ever were — so every tenant's booking was created in ClickScales'
 * diary while the `scheduled_calls` row was stamped with the customer's `tenant_id`: the database
 * saying one thing and the calendar showing another. `/slots` compounded it by offering customers
 * ClickScales' free time.
 *
 * The voice agent already resolved this per tenant; the REST routes did not, so the answer
 * depended on which door a booking came through. Both now call one resolver.
 *
 * Returns null when the tenant has no calendar at all — typically a customer who has not
 * connected Google. That is a 503, NOT a silent fall back to the platform account.
 */
async function getCalendarProvider(
  app: FastifyInstance,
  tenantId: string,
): Promise<{ provider: GoogleCalendarProvider; calendarId: string } | null> {
  const resolved = await resolveCalendarAuth(app.env, tenantId, app.db);
  if (!resolved) return null;

  return {
    calendarId: resolved.calendarId,
    provider: new GoogleCalendarProvider({
      calendarId: resolved.calendarId,
      auth: resolved.auth,
      slotMinutes: app.env.GOOGLE_CALENDAR_SLOT_MINUTES ?? 30,
      workStart: app.env.GOOGLE_CALENDAR_WORK_START ?? '09:00',
      workEnd: app.env.GOOGLE_CALENDAR_WORK_END ?? '18:00',
    }),
  };
}

/** Same body for "platform env incomplete" and "customer never connected": both mean this caller
 *  cannot book, and the distinction belongs in the logs the resolver already writes. */
const NOT_CONFIGURED = { error: 'Scheduling not configured' };

export async function schedulingRoutes(app: FastifyInstance) {
  /**
   * GET /bookings — the tenant's meetings.
   *
   * The dashboard's Bookings page has called this since it was built and it has never existed, so
   * the page has shown its error state to every user since day one. Read-only and additive: it
   * reads `scheduled_calls`, which is already written by the booking path.
   *
   * Defaults to UPCOMING, ascending, because the page renders the result under a heading that says
   * "Upcoming" — a list sorted newest-first under that heading would be actively misleading.
   */
  app.get<{
    Querystring: { page?: string; limit?: string; status?: string; upcoming?: string };
  }>('/bookings', async (request) => {
    const tenantId = getTenantId(request);
    const page = Math.max(1, Number(request.query.page ?? 1) || 1);
    const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 50) || 50));
    // Anything other than an explicit "false" means upcoming — the common case should not need a
    // query string, and a typo should not silently dump the entire history into the page.
    const upcoming = request.query.upcoming !== 'false';

    const filters = [eq(scheduledCalls.tenantId, tenantId)];
    if (request.query.status) filters.push(eq(scheduledCalls.status, request.query.status));
    if (upcoming) filters.push(gte(scheduledCalls.scheduledAt, new Date()));
    const where = and(...filters);

    const [rows, [counted]] = await Promise.all([
      app.db
        .select({
          id: scheduledCalls.id,
          leadId: scheduledCalls.leadId,
          leadName: leads.name,
          scheduledAt: scheduledCalls.scheduledAt,
          status: scheduledCalls.status,
          provider: scheduledCalls.provider,
          calendarEventId: scheduledCalls.providerRef,
          createdAt: scheduledCalls.createdAt,
        })
        .from(scheduledCalls)
        // LEFT join: `lead_id` is nullable, and a booking with no lead row still has to appear.
        // An inner join would silently hide meetings, which is the worst failure a calendar has.
        .leftJoin(leads, eq(leads.id, scheduledCalls.leadId))
        .where(where)
        .orderBy(upcoming ? asc(scheduledCalls.scheduledAt) : desc(scheduledCalls.scheduledAt))
        .limit(limit)
        .offset((page - 1) * limit),
      app.db.select({ c: count() }).from(scheduledCalls).where(where),
    ]);

    const total = Number(counted?.c ?? 0);
    return {
      data: rows,
      meta: { page, limit, total, total_pages: Math.max(1, Math.ceil(total / limit)) },
    };
  });

  // GET /slots — available time slots
  app.get<{
    Querystring: { startDate: string; endDate: string; timezone?: string };
  }>('/slots', async (request, reply) => {
    const tenantId = getTenantId(request);
    const calendar = await getCalendarProvider(app, tenantId);
    if (!calendar) {
      return reply.status(503).send(NOT_CONFIGURED);
    }
    const { provider, calendarId } = calendar;

    const { startDate, endDate, timezone = 'UTC' } = request.query;

    const slots = await provider.getAvailableSlots({
      startDate,
      endDate,
      serviceId: calendarId,
      timezone,
    });

    return { slots };
  });

  // POST /book — create a booking
  app.post<{
    Body: {
      start: string;
      name: string;
      email: string;
      phone?: string;
      timezone?: string;
      notes?: string;
      leadId?: string;
      conversationId?: string;
    };
  }>('/book', async (request, reply) => {
    const tenantId = getTenantId(request);
    const calendar = await getCalendarProvider(app, tenantId);
    if (!calendar) {
      return reply.status(503).send(NOT_CONFIGURED);
    }
    const { provider, calendarId } = calendar;

    const { start, name, email, phone, timezone = 'UTC', notes, leadId, conversationId } = request.body;

    const booking = await provider.createBooking({
      start,
      serviceId: calendarId,
      attendee: { name, email, phone, timezone },
      notes,
    });

    await app.db.insert(scheduledCalls).values({
      tenantId,
      leadId: leadId ?? undefined,
      conversationId: conversationId ?? undefined,
      providerRef: booking.uid,
      scheduledAt: new Date(booking.start),
      status: 'scheduled',
    });

    app.log.info({ tenantId, booking }, 'Google Calendar booking created');
    reply.status(201).send({ booking });
  });

  // POST /cancel/:bookingUid — cancel a booking
  app.post<{
    Params: { bookingUid: string };
  }>('/cancel/:bookingUid', async (request, reply) => {
    const tenantId = getTenantId(request);
    const calendar = await getCalendarProvider(app, tenantId);
    if (!calendar) {
      return reply.status(503).send(NOT_CONFIGURED);
    }

    const { bookingUid } = request.params;
    // Cancelling through the tenant's OWN credentials matters as much as booking through them:
    // the platform service account has no rights over an event in a customer's calendar, and the
    // error it would return reads as "already gone" rather than "wrong account".
    await calendar.provider.cancelBooking(bookingUid);

    // Read the row BEFORE flipping status — its reminders.jobIds is the list of pending
    // reminder jobs we can now remove by name (tenant-scoped, like every read here).
    const rows = await app.db
      .select({ reminders: scheduledCalls.reminders })
      .from(scheduledCalls)
      .where(
        and(
          eq(scheduledCalls.tenantId, tenantId),
          eq(scheduledCalls.providerRef, bookingUid),
        ),
      )
      .limit(1);

    await app.db
      .update(scheduledCalls)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(scheduledCalls.tenantId, tenantId),
          eq(scheduledCalls.providerRef, bookingUid),
        ),
      );

    // Best-effort: a job we miss here dies anyway at the worker's status check — the row is
    // 'cancelled' now. So removal failures must never fail the cancellation itself.
    const jobIds = rows[0]?.reminders?.jobIds ?? [];
    if (jobIds.length > 0) {
      try {
        const removed = await cancelMeetingReminders(app.queues.meetingReminders, jobIds);
        app.log.info({ tenantId, bookingUid, removed, of: jobIds.length }, 'Reminder jobs removed');
      } catch (err) {
        app.log.warn({ tenantId, bookingUid, err }, 'Reminder job removal failed — worker backstop will skip them');
      }
    }

    app.log.info({ tenantId, bookingUid }, 'Google Calendar booking cancelled');
    return { ok: true };
  });
}
