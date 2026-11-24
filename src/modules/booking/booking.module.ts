import { Module } from '@nestjs/common';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { BargainService } from './bargain.service';
import { BarberOrAdminGuard } from '../auth/barber-or-admin.guard';
import { AdminKeyGuard } from '../auth/admin-key.guard';
import { BookingMessageService } from './booking-message.service';
import { BookingReminderService } from './booking-reminder.service';

@Module({
  controllers: [BookingController],
  providers: [BookingService, BargainService, BarberOrAdminGuard, AdminKeyGuard, BookingMessageService, BookingReminderService],
  exports: [BookingService, BargainService, BookingMessageService, BookingReminderService],
})
export class BookingModule {}
