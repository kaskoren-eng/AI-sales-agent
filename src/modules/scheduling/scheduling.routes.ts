import type { FastifyInstance } from 'fastify';
import { getTenantId } from '../../shared/tenant-context.js';
import { TrafftProvider } from './providers/trafft.provider.js';
import { scheduledCalls } from '../../db/schema/index.js';
import { eq, and } from 'drizzle-orm';

function getTrafftProvider(app: FastifyInstance): TrafftProvider | null {
  const { TRAFFT_SUBDOMAIN, TRAFFT_EMAIL, TRAFFT_PASSWORD } = app.env;
  if (!TRAFFT_SUBDOMAIN || !TRAFFT_EMAIL || !TRAFFT_PASSWORD) return null;
  return new TrafftProvider({
    subdomain: TRAFFT_SUBDOMAIN,
    email: TRAFFT_EMAIL,
    password: TRAFFT_PASSWORD,
  });
}

export async function schedulingRoutes(app: FastifyInstance) {
  // GET /slots — available time slots for a service
  app.get<{
    Querystring: { startDate: string; endDate: string; timezone?: string };
  }>('/slots', async (request, reply) => {
    const tenantId = getTenantId(request);
    const provider = getTrafftProvider(app);
    if (!provider) {
      return reply.status(503).send({ error: 'Scheduling not configured' });
    }

    const { startDate, endDate, timezone = 'UTC' } = request.query;
    const serviceId = app.env.TRAFFT_SERVICE_ID;
    if (!serviceId) {
      return reply.status(400).send({ error: 'TRAFFT_SERVICE_ID not configured' });
    }

    const slots = await provider.getAvailableSlots({
      startDate,
      endDate,
      serviceId,
      timezone,
      employeeId: app.env.TRAFFT_EMPLOYEE_ID,
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
    };
  }>('/book', async (request, reply) => {
    const tenantId = getTenantId(request);
    const provider = getTrafftProvider(app);
    if (!provider) {
      return reply.status(503).send({ error: 'Scheduling not configured' });
    }

    const serviceId = app.env.TRAFFT_SERVICE_ID;
    if (!serviceId) {
      return reply.status(400).send({ error: 'TRAFFT_SERVICE_ID not configured' });
    }

    const { start, name, email, phone, timezone = 'UTC', notes, leadId } = request.body;

    const booking = await provider.createBooking({
      start,
      serviceId,
      attendee: { name, email, phone, timezone },
      employeeId: app.env.TRAFFT_EMPLOYEE_ID,
      notes,
    });

    // Persist to scheduled_calls table
    await app.db.insert(scheduledCalls).values({
      tenantId,
      leadId: leadId ?? undefined,
      providerRef: booking.uid,
      scheduledAt: new Date(booking.start),
      status: 'scheduled',
    });

    app.log.info({ tenantId, booking }, 'Trafft booking created');
    reply.status(201).send({ booking });
  });

  // POST /cancel/:bookingUid — cancel a booking
  app.post<{
    Params: { bookingUid: string };
  }>('/cancel/:bookingUid', async (request, reply) => {
    const tenantId = getTenantId(request);
    const provider = getTrafftProvider(app);
    if (!provider) {
      return reply.status(503).send({ error: 'Scheduling not configured' });
    }

    const { bookingUid } = request.params;
    await provider.cancelBooking(bookingUid);

    // Update local record
    await app.db
      .update(scheduledCalls)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(scheduledCalls.tenantId, tenantId),
          eq(scheduledCalls.providerRef, bookingUid),
        ),
      );

    app.log.info({ tenantId, bookingUid }, 'Trafft booking cancelled');
    return { ok: true };
  });
}
