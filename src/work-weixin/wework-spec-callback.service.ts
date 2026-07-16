import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../ai-service/ai.service';
import { constantTimeEqual } from '../common/security/api-key.guard';
import { WeixinKnowledgeSyncService } from '../knowledge-base/weixin-sync.service';
import { CallbackReplayStore } from './work-weixin.service';

const MAX_CALLBACK_SKEW_SECONDS = 5 * 60;
const MAX_DATA_BYTES = 256 * 1024;
const MAX_QUERY_BYTES = 32 * 1024;
const MAX_JSON_NODES = 512;
const MAX_JSON_DEPTH = 8;
const MAX_OBJECT_KEYS = 64;

export interface WeworkCallForwardData {
  corpid: string;
  agentid: number;
  ability_id: string;
  notify_id: string;
  req_id: string;
  data: string;
}

export interface AiQueryRequest {
  corpid: string;
  agentid: number;
  ability_id: string;
  func_req: {
    userId?: string;
    userName?: string;
    query?: string;
    userid?: string;
    username?: string;
    content?: string;
    [key: string]: unknown;
  };
}

interface CallbackData {
  event_type: string;
  timestamp: number;
  conversation_new_message?: {
    token: string;
  };
  [key: string]: unknown;
}

class ZoneCallbackValidationError extends Error {}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ZoneCallbackValidationError('Expected object');
  }
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== required.length ||
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new ZoneCallbackValidationError('Invalid envelope fields');
  }
}

function requireText(
  value: Record<string, unknown>,
  key: string,
  maxBytes: number,
  allowEmpty = false,
): string {
  const field = value[key];
  if (
    typeof field !== 'string' ||
    (!allowEmpty && field.length === 0) ||
    byteLength(field) > maxBytes ||
    field.includes('\0')
  ) {
    throw new ZoneCallbackValidationError(`Invalid field: ${key}`);
  }
  return field;
}

function optionalText(
  value: Record<string, unknown>,
  keys: readonly string[],
  maxBytes: number,
): string | undefined {
  for (const key of keys) {
    if (value[key] !== undefined) {
      return requireText(value, key, maxBytes, true);
    }
  }
  return undefined;
}

function requireAgentId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ZoneCallbackValidationError('Invalid agent ID');
  }
  return Number(value);
}

function isFreshTimestamp(timestamp: number): boolean {
  return (
    Number.isSafeInteger(timestamp) &&
    timestamp > 0 &&
    Math.abs(Math.floor(Date.now() / 1000) - timestamp) <=
      MAX_CALLBACK_SKEW_SECONDS
  );
}

function assertBoundedJson(root: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes++;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new ZoneCallbackValidationError('JSON structure exceeds limit');
    }

    if (
      current.value === null ||
      typeof current.value === 'boolean' ||
      typeof current.value === 'string'
    ) {
      if (
        typeof current.value === 'string' &&
        (byteLength(current.value) > MAX_DATA_BYTES ||
          current.value.includes('\0'))
      ) {
        throw new ZoneCallbackValidationError('JSON string exceeds limit');
      }
      continue;
    }

    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) {
        throw new ZoneCallbackValidationError('Invalid JSON number');
      }
      continue;
    }

    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_OBJECT_KEYS) {
        throw new ZoneCallbackValidationError('JSON array exceeds limit');
      }
      for (const item of current.value) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }

    const object = requireObject(current.value);
    const entries = Object.entries(object);
    if (entries.length > MAX_OBJECT_KEYS) {
      throw new ZoneCallbackValidationError('JSON object exceeds limit');
    }
    for (const [key, value] of entries) {
      if (
        key.length === 0 ||
        byteLength(key) > 128 ||
        key === '__proto__' ||
        key === 'constructor' ||
        key === 'prototype'
      ) {
        throw new ZoneCallbackValidationError('Invalid JSON key');
      }
      stack.push({ value, depth: current.depth + 1 });
    }
  }
}

