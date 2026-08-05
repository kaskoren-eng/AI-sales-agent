import type { FastifyInstance } from 'fastify';
import { getTenantId } from '../../shared/tenant-context.js';
import { GoogleCalendarProvider } from './providers/google-calendar.provider.js';
import { scheduledCalls, leads } from '../../db/schema/index.js';
import { eq, and, gte, asc, desc, count } from 'drizzle-orm';
import { cancelMeetingReminders } from '../../queues/meeting-reminders.queue.js';

function getCalendarProvider(app: FastifyInstance): GoogleCalendarProvider | null {
  const { GOOGLE_CALENDAR_ID, GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL, GOOGLE_CALENDAR_PRIVATE_KEY } = app.env;
  if (!GOOGLE_CALENDAR_ID || !GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL || !GOOGLE_CALENDAR_PRIVATE_KEY) return null;
  return new GoogleCalendarProvider({
    calendarId: GOOGLE_CALENDAR_ID,
    serviceAccountEmail: GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL,
    privateKey: GOOGLE_CALENDAR_PRIVATE_KEY.replace(/\\n/g, '\n'),
    slotMinutes: app.env.GOOGLE_CALENDAR_SLOT_MINUTES ?? 30,
    workStart: app.env.GOOGLE_CALENDAR_WORK_START ?? '09:00',
    workEnd: app.env.GOOGLE_CALENDAR_WORK_END ?? '18:00',
    impersonateUser: app.env.GOOGLE_CALENDAR_IMPERSONATE_USER,
  });
}

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
    const provider = getCalendarProvider(app);
    if (!provider) {
      return reply.status(503).send({ error: 'Scheduling not configured' });
    }

    const { startDate, endDate, timezone = 'UTC' } = request.query;
    const calendarId = app.env.GOOGLE_CALENDAR_ID!;

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
    const provider = getCalendarProvider(app);
    if (!provider) {
      return reply.status(503).send({ error: 'Scheduling not configured' });
    }

    const { start, name, email, phone, timezone = 'UTC', notes, leadId, conversationId } = request.body;

    const booking = await provider.createBooking({
      start,
      serviceId: app.env.GOOGLE_CALENDAR_ID!,
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
    const provider = getCalendarProvider(app);
    if (!provider) {
      return reply.status(503).send({ error: 'Scheduling not configured' });
    }

    const { bookingUid } = request.params;
    await provider.cancelBooking(bookingUid);

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
