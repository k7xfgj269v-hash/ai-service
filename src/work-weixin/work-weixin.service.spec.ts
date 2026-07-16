import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash } from 'crypto';
import axios from 'axios';
import {
  CallbackReplayStore,
  createCallbackRedisOptions,
  WorkWeixinService,
} from './work-weixin.service';
import { AiService } from '../ai-service/ai.service';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;
const NOW_MS = 1_700_000_000_000;
const CORP_ID = 'ww-test-corp';
const TOKEN = 'callback-secret';
const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const AGENT_ID = '1000002';

function signature(timestamp: string, nonce: string, encrypted: string): string {
  return createHash('sha1')
    .update([TOKEN, timestamp, nonce, encrypted].sort().join(''))
    .digest('hex');
}

function encryptEnvelope(
  message: string,
  corpId = CORP_ID,
  invalidPadding = false,
): string {
  const key = Buffer.from(`${AES_KEY}=`, 'base64');
  const messageBytes = Buffer.from(message);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(messageBytes.length);
  const plaintext = Buffer.concat([
    Buffer.alloc(16, 7),
    length,
    messageBytes,
    Buffer.from(corpId),
  ]);
  const paddingLength = 32 - (plaintext.length % 32);
  const padded = Buffer.concat([
    plaintext,
    Buffer.alloc(paddingLength, paddingLength),
  ]);
  if (invalidPadding) padded[padded.length - 1] = 0;

  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

function decryptEnvelope(encrypted: string): string {
  const key = Buffer.from(`${AES_KEY}=`, 'base64');
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final(),
  ]);
  const paddingLength = padded[padded.length - 1];
  const plaintext = padded.subarray(0, padded.length - paddingLength);
  const messageLength = plaintext.readUInt32BE(16);
  return plaintext.subarray(20, 20 + messageLength).toString('utf8');
}

function textMessage(content = 'hello', msgId = '123456789') {
  return `<xml>
<ToUserName><![CDATA[${CORP_ID}]]></ToUserName>
<FromUserName><![CDATA[user-1]]></FromUserName>
<CreateTime>${Math.floor(NOW_MS / 1000)}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
<MsgId>${msgId}</MsgId>
<AgentID>${AGENT_ID}</AgentID>
</xml>`;
}

function createService(overrides: Record<string, unknown> = {}) {
  const config = {
    WORK_WEIXIN_TOKEN: TOKEN,
    WORK_WEIXIN_ENCODING_AES_KEY: AES_KEY,
    WORK_WEIXIN_CORP_ID: CORP_ID,
    WORK_WEIXIN_CORP_SECRET: 'corp-secret',
    WORK_WEIXIN_AGENT_ID: AGENT_ID,
    WORK_WEIXIN_ENABLED: 'false',
    WORK_WEIXIN_HTTP_TIMEOUT_MS: 4321,
    ...overrides,
  };
  const configService = {
    get: jest.fn((key: string, defaultValue?: unknown) =>
      Object.prototype.hasOwnProperty.call(config, key)
        ? config[key]
        : defaultValue,
    ),
  } as unknown as ConfigService;
  const aiService = {
    processQuery: jest.fn().mockResolvedValue('AI reply'),
  } as unknown as AiService;
  const replayStore = {
    claim: jest.fn().mockResolvedValue(true),
  } as unknown as CallbackReplayStore;

  return {
    service: new WorkWeixinService(configService, aiService, replayStore),
    aiService: aiService as unknown as { processQuery: jest.Mock },
    replayStore: replayStore as unknown as { claim: jest.Mock },
  };
}

describe('callback Redis configuration', () => {
  it('uses bounded fail-fast Redis options', () => {
    const options = createCallbackRedisOptions();
    expect(options.lazyConnect).toBe(true);
    expect(options.maxRetriesPerRequest).toBe(1);
    expect(options.enableOfflineQueue).toBe(false);
    expect(options.retryStrategy!(6)).toBeNull();
  });

  it('serializes concurrent duplicate claims before Redis resolves', async () => {
    let resolveSet: (value: string) => void;
    const redis = {
      set: jest.fn(
        () =>
          new Promise<string>(resolve => {
            resolveSet = resolve;
          }),
      ),
    };
    const store = new CallbackReplayStore(redis as any);

    const first = store.claim('normal', 'same-delivery');
    const second = store.claim('normal', 'same-delivery');
    resolveSet!('OK');

    await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
    expect(redis.set).toHaveBeenCalledTimes(1);
  });
});

