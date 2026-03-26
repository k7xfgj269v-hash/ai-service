import { Controller, Post, Body } from "@nestjs/common";
import { AiService } from "../ai-service/ai.service";

@Controller("chat")
export class ChatController {
  constructor(private readonly aiService: AiService) {}

  @Post()
  async chat(@Body() body: { message: string; userId?: string }) {
    const userId = body.userId || "web-" + Date.now();
    const reply = await this.aiService.processQuery({
      userId,
      userName: "Web User",
      query: body.message,
    });
    return { reply };
  }

  @Post("clear")
  async clear(@Body() body: { userId?: string }) {
    const userId = body.userId || "web-default";
    const message = this.aiService.clearHistory(userId);
    return { message };
  }
}
