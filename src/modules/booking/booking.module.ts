import { Module } from '@nestjs/common';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { BargainService } from './bargain.service';

@Module({
  controllers: [BookingController],
  providers: [BookingService, BargainService],
  exports: [BookingService, BargainService],
})
export class BookingModule {}