describe('WorkWeixinService callback security', () => {
  const timestamp = String(Math.floor(NOW_MS / 1000));
  const nonce = 'nonce-123';

  beforeAll(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    mockedAxios.get.mockReset();
    mockedAxios.post.mockReset();
  });

  it('verifies and decrypts a fresh URL challenge', () => {
    const { service } = createService();
    const encrypted = encryptEnvelope('challenge-value');

    expect(
      service.verifyUrl(
        signature(timestamp, nonce, encrypted),
        timestamp,
        nonce,
        encrypted,
      ),
    ).toBe('challenge-value');
  });

  it('rejects stale timestamps and mismatched CorpIDs', () => {
    const { service } = createService();
    const valid = encryptEnvelope('challenge-value');
    const staleTimestamp = String(Number(timestamp) - 301);
    const wrongCorp = encryptEnvelope('challenge-value', 'ww-other-corp');

    expect(
      service.verifyUrl(
        signature(staleTimestamp, nonce, valid),
        staleTimestamp,
        nonce,
        valid,
      ),
    ).toBeNull();
    expect(
      service.verifyUrl(
        signature(timestamp, nonce, wrongCorp),
        timestamp,
        nonce,
        wrongCorp,
      ),
    ).toBeNull();
  });

  it('rejects malformed XML envelopes without attempting callback handling', () => {
    const { service } = createService();

    expect(
      service.parseEncryptedEnvelope(
        '<!DOCTYPE xml [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><xml><Encrypt>&xxe;</Encrypt></xml>',
      ),
    ).toBeNull();
    expect(
      service.parseEncryptedEnvelope(
        '<xml><Encrypt><![CDATA[AAAA]]></Encrypt><Encrypt><![CDATA[AAAA]]></Encrypt></xml>',
      ),
    ).toBeNull();
  });

  it('validates signatures, padding, and message XML before AI', async () => {
    const { service, aiService, replayStore } = createService();
    const valid = encryptEnvelope(textMessage());
    const invalidPadding = encryptEnvelope(textMessage(), CORP_ID, true);
    const malformedXml = encryptEnvelope(
      textMessage().replace(
        '</xml>',
        '<FromUserName><![CDATA[user-2]]></FromUserName></xml>',
      ),
    );

    await expect(
      service.handleMessage(
        '0'.repeat(40),
        timestamp,
        nonce,
        valid,
      ),
    ).resolves.toBeNull();
    await expect(
      service.handleMessage(
        signature(timestamp, nonce, invalidPadding),
        timestamp,
        nonce,
        invalidPadding,
      ),
    ).resolves.toBeNull();
    await expect(
      service.handleMessage(
        signature(timestamp, nonce, malformedXml),
        timestamp,
        nonce,
        malformedXml,
      ),
    ).resolves.toBeNull();
    expect(replayStore.claim).not.toHaveBeenCalled();
    expect(aiService.processQuery).not.toHaveBeenCalled();
  });

  it('processes a valid text callback and safely splits CDATA terminators', async () => {
    const { service, aiService } = createService();
    aiService.processQuery.mockResolvedValue('reply ]]> still safe');
    const encrypted = encryptEnvelope(textMessage());

    const response = await service.handleMessage(
      signature(timestamp, nonce, encrypted),
      timestamp,
      nonce,
      encrypted,
    );

    expect(response).not.toBeNull();
    const encryptedReply = response!.match(
      /<Encrypt><!\[CDATA\[([A-Za-z0-9+/=]+)]]><\/Encrypt>/,
    )![1];
    const replyXml = decryptEnvelope(encryptedReply);
    expect(replyXml).toContain(
      '<Content><![CDATA[reply ]]]]><![CDATA[> still safe]]></Content>',
    );
    expect(aiService.processQuery).toHaveBeenCalledTimes(1);
  });

  it('acknowledges duplicate callbacks with only one AI side effect', async () => {
    const { service, aiService, replayStore } = createService();
    replayStore.claim
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const encrypted = encryptEnvelope(textMessage());
    const msgSignature = signature(timestamp, nonce, encrypted);

    await service.handleMessage(msgSignature, timestamp, nonce, encrypted);
    await expect(
      service.handleMessage(msgSignature, timestamp, nonce, encrypted),
    ).resolves.toBe('');
    expect(aiService.processQuery).toHaveBeenCalledTimes(1);
  });

  it('single-flights token refreshes and applies the bounded HTTP timeout', async () => {
    const { service } = createService();
    let resolveRequest: (value: unknown) => void;
    mockedAxios.get.mockReturnValue(
      new Promise(resolve => {
        resolveRequest = resolve;
      }) as any,
    );

    const first = service.refreshAccessToken();
    const second = service.refreshAccessToken();
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(mockedAxios.get.mock.calls[0][1]).toMatchObject({ timeout: 4321 });

    resolveRequest!({
      data: {
        errcode: 0,
        errmsg: 'ok',
        access_token: 'access-token',
        expires_in: 7200,
      },
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      'access-token',
      'access-token',
    ]);
  });

  it('does not log secrets, signatures, ciphertext, or full replies', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { service, aiService } = createService();
    const encrypted = encryptEnvelope(textMessage('private message'));
    const msgSignature = signature(timestamp, nonce, encrypted);
    aiService.processQuery.mockResolvedValue('private reply');

    await service.handleMessage(
      msgSignature,
      timestamp,
      nonce,
      encrypted,
    );
    const output = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .flat()
      .join(' ');

    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(msgSignature);
    expect(output).not.toContain(encrypted);
    expect(output).not.toContain('private message');
    expect(output).not.toContain('private reply');
  });
});
