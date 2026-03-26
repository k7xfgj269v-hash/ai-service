import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { KnowledgeBaseService } from './knowledge-base.service';

describe('KnowledgeBaseService', () => {
  let service: KnowledgeBaseService;

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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KnowledgeBaseService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<KnowledgeBaseService>(KnowledgeBaseService);
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
      expect(result.sources).toEqual([]);
      expect(result.confidence).toBe(0);
    });
  });

  describe('listDocuments()', () => {
    it('should return empty array when no documents exist', async () => {
      const docs = await service.listDocuments();
      expect(Array.isArray(docs)).toBe(true);
    });
  });
});
