import { Module } from '@nestjs/common';
import { AiServiceModule } from '../ai-service/ai.module';
import { ChatController } from './chat.controller';

@Module({
  imports: [AiServiceModule],
  controllers: [ChatController],
})
export class ChatModule {}
