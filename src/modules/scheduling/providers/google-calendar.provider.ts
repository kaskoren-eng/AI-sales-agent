import { google } from 'googleapis';
import type { SchedulingProvider, TimeSlot, BookingResult } from './provider.interface.js';
import { CircuitBreaker } from '../../../shared/circuit-breaker.js';

const gcalCircuit = new CircuitBreaker({ name: 'google-calendar', failureThreshold: 5, cooldownMs: 30_000 });

export class GoogleCalendarProvider implements SchedulingProvider {
  private calendar: ReturnType<typeof google.calendar>;

  constructor(
    private config: {
      calendarId: string;
      serviceAccountEmail: string;
      privateKey: string;
      slotMinutes: number;
      workStart: string;
      workEnd: string;
    },
  ) {
    const auth = new google.auth.JWT({
      email: config.serviceAccountEmail,
      key: config.privateKey,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    this.calendar = google.calendar({ version: 'v3', auth });
  }

  async getAvailableSlots(params: {
    startDate: string;
    endDate: string;
    serviceId: string;
    timezone: string;
    employeeId?: string;
  }): Promise<TimeSlot[]> {
    const calendarId = params.serviceId || this.config.calendarId;
    const { slotMinutes, workStart, workEnd } = this.config;

    const timeMin = new Date(`${params.startDate}T00:00:00Z`).toISOString();
    const timeMax = new Date(`${params.endDate}T23:59:59Z`).toISOString();

    const freebusyRes = await gcalCircuit.execute(() =>
      this.calendar.freebusy.query({
        requestBody: {
          timeMin,
          timeMax,
          timeZone: params.timezone,
          items: [{ id: calendarId }],
        },
      }),
    );

    const busyPeriods = freebusyRes.data.calendars?.[calendarId]?.busy ?? [];

    const slots: TimeSlot[] = [];
    const startDate = new Date(`${params.startDate}T00:00:00Z`);
    const endDate = new Date(`${params.endDate}T00:00:00Z`);

    for (let d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
      const day = d.toISOString().slice(0, 10);
      let slotStart = new Date(`${day}T${workStart}:00Z`);
      const dayEnd = new Date(`${day}T${workEnd}:00Z`);

      while (slotStart < dayEnd) {
        const slotEnd = new Date(slotStart.getTime() + slotMinutes * 60_000);
        if (slotEnd > dayEnd) break;

        const isBusy = busyPeriods.some(({ start, end }) => {
          const busyStart = new Date(start!);
          const busyEnd = new Date(end!);
          return slotStart < busyEnd && slotEnd > busyStart;
        });

        if (!isBusy) {
          slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString() });
        }

        slotStart = slotEnd;
      }
    }

    return slots;
  }

  async createBooking(params: {
    start: string;
    serviceId: string;
    attendee: { name: string; email: string; phone?: string; timezone: string };
    employeeId?: string;
    notes?: string;
  }): Promise<BookingResult> {
    const calendarId = params.serviceId || this.config.calendarId;
    const startDt = new Date(params.start);
    const endDt = new Date(startDt.getTime() + this.config.slotMinutes * 60_000);

    const eventRes = await gcalCircuit.execute(() =>
      this.calendar.events.insert({
        calendarId,
        sendUpdates: 'all',
        conferenceDataVersion: 1,
        requestBody: {
          summary: `Sales Call — ${params.attendee.name}`,
          description: params.notes,
          start: { dateTime: startDt.toISOString(), timeZone: params.attendee.timezone },
          end: { dateTime: endDt.toISOString(), timeZone: params.attendee.timezone },
          attendees: [{ email: params.attendee.email, displayName: params.attendee.name }],
          conferenceData: { createRequest: { requestId: crypto.randomUUID() } },
        },
      }),
    );

    const event = eventRes.data;
    const meetLink = (event.conferenceData?.entryPoints ?? []).find(
      (ep: any) => ep.entryPointType === 'video',
    )?.uri as string | undefined;
    return {
      uid: event.id!,
      start: event.start?.dateTime ?? params.start,
      end: event.end?.dateTime ?? endDt.toISOString(),
      status: event.status ?? 'confirmed',
      meetLink,
    };
  }

  async cancelBooking(bookingUid: string): Promise<void> {
    await gcalCircuit.execute(() =>
      this.calendar.events.delete({
        calendarId: this.config.calendarId,
        eventId: bookingUid,
        sendUpdates: 'all',
      }),
    );
  }
}
