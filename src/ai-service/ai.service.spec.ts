import { AiService } from './ai.service';
import { createConversationRedisOptions } from './ai.module';
import { ExpertGenerationService } from '../generation/expert-generation.service';
import { KnowledgeBaseService } from '../knowledge-base/knowledge-base.service';

type StoredMessage = {
  type: 'human' | 'ai';
  content: string;
};

function createRedis(initialHistory?: string) {
  const store = new Map<string, string>();
  const locks = new Map<string, { token: string; expiresAt: number }>();
  if (initialHistory !== undefined) {
    store.set('chat:user-1', initialHistory);
  }

  let contentionSignaled = false;
  let signalContention: () => void;
  const waitForContention = new Promise<void>(resolve => {
    signalContention = resolve;
  });

  const activeLock = (key: string) => {
    const lock = locks.get(key);
    if (lock && lock.expiresAt <= Date.now()) {
      locks.delete(key);
      return undefined;
    }
    return lock;
  };

  const createClient = () => ({
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(
      async (
        key: string,
        token: string,
        mode: string,
        ttl: number,
        condition: string,
      ) => {
        if (mode !== 'PX' || condition !== 'NX') {
          throw new Error('unexpected Redis SET arguments');
        }
        if (activeLock(key)) {
          if (!contentionSignaled) {
            contentionSignaled = true;
            signalContention();
          }
          return null;
        }
        locks.set(key, { token, expiresAt: Date.now() + ttl });
        return 'OK';
      },
    ),
    eval: jest.fn(
      async (
        script: string,
        _keyCount: number,
        key: string,
        token: string,
        ttl?: string,
      ) => {
        const lock = activeLock(key);
        if (!lock || lock.token !== token) return 0;
        if (script.includes('pexpire')) {
          lock.expiresAt = Date.now() + Number(ttl);
          return 1;
        }
        if (script.includes('del')) {
          locks.delete(key);
          return 1;
        }
        return 0;
      },
    ),
    setex: jest.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => {
      const existed = store.delete(key);
      return existed ? 1 : 0;
    }),
  });

  const client = createClient();
  return {
    store,
    locks,
    client,
    createClient,
    waitForContention,
  };
}

function createKnowledgeBase() {
  return {
    vectorStore: null,
    db: {
      prepare: jest.fn(),
    },
  };
}

function createExpert() {
  return {
    isAvailable: jest.fn<boolean, []>(() => true),
    generate: jest.fn<Promise<string>, [string]>(async (_prompt: string) => 'expert reply'),
  };
}

function query(text: string, userId = 'user-1') {
  return {
    userId,
    userName: 'Test User',
    query: text,
  };
}

describe('Conversation Redis configuration', () => {
  it('retries transient outages with bounded exponential backoff', () => {
    const options = createConversationRedisOptions();
    const retryStrategy = options.retryStrategy;

    expect(options).toEqual(
      expect.objectContaining({
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 1000,
        enableOfflineQueue: false,
      }),
    );
    expect(retryStrategy).toBeDefined();
    expect([1, 2, 3, 4, 5].map(attempt => retryStrategy!(attempt))).toEqual([
      100,
      200,
      400,
      800,
      1000,
    ]);
    expect(retryStrategy!(6)).toBeNull();
  });
});

