import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KnowledgeBaseService } from './knowledge-base.service';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 企业微信聊天记录接口
 */
export interface WeixinChatRecord {
  id: string;
  userId: string;
  userName: string;
  content: string;
  timestamp: number;
  msgType: string;
}

/**
 * 知识库同步配置
 */
export interface SyncConfig {
  enabled: boolean;
  syncInterval: number; // 同步间隔（分钟）
  autoUpdate: boolean; // 是否自动更新
  minRecordsForUpdate: number; // 触发更新的最小记录数
}

// 知识库重建周期（3天，毫秒）
const REBUILD_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * 企业微信聊天记录知识库同步服务
 *
 * 功能：
 * 1. 接收回调推送的会话记录，实时写入知识库
 * 2. 每3天自动清空知识库并从历史同步文件重建
 */
@Injectable()
export class WeixinKnowledgeSyncService implements OnModuleInit {
  private readonly logger = new Logger(WeixinKnowledgeSyncService.name);
  private syncTimer: NodeJS.Timeout | null = null;
  private rebuildTimer: NodeJS.Timeout | null = null;
  private chatRecordsCache: WeixinChatRecord[] = [];
  private readonly syncDataPath: string;
  private lastRebuildTime: number = 0;
  private isRebuilding: boolean = false;

  constructor(
    private configService: ConfigService,
    private knowledgeBaseService: KnowledgeBaseService,
  ) {
    this.syncDataPath = path.join(process.cwd(), 'data', 'weixin-sync');
    this.ensureDirectories();
  }