@Injectable()
export class WeworkSpecCallbackService {
  private readonly logger = new Logger(WeworkSpecCallbackService.name);
  private readonly corpId: string;
  private readonly agentId: string;
  private readonly abilityId: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly weixinSyncService: WeixinKnowledgeSyncService,
    private readonly aiService: AiService,
    private readonly replayStore: CallbackReplayStore,
  ) {
    this.corpId = this.configService.get('WORK_WEIXIN_CORP_ID', '');
    this.agentId = this.configService.get('WORK_WEIXIN_AGENT_ID', '');
    this.abilityId = this.configService.get('WORK_WEIXIN_ABILITY_ID', '');
  }

  async handleWeworkCallForward(
    input: unknown,
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    let forwardData: WeworkCallForwardData;
    let callbackData: CallbackData;
    try {
      forwardData = this.parseForwardEnvelope(input);
      callbackData = this.parseCallbackData(forwardData.data);
    } catch {
      this.logger.warn('Rejected malformed zone callback');
      return { success: false, error: '数据格式错误' };
    }

    const identity = [
      forwardData.corpid,
      forwardData.ability_id,
      forwardData.notify_id,
    ].join('\0');
    if (!await this.replayStore.claim('zone', identity)) {
      this.logger.log('Ignored duplicate zone callback');
      return { success: true, message: 'ok' };
    }

    try {
      await this.dispatchEvent(callbackData, forwardData);
      return { success: true, message: 'ok' };
    } catch {
      this.logger.error('Zone callback processing failed');
      return { success: false, error: '处理失败' };
    }
  }

  async handleAiQuery(
    input: unknown,
  ): Promise<{ errcode: number; errmsg: string; reply?: string }> {
    let request: AiQueryRequest;
    try {
      request = this.parseAiQuery(input);
    } catch {
      this.logger.warn('Rejected malformed zone AI query');
      return { errcode: -1, errmsg: '请求格式错误' };
    }

    const userId =
      request.func_req.userId || request.func_req.userid || 'spec_user';
    const userName =
      request.func_req.userName || request.func_req.username || userId;
    const query = request.func_req.query || request.func_req.content || '';
    if (query.trim().length === 0) {
      return { errcode: -1, errmsg: '缺少 query 参数' };
    }

    try {
      const reply = await this.aiService.processQuery({
        userId,
        userName,
        query,
      });
      if (reply === null) {
        return { errcode: 0, errmsg: 'ok', reply: '用户已被人工接管' };
      }
      return { errcode: 0, errmsg: 'ok', reply };
    } catch {
      this.logger.error('Zone AI query failed');
      return { errcode: -1, errmsg: '处理失败' };
    }
  }

  private parseForwardEnvelope(input: unknown): WeworkCallForwardData {
    const value = requireObject(input);
    requireExactKeys(value, [
      'corpid',
      'agentid',
      'ability_id',
      'notify_id',
      'req_id',
      'data',
    ]);

    const forwardData: WeworkCallForwardData = {
      corpid: requireText(value, 'corpid', 128),
      agentid: requireAgentId(value.agentid),
      ability_id: requireText(value, 'ability_id', 128),
      notify_id: requireText(value, 'notify_id', 256),
      req_id: requireText(value, 'req_id', 256),
      data: requireText(value, 'data', MAX_DATA_BYTES),
    };
    this.validateRouting(
      forwardData.corpid,
      forwardData.agentid,
      forwardData.ability_id,
    );
    return forwardData;
  }

  private parseCallbackData(data: string): CallbackData {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new ZoneCallbackValidationError('Invalid callback JSON');
    }
    assertBoundedJson(parsed);
    const value = requireObject(parsed);
    const eventType = requireText(value, 'event_type', 64);
    if (!/^[a-z0-9_]{1,64}$/.test(eventType)) {
      throw new ZoneCallbackValidationError('Invalid event type');
    }
    if (!isFreshTimestamp(value.timestamp as number)) {
      throw new ZoneCallbackValidationError('Stale callback');
    }

    if (eventType === 'conversation_new_message') {
      const detail = requireObject(value.conversation_new_message);
      requireText(detail, 'token', 8192);
    }
    return value as CallbackData;
  }

  private parseAiQuery(input: unknown): AiQueryRequest {
    assertBoundedJson(input);
    const value = requireObject(input);
    requireExactKeys(value, ['corpid', 'agentid', 'ability_id', 'func_req']);

    const corpid = requireText(value, 'corpid', 128);
    const agentid = requireAgentId(value.agentid);
    const abilityId = requireText(value, 'ability_id', 128);
    this.validateRouting(corpid, agentid, abilityId);

    const funcReq = requireObject(value.func_req);
    const userId = optionalText(funcReq, ['userId', 'userid'], 128);
    const userName = optionalText(funcReq, ['userName', 'username'], 256);
    const query = optionalText(funcReq, ['query', 'content'], MAX_QUERY_BYTES);
    return {
      corpid,
      agentid,
      ability_id: abilityId,
      func_req: {
        ...funcReq,
        ...(userId === undefined ? {} : { userId }),
        ...(userName === undefined ? {} : { userName }),
        ...(query === undefined ? {} : { query }),
      },
    };
  }

  private validateRouting(
    corpid: string,
    agentid: number,
    abilityId: string,
  ): void {
    if (!constantTimeEqual(corpid, this.corpId)) {
      throw new ZoneCallbackValidationError('CorpID mismatch');
    }
    const configuredAgentId = Number(this.agentId);
    if (
      Number.isSafeInteger(configuredAgentId) &&
      configuredAgentId > 0 &&
      configuredAgentId !== agentid
    ) {
      throw new ZoneCallbackValidationError('AgentID mismatch');
    }
    if (this.abilityId && !constantTimeEqual(abilityId, this.abilityId)) {
      throw new ZoneCallbackValidationError('Ability ID mismatch');
    }
  }

  private async dispatchEvent(
    data: CallbackData,
    forwardData: WeworkCallForwardData,
  ): Promise<void> {
    switch (data.event_type) {
      case 'conversation_new_message':
        await this.handleConversationNewMessage(data, forwardData);
        break;
      case 'chat_archive_audit_approved_single':
      case 'hit_keyword':
      case 'auth_knowledge_base':
      case 'unauth_knowledge_base':
      case 'delete_knowledge_base':
      case 'chat_archive_export_finished':
        this.logger.log(`Processed zone event type ${data.event_type}`);
        break;
      default:
        this.logger.warn(`Ignored unsupported zone event type ${data.event_type}`);
    }
  }

  private async handleConversationNewMessage(
    data: CallbackData,
    forwardData: WeworkCallForwardData,
  ): Promise<void> {
    await this.weixinSyncService.ingestChatRecords([
      {
        msg_id: forwardData.notify_id,
        from: 'wework_callback',
        content: forwardData.data,
        send_time: data.timestamp,
        msg_type: 'spec_callback',
      },
    ]);
    this.logger.log('Submitted zone callback to knowledge sync');
  }
}