describe('AiService', () => {
  let redis: ReturnType<typeof createRedis>;
  let knowledgeBase: ReturnType<typeof createKnowledgeBase>;
  let expert: ReturnType<typeof createExpert>;
  let service: AiService;

  beforeEach(() => {
    redis = createRedis();
    knowledgeBase = createKnowledgeBase();
    expert = createExpert();
    service = new AiService(
      knowledgeBase as unknown as KnowledgeBaseService,
      expert as unknown as ExpertGenerationService,
      redis.client as any,
    );
  });

  it('uses the Expert generator exactly once for one answerable query', async () => {
    await expect(service.processQuery(query('How should I recruit locally?'))).resolves.toBe(
      'expert reply',
    );

    expect(expert.generate).toHaveBeenCalledTimes(1);
    expect(expert.generate.mock.calls[0][0]).toContain('How should I recruit locally?');
  });

  it.each(['/normal', '/expert', '进入专家模式', '退出专家模式'])(
    'treats the removed mode command %s as a normal query',
    async modeCommand => {
      await expect(service.processQuery(query(modeCommand))).resolves.toBe('expert reply');

      expect(expert.generate).toHaveBeenCalledTimes(1);
      expect(expert.generate.mock.calls[0][0]).toContain(modeCommand);
      expect(redis.client.setex).toHaveBeenCalledTimes(1);
    },
  );

  it('returns the unavailable response without touching history', async () => {
    expert.isAvailable.mockReturnValue(false);

    await expect(service.processQuery(query('question'))).resolves.toBe(
      '抱歉，AI服务暂时不可用，请稍后再试。',
    );
    expect(expert.generate).not.toHaveBeenCalled();
    expect(redis.client.get).not.toHaveBeenCalled();
    expect(redis.client.setex).not.toHaveBeenCalled();
  });

  it.each(['/clear', '清除上下文', '清除对话'])(
    'clears history for %s without generating an answer',
    async clearCommand => {
      redis.store.set('chat:user-1', 'existing history');

      await expect(service.processQuery(query(` ${clearCommand} `))).resolves.toBe(
        '对话上下文已清除。',
      );
      expect(redis.client.del).toHaveBeenCalledWith('chat:user-1');
      expect(redis.store.has('chat:user-1')).toBe(false);
      expect(expert.generate).not.toHaveBeenCalled();
      expect(redis.client.get).not.toHaveBeenCalled();
    },
  );

  it('degrades Redis read and write failures without losing the generated answer', async () => {
    redis.client.set.mockRejectedValue(new Error('redis unavailable'));
    redis.client.get.mockRejectedValue(new Error('redis unavailable'));
    redis.client.setex.mockRejectedValue(new Error('redis unavailable'));

    await expect(service.processQuery(query('question'))).resolves.toBe('expert reply');
    expect(expert.generate).toHaveBeenCalledTimes(1);
    expect(redis.client.get).toHaveBeenCalledTimes(2);
    expect(redis.client.setex).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed history and persists only the valid new exchange', async () => {
    redis = createRedis('{not-json');
    service = new AiService(
      knowledgeBase as unknown as KnowledgeBaseService,
      expert as unknown as ExpertGenerationService,
      redis.client as any,
    );

    await expect(service.processQuery(query('new question'))).resolves.toBe('expert reply');

    expect(expert.generate.mock.calls[0][0]).toContain('无历史对话');
    const persisted = JSON.parse(redis.client.setex.mock.calls[0][2]) as StoredMessage[];
    expect(persisted).toEqual([
      { type: 'human', content: 'new question' },
      { type: 'ai', content: 'expert reply' },
    ]);
  });

  it('truncates persisted history to the latest 20 exchanges', async () => {
    const oldHistory: StoredMessage[] = Array.from({ length: 40 }, (_, index) => ({
      type: index % 2 === 0 ? 'human' : 'ai',
      content: `old-${index}`,
    }));
    redis = createRedis(JSON.stringify(oldHistory));
    service = new AiService(
      knowledgeBase as unknown as KnowledgeBaseService,
      expert as unknown as ExpertGenerationService,
      redis.client as any,
    );

    await service.processQuery(query('latest question'));

    const persisted = JSON.parse(redis.client.setex.mock.calls[0][2]) as StoredMessage[];
    expect(persisted).toHaveLength(40);
    expect(persisted[0]).toEqual({ type: 'human', content: 'old-2' });
    expect(persisted.slice(-2)).toEqual([
      { type: 'human', content: 'latest question' },
      { type: 'ai', content: 'expert reply' },
    ]);
  });

  it('keeps same-user local ordering when Redis is unavailable', async () => {
    redis.client.set.mockRejectedValue(new Error('redis unavailable'));
    let markFirstStarted: () => void;
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve;
    });
    let resolveFirst: (reply: string) => void;

    expert.generate
      .mockImplementationOnce(() => {
        markFirstStarted();
        return new Promise<string>(resolve => {
          resolveFirst = resolve;
        });
      })
      .mockResolvedValueOnce('second reply');

    const first = service.processQuery(query('first question'));
    await firstStarted;
    const second = service.processQuery(query('second question'));
    await Promise.resolve();

    expect(expert.generate).toHaveBeenCalledTimes(1);

    resolveFirst('first reply');
    await expect(first).resolves.toBe('first reply');
    await expect(second).resolves.toBe('second reply');

    expect(expert.generate).toHaveBeenCalledTimes(2);
    expect(expert.generate.mock.calls[1][0]).toContain('用户: first question');
    expect(expert.generate.mock.calls[1][0]).toContain('助手: first reply');
    expect(expert.generate.mock.calls[1][0]).toContain('second question');

    const persisted = JSON.parse(redis.store.get('chat:user-1')) as StoredMessage[];
    expect(persisted).toEqual([
      { type: 'human', content: 'first question' },
      { type: 'ai', content: 'first reply' },
      { type: 'human', content: 'second question' },
      { type: 'ai', content: 'second reply' },
    ]);
  });

  it('serializes same-user requests across two instances sharing Redis', async () => {
    const secondService = new AiService(
      knowledgeBase as unknown as KnowledgeBaseService,
      expert as unknown as ExpertGenerationService,
      redis.createClient() as any,
    );
    let markFirstStarted: () => void;
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve;
    });
    let resolveFirst: (reply: string) => void;

    expert.generate
      .mockImplementationOnce(() => {
        markFirstStarted();
        return new Promise<string>(resolve => {
          resolveFirst = resolve;
        });
      })
      .mockResolvedValueOnce('second reply');

    const first = service.processQuery(query('first question'));
    await firstStarted;
    const second = secondService.processQuery(query('second question'));
    await redis.waitForContention;

    expect(expert.generate).toHaveBeenCalledTimes(1);

    resolveFirst('first reply');
    await expect(first).resolves.toBe('first reply');
    await expect(second).resolves.toBe('second reply');

    expect(expert.generate).toHaveBeenCalledTimes(2);
    expect(expert.generate.mock.calls[1][0]).toContain('用户: first question');
    expect(expert.generate.mock.calls[1][0]).toContain('助手: first reply');

    const persisted = JSON.parse(redis.store.get('chat:user-1')) as StoredMessage[];
    expect(persisted).toEqual([
      { type: 'human', content: 'first question' },
      { type: 'ai', content: 'first reply' },
      { type: 'human', content: 'second question' },
      { type: 'ai', content: 'second reply' },
    ]);
    expect(redis.locks.size).toBe(0);
  });

  it('renews and releases a lock only while its token owns the key', async () => {
    const lock = await (service as any).acquireConversationLock('user-1');
    const record = redis.locks.get(lock.key);
    record.expiresAt = Date.now() + 1;

    await expect((service as any).renewConversationLock(lock)).resolves.toBe(true);
    expect(record.expiresAt).toBeGreaterThan(Date.now() + 1000);

    redis.locks.set(lock.key, {
      token: 'replacement-owner',
      expiresAt: Date.now() + 15000,
    });
    await (service as any).releaseConversationLock(lock);

    expect(redis.locks.get(lock.key)?.token).toBe('replacement-owner');
  });
});
