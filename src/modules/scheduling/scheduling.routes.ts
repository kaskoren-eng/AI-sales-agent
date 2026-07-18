import type { FastifyInstance } from 'fastify';
import { getTenantId } from '../../shared/tenant-context.js';
import { GoogleCalendarProvider } from './providers/google-calendar.provider.js';
import { scheduledCalls } from '../../db/schema/index.js';
import { eq, and } from 'drizzle-orm';

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

    await app.db
      .update(scheduledCalls)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(scheduledCalls.tenantId, tenantId),
          eq(scheduledCalls.providerRef, bookingUid),
        ),
      );

    app.log.info({ tenantId, bookingUid }, 'Google Calendar booking cancelled');
    return { ok: true };
  });
}
