export const BOOKING_NOTIFIER = Symbol('BOOKING_NOTIFIER');

export interface BookingNotifier {
  onBookingCreated(booking: unknown): Promise<void> | void;
  onBookingCancelled(booking: unknown): Promise<void> | void;
}
