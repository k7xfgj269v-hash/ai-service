import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Document } from '@langchain/core/documents';
import { ChatOpenAI } from '@langchain/openai';
import { KnowledgeBaseService } from './knowledge-base.service';

jest.mock('@langchain/openai', () => ({
  OpenAIEmbeddings: jest.fn(),
  ChatOpenAI: jest.fn(),
}));

jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    get: jest.fn(async () => null),
    setex: jest.fn(async () => 'OK'),
    disconnect: jest.fn(),
  })),
);

function doc(documentId: string, extra: Record<string, any> = {}): Document {
  return new Document({ pageContent: `content-${documentId}`, metadata: { documentId, ...extra } });
}

describe('KnowledgeBaseService', () => {
  let service: KnowledgeBaseService;
  const ChatOpenAIMock = ChatOpenAI as unknown as jest.Mock;

  const mockConfigService = {
    get: jest.fn((key: string, defaultVal?: any) => {
      const config: Record<string, string> = {
        DEEPSEEK_API_KEY: 'test_key',
        OPENAI_API_BASE_URL: 'https://api.deepseek.com',
        EMBEDDING_API_KEY: 'test_embedding_key',
        EMBEDDING_API_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        EMBEDDING_MODEL: 'text-embedding-v3',
        QWEN_API_KEY: 'test_qwen_key',
        QWEN_API_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        QWEN_MODEL: 'qwen-plus',
        REDIS_URL: 'redis://localhost:6379',
      };
      return config[key] ?? defaultVal;
    }),
  };

  beforeEach(async () => {
    ChatOpenAIMock.mockClear();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KnowledgeBaseService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<KnowledgeBaseService>(KnowledgeBaseService);
  });

  afterEach(() => {
    (service as any).redis?.disconnect?.();
    (service as any).db?.close?.();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getStats()', () => {
    it('should return stats with defaults when knowledge base is empty', async () => {
      const stats = await service.getStats();
      expect(stats).toBeDefined();
      expect(typeof stats.totalDocuments).toBe('number');
      expect(typeof stats.totalChunks).toBe('number');
      expect(Array.isArray(stats.categories)).toBe(true);
    });
  });

  describe('search()', () => {
    it('should return empty result when vector store is not initialized', async () => {
      const result = await service.search('test query');
      expect(result).toBeDefined();
      expect(result.answer).toBe('');
      expect(result.sources).toEqual([]);
      expect(result.confidence).toBe(0);
    });

    it('returns retrieval evidence without creating a second answer generator', async () => {
      const vectorStore = {
        similaritySearchWithScore: jest.fn(async () => [
          [doc('a', { fileName: 'policy.md' }), 0.2],
        ]),
      };
      const redis = {
        get: jest.fn(async () => null),
        setex: jest.fn(async (_key: string, _ttl: number, _value: string) => 'OK'),
      };
      const db = {
        prepare: jest.fn((sql: string) => {
          if (sql.includes('SUM(chunkCount)')) {
            return { get: () => ({ total: 1 }) };
          }
          if (sql.includes('SELECT id FROM documents')) {
            return { all: () => [{ id: 'a' }] };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        }),
      };
      (service as any).vectorStore = vectorStore;
      (service as any).redis = redis;
      (service as any).db.close();
      (service as any).db = db;

      const result = await service.search('policy question', { topK: 1 });

      expect(result.answer).toBe('');
      expect(result.sources).toEqual([
        {
          content: 'content-a',
          metadata: {
            documentId: 'a',
            fileName: 'policy.md',
          },
          score: 0.2,
        },
      ]);
      expect(result.confidence).toBeCloseTo(1 / 1.2);
      expect(ChatOpenAIMock).not.toHaveBeenCalled();
      expect(redis.setex).toHaveBeenCalledTimes(1);
      expect(JSON.parse(redis.setex.mock.calls[0][2]).answer).toBe('');
    });

    it('strips answers from legacy cached retrieval results', async () => {
      const sources = [{ content: 'cached evidence', metadata: { documentId: 'a' }, score: 0.2 }];
      (service as any).vectorStore = {};
      (service as any).redis = {
        get: jest.fn(async () =>
          JSON.stringify({
            answer: 'legacy generated answer',
            sources,
            confidence: 0.8,
            processingTime: 12,
          }),
        ),
      };

      const result = await service.search('cached question');

      expect(result).toEqual({
        answer: '',
        sources,
        confidence: 0.8,
        processingTime: 12,
      });
      expect(ChatOpenAIMock).not.toHaveBeenCalled();
    });
  });

  describe('listDocuments()', () => {
    it('should return empty array when no documents exist', async () => {
      const docs = await service.listDocuments();
      expect(Array.isArray(docs)).toBe(true);
    });
  });

  describe('selectRelevantDocs()', () => {
    const live = new Set(['a', 'b', 'c']);

    it('drops chunks whose parent document was deleted', () => {
      const scored: Array<[Document, number]> = [
        [doc('deleted'), 0.1],
        [doc('a'), 0.2],
      ];
      const out = KnowledgeBaseService.selectRelevantDocs(scored, { topK: 5, liveDocIds: live });
      expect(out.map(d => d.metadata.documentId)).toEqual(['a']);
    });

    it('always keeps the closest hit and drops far-away noise via the relative gate', () => {
      const scored: Array<[Document, number]> = [
        [doc('a'), 0.2],
        [doc('b'), 0.25],
        [doc('c'), 5.0], // way past 0.2 * 1.5
      ];
      const out = KnowledgeBaseService.selectRelevantDocs(scored, {
        topK: 5,
        liveDocIds: live,
        maxRelativeDistance: 1.5,
      });
      expect(out.map(d => d.metadata.documentId)).toEqual(['a', 'b']);
    });

    it('over-fetch + category filter still yields matches (no starvation)', () => {
      const scored: Array<[Document, number]> = [
        [doc('a', { category: 'other' }), 0.1],
        [doc('b', { category: 'hr' }), 0.15],
        [doc('c', { category: 'hr' }), 0.18],
      ];
      const out = KnowledgeBaseService.selectRelevantDocs(scored, {
        topK: 2,
        liveDocIds: live,
        filter: { category: 'hr' },
      });
      expect(out.map(d => d.metadata.documentId)).toEqual(['b', 'c']);
    });

    it('returns [] when everything is filtered out', () => {
      const scored: Array<[Document, number]> = [[doc('deleted'), 0.1]];
      const out = KnowledgeBaseService.selectRelevantDocs(scored, { topK: 5, liveDocIds: live });
      expect(out).toEqual([]);
    });

    it('respects topK after filtering', () => {
      const scored: Array<[Document, number]> = [
        [doc('a'), 0.1],
        [doc('b'), 0.11],
        [doc('c'), 0.12],
      ];
      const out = KnowledgeBaseService.selectRelevantDocs(scored, { topK: 2, liveDocIds: live });
      expect(out).toHaveLength(2);
    });
  });

  describe('confidenceFromDistance()', () => {
    it('is 1 at distance 0 and decreases monotonically', () => {
      expect(KnowledgeBaseService.confidenceFromDistance(0)).toBe(1);
      expect(KnowledgeBaseService.confidenceFromDistance(1)).toBeCloseTo(0.5);
      expect(KnowledgeBaseService.confidenceFromDistance(0.2)).toBeGreaterThan(
        KnowledgeBaseService.confidenceFromDistance(2),
      );
    });

    it('returns 0 for invalid input', () => {
      expect(KnowledgeBaseService.confidenceFromDistance(NaN)).toBe(0);
      expect(KnowledgeBaseService.confidenceFromDistance(-1)).toBe(0);
    });
  });
});
