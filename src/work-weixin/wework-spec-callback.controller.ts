import { Controller, Post, Body, Logger, Get } from '@nestjs/common';
import { WeworkSpecCallbackService, WeworkCallForwardData, AiQueryRequest } from './wework-spec-callback.service';

/**
 * 企业微信专区回调控制器
 * 接收专区程序（demoloadsdk.py）转发的已解密数据
 * 挂在主服务 port 3031 下，路径前缀 /spec-callback
 */
@Controller('spec-callback')
export class WeworkSpecCallbackController {
  private readonly logger = new Logger(WeworkSpecCallbackController.name);

  constructor(
    private readonly callbackService: WeworkSpecCallbackService,
  ) {}

  /**
   * 健康检查
   */
  @Get('health')
  healthCheck() {
    return {
      status: 'ok',
      service: '专区回调接收服务',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 接收专区程序转发的 wework_call 数据
   * POST /spec-callback/wework-call
   *
   * 专区程序在 wework_call 中解密数据后，异步转发到此接口
   */
  @Post('wework-call')
  async handleWeworkCall(@Body() body: WeworkCallForwardData) {
    this.logger.log('收到专区程序转发的 wework_call 数据');
    return await this.callbackService.handleWeworkCallForward(body);
  }

  /**
   * 接收专区程序转发的 AI 查询请求
   * POST /spec-callback/ai-query
   *
   * 专区程序在 corp_call func=ai_query 时转发到此接口
   */
  @Post('ai-query')
  async handleAiQuery(@Body() body: AiQueryRequest) {
    this.logger.log('收到专区程序转发的 AI 查询');
    return await this.callbackService.handleAiQuery(body);
  }
}
