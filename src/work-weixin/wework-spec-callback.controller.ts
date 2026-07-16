import { Body, Controller, Get, Post } from '@nestjs/common';
import { WeworkSpecCallbackService } from './wework-spec-callback.service';

@Controller('spec-callback')
export class WeworkSpecCallbackController {
  constructor(
    private readonly callbackService: WeworkSpecCallbackService,
  ) {}

  @Get('health')
  healthCheck() {
    return {
      status: 'ok',
      service: '专区回调接收服务',
      timestamp: new Date().toISOString(),
    };
  }

  @Post('wework-call')
  handleWeworkCall(@Body() body: unknown) {
    return this.callbackService.handleWeworkCallForward(body);
  }

  @Post('ai-query')
  handleAiQuery(@Body() body: unknown) {
    return this.callbackService.handleAiQuery(body);
  }
}
