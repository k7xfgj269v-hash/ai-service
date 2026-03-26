import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../ai-service/ai.service';
import * as crypto from 'crypto';
import axios from 'axios';

interface AccessTokenResponse {
  errcode: number;
  errmsg: string;
  access_token?: string;
  expires_in?: number;
}

interface SendMessageResponse {
  errcode: number;
  errmsg: string;
  invaliduser?: string;
  invalidparty?: string;
  invalidtag?: string;
}

interface WeixinMessage {
  ToUserName: string;
  FromUserName: string;
  CreateTime: number;
  MsgType: string;
  Content?: string;
  MsgId?: string;
  AgentID?: number;
  Event?: string; // 事件类型
  EventKey?: string; // 事件KEY值
  SessionId?: string; // 会话ID
}

@Injectable()
export class WorkWeixinService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkWeixinService.name);
  private accessToken: string | null = null;
  private tokenExpireTime: number = 0;
  private tokenRefreshInterval: NodeJS.Timeout | null = null; // 保存定时器引用

  // 企业微信配置
  private corpId: string;
  private corpSecret: string;
  private agentId: string;
  private token: string; // 用于验证回调URL
  private encodingAESKey: string; // 用于消息加解密

  constructor(
    private configService: ConfigService,
    private aiService: AiService,
  ) {
    this.corpId = this.configService.get('WORK_WEIXIN_CORP_ID', '');
    this.corpSecret = this.configService.get('WORK_WEIXIN_CORP_SECRET', '');
    this.agentId = this.configService.get('WORK_WEIXIN_AGENT_ID', '');
    this.token = this.configService.get('WORK_WEIXIN_TOKEN', '');
    this.encodingAESKey = this.configService.get('WORK_WEIXIN_ENCODING_AES_KEY', '');
  }

  async onModuleInit() {
    const enabled = this.configService.get('WORK_WEIXIN_ENABLED');
    if (enabled === 'true' || enabled === true) {
      await this.initialize();
    } else {
      this.logger.log('企业微信服务未启用');
    }
  }

  private async initialize() {
    this.logger.log('正在初始化企业微信服务...');

    if (!this.corpId || !this.corpSecret || !this.agentId) {
      this.logger.error('企业微信配置不完整，请检查环境变量');
      return;
    }

    // 获取 access_token
    await this.refreshAccessToken();

    // 设置定时刷新 token（每 100 分钟刷新一次，token 有效期 2 小时）
    this.tokenRefreshInterval = setInterval(() => {
      this.refreshAccessToken();
    }, 100 * 60 * 1000);

    this.logger.log('企业微信服务初始化完成');
  }

  async onModuleDestroy() {
    // 清理定时器，防止内存泄漏
    if (this.tokenRefreshInterval) {
      clearInterval(this.tokenRefreshInterval);
      this.tokenRefreshInterval = null;
      this.logger.log('企业微信 Token 刷新定时器已清理');
    }
  }

  /**
   * 获取 access_token
   * API: https://qyapi.weixin.qq.com/cgi-bin/gettoken
   */
  async refreshAccessToken(): Promise<string | null> {
    try {
      const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.corpId}&corpsecret=${this.corpSecret}`;

      const response = await axios.get<AccessTokenResponse>(url);

      if (response.data.errcode === 0 && response.data.access_token) {
        this.accessToken = response.data.access_token;
        this.tokenExpireTime = Date.now() + (response.data.expires_in || 7200) * 1000;
        this.logger.log('Access Token 获取成功');
        return this.accessToken;
      } else {
        this.logger.error(`获取 Access Token 失败: ${response.data.errmsg}`);
        return null;
      }
    } catch (error) {
      this.logger.error('获取 Access Token 异常:', error.message);
      return null;
    }
  }

  /**
   * 获取有效的 access_token
   */
  async getAccessToken(): Promise<string | null> {
    // 如果 token 即将过期（提前 5 分钟刷新），重新获取
    if (!this.accessToken || Date.now() >= this.tokenExpireTime - 5 * 60 * 1000) {
      await this.refreshAccessToken();
    }
    return this.accessToken;
  }

  /**
   * 验证回调 URL（企业微信服务器验证）
   * 文档: https://developer.work.weixin.qq.com/document/path/90930
   */
  verifyUrl(
    msgSignature: string,
    timestamp: string,
    nonce: string,
    echostr: string,
  ): string | null {
    try {
      this.logger.log(`回调验证参数 - Token: ${this.token}, Timestamp: ${timestamp}, Nonce: ${nonce}`);
      this.logger.log(`Echostr 长度: ${echostr?.length}, MsgSignature: ${msgSignature}`);

      // 关键：@Query装饰器已经进行了一次URL解码
      // 但是echostr可能仍然包含URL编码（双重编码情况）
      // 我们需要尝试多次解码，直到无法解码为止
      let finalEchostr = echostr;
      let decodeCount = 0;
      let canDecode = true;
      
      while (canDecode) {
        try {
          const decoded = decodeURIComponent(finalEchostr);
          // 如果解码后的值不同，说明还可以继续解码
          if (decoded !== finalEchostr) {
            finalEchostr = decoded;
            decodeCount++;
            this.logger.log(`第 ${decodeCount} 次解码成功，长度: ${finalEchostr?.length}`);
          } else {
            canDecode = false;
          }
        } catch (error) {
          // 解码失败，停止
          canDecode = false;
          this.logger.log(`第 ${decodeCount + 1} 次解码失败: ${error.message}`);
        }
      }
      
      this.logger.log(`总共解码次数: ${decodeCount}`);
      this.logger.log(`最终echostr长度: ${finalEchostr?.length}`);
      
      // 重要：企业微信使用发送时的原始值（URL编码后的值）计算签名
      // 但由于@Query已经进行了解码，我们不知道原始值
      // 根据企业微信文档，签名验证应该使用接收到的原始参数值
      // 但@Query解码后，我们只能使用解码后的值进行签名验证
      
      // 1. 首先尝试使用传入的echostr值（@Query解码后）进行签名验证
      let signature = this.generateSignature(this.token, timestamp, nonce, echostr);
      this.logger.log(`使用传入echostr计算的签名: ${signature}`);
      this.logger.log(`企业微信签名: ${msgSignature}`);
      this.logger.log(`签名是否匹配: ${signature === msgSignature}`);
      
      if (signature !== msgSignature) {
        // 如果不匹配，尝试使用最终解码后的值进行签名验证
        // 这可能是因为企业微信发送的原始值经过了不同的编码
        signature = this.generateSignature(this.token, timestamp, nonce, finalEchostr);
        this.logger.log(`使用最终解码值计算的签名: ${signature}`);
        this.logger.log(`签名是否匹配: ${signature === msgSignature}`);
        
        if (signature !== msgSignature) {
          this.logger.error('签名验证失败');
          return null;
        }
      }
      
      this.logger.log('✅ 签名验证成功');
      
      // 2. 解密 echostr - 使用最终解码后的值进行解密
      try {
        const decrypted = this.decrypt(finalEchostr);
        this.logger.log(`✅ 解密成功: ${decrypted}`);
        return decrypted;
      } catch (decryptError) {
        this.logger.error(`解密失败: ${decryptError.message}`);
        
        // 如果使用最终解码值解密失败，尝试使用原始传入值解密
        if (finalEchostr !== echostr) {
          try {
            this.logger.log('尝试使用原始传入值解密...');
            const decrypted = this.decrypt(echostr);
            this.logger.log(`使用原始值解密成功: ${decrypted}`);
            return decrypted;
          } catch (secondError) {
            this.logger.error(`使用原始值解密也失败: ${secondError.message}`);
          }
        }
        
        return null;
      }
    } catch (error) {
      this.logger.error('URL 验证失败:', error.message);
      return null;
    }
  }

  /**
   * 生成签名
   */
  private generateSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
    const arr = [token, timestamp, nonce, encrypt].sort();
    const str = arr.join('');
    const sha1 = crypto.createHash('sha1');
    sha1.update(str);
    return sha1.digest('hex');
  }

  /**
   * 解密消息
   */
  private decrypt(encryptedMsg: string): string {
    try {
      const aesKey = Buffer.from(this.encodingAESKey + '=', 'base64');
      const encryptedBuffer = Buffer.from(encryptedMsg, 'base64');

      const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, aesKey.slice(0, 16));
      decipher.setAutoPadding(false);

      let decrypted = Buffer.concat([
        decipher.update(encryptedBuffer),
        decipher.final(),
      ]);

      // 去除补位字符
      const pad = decrypted[decrypted.length - 1];
      decrypted = decrypted.slice(0, decrypted.length - pad);

      // 解析内容
      const content = decrypted.slice(16);
      const msgLen = content.slice(0, 4).readUInt32BE(0);
      const msg = content.slice(4, msgLen + 4).toString();

      return msg;
    } catch (error) {
      this.logger.error('解密失败:', error.message);
      throw error;
    }
  }

  /**
   * 加密消息
   */
  private encrypt(text: string): string {
    try {
      const aesKey = Buffer.from(this.encodingAESKey + '=', 'base64');

      // 生成随机字符串
      const random = crypto.randomBytes(16);

      // 消息长度（4字节）
      const msgLen = Buffer.alloc(4);
      msgLen.writeUInt32BE(Buffer.byteLength(text), 0);

      // 拼接：随机字符串 + 消息长度 + 消息内容 + corpId
      const content = Buffer.concat([
        random,
        msgLen,
        Buffer.from(text),
        Buffer.from(this.corpId),
      ]);

      // PKCS7 补位
      const blockSize = 32;
      const padLength = blockSize - (content.length % blockSize);
      const padded = Buffer.concat([content, Buffer.alloc(padLength, padLength)]);

      // AES 加密
      const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, aesKey.slice(0, 16));
      cipher.setAutoPadding(false);

      const encrypted = Buffer.concat([
        cipher.update(padded),
        cipher.final(),
      ]);

      return encrypted.toString('base64');
    } catch (error) {
      this.logger.error('加密失败:', error.message);
      throw error;
    }
  }

  /**
   * 处理接收到的消息
   */
  async handleMessage(
    msgSignature: string,
    timestamp: string,
    nonce: string,
    encryptedMsg: string,
  ): Promise<string> {
    try {
      this.logger.debug(`开始处理企业微信消息，加密消息长度: ${encryptedMsg.length}`);
      this.logger.debug(`消息签名: ${msgSignature}, 时间戳: ${timestamp}, 随机数: ${nonce}`);

      // 1. 验证签名
      const signature = this.generateSignature(this.token, timestamp, nonce, encryptedMsg);
      if (signature !== msgSignature) {
        this.logger.error('消息签名验证失败');
        this.logger.error(`计算签名: ${signature}`);
        this.logger.error(`接收签名: ${msgSignature}`);
        this.logger.error('请检查WORK_WEIXIN_TOKEN配置是否正确');
        return '';
      }
      
      this.logger.debug('签名验证成功');

      // 2. 解密消息
      let decryptedXml: string;
      try {
        decryptedXml = this.decrypt(encryptedMsg);
        this.logger.debug(`解密成功，XML长度: ${decryptedXml.length}`);
      } catch (decryptError) {
        this.logger.error('消息解密失败:', decryptError.message);
        this.logger.error('请检查WORK_WEIXIN_ENCODING_AES_KEY配置是否正确');
        throw decryptError;
      }

      // 3. 解析 XML 消息
      let message: WeixinMessage;
      try {
        message = this.parseXmlMessage(decryptedXml);
        this.logger.debug(`解析XML成功，消息类型: ${message.MsgType}, 发送者: ${message.FromUserName}`);
      } catch (parseError) {
        this.logger.error('解析XML失败:', parseError.message);
        this.logger.error(`XML内容: ${decryptedXml.substring(0, 500)}`);
        throw parseError;
      }

      // 4. 处理消息
      if (message.MsgType === 'text' && message.Content) {
        const userId = message.FromUserName;
        const content = message.Content;

        this.logger.log(`收到文本消息 - 用户: ${userId}, 内容: ${content}`);
        this.logger.debug(`消息ID: ${message.MsgId || '无'}, AgentID: ${message.AgentID || '无'}`);

        try {
          // 调用 AI 客服处理
          const reply = await this.aiService.processQuery({
            userId,
            userName: userId,
            query: content,
          });

          // 如果返回 null，表示用户被人工接管
          if (reply === null) {
            this.logger.log(`用户 ${userId} 已被人工接管，跳过自动回复`);
            return '';
          }

          this.logger.debug(`AI回复内容: ${reply.substring(0, 100)}...`);

          // 发送回复（使用被动回复）
          const replyXml = this.buildTextReplyXml(message, reply);
          const encrypted = this.encrypt(replyXml);
          const replySignature = this.generateSignature(this.token, timestamp, nonce, encrypted);

          this.logger.debug('成功构建加密回复');
          return this.buildEncryptedReplyXml(encrypted, replySignature, timestamp, nonce);
        } catch (aiError) {
          this.logger.error('AI处理消息失败:', aiError.message);
          this.logger.error(`AI错误堆栈: ${aiError.stack || '无堆栈信息'}`);

          // 返回空字符串表示处理失败但不需要重试
          return '';
        }
      } else if (message.MsgType === 'event') {
        // 处理事件类型消息
        this.logger.log(`收到事件消息 - 事件类型: ${message.Event}`);
        await this.handleEventMessage(message);
        return ''; // 事件消息通常不需要回复
      } else {
        this.logger.log(`收到非文本消息类型: ${message.MsgType}, 跳过处理`);
        return '';
      }
    } catch (error) {
      // 增强的错误处理
      this.logger.error('处理企业微信消息失败:');
      this.logger.error(`错误类型: ${error.constructor.name}`);
      this.logger.error(`错误消息: ${error.message}`);
      this.logger.error(`错误堆栈: ${error.stack || '无堆栈信息'}`);
      this.logger.error(`输入参数: msgSignature=${msgSignature}, timestamp=${timestamp}, nonce=${nonce}`);
      this.logger.error(`加密消息前50字符: ${encryptedMsg.substring(0, 50)}...`);
      
      // 根据错误类型提供更具体的建议
      if (error.message.includes('decrypt') || error.message.includes('AES')) {
        this.logger.error('⚠️ 可能是WORK_WEIXIN_ENCODING_AES_KEY配置错误');
      } else if (error.message.includes('signature')) {
        this.logger.error('⚠️ 可能是WORK_WEIXIN_TOKEN配置错误');
      } else if (error.message.includes('XML') || error.message.includes('parse')) {
        this.logger.error('⚠️ XML解析错误，可能是企业微信消息格式问题');
      } else if (error.message.includes('network') || error.message.includes('timeout') || error.message.includes('ECONN')) {
        this.logger.error('⚠️ 网络错误，检查AI服务连接');
      }
      
      // 返回空字符串，避免企业微信服务器重试
      return '';
    }
  }

  /**
   * 解析 XML 消息（简单实现）
   */
  private parseXmlMessage(xml: string): WeixinMessage {
    const message: any = {};

    const patterns = {
      ToUserName: /<ToUserName><!\[CDATA\[(.*?)\]\]><\/ToUserName>/,
      FromUserName: /<FromUserName><!\[CDATA\[(.*?)\]\]><\/FromUserName>/,
      CreateTime: /<CreateTime>(\d+)<\/CreateTime>/,
      MsgType: /<MsgType><!\[CDATA\[(.*?)\]\]><\/MsgType>/,
      Content: /<Content><!\[CDATA\[(.*?)\]\]><\/Content>/,
      MsgId: /<MsgId>(\d+)<\/MsgId>/,
      AgentID: /<AgentID>(\d+)<\/AgentID>/,
      Event: /<Event><!\[CDATA\[(.*?)\]\]><\/Event>/,
      EventKey: /<EventKey><!\[CDATA\[(.*?)\]\]><\/EventKey>/,
      SessionId: /<SessionId><!\[CDATA\[(.*?)\]\]><\/SessionId>/,
    };

    for (const [key, pattern] of Object.entries(patterns)) {
      const match = xml.match(pattern);
      if (match) {
        message[key] = key === 'CreateTime' || key === 'MsgId' || key === 'AgentID'
          ? parseInt(match[1])
          : match[1];
      }
    }

    return message as WeixinMessage;
  }

  /**
   * 构建文本回复 XML
   */
  private buildTextReplyXml(message: WeixinMessage, content: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    return `<xml>
<ToUserName><![CDATA[${message.FromUserName}]]></ToUserName>
<FromUserName><![CDATA[${message.ToUserName}]]></FromUserName>
<CreateTime>${timestamp}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
</xml>`;
  }

  /**
   * 构建加密回复 XML
   */
  private buildEncryptedReplyXml(
    encrypted: string,
    signature: string,
    timestamp: string,
    nonce: string,
  ): string {
    return `<xml>
<Encrypt><![CDATA[${encrypted}]]></Encrypt>
<MsgSignature><![CDATA[${signature}]]></MsgSignature>
<TimeStamp>${timestamp}</TimeStamp>
<Nonce><![CDATA[${nonce}]]></Nonce>
</xml>`;
  }

  /**
   * 处理测试消息（不加密）
   */
  async handleTestMessage(userId: string, content: string): Promise<string | null> {
    try {
      this.logger.log(`处理测试消息 - 用户: ${userId}, 内容: ${content}`);

      // 调用 AI 客服处理
      const reply = await this.aiService.processQuery({
        userId,
        userName: userId,
        query: content,
      });

      // 如果返回 null，表示用户被人工接管
      if (reply === null) {
        this.logger.log(`用户 ${userId} 已被人工接管，跳过自动回复`);
        return null;
      }

      this.logger.debug(`AI测试回复内容: ${reply.substring(0, 100)}...`);
      return reply;
    } catch (error) {
      this.logger.error('测试消息处理失败:', error.message);
      return null;
    }
  }

  /**
   * 主动发送消息
   * API: https://qyapi.weixin.qq.com/cgi-bin/message/send
   */
  async sendTextMessage(userId: string, content: string): Promise<boolean> {
    try {
      const token = await this.getAccessToken();
      if (!token) {
        this.logger.error('无法获取 Access Token');
        return false;
      }

      const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

      const data = {
        touser: userId,
        msgtype: 'text',
        agentid: parseInt(this.agentId),
        text: {
          content: content,
        },
        safe: 0,
      };

      const response = await axios.post<SendMessageResponse>(url, data);

      if (response.data.errcode === 0) {
        this.logger.log(`消息发送成功 - 用户: ${userId}`);
        return true;
      } else {
        this.logger.error(`消息发送失败: ${response.data.errmsg}`);
        return false;
      }
    } catch (error) {
      this.logger.error('发送消息异常:', error.message);
      return false;
    }
  }

  /**
   * 处理事件类型消息
   */
  private async handleEventMessage(message: WeixinMessage): Promise<void> {
    const eventType = message.Event;
    const userId = message.FromUserName;

    this.logger.log(`处理事件消息 - 用户: ${userId}, 事件: ${eventType}`);

    switch (eventType) {
      case 'enter_session':
      case 'session_create':
        // 产生会话回调通知
        await this.handleSessionCreate(message);
        break;

      case 'subscribe':
        // 用户关注事件
        this.logger.log(`用户 ${userId} 关注了应用`);
        break;

      case 'unsubscribe':
        // 用户取消关注事件
        this.logger.log(`用户 ${userId} 取消关注了应用`);
        break;

      case 'click':
        // 菜单点击事件
        this.logger.log(`用户 ${userId} 点击了菜单: ${message.EventKey}`);
        break;

      default:
        this.logger.log(`未处理的事件类型: ${eventType}`);
    }
  }

  /**
   * 处理会话创建事件
   */
  private async handleSessionCreate(message: WeixinMessage): Promise<void> {
    const userId = message.FromUserName;
    const sessionId = message.SessionId;

    this.logger.log(`会话创建事件 - 用户: ${userId}, 会话ID: ${sessionId || '无'}`);

    try {
      // 可以在这里执行会话创建后的逻辑
      // 例如：记录会话、初始化用户状态、发送欢迎消息等

      // 示例：发送欢迎消息
      const welcomeMessage = '您好！我是AI客服助手，很高兴为您服务。请问有什么可以帮助您的吗？';
      await this.sendTextMessage(userId, welcomeMessage);

      this.logger.log(`已向用户 ${userId} 发送欢迎消息`);
    } catch (error) {
      this.logger.error(`处理会话创建事件失败: ${error.message}`);
    }
  }

  /**
   * 获取服务状态
   */
  getStatus() {
    return {
      corpId: this.corpId,
      agentId: this.agentId,
      hasAccessToken: !!this.accessToken,
      tokenExpireTime: this.tokenExpireTime,
      isTokenValid: this.accessToken && Date.now() < this.tokenExpireTime,
    };
  }
}
