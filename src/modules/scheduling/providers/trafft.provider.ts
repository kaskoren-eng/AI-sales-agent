import type { SchedulingProvider, TimeSlot, BookingResult } from './provider.interface.js';
import { CircuitBreaker } from '../../../shared/circuit-breaker.js';

/**
 * Trafft scheduling provider.
 *
 * Auth flow: POST /api/v1/auth/token with email+password → Bearer token.
 * All subsequent requests use Authorization: Bearer <token>.
 *
 * Pass the full admin base URL, e.g. https://booking.admin.pusher.li
 */
const TRAFFT_TIMEOUT_MS = 15_000;

const trafftCircuit = new CircuitBreaker({ name: 'trafft', failureThreshold: 5, cooldownMs: 30_000 });

export class TrafftProvider implements SchedulingProvider {
  private baseUrl: string;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private config: {
      baseUrl: string;
      email: string;
      password: string;
    },
  ) {
    // Strip trailing slash, append /api/v1
    this.baseUrl = `${config.baseUrl.replace(/\/$/, '')}/api/v1`;
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
      signal: AbortSignal.timeout(TRAFFT_TIMEOUT_MS),
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

    return trafftCircuit.execute(async () => {
      const response = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TRAFFT_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Trafft API ${method} ${path} failed: ${response.status} — ${text}`);
      }

      return (await response.json()) as T;
    });
  }

  async getAvailableSlots(params: {
    startDate: string;
    endDate: string;
    serviceId: string;
    timezone: string;
    employeeId?: string;
  }): Promise<TimeSlot[]> {
    // Trafft uses /appointments/entities/date-time which returns:
    // { payload: { "YYYY-MM-DD": { "HH:MM": { s: [svcId], b: 1, e: [empId], l: [locId] } } }, status: "success" }
    const queryParams: Record<string, string> = {
      calendarStartDate: params.startDate,
      calendarEndDate: params.endDate,
      service: params.serviceId,
    };
    if (params.employeeId) {
      queryParams.employee = params.employeeId;
    }

    const data = await this.request<any>('GET', '/appointments/entities/date-time', undefined, queryParams);

    const slots: TimeSlot[] = [];
    const payload = data.payload ?? {};

    for (const [date, times] of Object.entries(payload)) {
      for (const time of Object.keys(times as Record<string, unknown>)) {
        slots.push({
          start: `${date} ${time}`,
          end: '',
        });
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
