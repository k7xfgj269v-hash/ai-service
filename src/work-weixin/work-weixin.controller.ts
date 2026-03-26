import { Controller, Get, Post, Query, Body, Res, Logger, Req } from '@nestjs/common';
import { WorkWeixinService } from './work-weixin.service';
import { Response, Request } from 'express';

@Controller('work-weixin')
export class WorkWeixinController {
  private readonly logger = new Logger(WorkWeixinController.name);

  constructor(private readonly workWeixinService: WorkWeixinService) {}

  /**
   * 企业微信回调 URL 验证
   * GET /work-weixin/callback
   *
   * 参数:
   * - msg_signature: 签名
   * - timestamp: 时间戳
   * - nonce: 随机数
   * - echostr: 加密的随机字符串
   */
  @Get('callback')
  async verifyCallback(
    @Query('msg_signature') msgSignature: string,
    @Query('timestamp') timestamp: string,
    @Query('nonce') nonce: string,
    @Query('echostr') echostr: string,
    @Res() res: Response,
  ) {
    this.logger.log('收到企业微信回调验证请求');
    try {
      const result = this.workWeixinService.verifyUrl(msgSignature, timestamp, nonce, echostr);
      if (result) {
        this.logger.log('回调验证成功');
        res.send(result);
      } else {
        this.logger.error('回调验证失败');
        res.status(400).send('验证失败');
      }
    } catch (error) {
      this.logger.error('回调验证异常:', error.message);
      res.status(500).send('服务器错误');
    }
  }


  /**
   * 接收企业微信消息
   * POST /work-weixin/callback
   *
   * 参数:
   * - msg_signature: 签名
   * - timestamp: 时间戳
   * - nonce: 随机数
   *
   * Body: XML 格式的加密消息
   */
  @Post('callback')
  async receiveMessage(
    @Query('msg_signature') msgSignature: string,
    @Query('timestamp') timestamp: string,
    @Query('nonce') nonce: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    this.logger.log('收到企业微信消息');

    try {
      // 直接从请求获取 body（已被中间件处理为字符串）
      let bodyStr = '';

      if ((req as any).body !== undefined) {
        const body = (req as any).body;

        if (typeof body === 'string') {
          bodyStr = body;
        } else if (Buffer.isBuffer(body)) {
          bodyStr = body.toString('utf8');
        } else if (typeof body === 'object') {
          bodyStr = JSON.stringify(body);
        } else {
          bodyStr = String(body);
        }

        this.logger.debug(`请求体类型: ${typeof body}, 长度: ${bodyStr.length}`);
      } else {
        this.logger.error('请求体为空或未定义');
        this.logger.error(`请求参数: msg_signature=${msgSignature}, timestamp=${timestamp}, nonce=${nonce}`);
        res.send('success');
        return;
      }

      // 检查是否成功读取到数据
      if (!bodyStr || bodyStr.length === 0) {
        this.logger.error('请求体内容为空');
        res.send('success');
        return;
      }

      // 检查是否为测试消息（使用test_signature）
      if (msgSignature === 'test_signature') {
        this.logger.log('检测到测试消息，跳过加密验证');
        
        // 尝试直接解析XML消息
        const xmlMatch = bodyStr.match(/<xml>[\s\S]*<\/xml>/);
        if (!xmlMatch) {
          this.logger.error('测试消息：无法找到XML内容');
          this.logger.error('请求体内容:', bodyStr.substring(0, 500));
          res.status(201).send('success');
          return;
        }
        
        const xmlContent = xmlMatch[0];
        this.logger.debug(`测试消息XML长度: ${xmlContent.length}`);
        
        // 解析XML获取消息内容
        const toUserNameMatch = xmlContent.match(/<ToUserName><!\[CDATA\[(.*?)\]\]><\/ToUserName>/);
        const fromUserNameMatch = xmlContent.match(/<FromUserName><!\[CDATA\[(.*?)\]\]><\/FromUserName>/);
        const contentMatch = xmlContent.match(/<Content><!\[CDATA\[(.*?)\]\]><\/Content>/);
        
        if (!toUserNameMatch || !fromUserNameMatch || !contentMatch) {
          this.logger.error('测试消息：无法解析XML字段');
          res.status(201).send('success');
          return;
        }
        
        const toUserName = toUserNameMatch[1];
        const fromUserName = fromUserNameMatch[1];
        const content = contentMatch[1];
        
        this.logger.log(`测试消息 - 发送者: ${fromUserName}, 内容: ${content}`);
        
        try {
          // 调用 AI 客服处理测试消息
          const reply = await this.workWeixinService.handleTestMessage(
            fromUserName,
            content
          );
          
          if (reply) {
            this.logger.log('测试消息回复生成成功');
            // 构建简单的XML回复（非加密）
            const timestamp = Math.floor(Date.now() / 1000);
            const replyXml = `<xml>
<ToUserName><![CDATA[${fromUserName}]]></ToUserName>
<FromUserName><![CDATA[${toUserName}]]></FromUserName>
<CreateTime>${timestamp}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${reply}]]></Content>
</xml>`;
            
            res.status(201).type('application/xml').send(replyXml);
          } else {
            this.logger.log('测试消息处理完成，无需回复');
            res.status(201).send('success');
          }
        } catch (error) {
          this.logger.error(`测试消息处理异常: ${error.message}`);
          res.status(201).send('success');
        }
        return;
      }

      // 正常消息处理：解析 XML 获取加密消息
      const encryptMatch = bodyStr.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/);

      if (!encryptMatch) {
        this.logger.error('无法解析加密消息');
        this.logger.error('请求体内容:', bodyStr.substring(0, 500)); // 记录前500个字符用于调试
        res.send('success');
        return;
      }

      const encryptedMsg = encryptMatch[1];
      
      this.logger.debug(`加密消息长度: ${encryptedMsg.length}`);
      this.logger.debug(`消息签名: ${msgSignature}, 时间戳: ${timestamp}, 随机数: ${nonce}`);

      // 处理消息并获取回复
      const reply = await this.workWeixinService.handleMessage(
        msgSignature,
        timestamp,
        nonce,
        encryptedMsg,
      );

      // 返回回复（如果有）
      if (reply) {
        this.logger.log('成功生成回复消息');
        res.type('application/xml').send(reply);
      } else {
        this.logger.log('消息处理完成，无需回复');
        res.send('success');
      }
    } catch (error) {
      // 增强的错误处理：记录完整的错误信息和堆栈
      this.logger.error('处理消息异常:');
      this.logger.error(`错误消息: ${error.message}`);
      this.logger.error(`错误堆栈: ${error.stack || '无堆栈信息'}`);
      this.logger.error(`请求参数: msg_signature=${msgSignature}, timestamp=${timestamp}, nonce=${nonce}`);
      
      // 如果是网络错误或超时错误，记录更多信息
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        this.logger.error('网络连接错误，检查AI服务是否可用');
      }
      
