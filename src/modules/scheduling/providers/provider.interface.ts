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
