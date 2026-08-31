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
     * is created with no attendee and `BookingResult.inviteSent` is false. Every other caller
     * passes one, and always has.
     *
     * ⚠️ NOTHING IS AUTOMATICALLY SENT TO SUCH A LEAD. An earlier draft of this comment said the
     * confirmation "goes out over WhatsApp instead", and it does not: a lead who has only ever
     * phoned us has no open 24-hour window, so an outbound WhatsApp needs an approved
     * `meeting_confirmation` template, which is still pending — the worker logs
     * `whatsapp_send_blocked`, drops the job and returns success. That is precisely why the voice
     * prompt was written NOT to promise a channel. The only thing that reaches this lead is a human
     * looking at the booking, or a WhatsApp HE sends us (which does open the window). Do not
     * reintroduce the claim without checking `whatsapp-window.ts` and the tenant's template slots.
     */
    attendee: { name: string; email?: string; phone?: string; timezone: string };
    employeeId?: string;
    notes?: string;
  }): Promise<BookingResult>;

  cancelBooking(bookingUid: string): Promise<void>;
}
