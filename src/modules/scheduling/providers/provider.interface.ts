export interface TimeSlot {
  start: string;
  end: string;
}

export interface BookingResult {
  uid: string;
  start: string;
  end: string;
  status: string;
}

export interface SchedulingProvider {
  getAvailableSlots(params: {
    startDate: string;
    endDate: string;
    serviceId: number;
    timezone: string;
    employeeId?: number;
  }): Promise<TimeSlot[]>;

  createBooking(params: {
    start: string;
    serviceId: number;
    attendee: { name: string; email: string; phone?: string; timezone: string };
    employeeId?: number;
    notes?: string;
  }): Promise<BookingResult>;

  cancelBooking(bookingUid: string): Promise<void>;
}
