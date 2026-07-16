import { AiService } from './ai.service';
import { ExpertGenerationService } from '../generation/expert-generation.service';
import { KnowledgeBaseService } from '../knowledge-base/knowledge-base.service';

type StoredMessage = {
  type: 'human' | 'ai';
  content: string;
};

function createRedis(initialHistory?: string) {
  const store = new Map<string, string>();
  if (initialHistory !== undefined) {
    store.set('chat:user-1', initialHistory);
  }

  return {
    store,
    client: {
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      setex: jest.fn(async (key: string, _ttl: number, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async (key: string) => {
        const existed = store.delete(key);
        return existed ? 1 : 0;
      }),
    },
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

  it('serializes same-user requests so the second prompt observes the first reply', async () => {
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
});
