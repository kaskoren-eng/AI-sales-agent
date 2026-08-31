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
    /**
     * `email` is OPTIONAL (2026-08-31). A voice lead who cannot get his address across an 8kHz
     * line still deserves the meeting: `book_meeting` may pass it absent, in which case the event
     * is created with no attendee (`BookingResult.inviteSent` false) and the confirmation goes out
     * over WhatsApp instead. Every other caller passes one, and always has.
     */
    attendee: { name: string; email?: string; phone?: string; timezone: string };
    employeeId?: string;
    notes?: string;
  }): Promise<BookingResult>;

  cancelBooking(bookingUid: string): Promise<void>;
}