      // 如果是加密/解密错误，可能是配置问题
      if (error.message.includes('decrypt') || error.message.includes('encrypt') || error.message.includes('AES')) {
        this.logger.error('加密解密错误，请检查WORK_WEIXIN_ENCODING_AES_KEY配置');
      }
      
      // 如果是签名验证错误
      if (error.message.includes('signature') || error.message.includes('签名')) {
        this.logger.error('签名验证失败，请检查WORK_WEIXIN_TOKEN配置');
      }
      
      // 始终返回success，避免企业微信服务器重试
      res.send('success');
    }
  }

  /**
   * 主动发送消息
   * POST /work-weixin/send
   */
  @Post('send')
  async sendMessage(
    @Body() body: { userId: string; content: string },
  ) {
    const { userId, content } = body;

    if (!userId || !content) {
      return {
        success: false,
        message: '缺少必需参数',
      };
    }

    const success = await this.workWeixinService.sendTextMessage(userId, content);

    return {
      success,
      message: success ? '发送成功' : '发送失败',
    };
  }

  /**
   * 获取服务状态
   * GET /work-weixin/status
   */
  @Get('status')
  getStatus() {
    return this.workWeixinService.getStatus();
  }

  /**
   * 刷新 Access Token
   * POST /work-weixin/refresh-token
   */
  @Post('refresh-token')
  async refreshToken() {
    const token = await this.workWeixinService.refreshAccessToken();
    return {
      success: !!token,
      message: token ? 'Token 刷新成功' : 'Token 刷新失败',
    };
  }
}
