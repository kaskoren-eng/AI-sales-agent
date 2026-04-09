import type { SchedulingProvider, TimeSlot, BookingResult } from './provider.interface.js';

/**
 * Trafft.com scheduling provider.
 *
 * Auth flow: POST /auth/token with email+password → Bearer token.
 * All subsequent requests use Authorization: Bearer <token>.
 *
 * Trafft API base: https://<subdomain>.trafft.com/api/v1
 */
export class TrafftProvider implements SchedulingProvider {
  private baseUrl: string;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private config: {
      subdomain: string;
      email: string;
      password: string;
    },
  ) {
    this.baseUrl = `https://${config.subdomain}.trafft.com/api/v1`;
  }

  private async authenticate(): Promise<string> {
    // Reuse token if still valid (with 60s buffer)
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.token;
    }

    const response = await fetch(`${this.baseUrl}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: this.config.email,
        password: this.config.password,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Trafft auth failed: ${response.status} — ${body}`);
    }

    const data = (await response.json()) as any;
    this.token = data.data?.token ?? data.token;
    // Default 1-hour expiry if not specified
    this.tokenExpiresAt = Date.now() + 3_600_000;
    return this.token!;
  }

  private async request<T>(method: string, path: string, body?: unknown, params?: Record<string, string>): Promise<T> {
    const token = await this.authenticate();

    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Trafft API ${method} ${path} failed: ${response.status} — ${text}`);
    }

    return (await response.json()) as T;
  }

  async getAvailableSlots(params: {
    startDate: string;
    endDate: string;
    serviceId: number;
    timezone: string;
    employeeId?: number;
  }): Promise<TimeSlot[]> {
    const queryParams: Record<string, string> = {
      serviceId: params.serviceId.toString(),
      startDate: params.startDate,
      endDate: params.endDate,
      timeZone: params.timezone,
    };
    if (params.employeeId) {
      queryParams.employeeId = params.employeeId.toString();
    }

    const data = await this.request<any>('GET', '/appointments/slots', undefined, queryParams);

    // Trafft returns slots grouped by date: { "2026-04-08": ["09:00", "09:30", ...] }
    const slots: TimeSlot[] = [];
    const slotsData = data.data?.slots ?? data.slots ?? data.data ?? {};

    for (const [date, times] of Object.entries(slotsData)) {
      if (!Array.isArray(times)) continue;
      for (const time of times) {
        slots.push({
          start: `${date} ${time}`,
          end: '', // Trafft slots are start-time only; duration comes from service config
        });
      }
    }

    return slots;
  }

  async createBooking(params: {
    start: string;
    serviceId: number;
    attendee: { name: string; email: string; phone?: string; timezone: string };
    employeeId?: number;
    notes?: string;
  }): Promise<BookingResult> {
    const [firstName, ...lastParts] = params.attendee.name.split(' ');
    const lastName = lastParts.join(' ') || firstName;

    const body: Record<string, unknown> = {
      serviceId: params.serviceId,
      dateTime: params.start,
      customer: {
        firstName,
        lastName,
        email: params.attendee.email,
        phone: params.attendee.phone ?? '',
        timeZone: params.attendee.timezone,
      },
    };

    if (params.employeeId) body.employeeId = params.employeeId;
    if (params.notes) body.note = params.notes;

    const data = await this.request<any>('POST', '/appointments', body);
    const appointment = data.data ?? data;

    return {
      uid: String(appointment.id),
      start: appointment.dateTime ?? params.start,
      end: appointment.endDateTime ?? '',
      status: appointment.status ?? 'approved',
    };
  }

  async cancelBooking(bookingUid: string): Promise<void> {
    await this.request('POST', `/appointments/${bookingUid}/cancel`);
  }
}
