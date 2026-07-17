export interface TimeSlot {
  start: string;
  end: string;
}

export interface BookingResult {
  uid: string;
  start: string;
  end: string;
  status: string;
  meetLink?: string;
  /**
   * False when the event was created WITHOUT the attendee on it (so no email invite went out) —
   * Google service accounts cannot invite attendees without Domain-Wide Delegation (403,
   * verified 2026-07-17). Absent/true = the attendee is on the event and Google emailed them.
   * Callers that tell a human "an invite was sent" MUST check this.
   */
  inviteSent?: boolean;
}

export interface SchedulingProvider {
  getAvailableSlots(params: {
    startDate: string;
    endDate: string;
    serviceId: string;
    timezone: string;
    employeeId?: string;
  }): Promise<TimeSlot[]>;

  createBooking(params: {
    start: string;
    serviceId: string;
    attendee: { name: string; email: string; phone?: string; timezone: string };
    employeeId?: string;
    notes?: string;
  }): Promise<BookingResult>;

  cancelBooking(bookingUid: string): Promise<void>;
}
