import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { KnowledgeBaseService } from './knowledge-base.service';

export interface WeixinChatRecord {
  id: string;
  userId: string;
  userName: string;
  content: string;
  timestamp: number;
  msgType: string;
}

export interface SyncConfig {
  enabled: boolean;
  syncInterval: number;
  autoUpdate: boolean;
  minRecordsForUpdate: number;
}

interface PendingChatRecord {
  version: 1;
  sourceHash: string;
  record: WeixinChatRecord;
  filePath: string;
}

interface PersistedChatRecord {
  version: 1;
  sourceHash: string;
  record: WeixinChatRecord;
}

interface BatchMetadata {
  version: 1;
  batchHash: string;
  sourceHashes: string[];
  messageIds: string[];
}

interface FlushResult {
  success: boolean;
  processed: number;
}

const DEFAULT_REBUILD_DAYS = 3;
const DEFAULT_SYNC_INTERVAL_MINUTES = 30;
const DEFAULT_MIN_RECORDS = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const BATCH_METADATA_PREFIX = '<!-- weixin-sync-meta:';
const BATCH_METADATA_SUFFIX = ' -->';
const NOTIFICATION_MESSAGE_TYPES = new Set([
  'callback',
  'event',
  'notification',
  'spec_callback',
]);
const NOTIFICATION_KEYS = new Set([
  'auth_knowledge_base',
  'chat_archive_audit_approved',
  'chat_archive_export_finished',
  'conversation_new_message',
  'delete_knowledge_base',
  'hit_keyword',
  'unauth_knowledge_base',
]);
const SENSITIVE_KEY_PATTERN =
  /^(access[_-]?token|authorization|credential|msg[_-]?signature|secret|suite[_-]?ticket|token)$/i;
const SENSITIVE_TEXT_PATTERN =
  /\b(access[_-]?token|authorization|credential|msg[_-]?signature|secret|suite[_-]?ticket|token)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;]+)/gi;

