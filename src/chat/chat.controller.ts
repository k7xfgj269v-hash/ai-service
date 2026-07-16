import { Body, Controller, Post } from '@nestjs/common';
import { AiService } from '../ai-service/ai.service';

@Controller('chat')
export class ChatController {
  constructor(private readonly aiService: AiService) {}

  @Post()
  async chat(
    @Body() body: { message: string; userId?: string },
  ): Promise<{
    reply: string;
    citations: unknown[];
    abstained: boolean;
    abstentionReasons: readonly string[];
    activeGeneration: string | null;
    timings: unknown;
  }> {
    const userId = body.userId || `web-${Date.now()}`;
    const result = await this.aiService.processQueryDetailed({
      userId,
      userName: 'Web User',
      query: body.message,
    });
    return {
      reply: result.answer,
      citations: [...result.citations],
      abstained: result.abstained,
      abstentionReasons: result.abstentionReasons,
      activeGeneration: result.activeGeneration,
      timings: result.timings,
    };
  }

  @Post('clear')
  async clear(
    @Body() body: { userId?: string },
  ): Promise<{ message: string }> {
    const userId = body.userId || 'web-default';
    const message = await this.aiService.clearHistory(userId);
    return { message };
  }
}
