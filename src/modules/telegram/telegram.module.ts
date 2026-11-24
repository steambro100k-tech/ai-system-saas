import { Global, Module } from '@nestjs/common';
import { BOOKING_NOTIFIER } from '../booking/booking-notifier';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

@Global()
@Module({
  controllers: [TelegramController],
  providers: [
    TelegramService,
    { provide: BOOKING_NOTIFIER, useExisting: TelegramService },
  ],
  exports: [TelegramService, BOOKING_NOTIFIER],
})
export class TelegramModule {}


