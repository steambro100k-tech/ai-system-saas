import { Module } from '@nestjs/common';
import { PrismaModule } from './core/db/prisma.module';
import { AppController } from './app.controller';
import { BookingModule } from './modules/booking/booking.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { AiModule } from './modules/ai/ai.module';

@Module({
  imports: [PrismaModule, BookingModule, AiModule, TelegramModule],
  controllers: [AppController],
})
export class AppModule {}