  async onModuleInit() {
    // 启动3天自动重建定时器
    this.startAutoRebuild();

    // 如果配置了自动同步，启动
    const autoSync = this.configService.get('KNOWLEDGE_BASE_AUTO_SYNC', 'false');
    if (autoSync === 'true') {
      await this.startAutoSync({
        enabled: true,
        syncInterval: parseInt(this.configService.get('SYNC_INTERVAL_MINUTES', '30')),
        autoUpdate: true,
        minRecordsForUpdate: parseInt(this.configService.get('MIN_RECORDS_FOR_UPDATE', '50')),
      });
    }
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.syncDataPath)) {
      fs.mkdirSync(this.syncDataPath, { recursive: true });
      this.logger.log(`创建同步数据目录: ${this.syncDataPath}`);
    }
  }

  // ============================================================
  // 核心方法：接收回调推送的会话记录（Fix 1 + Fix 2）
  // ============================================================

  /**
   * 接收从回调服务推送过来的会话记录，解析后写入缓存并触发知识库更新
   * 由 WeworkSpecCallbackService.handleConversationNewMessage 调用
   */
  async ingestChatRecords(msgList: any[]): Promise<void> {
    if (!msgList || msgList.length === 0) return;

    const records: WeixinChatRecord[] = msgList
      .filter(msg => msg.content || msg.text || msg.msg_content)
      .map((msg, index) => ({
        id: msg.msg_id || msg.msgid || `msg-${Date.now()}-${index}`,
        userId: msg.from || msg.sender || msg.userid || 'unknown',
        userName: msg.from_name || msg.sender_name || msg.from || 'unknown',
        content: msg.content || msg.text || msg.msg_content || '',
        timestamp: msg.send_time ? msg.send_time * 1000 : Date.now(),
        msgType: msg.msg_type || msg.msgtype || 'text',
      }));

    if (records.length === 0) return;

    this.chatRecordsCache.push(...records);
    this.logger.log(`收到 ${records.length} 条会话记录，缓存总计 ${this.chatRecordsCache.length} 条`);

    // 达到阈值或每次回调都立即写入
    const minRecords = parseInt(this.configService.get('MIN_RECORDS_FOR_UPDATE', '1'));
    if (this.chatRecordsCache.length >= minRecords) {
      await this.flushToKnowledgeBase();
    }
  }

  /**
   * 将缓存中的记录写入知识库
   */
  private async flushToKnowledgeBase(): Promise<void> {
    if (this.chatRecordsCache.length === 0) return;

    try {
      const count = this.chatRecordsCache.length;
      this.logger.log(`写入知识库: ${count} 条聊天记录`);

      const documentContent = this.convertChatRecordsToDocument(this.chatRecordsCache);

      const timestamp = Date.now();
      const fileName = `weixin-chat-${timestamp}.txt`;
      const filePath = path.join(this.syncDataPath, fileName);

      fs.writeFileSync(filePath, documentContent, 'utf-8');

      await this.knowledgeBaseService.addDocument(
        filePath,
        fileName,
        'text/plain',
        {
          category: 'weixin-chat',
          tags: ['企业微信', '聊天记录', '自动同步'],
        },
      );

      this.chatRecordsCache = [];
      this.logger.log(`✅ ${count} 条记录已写入知识库: ${fileName}`);
    } catch (error) {
      this.logger.error('写入知识库失败:', error.message);
    }
  }

  // ============================================================
  // 3天自动清空重建（Fix 3）
  // ============================================================

  /**
   * 启动每3天自动清空并重建知识库
   */
  private startAutoRebuild(): void {
    const rebuildDays = parseInt(this.configService.get('KB_REBUILD_DAYS', '3'));
    const intervalMs = rebuildDays * 24 * 60 * 60 * 1000;

    this.lastRebuildTime = Date.now();
    this.logger.log(`知识库自动重建已启动，周期: 每 ${rebuildDays} 天`);

    this.rebuildTimer = setInterval(async () => {
      await this.rebuildKnowledgeBase();
    }, intervalMs);
  }

  /**
   * 清空知识库并从历史同步文件重新导入
   */
  async rebuildKnowledgeBase(): Promise<{ success: boolean; message: string }> {
    if (this.isRebuilding) {
      this.logger.warn('知识库重建已在进行中，跳过本次触发');
      return { success: false, message: '重建已在进行中' };
    }
    this.isRebuilding = true;
    try {
      this.logger.log('=== 开始知识库增量同步（保留已有内容）===');

      // 读取所有历史同步文件并导入（增量，不清空已有内容）
      const files = fs.readdirSync(this.syncDataPath)
        .filter(f => f.endsWith('.txt'))
        .sort(); // 按文件名（时间戳）排序

      let imported = 0;
      for (const file of files) {
        const filePath = path.join(this.syncDataPath, file);
        try {
          await this.knowledgeBaseService.addDocument(
            filePath,
            file,
            'text/plain',
            {
              category: 'weixin-chat',
              tags: ['企业微信', '聊天记录', '自动同步'],
            },
          );
          imported++;
        } catch (err) {
          this.logger.error(`重建导入失败 ${file}: ${err.message}`);
        }
      }

      this.lastRebuildTime = Date.now();
      const msg = `知识库重建完成，导入 ${imported}/${files.length} 个文件`;
      this.logger.log(`✅ ${msg}`);

      return { success: true, message: msg };
    } catch (error) {
      this.logger.error('知识库重建失败:', error.message);
      return { success: false, message: error.message };
    } finally {
      this.isRebuilding = false;
    }
  }

  /**
   * 清空历史同步文件并重建（彻底清理）
   */
  async purgeAndRebuild(): Promise<{ success: boolean; message: string }> {
    try {
      this.logger.log('=== 彻底清理：删除历史文件并清空知识库 ===');

      // 删除所有同步文件
      const files = fs.readdirSync(this.syncDataPath).filter(f => f.endsWith('.txt'));
      for (const file of files) {
        fs.unlinkSync(path.join(this.syncDataPath, file));
      }
      this.logger.log(`已删除 ${files.length} 个历史同步文件`);

      // 清空知识库
      await this.knowledgeBaseService.clear();

      // 清空缓存
      this.chatRecordsCache = [];
      this.lastRebuildTime = Date.now();

      return { success: true, message: `已清理 ${files.length} 个文件并清空知识库` };
    } catch (error) {
      this.logger.error('彻底清理失败:', error.message);
      return { success: false, message: error.message };
    }
  }

  // ============================================================
  // 原有方法（保留兼容）
  // ============================================================

  async startAutoSync(config: SyncConfig): Promise<void> {
    if (!config.enabled) {
      this.logger.log('企业微信知识库自动同步未启用');
      return;
    }

    this.logger.log(`启动企业微信知识库自动同步，间隔: ${config.syncInterval}分钟`);

    // 设置定时刷新缓存到知识库
    this.syncTimer = setInterval(
      async () => {
        if (this.chatRecordsCache.length > 0) {
          this.logger.log(`定时刷新: 缓存中有 ${this.chatRecordsCache.length} 条记录`);
          await this.flushToKnowledgeBase();
        }
      },
      config.syncInterval * 60 * 1000,
    );
  }

  stopAutoSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
      this.logger.log('企业微信知识库自动同步已停止');
    }
  }

  async syncChatRecords(config: SyncConfig): Promise<{
    success: boolean;
    recordsProcessed: number;
    message: string;
  }> {
    // 现在由回调推送驱动，这里只刷新缓存
    if (this.chatRecordsCache.length > 0) {
      const count = this.chatRecordsCache.length;
      await this.flushToKnowledgeBase();
      return {
        success: true,
        recordsProcessed: count,
        message: `已将 ${count} 条缓存记录写入知识库`,
      };
    }
    return {
      success: true,
      recordsProcessed: 0,
      message: '缓存为空，等待回调推送新数据',
    };
  }

  private convertChatRecordsToDocument(records: WeixinChatRecord[]): string {
    const lines: string[] = [
      '# 企业微信聊天记录',
      '',
      `生成时间: ${new Date().toLocaleString('zh-CN')}`,
      `记录数量: ${records.length}`,
      '',
      '---',
      '',
    ];

    const sortedRecords = records.sort((a, b) => a.timestamp - b.timestamp);

    sortedRecords.forEach((record, index) => {
      const date = new Date(record.timestamp).toLocaleString('zh-CN');
      lines.push(`## 记录 ${index + 1}`);
      lines.push(`- 用户: ${record.userName} (${record.userId})`);
      lines.push(`- 时间: ${date}`);
      lines.push(`- 类型: ${record.msgType}`);
      lines.push(`- 内容: ${record.content}`);
      lines.push('');
    });

    return lines.join('\n');
  }

  async manualUpdateKnowledgeBase(): Promise<{
    success: boolean;
    message: string;
    recordsProcessed: number;
  }> {
    const recordCount = this.chatRecordsCache.length;
    if (recordCount === 0) {
      return {
        success: false,
        message: '缓存中没有待处理的聊天记录',
        recordsProcessed: 0,
      };
    }

    await this.flushToKnowledgeBase();
    return {
      success: true,
      message: '知识库更新成功',
      recordsProcessed: recordCount,
    };
  }

  getSyncStatus(): {
    isRunning: boolean;
    cachedRecords: number;
    lastRebuildTime: string;
    nextRebuildIn: string;
  } {
    const rebuildDays = parseInt(this.configService.get('KB_REBUILD_DAYS', '3'));
    const intervalMs = rebuildDays * 24 * 60 * 60 * 1000;
    const nextRebuild = this.lastRebuildTime + intervalMs - Date.now();
    const hoursLeft = Math.max(0, Math.floor(nextRebuild / (60 * 60 * 1000)));

    return {
      isRunning: this.syncTimer !== null,
      cachedRecords: this.chatRecordsCache.length,
      lastRebuildTime: this.lastRebuildTime
        ? new Date(this.lastRebuildTime).toLocaleString('zh-CN')
        : '从未',
      nextRebuildIn: `${hoursLeft} 小时`,
    };
  }

  clearCache(): void {
    this.chatRecordsCache = [];
    this.logger.log('聊天记录缓存已清空');
  }
}
