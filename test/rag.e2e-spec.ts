import {
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { KnowledgeBaseController } from '../src/knowledge-base/knowledge-base.controller';
import { KnowledgeBaseService } from '../src/knowledge-base/knowledge-base.service';
import { RagQueryService } from '../src/rag/rag-query.service';

describe('RAG routes (e2e)', () => {
  let app: INestApplication;
  const knowledgeBase = {
    search: jest.fn(),
  };
  const ragQuery = {
    retrieve: jest.fn(),
    answer: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [KnowledgeBaseController],
      providers: [
        { provide: KnowledgeBaseService, useValue: knowledgeBase },
        { provide: RagQueryService, useValue: ragQuery },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('retrieves evidence without calling answer generation', async () => {
    const result = {
      query: 'annual leave',
      evidence: [],
      context: '',
      estimatedTokens: 0,
    };
    ragQuery.retrieve.mockResolvedValue(result);

    await request(app.getHttpServer())
      .post('/knowledge-base/retrieve')
      .send({ query: ' annual leave ', topK: 3 })
      .expect(201)
      .expect(result);

    expect(ragQuery.retrieve).toHaveBeenCalledWith({
      query: 'annual leave',
      limit: 3,
      filter: {
        category: undefined,
        tags: undefined,
      },
    });
    expect(ragQuery.answer).not.toHaveBeenCalled();
  });

  it('returns answer metadata from the single Expert pipeline', async () => {
    const result = {
      query: 'annual leave',
      answer: 'Use the current policy.',
      citations: [],
      abstained: false,
      abstentionReasons: [],
    };
    ragQuery.answer.mockResolvedValue(result);

    await request(app.getHttpServer())
      .post('/knowledge-base/answer')
      .send({ query: 'annual leave', filterCategory: 'HR' })
      .expect(201)
      .expect(result);

    expect(ragQuery.answer).toHaveBeenCalledWith({
      query: 'annual leave',
      limit: undefined,
      filter: {
        category: 'HR',
        tags: undefined,
      },
    });
  });
});