@Injectable()
export class WeixinKnowledgeSyncService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WeixinKnowledgeSyncService.name);
  private readonly syncDataPath: string;
  private readonly pendingDataPath: string;
  private readonly pendingRecords = new Map<string, PendingChatRecord>();
  private completedSourceHashes = new Set<string>();
  private completedMessageIds = new Set<string>();
  private knownMessageIds = new Set<string>();
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private maintenanceTask: Promise<void> | null = null;
  private activeFlush: Promise<FlushResult> | null = null;
  private autoSyncEnabled = false;
  private syncIntervalMs =
    DEFAULT_SYNC_INTERVAL_MINUTES * 60 * 1000;
  private minRecordsForUpdate = DEFAULT_MIN_RECORDS;
  private rebuildIntervalMs =
    DEFAULT_REBUILD_DAYS * 24 * 60 * 60 * 1000;
  private nextSyncAt = 0;
  private nextRebuildAt = 0;
  private lastRebuildTime = 0;
  private isRebuilding = false;
  private isShuttingDown = false;

  constructor(
    private configService: ConfigService,
    private knowledgeBaseService: KnowledgeBaseService,
  ) {
    this.syncDataPath = path.join(process.cwd(), 'data', 'weixin-sync');
    this.pendingDataPath = path.join(this.syncDataPath, 'pending');
    this.syncIntervalMs =
      this.positiveNumber(
        this.configService.get(
          'SYNC_INTERVAL_MINUTES',
          String(DEFAULT_SYNC_INTERVAL_MINUTES),
        ),
        DEFAULT_SYNC_INTERVAL_MINUTES,
      ) *
      60 *
      1000;
    this.minRecordsForUpdate = this.positiveNumber(
      this.configService.get(
        'MIN_RECORDS_FOR_UPDATE',
        String(DEFAULT_MIN_RECORDS),
      ),
      DEFAULT_MIN_RECORDS,
    );
    this.ensureDirectories();
    this.loadCompletedRecords();
    this.recoverPendingRecords();
  }

  async onModuleInit(): Promise<void> {
    const rebuildDays = this.positiveNumber(
      this.configService.get('KB_REBUILD_DAYS', String(DEFAULT_REBUILD_DAYS)),
      DEFAULT_REBUILD_DAYS,
    );
    this.rebuildIntervalMs = rebuildDays * 24 * 60 * 60 * 1000;
    this.lastRebuildTime = Date.now();
    this.nextRebuildAt = this.lastRebuildTime + this.rebuildIntervalMs;

    const autoSync =
      this.configService.get('KNOWLEDGE_BASE_AUTO_SYNC', 'false') === 'true';
    if (autoSync) {
      this.configureAutoSync({
        enabled: true,
        syncInterval: this.positiveNumber(
          this.configService.get(
            'SYNC_INTERVAL_MINUTES',
            String(DEFAULT_SYNC_INTERVAL_MINUTES),
          ),
          DEFAULT_SYNC_INTERVAL_MINUTES,
        ),
        autoUpdate: true,
        minRecordsForUpdate: this.positiveNumber(
          this.configService.get(
            'MIN_RECORDS_FOR_UPDATE',
            String(DEFAULT_MIN_RECORDS),
          ),
          DEFAULT_MIN_RECORDS,
        ),
      });
    }

    this.scheduleMaintenance();

    if (this.pendingRecords.size > 0) {
      this.logger.log(
        `恢复 ${this.pendingRecords.size} 条待同步记录，立即重试`,
      );
      await this.flushToKnowledgeBase();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    this.clearMaintenanceTimer();

    if (this.maintenanceTask) {
      await this.maintenanceTask;
    }
    if (this.activeFlush) {
      await this.activeFlush;
    }
  }

  async ingestChatRecords(msgList: any[]): Promise<void> {
    if (!Array.isArray(msgList) || msgList.length === 0) {
      return;
    }

    let accepted = 0;
    for (const message of msgList) {
      const pending = this.normalizeMessage(message);
      if (!pending) {
        continue;
      }

      if (this.persistPendingRecord(pending)) {
        accepted++;
      }
    }

    if (accepted === 0) {
      return;
    }

    this.logger.log(
      `收到 ${accepted} 条会话记录，待同步总计 ${this.pendingRecords.size} 条`,
    );

    if (this.pendingRecords.size >= this.minRecordsForUpdate) {
      await this.flushWhileThresholdMet();
    }
  }

  async rebuildKnowledgeBase(): Promise<{
    success: boolean;
    message: string;
  }> {
    if (this.isRebuilding) {
      this.logger.warn('知识库重建已在进行中，跳过本次触发');
      return { success: false, message: '重建已在进行中' };
    }

    if (this.activeFlush) {
      await this.activeFlush;
    }

    this.isRebuilding = true;
    try {
      const files = fs
        .readdirSync(this.syncDataPath)
        .filter((file) => file.endsWith('.txt'))
        .sort();

      let imported = 0;
      for (const file of files) {
        const filePath = path.join(this.syncDataPath, file);
        try {
          await this.knowledgeBaseService.addDocument(
            filePath,
            file,
            'text/plain',
            this.documentConfig(),
          );
          imported++;
        } catch (error) {
          this.logger.error(
            `重建导入失败 ${file}: ${this.errorMessage(error)}`,
          );
        }
      }

      this.lastRebuildTime = Date.now();
      this.nextRebuildAt = this.lastRebuildTime + this.rebuildIntervalMs;
      const message = `知识库重建完成，导入 ${imported}/${files.length} 个文件`;
      this.logger.log(message);
      return { success: true, message };
    } catch (error) {
      const message = this.errorMessage(error);
      this.logger.error(`知识库重建失败: ${message}`);
      return { success: false, message };
    } finally {
      this.isRebuilding = false;
    }
  }

  async purgeAndRebuild(): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      if (this.activeFlush) {
        await this.activeFlush;
      }

      const files = fs
        .readdirSync(this.syncDataPath)
        .filter((file) => file.endsWith('.txt'));
      for (const file of files) {
        fs.unlinkSync(path.join(this.syncDataPath, file));
      }

      await this.clearCache();
      await this.knowledgeBaseService.clear();

      this.completedSourceHashes.clear();
      this.completedMessageIds.clear();
      this.knownMessageIds.clear();
      this.lastRebuildTime = Date.now();
      this.nextRebuildAt = this.lastRebuildTime + this.rebuildIntervalMs;

      return {
        success: true,
        message: `已清理 ${files.length} 个文件并清空知识库`,
      };
    } catch (error) {
      const message = this.errorMessage(error);
      this.logger.error(`彻底清理失败: ${message}`);
      return { success: false, message };
    }
  }

  async startAutoSync(config: SyncConfig): Promise<void> {
    if (!config.enabled) {
      await this.stopAutoSync();
      this.logger.log('企业微信知识库自动同步未启用');
      return;
    }

    this.configureAutoSync(config);
    this.scheduleMaintenance();
    this.logger.log(
      `启动企业微信知识库自动同步，间隔: ${config.syncInterval}分钟`,
    );

    if (this.pendingRecords.size >= this.minRecordsForUpdate) {
      await this.flushWhileThresholdMet();
    }
  }

  async stopAutoSync(): Promise<void> {
    this.autoSyncEnabled = false;
    this.nextSyncAt = 0;
    this.scheduleMaintenance();

    if (this.activeFlush) {
      await this.activeFlush;
    }
    this.logger.log('企业微信知识库自动同步已停止');
  }

  async syncChatRecords(_config: SyncConfig): Promise<{
    success: boolean;
    recordsProcessed: number;
    message: string;
  }> {
    const recordCount = this.pendingRecords.size;
    if (recordCount === 0) {
      return {
        success: true,
        recordsProcessed: 0,
        message: '缓存为空，等待回调推送新数据',
      };
    }

    const result = await this.flushToKnowledgeBase();
    return {
      success: result.success,
      recordsProcessed: result.processed,
      message: result.success
        ? `已将 ${result.processed} 条缓存记录写入知识库`
        : '知识库写入失败，记录已保留等待重试',
    };
  }

  async manualUpdateKnowledgeBase(): Promise<{
    success: boolean;
    message: string;
    recordsProcessed: number;
  }> {
    if (this.pendingRecords.size === 0) {
      return {
        success: false,
        message: '缓存中没有待处理的聊天记录',
        recordsProcessed: 0,
      };
    }

    const result = await this.flushToKnowledgeBase();
    return {
      success: result.success,
      message: result.success
        ? '知识库更新成功'
        : '知识库更新失败，记录已保留等待重试',
      recordsProcessed: result.processed,
    };
  }

  getSyncStatus(): {
    isRunning: boolean;
    cachedRecords: number;
    lastRebuildTime: string;
    nextRebuildIn: string;
  } {
    const nextRebuild = this.nextRebuildAt - Date.now();
    const hoursLeft = Math.max(
      0,
      Math.floor(nextRebuild / (60 * 60 * 1000)),
    );

    return {
      isRunning: this.autoSyncEnabled && this.maintenanceTimer !== null,
      cachedRecords: this.pendingRecords.size,
      lastRebuildTime: this.lastRebuildTime
        ? new Date(this.lastRebuildTime).toLocaleString('zh-CN')
        : '从未',
      nextRebuildIn: `${hoursLeft} 小时`,
    };
  }

  async clearCache(): Promise<void> {
    if (this.activeFlush) {
      await this.activeFlush;
    }

    const snapshot = Array.from(this.pendingRecords.values());
    for (const pending of snapshot) {
      this.unlinkIfExists(pending.filePath);
    }
    for (const file of fs.readdirSync(this.pendingDataPath)) {
      if (file.endsWith('.batch.txt')) {
        this.unlinkIfExists(path.join(this.pendingDataPath, file));
      }
    }

    this.pendingRecords.clear();
    this.knownMessageIds = new Set(this.completedMessageIds);
    this.logger.log('聊天记录缓存已清空');
  }

  private configureAutoSync(config: SyncConfig): void {
    this.autoSyncEnabled = true;
    this.syncIntervalMs =
      this.positiveNumber(
        config.syncInterval,
        DEFAULT_SYNC_INTERVAL_MINUTES,
      ) *
      60 *
      1000;
    this.minRecordsForUpdate = this.positiveNumber(
      config.minRecordsForUpdate,
      DEFAULT_MIN_RECORDS,
    );
    this.nextSyncAt = Date.now() + this.syncIntervalMs;
  }

  private scheduleMaintenance(): void {
    this.clearMaintenanceTimer();
    if (this.isShuttingDown) {
      return;
    }

    if (this.nextRebuildAt === 0) {
      const now = Date.now();
      this.lastRebuildTime = now;
      this.nextRebuildAt = now + this.rebuildIntervalMs;
    }

    const intervalMs = this.autoSyncEnabled
      ? Math.min(this.syncIntervalMs, this.rebuildIntervalMs)
      : this.rebuildIntervalMs;

    this.maintenanceTimer = setInterval(() => {
      this.runMaintenanceTick();
    }, intervalMs);
    this.maintenanceTimer.unref?.();
  }

  private clearMaintenanceTimer(): void {
    if (!this.maintenanceTimer) {
      return;
    }
    clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
  }

  private runMaintenanceTick(): void {
    if (this.maintenanceTask || this.isShuttingDown) {
      return;
    }

    const task = this.performMaintenance().finally(() => {
      if (this.maintenanceTask === task) {
        this.maintenanceTask = null;
      }
    });
    this.maintenanceTask = task;
  }

  private async performMaintenance(): Promise<void> {
    const now = Date.now();
    if (this.autoSyncEnabled && now >= this.nextSyncAt) {
      this.nextSyncAt = now + this.syncIntervalMs;
      await this.flushToKnowledgeBase();
    }

    if (now >= this.nextRebuildAt) {
      this.nextRebuildAt = now + this.rebuildIntervalMs;
      await this.rebuildKnowledgeBase();
    }
  }

  private async flushWhileThresholdMet(): Promise<void> {
    while (this.pendingRecords.size >= this.minRecordsForUpdate) {
      const result = await this.flushToKnowledgeBase();
      if (!result.success || result.processed === 0) {
        return;
      }
    }
  }

  private flushToKnowledgeBase(): Promise<FlushResult> {
    if (this.activeFlush) {
      return this.activeFlush;
    }
    if (this.pendingRecords.size === 0 || this.isShuttingDown) {
      return Promise.resolve({ success: true, processed: 0 });
    }

    const task = this.performFlush().finally(() => {
      if (this.activeFlush === task) {
        this.activeFlush = null;
      }
    });
    this.activeFlush = task;
    return task;
  }

  private async performFlush(): Promise<FlushResult> {
    const snapshot = Array.from(this.pendingRecords.values()).sort((a, b) =>
      a.sourceHash.localeCompare(b.sourceHash),
    );
    if (snapshot.length === 0) {
      return { success: true, processed: 0 };
    }

    const sourceHashes = snapshot.map((pending) => pending.sourceHash);
    const messageIds = snapshot.map((pending) => pending.record.id);
    const batchHash = this.hash(sourceHashes.join('\n'));
    const fileName = `weixin-chat-${batchHash}.txt`;
    const pendingBatchPath = path.join(
      this.pendingDataPath,
      `${batchHash}.batch.txt`,
    );
    const completedBatchPath = path.join(this.syncDataPath, fileName);
    const metadata: BatchMetadata = {
      version: 1,
      batchHash,
      sourceHashes,
      messageIds,
    };

    try {
      fs.writeFileSync(
        pendingBatchPath,
        this.convertChatRecordsToDocument(snapshot, metadata),
        { encoding: 'utf8', mode: FILE_MODE },
      );
      fs.chmodSync(pendingBatchPath, FILE_MODE);

      await this.knowledgeBaseService.addDocument(
        pendingBatchPath,
        fileName,
        'text/plain',
        this.documentConfig(),
      );

      fs.renameSync(pendingBatchPath, completedBatchPath);
      fs.chmodSync(completedBatchPath, FILE_MODE);

      for (const pending of snapshot) {
        const current = this.pendingRecords.get(pending.sourceHash);
        if (!current || current.filePath !== pending.filePath) {
          continue;
        }

        this.unlinkIfExists(pending.filePath);
        this.pendingRecords.delete(pending.sourceHash);
        this.completedSourceHashes.add(pending.sourceHash);
        this.completedMessageIds.add(pending.record.id);
      }

      this.logger.log(
        `${snapshot.length} 条记录已写入知识库: ${fileName}`,
      );
      return { success: true, processed: snapshot.length };
    } catch (error) {
      this.unlinkIfExists(pendingBatchPath);
      this.logger.error(
        `写入知识库失败，保留 ${snapshot.length} 条记录等待重试: ${this.errorMessage(error)}`,
      );
      return { success: false, processed: 0 };
    }
  }

  private normalizeMessage(message: any): PendingChatRecord | null {
    if (!message || typeof message !== 'object') {
      return null;
    }

    const msgType = this.nonEmptyString(
      message.msg_type ?? message.msgtype ?? message.type,
      'text',
    ).toLowerCase();
    if (NOTIFICATION_MESSAGE_TYPES.has(msgType)) {
      return null;
    }

    const content = this.normalizeContent(
      message.content ?? message.text ?? message.msg_content,
    );
    if (!content) {
      return null;
    }

    const userId = this.nonEmptyString(
      message.from ?? message.sender ?? message.userid,
      'unknown',
    );
    const userName = this.nonEmptyString(
      message.from_name ??
        message.sender_name ??
        message.username ??
        message.from,
      userId,
    );
    const timestamp = this.normalizeTimestamp(
      message.send_time ??
        message.timestamp ??
        message.create_time ??
        message.createTime,
    );
    const explicitId = this.optionalString(
      message.msg_id ?? message.msgid ?? message.id,
    );
    const sourceHash = this.hash(
      this.stableSerialize({
        content,
        explicitId,
        msgType,
        timestamp,
        userId,
        userName,
      }),
    );
    const id = explicitId || `weixin-${sourceHash}`;

    if (
      this.completedSourceHashes.has(sourceHash) ||
      this.pendingRecords.has(sourceHash) ||
      this.knownMessageIds.has(id)
    ) {
      return null;
    }

    return {
      version: 1,
      sourceHash,
      record: {
        id,
        userId,
        userName,
        content,
        timestamp,
        msgType,
      },
      filePath: path.join(this.pendingDataPath, `${sourceHash}.json`),
    };
  }

  private normalizeContent(rawContent: unknown): string | null {
    if (rawContent === null || rawContent === undefined) {
      return null;
    }

    if (typeof rawContent === 'object') {
      if (this.isNotificationEnvelope(rawContent)) {
        return null;
      }
      return this.contentFromStructuredValue(rawContent);
    }

    const content = String(rawContent).trim();
    if (!content) {
      return null;
    }

    if (
      (content.startsWith('{') && content.endsWith('}')) ||
      (content.startsWith('[') && content.endsWith(']'))
    ) {
      try {
        const parsed = JSON.parse(content);
        if (this.isNotificationEnvelope(parsed)) {
          return null;
        }
        return this.contentFromStructuredValue(parsed);
      } catch {
        return this.redactSensitiveText(content);
      }
    }

    return this.redactSensitiveText(content);
  }

  private contentFromStructuredValue(value: unknown): string | null {
    const extracted = this.extractChatText(value);
    if (extracted) {
      return this.redactSensitiveText(extracted);
    }

    const sanitized = this.sanitizeStructuredValue(value);
    if (
      sanitized === null ||
      sanitized === undefined ||
      (Array.isArray(sanitized) && sanitized.length === 0) ||
      (typeof sanitized === 'object' &&
        !Array.isArray(sanitized) &&
        Object.keys(sanitized as Record<string, unknown>).length === 0)
    ) {
      return null;
    }
    return this.stableSerialize(sanitized);
  }

  private extractChatText(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const object = value as Record<string, unknown>;
    for (const key of ['content', 'msg_content', 'body', 'message']) {
      const candidate = object[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }

    const text = object.text;
    if (typeof text === 'string' && text.trim()) {
      return text.trim();
    }
    if (text && typeof text === 'object' && !Array.isArray(text)) {
      const nestedContent = (text as Record<string, unknown>).content;
      if (typeof nestedContent === 'string' && nestedContent.trim()) {
        return nestedContent.trim();
      }
    }

    return null;
  }

  private isNotificationEnvelope(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }

    const object = value as Record<string, unknown>;
    if (
      typeof object.event_type === 'string' ||
      typeof object.Event === 'string'
    ) {
      return true;
    }
    if (Object.keys(object).some((key) => NOTIFICATION_KEYS.has(key))) {
      return true;
    }

    const keys = Object.keys(object);
    const hasChatContent = [
      'body',
      'content',
      'message',
      'msg_content',
      'text',
    ].some((key) => object[key] !== undefined);
    return (
      !hasChatContent &&
      keys.length > 0 &&
      keys.every((key) => SENSITIVE_KEY_PATTERN.test(key))
    );
  }

  private sanitizeStructuredValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value
        .map((item) => this.sanitizeStructuredValue(item))
        .filter((item) => item !== undefined);
    }
    if (!value || typeof value !== 'object') {
      return value;
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        continue;
      }
      sanitized[key] = this.sanitizeStructuredValue(item);
    }
    return sanitized;
  }

  private redactSensitiveText(content: string): string {
    return content.replace(
      SENSITIVE_TEXT_PATTERN,
      (_match, key: string, separator: string) =>
        `${key}${separator}[REDACTED]`,
    );
  }

  private normalizeTimestamp(value: unknown): number {
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return this.normalizeNumericTimestamp(numeric);
      }
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return this.normalizeNumericTimestamp(value);
    }
    return 0;
  }

  private normalizeNumericTimestamp(value: number): number {
    if (value <= 0) {
      return 0;
    }
    return value < 1_000_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }

  private persistPendingRecord(pending: PendingChatRecord): boolean {
    const persisted: PersistedChatRecord = {
      version: pending.version,
      sourceHash: pending.sourceHash,
      record: pending.record,
    };
    const temporaryPath = `${pending.filePath}.tmp`;
    let descriptor: number | null = null;

    try {
      if (fs.existsSync(pending.filePath)) {
        return false;
      }

      descriptor = fs.openSync(temporaryPath, 'wx', FILE_MODE);
      fs.writeFileSync(
        descriptor,
        `${this.stableSerialize(persisted)}\n`,
        { encoding: 'utf8' },
      );
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporaryPath, pending.filePath);
      fs.chmodSync(pending.filePath, FILE_MODE);
    } catch (error: any) {
      if (descriptor !== null) {
        fs.closeSync(descriptor);
      }
      this.unlinkIfExists(temporaryPath);
      if (error?.code === 'EEXIST') {
        return false;
      }
      throw error;
    }

    this.pendingRecords.set(pending.sourceHash, pending);
    this.knownMessageIds.add(pending.record.id);
    return true;
  }

  private ensureDirectories(): void {
    fs.mkdirSync(this.syncDataPath, {
      recursive: true,
      mode: DIRECTORY_MODE,
    });
    fs.mkdirSync(this.pendingDataPath, {
      recursive: true,
      mode: DIRECTORY_MODE,
    });
    fs.chmodSync(this.pendingDataPath, DIRECTORY_MODE);
  }

  private loadCompletedRecords(): void {
    const files = fs
      .readdirSync(this.syncDataPath)
      .filter((file) => file.endsWith('.txt'));

    for (const file of files) {
      try {
        const content = fs.readFileSync(
          path.join(this.syncDataPath, file),
          'utf8',
        );
        const metadata = this.readBatchMetadata(content);
        if (!metadata) {
          continue;
        }
        metadata.sourceHashes.forEach((hash) =>
          this.completedSourceHashes.add(hash),
        );
        metadata.messageIds.forEach((id) =>
          this.completedMessageIds.add(id),
        );
      } catch (error) {
        this.logger.warn(
          `读取历史同步元数据失败 ${file}: ${this.errorMessage(error)}`,
        );
      }
    }

    this.knownMessageIds = new Set(this.completedMessageIds);
  }

  private recoverPendingRecords(): void {
    this.recoverTemporaryRecordFiles();
    const files = fs
      .readdirSync(this.pendingDataPath)
      .filter((file) => file.endsWith('.json'))
      .sort();

    for (const file of files) {
      const filePath = path.join(this.pendingDataPath, file);
      try {
        fs.chmodSync(filePath, FILE_MODE);
        const persisted = JSON.parse(
          fs.readFileSync(filePath, 'utf8'),
        ) as PersistedChatRecord;
        if (!this.isValidPersistedRecord(persisted)) {
          throw new Error('invalid pending record');
        }

        if (
          this.completedSourceHashes.has(persisted.sourceHash) ||
          this.completedMessageIds.has(persisted.record.id)
        ) {
          this.unlinkIfExists(filePath);
          continue;
        }
        if (
          this.pendingRecords.has(persisted.sourceHash) ||
          this.knownMessageIds.has(persisted.record.id)
        ) {
          this.unlinkIfExists(filePath);
          continue;
        }

        this.pendingRecords.set(persisted.sourceHash, {
          ...persisted,
          filePath,
        });
        this.knownMessageIds.add(persisted.record.id);
      } catch (error) {
        this.logger.warn(
          `恢复待同步记录失败 ${file}: ${this.errorMessage(error)}`,
        );
      }
    }
  }

  private recoverTemporaryRecordFiles(): void {
    const files = fs
      .readdirSync(this.pendingDataPath)
      .filter((file) => file.endsWith('.json.tmp'))
      .sort();

    for (const file of files) {
      const temporaryPath = path.join(this.pendingDataPath, file);
      try {
        fs.chmodSync(temporaryPath, FILE_MODE);
        const persisted = JSON.parse(
          fs.readFileSync(temporaryPath, 'utf8'),
        ) as PersistedChatRecord;
        if (!this.isValidPersistedRecord(persisted)) {
          throw new Error('invalid temporary pending record');
        }

        const completedPath = path.join(
          this.pendingDataPath,
          `${persisted.sourceHash}.json`,
        );
        if (fs.existsSync(completedPath)) {
          this.unlinkIfExists(temporaryPath);
          continue;
        }
        fs.renameSync(temporaryPath, completedPath);
        fs.chmodSync(completedPath, FILE_MODE);
      } catch (error) {
        this.logger.warn(
          `恢复临时待同步记录失败 ${file}: ${this.errorMessage(error)}`,
        );
      }
    }
  }

  private isValidPersistedRecord(
    persisted: PersistedChatRecord,
  ): boolean {
    return Boolean(
      persisted &&
        persisted.version === 1 &&
        typeof persisted.sourceHash === 'string' &&
        /^[a-f0-9]{64}$/.test(persisted.sourceHash) &&
        persisted.record &&
        typeof persisted.record.id === 'string' &&
        typeof persisted.record.userId === 'string' &&
        typeof persisted.record.userName === 'string' &&
        typeof persisted.record.content === 'string' &&
        typeof persisted.record.timestamp === 'number' &&
        typeof persisted.record.msgType === 'string',
    );
  }

  private convertChatRecordsToDocument(
    pendingRecords: PendingChatRecord[],
    metadata: BatchMetadata,
  ): string {
    const records = [...pendingRecords].sort((a, b) => {
      const timestampOrder = a.record.timestamp - b.record.timestamp;
      return timestampOrder || a.sourceHash.localeCompare(b.sourceHash);
    });
    const lines = [
      '# 企业微信聊天记录',
      '',
      `${BATCH_METADATA_PREFIX}${this.stableSerialize(metadata)}${BATCH_METADATA_SUFFIX}`,
      `批次: ${metadata.batchHash}`,
      `记录数量: ${records.length}`,
      '',
      '---',
      '',
    ];

    records.forEach((pending, index) => {
      const record = pending.record;
      const date = new Date(record.timestamp).toISOString();
      lines.push(`## 记录 ${index + 1}`);
      lines.push(`- 消息ID: ${record.id}`);
      lines.push(`- 来源哈希: ${pending.sourceHash}`);
      lines.push(`- 用户: ${record.userName} (${record.userId})`);
      lines.push(`- 时间: ${date}`);
      lines.push(`- 类型: ${record.msgType}`);
      lines.push(`- 内容: ${record.content}`);
      lines.push('');
    });

    return lines.join('\n');
  }

  private readBatchMetadata(content: string): BatchMetadata | null {
    const start = content.indexOf(BATCH_METADATA_PREFIX);
    if (start < 0) {
      return null;
    }
    const jsonStart = start + BATCH_METADATA_PREFIX.length;
    const end = content.indexOf(BATCH_METADATA_SUFFIX, jsonStart);
    if (end < 0) {
      return null;
    }

    const metadata = JSON.parse(
      content.slice(jsonStart, end),
    ) as BatchMetadata;
    if (
      metadata.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(metadata.batchHash) ||
      !Array.isArray(metadata.sourceHashes) ||
      !Array.isArray(metadata.messageIds)
    ) {
      return null;
    }
    return metadata;
  }

  private stableSerialize(value: unknown): string {
    if (value === undefined) {
      return 'null';
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableSerialize(item)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${this.stableSerialize(object[key])}`,
        )
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private documentConfig(): {
    category: string;
    tags: string[];
  } {
    return {
      category: 'weixin-chat',
      tags: ['企业微信', '聊天记录', '自动同步'],
    };
  }

  private optionalString(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    const normalized = String(value).trim();
    return normalized || null;
  }

  private nonEmptyString(value: unknown, fallback: string): string {
    return this.optionalString(value) || fallback;
  }

  private positiveNumber(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private unlinkIfExists(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
