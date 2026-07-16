import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TextDecoder } from 'util';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import axios from 'axios';
import Redis, { RedisOptions } from 'ioredis';
import { AiService } from '../ai-service/ai.service';
import { constantTimeEqual } from '../common/security/api-key.guard';

export const CALLBACK_REDIS = Symbol('CALLBACK_REDIS');

const MAX_RECONNECT_ATTEMPTS = 5;
const MAX_CALLBACK_SKEW_SECONDS = 5 * 60;
const CALLBACK_REPLAY_TTL_SECONDS = 24 * 60 * 60;
const MAX_LOCAL_REPLAY_KEYS = 10_000;
const MAX_ENVELOPE_BYTES = 128 * 1024;
const MAX_DECRYPTED_BYTES = 64 * 1024;
const MAX_XML_FIELDS = 64;
const MAX_FIELD_BYTES = 64 * 1024;
const MAX_REPLY_BYTES = 64 * 1024;

interface AccessTokenResponse {
  errcode: number;
  errmsg: string;
  access_token?: string;
  expires_in?: number;
}

interface SendMessageResponse {
  errcode: number;
  errmsg: string;
}

interface WeixinMessage {
  ToUserName: string;
  FromUserName: string;
  CreateTime: number;
  MsgType: string;
  Content?: string;
  MsgId?: string;
  AgentID?: number;
  Event?: string;
  EventKey?: string;
  SessionId?: string;
}

class CallbackValidationError extends Error {}

export function createCallbackRedisOptions(): RedisOptions {
  return {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1000,
    enableOfflineQueue: false,
    retryStrategy: attempt => {
      if (attempt > MAX_RECONNECT_ATTEMPTS) return null;
      return Math.min(100 * 2 ** (attempt - 1), 1000);
    },
  };
}

@Injectable()
export class CallbackReplayStore {
  private readonly logger = new Logger(CallbackReplayStore.name);
  private readonly localClaims = new Map<string, number>();
  private redisUnavailableLogged = false;

  constructor(@Inject(CALLBACK_REDIS) private readonly redis: Redis) {}

  async claim(namespace: string, identity: string): Promise<boolean> {
    const digest = createHash('sha256').update(identity).digest('hex');
    const key = `weixin:callback:${namespace}:${digest}`;
    const now = Date.now();
    const localExpiry = this.localClaims.get(key);

    if (localExpiry && localExpiry > now) return false;

    this.pruneLocalClaims(now);
    this.localClaims.set(key, now + CALLBACK_REPLAY_TTL_SECONDS * 1000);

    try {
      const result = await this.redis.set(
        key,
        '1',
        'EX',
        CALLBACK_REPLAY_TTL_SECONDS,
        'NX',
      );
      this.redisUnavailableLogged = false;
      return result === 'OK';
    } catch {
      if (!this.redisUnavailableLogged) {
        this.logger.warn('Callback replay Redis unavailable; using local protection');
        this.redisUnavailableLogged = true;
      }
      return true;
    }
  }

