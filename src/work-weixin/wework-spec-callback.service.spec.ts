import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../ai-service/ai.service';
import { WeixinKnowledgeSyncService } from '../knowledge-base/weixin-sync.service';
import { CallbackReplayStore } from './work-weixin.service';
import { WeworkSpecCallbackService } from './wework-spec-callback.service';

const NOW_MS = 1_700_000_000_000;
const CORP_ID = 'ww-test-corp';
const AGENT_ID = 1000002;
const ABILITY_ID = 'ability-1';

function createService() {
  const config = {
    WORK_WEIXIN_CORP_ID: CORP_ID,
    WORK_WEIXIN_AGENT_ID: String(AGENT_ID),
    WORK_WEIXIN_ABILITY_ID: ABILITY_ID,
  };
  const configService = {
    get: jest.fn((key: string, defaultValue?: unknown) =>
      Object.prototype.hasOwnProperty.call(config, key)
        ? config[key]
        : defaultValue,
    ),
  } as unknown as ConfigService;
  const syncService = {
    ingestChatRecords: jest.fn().mockResolvedValue(undefined),
  } as unknown as WeixinKnowledgeSyncService;
  const aiService = {
    processQuery: jest.fn().mockResolvedValue('zone reply'),
  } as unknown as AiService;
  const replayStore = {
    claim: jest.fn().mockResolvedValue(true),
  } as unknown as CallbackReplayStore;

  return {
    service: new WeworkSpecCallbackService(
      configService,
      syncService,
      aiService,
      replayStore,
    ),
    syncService: syncService as unknown as { ingestChatRecords: jest.Mock },
    aiService: aiService as unknown as { processQuery: jest.Mock },
    replayStore: replayStore as unknown as { claim: jest.Mock },
  };
}

function callbackEnvelope(overrides: Record<string, unknown> = {}) {
  const data = JSON.stringify({
    event_type: 'conversation_new_message',
    timestamp: Math.floor(NOW_MS / 1000),
    conversation_new_message: { token: 'decrypted-event-token' },
  });
  return {
    corpid: CORP_ID,
    agentid: AGENT_ID,
    ability_id: ABILITY_ID,
    notify_id: 'notify-1',
    req_id: 'request-1',
    data,
    ...overrides,
  };
}

describe('WeworkSpecCallbackService', () => {
  beforeAll(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('validates and ingests a fresh callback once', async () => {
    const { service, syncService, replayStore } = createService();
    const envelope = callbackEnvelope();

    await expect(service.handleWeworkCallForward(envelope)).resolves.toEqual({
      success: true,
      message: 'ok',
    });
    expect(replayStore.claim).toHaveBeenCalledWith(
      'zone',
      `${CORP_ID}\0${ABILITY_ID}\0notify-1`,
    );
    expect(syncService.ingestChatRecords).toHaveBeenCalledWith([
      expect.objectContaining({
        msg_id: 'notify-1',
        content: envelope.data,
        send_time: Math.floor(NOW_MS / 1000),
      }),
    ]);
  });

  it('acknowledges duplicate notify IDs without a second sync side effect', async () => {
    const { service, syncService, replayStore } = createService();
    replayStore.claim.mockResolvedValue(false);

    await expect(
      service.handleWeworkCallForward(callbackEnvelope()),
    ).resolves.toEqual({ success: true, message: 'ok' });
    expect(syncService.ingestChatRecords).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong CorpID', { corpid: 'ww-other' }],
    ['wrong agent', { agentid: AGENT_ID + 1 }],
    ['wrong ability', { ability_id: 'ability-other' }],
    [
      'stale timestamp',
      {
        data: JSON.stringify({
          event_type: 'conversation_new_message',
          timestamp: Math.floor(NOW_MS / 1000) - 301,
          conversation_new_message: { token: 'token' },
        }),
      },
    ],
    [
      'missing event token',
      {
        data: JSON.stringify({
          event_type: 'conversation_new_message',
          timestamp: Math.floor(NOW_MS / 1000),
        }),
      },
    ],
    ['unknown envelope field', { unexpected: true }],
  ])('rejects %s before replay claim or sync', async (_case, override) => {
    const { service, syncService, replayStore } = createService();

    await expect(
      service.handleWeworkCallForward(callbackEnvelope(override)),
    ).resolves.toEqual({ success: false, error: '数据格式错误' });
    expect(replayStore.claim).not.toHaveBeenCalled();
    expect(syncService.ingestChatRecords).not.toHaveBeenCalled();
  });

  it('bounds and validates internal AI queries before invoking AI', async () => {
    const { service, aiService } = createService();
    const request = {
      corpid: CORP_ID,
      agentid: AGENT_ID,
      ability_id: ABILITY_ID,
      func_req: {
        userid: 'zone-user',
        username: 'Zone User',
        content: 'private zone query',
      },
    };

    await expect(service.handleAiQuery(request)).resolves.toEqual({
      errcode: 0,
      errmsg: 'ok',
      reply: 'zone reply',
    });
    expect(aiService.processQuery).toHaveBeenCalledWith({
      userId: 'zone-user',
      userName: 'Zone User',
      query: 'private zone query',
    });
  });

  it('does not log decrypted payloads, callback tokens, or full queries', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { service } = createService();
    const envelope = callbackEnvelope();

    await service.handleWeworkCallForward(envelope);
    await service.handleAiQuery({
      corpid: CORP_ID,
      agentid: AGENT_ID,
      ability_id: ABILITY_ID,
      func_req: { query: 'private zone query' },
    });
    const output = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .flat()
      .join(' ');

    expect(output).not.toContain(envelope.data);
    expect(output).not.toContain('decrypted-event-token');
    expect(output).not.toContain('private zone query');
  });
});
