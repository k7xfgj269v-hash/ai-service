import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WeixinKnowledgeSyncService } from '../knowledge-base/weixin-sync.service';
import { AiService } from '../ai-service/ai.service';

/**
 * 专区程序转发的 wework_call 数据
 */
export interface WeworkCallForwardData {
  corpid: string;
  agentid: number;
  ability_id: string;
  notify_id: string;
  req_id: string;
  data: string; // 解密后的 JSON 字符串
}

/**
 * 专区程序转发的 ai_query 请求
 */
export interface AiQueryRequest {
  corpid: string;
  agentid: number;
  ability_id: string;
  func_req: {
    userId?: string;
    userName?: string;
    query?: string;
    [key: string]: any;
  };
}

/**
 * 回调数据接口
 */
interface CallbackData {
  event_type: string;
  timestamp: number;
  conversation_new_message?: {
    token: string;
  };
  chat_archive_audit_approved?: {
    userid: string;
    external_userid: string;
    chatid: string;
  };
  hit_keyword?: {
    token: string;
  };
  auth_knowledge_base?: {
    knowledge_base_id: string;
    knowledge_base_name: string;
  };
  unauth_knowledge_base?: {
    knowledge_base_id: string;
    knowledge_base_name: string;
  };
  delete_knowledge_base?: {
    knowledge_base_id: string;
    knowledge_base_name: string;
  };
  chat_archive_export_finished?: {
    jobid: string;
  };
}

/**
 * 企业微信专区回调服务
 * 接收专区程序（demoloadsdk.py）转发的已解密数据
 */
@Injectable()
export class WeworkSpecCallbackService {
  private readonly logger = new Logger(WeworkSpecCallbackService.name);

  constructor(
    private configService: ConfigService,
    private weixinSyncService: WeixinKnowledgeSyncService,
    private aiService: AiService,
  ) {}

  /**
   * 处理专区程序转发的 wework_call 数据
   * 数据已由专区程序的 SDK 解密，这里直接处理明文 JSON
   */
  async handleWeworkCallForward(
    forwardData: WeworkCallForwardData,
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      this.logger.log(`收到专区程序转发数据 - corpid: ${forwardData.corpid}, notify_id: ${forwardData.notify_id}`);

      // 解析解密后的事件数据
      let callbackData: CallbackData;
      try {
        callbackData = JSON.parse(forwardData.data);
      } catch (e) {
        this.logger.error(`解析转发数据失败: ${e.message}`);
        return { success: false, error: '数据格式错误' };
      }

      this.logger.log(`事件类型: ${callbackData.event_type}`);

      // 分发事件处理
      await this.dispatchEvent(callbackData, forwardData);

      return { success: true, message: 'ok' };
    } catch (error) {
      this.logger.error(`处理转发数据失败: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * 处理专区程序转发的 AI 查询
   */
  async handleAiQuery(
    request: AiQueryRequest,
  ): Promise<{ errcode: number; errmsg: string; reply?: string }> {
    try {
      const { func_req } = request;
      const userId = func_req.userId || func_req.userid || 'spec_user';
      const userName = func_req.userName || func_req.username || userId;
      const query = func_req.query || func_req.content || '';

      if (!query) {
        return { errcode: -1, errmsg: '缺少 query 参数' };
      }

      this.logger.log(`AI查询 - 用户: ${userId}, 问题: ${query}`);

      const reply = await this.aiService.processQuery({
        userId,
        userName,
        query,
      });

      if (reply === null) {
        return { errcode: 0, errmsg: 'ok', reply: '用户已被人工接管' };
      }

      return { errcode: 0, errmsg: 'ok', reply };
    } catch (error) {
      this.logger.error(`AI查询失败: ${error.message}`);
      return { errcode: -1, errmsg: error.message };
    }
  }

  /**
   * 分发事件到对应的处理器
   */
  private async dispatchEvent(data: CallbackData, forwardData: WeworkCallForwardData): Promise<void> {
    switch (data.event_type) {
      case 'conversation_new_message':
        await this.handleConversationNewMessage(data, forwardData);
        break;
      case 'chat_archive_audit_approved_single':
        this.handleChatArchiveAuditApproved(data);
        break;
      case 'hit_keyword':
        this.handleHitKeyword(data);
        break;
      case 'auth_knowledge_base':
        this.handleAuthKnowledgeBase(data);
        break;
      case 'unauth_knowledge_base':
        this.handleUnauthKnowledgeBase(data);
        break;
      case 'delete_knowledge_base':
        this.handleDeleteKnowledgeBase(data);
        break;
      case 'chat_archive_export_finished':
        this.handleChatArchiveExportFinished(data);
        break;
      default:
        this.logger.warn(`未知的事件类型: ${data.event_type}`);
    }
  }

  /**
   * 处理产生会话回调通知
   */
  private async handleConversationNewMessage(data: CallbackData, forwardData: WeworkCallForwardData): Promise<void> {
    const token = data.conversation_new_message?.token;

    this.logger.log('=== 产生会话回调通知 ===');
    this.logger.log(`Token: ${token ? token.substring(0, 8) + '***' : '无'}`);

    if (!token) {
      this.logger.warn('会话通知中没有token');
      return;
    }

    // 将原始事件数据作为聊天记录写入知识库
    try {
      const msgList = [{
        msg_id: forwardData.notify_id,
        from: 'wework_callback',
        content: forwardData.data,
        send_time: data.timestamp,
        msg_type: 'spec_callback',
      }];
      await this.weixinSyncService.ingestChatRecords(msgList);
      this.logger.log('会话回调数据已提交到知识库同步服务');
    } catch (error) {
      this.logger.error(`写入知识库失败: ${error.message}`);
    }
  }

  private handleChatArchiveAuditApproved(data: CallbackData): void {
    const info = data.chat_archive_audit_approved;
    this.logger.log(`=== 客户同意聊天内容存档 === userid: ${info?.userid}, external_userid: ${info?.external_userid}`);
  }

  private handleHitKeyword(data: CallbackData): void {
    const token = data.hit_keyword?.token;
    this.logger.log(`=== 命中关键词规则通知 === Token: ${token ? token.substring(0, 8) + '***' : '无'}`);
  }

  private handleAuthKnowledgeBase(data: CallbackData): void {
    const info = data.auth_knowledge_base;
    this.logger.log(`=== 知识库授权回调 === ID: ${info?.knowledge_base_id}, 名称: ${info?.knowledge_base_name}`);
  }

  private handleUnauthKnowledgeBase(data: CallbackData): void {
    const info = data.unauth_knowledge_base;
    this.logger.log(`=== 知识库取消授权回调 === ID: ${info?.knowledge_base_id}, 名称: ${info?.knowledge_base_name}`);
  }

  private handleDeleteKnowledgeBase(data: CallbackData): void {
    const info = data.delete_knowledge_base;
    this.logger.log(`=== 知识库删除回调 === ID: ${info?.knowledge_base_id}, 名称: ${info?.knowledge_base_name}`);
  }

  private handleChatArchiveExportFinished(data: CallbackData): void {
    this.logger.log(`=== 会话内容导出完成通知 === 任务ID: ${data.chat_archive_export_finished?.jobid}`);
  }
}