  private pruneLocalClaims(now: number): void {
    for (const [key, expiry] of this.localClaims) {
      if (expiry <= now) this.localClaims.delete(key);
    }
    while (this.localClaims.size >= MAX_LOCAL_REPLAY_KEYS) {
      const oldest = this.localClaims.keys().next().value;
      if (oldest === undefined) break;
      this.localClaims.delete(oldest);
    }
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function requireBoundedText(
  fields: Map<string, string>,
  name: string,
  maxBytes: number,
  allowEmpty = false,
): string {
  const value = fields.get(name);
  if (
    value === undefined ||
    (!allowEmpty && value.length === 0) ||
    byteLength(value) > maxBytes ||
    value.includes('\0')
  ) {
    throw new CallbackValidationError(`Invalid XML field: ${name}`);
  }
  return value;
}

function optionalBoundedText(
  fields: Map<string, string>,
  name: string,
  maxBytes: number,
): string | undefined {
  if (!fields.has(name)) return undefined;
  return requireBoundedText(fields, name, maxBytes, true);
}

function parseSafeInteger(value: string, name: string): number {
  if (!/^(0|[1-9]\d{0,15})$/.test(value)) {
    throw new CallbackValidationError(`Invalid numeric field: ${name}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CallbackValidationError(`Invalid numeric field: ${name}`);
  }
  return parsed;
}

function parseFlatXml(xml: string, maxBytes: number): Map<string, string> {
  if (
    typeof xml !== 'string' ||
    xml.length === 0 ||
    byteLength(xml) > maxBytes ||
    /<!DOCTYPE|<!ENTITY|<!--|<\?(?!xml\b)/i.test(xml)
  ) {
    throw new CallbackValidationError('Invalid XML envelope');
  }

  let input = xml.trim();
  const declaration = input.match(/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-8"|'UTF-8'))?\s*\?>/i);
  if (declaration) input = input.slice(declaration[0].length).trimStart();
  if (!input.startsWith('<xml>') || !input.endsWith('</xml>')) {
    throw new CallbackValidationError('Invalid XML root');
  }

  const body = input.slice(5, -6);
  const fields = new Map<string, string>();
  let position = 0;

  while (position < body.length) {
    while (position < body.length && /\s/.test(body[position])) position++;
    if (position >= body.length) break;
    if (fields.size >= MAX_XML_FIELDS) {
      throw new CallbackValidationError('Too many XML fields');
    }

    const opening = body.slice(position).match(/^<([A-Za-z_][A-Za-z0-9_-]{0,63})>/);
    if (!opening) throw new CallbackValidationError('Invalid XML child');

    const name = opening[1];
    if (fields.has(name)) throw new CallbackValidationError('Duplicate XML field');
    const contentStart = position + opening[0].length;
    const closing = `</${name}>`;
    let content: string;
    let nextPosition: number;

    if (body.startsWith('<![CDATA[', contentStart)) {
      const cdataEnd = body.indexOf(']]>', contentStart + 9);
      if (cdataEnd < 0 || !body.startsWith(closing, cdataEnd + 3)) {
        throw new CallbackValidationError('Invalid CDATA field');
      }
      content = body.slice(contentStart + 9, cdataEnd);
      nextPosition = cdataEnd + 3 + closing.length;
    } else {
      const closingIndex = body.indexOf(closing, contentStart);
      if (closingIndex < 0) throw new CallbackValidationError('Unclosed XML field');
      const raw = body.slice(contentStart, closingIndex);
      if (/[<&]/.test(raw)) throw new CallbackValidationError('Nested XML is not allowed');
      content = raw.trim();
      nextPosition = closingIndex + closing.length;
    }

    if (byteLength(content) > MAX_FIELD_BYTES || content.includes('\0')) {
      throw new CallbackValidationError('XML field exceeds limit');
    }
    fields.set(name, content);
    position = nextPosition;
  }

  if (fields.size === 0) throw new CallbackValidationError('Empty XML envelope');
  return fields;
}

function xmlCdata(value: string): string {
  if (byteLength(value) > MAX_REPLY_BYTES) {
    throw new CallbackValidationError('Reply exceeds XML limit');
  }
  let normalized = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    ) {
      normalized += character;
    }
  }
  return `<![CDATA[${normalized.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function isFreshTimestamp(timestamp: string): boolean {
  if (!/^(0|[1-9]\d{8,10})$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - seconds) <= MAX_CALLBACK_SKEW_SECONDS;
}

function isValidNonce(nonce: string): boolean {
  return typeof nonce === 'string' && /^[\x21-\x7e]{1,128}$/.test(nonce);
}

function isCanonicalBase64(value: string): boolean {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ENVELOPE_BYTES ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

@Injectable()
export class WorkWeixinService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkWeixinService.name);
  private readonly corpId: string;
  private readonly corpSecret: string;
  private readonly agentId: string;
  private readonly token: string;
  private readonly encodingAESKey: string;
  private readonly httpTimeoutMs: number;
  private accessToken: string | null = null;
  private tokenExpireTime = 0;
  private tokenRefreshInterval: NodeJS.Timeout | null = null;
  private tokenRefreshPromise: Promise<string | null> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly aiService: AiService,
    private readonly replayStore: CallbackReplayStore,
  ) {
    this.corpId = this.configService.get('WORK_WEIXIN_CORP_ID', '');
    this.corpSecret = this.configService.get('WORK_WEIXIN_CORP_SECRET', '');
    this.agentId = this.configService.get('WORK_WEIXIN_AGENT_ID', '');
    this.token = this.configService.get('WORK_WEIXIN_TOKEN', '');
    this.encodingAESKey = this.configService.get('WORK_WEIXIN_ENCODING_AES_KEY', '');
    const configuredTimeout = Number(
      this.configService.get('WORK_WEIXIN_HTTP_TIMEOUT_MS', 5000),
    );
    this.httpTimeoutMs = Number.isFinite(configuredTimeout)
      ? Math.min(Math.max(configuredTimeout, 1000), 30_000)
      : 5000;
  }

  async onModuleInit(): Promise<void> {
    const enabled = this.configService.get('WORK_WEIXIN_ENABLED');
    if (enabled === 'true' || enabled === true) {
      await this.initialize();
    } else {
      this.logger.log('Work Weixin service disabled');
    }
  }

  onModuleDestroy(): void {
    if (this.tokenRefreshInterval) {
      clearInterval(this.tokenRefreshInterval);
      this.tokenRefreshInterval = null;
    }
  }

  async refreshAccessToken(): Promise<string | null> {
    if (this.tokenRefreshPromise) return this.tokenRefreshPromise;

    const refresh = this.requestAccessToken();
    this.tokenRefreshPromise = refresh;
    try {
      return await refresh;
    } finally {
      if (this.tokenRefreshPromise === refresh) this.tokenRefreshPromise = null;
    }
  }

  async getAccessToken(): Promise<string | null> {
    if (!this.accessToken || Date.now() >= this.tokenExpireTime - 5 * 60 * 1000) {
      await this.refreshAccessToken();
    }
    return this.accessToken && Date.now() < this.tokenExpireTime
      ? this.accessToken
      : null;
  }

  verifyUrl(
    msgSignature: string,
    timestamp: string,
    nonce: string,
    echostr: string,
  ): string | null {
    if (!this.verifyProtocolSignature(msgSignature, timestamp, nonce, echostr)) {
      this.logger.warn('Rejected Work Weixin URL verification');
      return null;
    }

    try {
      const result = this.decryptEnvelope(echostr);
      if (result.length === 0 || byteLength(result) > 4096) return null;
      return result;
    } catch {
      this.logger.warn('Rejected Work Weixin URL verification');
      return null;
    }
  }

  parseEncryptedEnvelope(xml: string): string | null {
    try {
      const fields = parseFlatXml(xml, MAX_ENVELOPE_BYTES);
      const encrypted = requireBoundedText(fields, 'Encrypt', MAX_ENVELOPE_BYTES);
      return isCanonicalBase64(encrypted) ? encrypted : null;
    } catch {
      return null;
    }
  }

  async handleMessage(
    msgSignature: string,
    timestamp: string,
    nonce: string,
    encryptedMsg: string,
  ): Promise<string | null> {
    if (
      !this.verifyProtocolSignature(
        msgSignature,
        timestamp,
        nonce,
        encryptedMsg,
      )
    ) {
      this.logger.warn('Rejected Work Weixin callback');
      return null;
    }

    let message: WeixinMessage;
    let decryptedXml: string;
    try {
      decryptedXml = this.decryptEnvelope(encryptedMsg);
      message = this.parseXmlMessage(decryptedXml);
      if (!constantTimeEqual(message.ToUserName, this.corpId)) {
        throw new CallbackValidationError('CorpID mismatch');
      }
      const configuredAgentId = Number(this.agentId);
      if (
        message.AgentID !== undefined &&
        Number.isSafeInteger(configuredAgentId) &&
        configuredAgentId > 0 &&
        message.AgentID !== configuredAgentId
      ) {
        throw new CallbackValidationError('AgentID mismatch');
      }
    } catch {
      this.logger.warn('Rejected Work Weixin callback');
      return null;
    }

    const deliveryId = message.MsgId
      ? `message:${message.MsgId}`
      : `payload:${createHash('sha256').update(decryptedXml).digest('hex')}`;
    if (!await this.replayStore.claim('normal', `${this.corpId}\0${deliveryId}`)) {
      this.logger.log('Ignored duplicate Work Weixin callback');
      return '';
    }

    if (message.MsgType === 'text') {
      return this.handleTextMessage(message, timestamp, nonce);
    }
    if (message.MsgType === 'event') {
      await this.handleEventMessage(message);
    }
    return '';
  }

  async handlePlaintextTestCallback(xml: string): Promise<string | null> {
    try {
      const message = this.parseXmlMessage(xml);
      if (
        message.MsgType !== 'text' ||
        !message.Content ||
        !constantTimeEqual(message.ToUserName, this.corpId)
      ) {
        return null;
      }
      const reply = await this.handleTestMessage(
        message.FromUserName,
        message.Content,
      );
      return reply === null ? '' : this.buildTextReplyXml(message, reply);
    } catch {
      return null;
    }
  }

  async handleTestMessage(
    userId: string,
    content: string,
  ): Promise<string | null> {
    try {
      const reply = await this.aiService.processQuery({
        userId,
        userName: userId,
        query: content,
      });
      return reply === null ? null : reply;
    } catch {
      this.logger.error('Work Weixin test message processing failed');
      return null;
    }
  }

  async sendTextMessage(userId: string, content: string): Promise<boolean> {
    try {
      const token = await this.getAccessToken();
      if (!token) return false;

      const response = await axios.post<SendMessageResponse>(
        'https://qyapi.weixin.qq.com/cgi-bin/message/send',
        {
          touser: userId,
          msgtype: 'text',
          agentid: Number(this.agentId),
          text: { content },
          safe: 0,
        },
        {
          params: { access_token: token },
          timeout: this.httpTimeoutMs,
        },
      );

      if (response.data.errcode !== 0) {
        this.logger.error(`Work Weixin send failed with code ${response.data.errcode}`);
        return false;
      }
      return true;
    } catch {
      this.logger.error('Work Weixin send request failed');
      return false;
    }
  }

  getStatus() {
    return {
      corpId: this.corpId,
      agentId: this.agentId,
      hasAccessToken: !!this.accessToken,
      tokenExpireTime: this.tokenExpireTime,
      isTokenValid: !!this.accessToken && Date.now() < this.tokenExpireTime,
    };
  }

  private async initialize(): Promise<void> {
    if (!this.corpId || !this.corpSecret || !this.agentId) {
      this.logger.error('Work Weixin configuration is incomplete');
      return;
    }

    await this.refreshAccessToken();
    this.tokenRefreshInterval = setInterval(() => {
      void this.refreshAccessToken();
    }, 100 * 60 * 1000);
  }

  private async requestAccessToken(): Promise<string | null> {
    if (!this.corpId || !this.corpSecret) return null;

    try {
      const response = await axios.get<AccessTokenResponse>(
        'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
        {
          params: {
            corpid: this.corpId,
            corpsecret: this.corpSecret,
          },
          timeout: this.httpTimeoutMs,
        },
      );

      const expiresIn = Number(response.data.expires_in ?? 7200);
      if (
        response.data.errcode !== 0 ||
        !response.data.access_token ||
        !Number.isFinite(expiresIn) ||
        expiresIn <= 0 ||
        expiresIn > 86_400
      ) {
        this.logger.error(
          `Work Weixin token refresh failed with code ${response.data.errcode}`,
        );
        return null;
      }

      this.accessToken = response.data.access_token;
      this.tokenExpireTime = Date.now() + expiresIn * 1000;
      return this.accessToken;
    } catch {
      this.logger.error('Work Weixin token request failed');
      return null;
    }
  }

  private verifyProtocolSignature(
    msgSignature: string,
    timestamp: string,
    nonce: string,
    encrypted: string,
  ): boolean {
    if (
      !this.token ||
      !/^[a-f0-9]{40}$/.test(msgSignature) ||
      !isFreshTimestamp(timestamp) ||
      !isValidNonce(nonce) ||
      !isCanonicalBase64(encrypted)
    ) {
      return false;
    }
    const expected = this.generateSignature(
      this.token,
      timestamp,
      nonce,
      encrypted,
    );
    return constantTimeEqual(msgSignature, expected);
  }

  private generateSignature(
    token: string,
    timestamp: string,
    nonce: string,
    encrypted: string,
  ): string {
    return createHash('sha1')
      .update([token, timestamp, nonce, encrypted].sort().join(''))
      .digest('hex');
  }

  private getAesKey(): Buffer {
    if (
      !/^[A-Za-z0-9+/]{43}$/.test(this.encodingAESKey) ||
      this.encodingAESKey.length !== 43
    ) {
      throw new CallbackValidationError('Invalid AES key');
    }
    const key = Buffer.from(`${this.encodingAESKey}=`, 'base64');
    if (key.length !== 32) throw new CallbackValidationError('Invalid AES key');
    return key;
  }

  private decryptEnvelope(encryptedMsg: string): string {
    if (!isCanonicalBase64(encryptedMsg)) {
      throw new CallbackValidationError('Invalid ciphertext');
    }

    const aesKey = this.getAesKey();
    const encrypted = Buffer.from(encryptedMsg, 'base64');
    if (encrypted.length === 0 || encrypted.length % 16 !== 0) {
      throw new CallbackValidationError('Invalid ciphertext');
    }

    const decipher = createDecipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
    decipher.setAutoPadding(false);
    const padded = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    if (padded.length < 32) throw new CallbackValidationError('Invalid plaintext');

    const paddingLength = padded[padded.length - 1];
    if (paddingLength < 1 || paddingLength > 32 || paddingLength > padded.length) {
      throw new CallbackValidationError('Invalid padding');
    }
    for (let index = padded.length - paddingLength; index < padded.length; index++) {
      if (padded[index] !== paddingLength) {
        throw new CallbackValidationError('Invalid padding');
      }
    }

    const plaintext = padded.subarray(0, padded.length - paddingLength);
    if (plaintext.length < 20) throw new CallbackValidationError('Invalid plaintext');
    const messageLength = plaintext.readUInt32BE(16);
    if (messageLength === 0 || messageLength > MAX_DECRYPTED_BYTES) {
      throw new CallbackValidationError('Invalid message length');
    }

    const messageStart = 20;
    const messageEnd = messageStart + messageLength;
    const corpBytes = plaintext.subarray(messageEnd);
    if (messageEnd > plaintext.length || corpBytes.length === 0) {
      throw new CallbackValidationError('Invalid message bounds');
    }

    let corpId: string;
    let message: string;
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      message = decoder.decode(plaintext.subarray(messageStart, messageEnd));
      corpId = decoder.decode(corpBytes);
    } catch {
      throw new CallbackValidationError('Invalid UTF-8');
    }
    if (!constantTimeEqual(corpId, this.corpId)) {
      throw new CallbackValidationError('CorpID mismatch');
    }
    return message;
  }

  private encrypt(text: string): string {
    if (byteLength(text) > MAX_DECRYPTED_BYTES) {
      throw new CallbackValidationError('Reply exceeds encryption limit');
    }

    const aesKey = this.getAesKey();
    const message = Buffer.from(text, 'utf8');
    const messageLength = Buffer.alloc(4);
    messageLength.writeUInt32BE(message.length, 0);
    const plaintext = Buffer.concat([
      randomBytes(16),
      messageLength,
      message,
      Buffer.from(this.corpId, 'utf8'),
    ]);
    const paddingLength = 32 - (plaintext.length % 32);
    const padded = Buffer.concat([
      plaintext,
      Buffer.alloc(paddingLength, paddingLength),
    ]);
    const cipher = createCipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
  }

  private parseXmlMessage(xml: string): WeixinMessage {
    const fields = parseFlatXml(xml, MAX_DECRYPTED_BYTES);
    const message: WeixinMessage = {
      ToUserName: requireBoundedText(fields, 'ToUserName', 128),
      FromUserName: requireBoundedText(fields, 'FromUserName', 128),
      CreateTime: parseSafeInteger(
        requireBoundedText(fields, 'CreateTime', 16),
        'CreateTime',
      ),
      MsgType: requireBoundedText(fields, 'MsgType', 32),
    };

    if (!/^[a-z0-9_]{1,32}$/.test(message.MsgType)) {
      throw new CallbackValidationError('Invalid message type');
    }

    const content = optionalBoundedText(fields, 'Content', 32 * 1024);
    const msgId = optionalBoundedText(fields, 'MsgId', 32);
    const agentId = optionalBoundedText(fields, 'AgentID', 16);
    const event = optionalBoundedText(fields, 'Event', 64);

    if (msgId !== undefined && !/^(0|[1-9]\d{0,31})$/.test(msgId)) {
      throw new CallbackValidationError('Invalid message ID');
    }
    if (message.MsgType === 'text' && (!content || content.trim().length === 0)) {
      throw new CallbackValidationError('Missing text content');
    }
    if (message.MsgType === 'event' && !event) {
      throw new CallbackValidationError('Missing event type');
    }

    message.Content = content;
    message.MsgId = msgId;
    message.AgentID = agentId === undefined
      ? undefined
      : parseSafeInteger(agentId, 'AgentID');
    message.Event = event;
    message.EventKey = optionalBoundedText(fields, 'EventKey', 1024);
    message.SessionId = optionalBoundedText(fields, 'SessionId', 256);
    return message;
  }

  private async handleTextMessage(
    message: WeixinMessage,
    timestamp: string,
    nonce: string,
  ): Promise<string> {
    try {
      const reply = await this.aiService.processQuery({
        userId: message.FromUserName,
        userName: message.FromUserName,
        query: message.Content!,
      });
      if (reply === null) return '';

      const encrypted = this.encrypt(this.buildTextReplyXml(message, reply));
      const signature = this.generateSignature(
        this.token,
        timestamp,
        nonce,
        encrypted,
      );
      return this.buildEncryptedReplyXml(
        encrypted,
        signature,
        timestamp,
        nonce,
      );
    } catch {
      this.logger.error('Work Weixin AI callback processing failed');
      return '';
    }
  }

  private buildTextReplyXml(message: WeixinMessage, content: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    return `<xml>
<ToUserName>${xmlCdata(message.FromUserName)}</ToUserName>
<FromUserName>${xmlCdata(message.ToUserName)}</FromUserName>
<CreateTime>${timestamp}</CreateTime>
<MsgType>${xmlCdata('text')}</MsgType>
<Content>${xmlCdata(content)}</Content>
</xml>`;
  }

  private buildEncryptedReplyXml(
    encrypted: string,
    signature: string,
    timestamp: string,
    nonce: string,
  ): string {
    return `<xml>
<Encrypt>${xmlCdata(encrypted)}</Encrypt>
<MsgSignature>${xmlCdata(signature)}</MsgSignature>
<TimeStamp>${timestamp}</TimeStamp>
<Nonce>${xmlCdata(nonce)}</Nonce>
</xml>`;
  }

  private async handleEventMessage(message: WeixinMessage): Promise<void> {
    switch (message.Event) {
      case 'enter_session':
      case 'session_create':
        await this.sendTextMessage(
          message.FromUserName,
          '您好！我是AI客服助手，很高兴为您服务。请问有什么可以帮助您的吗？',
        );
        break;
      default:
        break;
    }
  }
}
