import {
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { WorkWeixinService } from './work-weixin.service';

@Controller('work-weixin')
export class WorkWeixinController {
  private readonly logger = new Logger(WorkWeixinController.name);

  constructor(
    private readonly workWeixinService: WorkWeixinService,
    private readonly configService: ConfigService,
  ) {}

  @Get('callback')
  verifyCallback(
    @Query('msg_signature') msgSignature: string,
    @Query('timestamp') timestamp: string,
    @Query('nonce') nonce: string,
    @Query('echostr') echostr: string,
    @Res() res: Response,
  ): void {
    const result = this.workWeixinService.verifyUrl(
      msgSignature,
      timestamp,
      nonce,
      echostr,
    );
    if (result === null) {
      this.logger.warn('Rejected Work Weixin URL verification request');
      res.status(400).send('验证失败');
      return;
    }
    res.send(result);
  }

  @Post('callback')
  async receiveMessage(
    @Query('msg_signature') msgSignature: string,
    @Query('timestamp') timestamp: string,
    @Query('nonce') nonce: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const body = (req as Request & { body?: unknown }).body;
    if (typeof body !== 'string' && !Buffer.isBuffer(body)) {
      this.logger.warn('Rejected non-text Work Weixin callback body');
      res.status(400).send('invalid callback');
      return;
    }
    const bodyText = Buffer.isBuffer(body) ? body.toString('utf8') : body;

    try {
      const allowTest = this.configService.get('WORK_WEIXIN_ALLOW_TEST') === 'true';
      if (msgSignature === 'test_signature' && allowTest) {
        const reply = await this.workWeixinService.handlePlaintextTestCallback(
          bodyText,
        );
        if (reply === null) {
          res.status(400).send('invalid callback');
        } else if (reply.length > 0) {
          res.status(201).type('application/xml').send(reply);
        } else {
          res.status(201).send('success');
        }
        return;
      }

      const encrypted = this.workWeixinService.parseEncryptedEnvelope(bodyText);
      if (encrypted === null) {
        this.logger.warn('Rejected malformed Work Weixin callback envelope');
        res.status(400).send('invalid callback');
        return;
      }

      const reply = await this.workWeixinService.handleMessage(
        msgSignature,
        timestamp,
        nonce,
        encrypted,
      );
      if (reply === null) {
        res.status(400).send('invalid callback');
      } else if (reply.length > 0) {
        res.type('application/xml').send(reply);
      } else {
        res.send('success');
      }
    } catch {
      this.logger.error('Work Weixin callback processing failed');
      res.status(500).send('服务器错误');
    }
  }

  @Post('send')
  async sendMessage(@Body() body: { userId: string; content: string }) {
    const { userId, content } = body;
    if (!userId || !content) {
      return { success: false, message: '缺少必需参数' };
    }

    const success = await this.workWeixinService.sendTextMessage(userId, content);
    return {
      success,
      message: success ? '发送成功' : '发送失败',
    };
  }

  @Get('status')
  getStatus() {
    return this.workWeixinService.getStatus();
  }

  @Post('refresh-token')
  async refreshToken() {
    const token = await this.workWeixinService.refreshAccessToken();
    return {
      success: !!token,
      message: token ? 'Token 刷新成功' : 'Token 刷新失败',
    };
  }
}
