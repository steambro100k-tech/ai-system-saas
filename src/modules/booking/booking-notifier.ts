export const BOOKING_NOTIFIER = Symbol('BOOKING_NOTIFIER');

export interface BookingNotifier {
  onBookingCreated(booking: unknown): Promise<{ clientConfirmationSent?: boolean } | void> | { clientConfirmationSent?: boolean } | void;
  onBookingCancelled(booking: unknown): Promise<void> | void;
  sendClientReminder?(booking: unknown): Promise<void>;
}
