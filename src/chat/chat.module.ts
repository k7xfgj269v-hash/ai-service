import { Module } from "@nestjs/common";
import { ChatController } from "./chat.controller";
import { AiServiceModule } from "../ai-service/ai.module";

@Module({
  imports: [AiServiceModule],
  controllers: [ChatController],
})
export class ChatModule {}
