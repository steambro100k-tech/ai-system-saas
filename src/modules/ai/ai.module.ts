import { Global, Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { CONVERSATION_HANDLER } from '../../common/conversation/conversation.tokens';
import { AiService } from './ai.service';

@Global()
@Module({
  imports: [BookingModule],
  providers: [
    AiService,
    { provide: CONVERSATION_HANDLER, useExisting: AiService },
  ],
  exports: [CONVERSATION_HANDLER, AiService],
})
export class AiModule {}


