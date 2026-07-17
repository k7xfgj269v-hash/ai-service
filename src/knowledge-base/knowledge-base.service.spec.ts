import { ConfigService } from '@nestjs/config';
import { Document } from '@langchain/core/documents';
import { RagIndexerService } from '../rag/indexing/rag-indexer.service';
import { RagQueryService } from '../rag/rag-query.service';
import { RagRepository } from '../rag/storage/rag.repository';
import { KnowledgeBaseService } from './knowledge-base.service';

function doc(
  documentId: string,
  extra: Record<string, any> = {},
): Document {
  return new Document({
    pageContent: `content-${documentId}`,
    metadata: { documentId, ...extra },
  });
}

function emptyAnswer(query: string) {
  return {
    query,
    activeGeneration: null,
    evidence: [],
    context: '',
    estimatedTokens: 0,
    degraded: false,
    failedRetrievers: [],
    rerankerStatus: 'disabled',
    cache: {
      retrieval: 'disabled',
      context: 'disabled',
      version: 'test',
    },
    timings: {
      cacheMs: 0,
      retrievalMs: 0,
      contextMs: 0,
      generationMs: 0,
      totalMs: 5,
    },
    answer: '',
    citations: [],
    abstained: true,
    abstentionReasons: ['weak-evidence'],
  };
}

describe('KnowledgeBaseService', () => {
  let service: KnowledgeBaseService;
  let indexer: {
    ingest: jest.Mock;
    rebuild: jest.Mock;
  };
  let repository: {
    listDocuments: jest.Mock;
    getDocumentVersion: jest.Mock;
    getActiveGeneration: jest.Mock;
    deactivateDocument: jest.Mock;
    clearCorpus: jest.Mock;
  };
  let ragQuery: {
    retrieve: jest.Mock;
    answer: jest.Mock;
  };

  beforeEach(() => {
    indexer = {
      ingest: jest.fn(),
      rebuild: jest.fn(),
    };
    repository = {
      listDocuments: jest.fn(() => []),
      getDocumentVersion: jest.fn(),
      getActiveGeneration: jest.fn(() => null),
      deactivateDocument: jest.fn(),
      clearCorpus: jest.fn(),
    };
    ragQuery = {
      retrieve: jest.fn(),
      answer: jest.fn(async request => emptyAnswer(request.query)),
    };
    const configService = {
      get: jest.fn((key: string) =>
        key === 'EMBEDDING_MODEL' ? 'text-embedding-v3' : undefined,
      ),
    };
    service = new KnowledgeBaseService(
      indexer as unknown as RagIndexerService,
      repository as unknown as RagRepository,
      ragQuery as unknown as RagQueryService,
      configService as unknown as ConfigService,
    );
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  it('returns empty repository statistics', async () => {
    await expect(service.getStats()).resolves.toEqual({
      totalDocuments: 0,
      totalChunks: 0,
      categories: [],
      lastUpdated: 'Never',
      vectorStorePath: '',
    });
  });

  it('returns an empty legacy search shape when RAG abstains without evidence', async () => {
    await expect(service.search('test query')).resolves.toEqual({
      answer: '',
      sources: [],
      confidence: 0,
      processingTime: 5,
    });
    expect(ragQuery.answer).toHaveBeenCalledWith({
      query: 'test query',
      limit: undefined,
      filter: undefined,
    });
  });

  it('maps one RAG answer into the legacy search response with one generation call', async () => {
    ragQuery.answer.mockResolvedValue({
      ...emptyAnswer('policy question'),
      answer: 'Use the current policy.',
      abstained: false,
      abstentionReasons: [],
      evidence: [
        {
          sourceId: 'source-1',
          parentId: 'parent-1',
          documentId: 'doc-1',
          versionId: 'version-1',
          documentName: 'policy.md',
          mimeType: 'text/markdown',
          sourceIdentity: 'document:policy.md',
          headingPath: ['Leave'],
          category: 'hr',
          tags: ['leave'],
          documentUpdatedAt: '2026-07-17T00:00:00.000Z',
          content: 'Policy evidence',
          confidence: 0.8,
          metadata: { section: 'leave' },
        },
      ],
    });

    const result = await service.search('policy question', {
      topK: 1,
      filter: { category: 'hr' },
    });

    expect(result.answer).toBe('Use the current policy.');
    expect(result.confidence).toBe(0.8);
    expect(result.sources).toEqual([
      {
        content: 'Policy evidence',
        metadata: {
          section: 'leave',
          sourceId: 'source-1',
          parentId: 'parent-1',
          documentId: 'doc-1',
          versionId: 'version-1',
          fileName: 'policy.md',
          fileType: 'text/markdown',
          sourceIdentity: 'document:policy.md',
          headingPath: ['Leave'],
          category: 'hr',
          tags: ['leave'],
          updatedAt: '2026-07-17T00:00:00.000Z',
        },
        score: 0.8,
      },
    ]);
    expect(ragQuery.answer).toHaveBeenCalledTimes(1);
    expect(ragQuery.answer).toHaveBeenCalledWith({
      query: 'policy question',
      limit: 1,
      filter: { category: 'hr' },
    });
  });

  it('returns documents from the authoritative repository', async () => {
    await expect(service.listDocuments()).resolves.toEqual([]);
    expect(repository.listDocuments).toHaveBeenCalledWith({});
  });

  describe('selectRelevantDocs()', () => {
    const live = new Set(['a', 'b', 'c']);

    it('drops chunks whose parent document was deleted', () => {
      const scored: Array<[Document, number]> = [
        [doc('deleted'), 0.1],
        [doc('a'), 0.2],
      ];
      const out = KnowledgeBaseService.selectRelevantDocs(scored, {
        topK: 5,
        liveDocIds: live,
      });
      expect(out.map(item => item.metadata.documentId)).toEqual(['a']);
    });

    it('keeps close hits and drops far-away noise', () => {
      const scored: Array<[Document, number]> = [
        [doc('a'), 0.2],
        [doc('b'), 0.25],
        [doc('c'), 5],
      ];
      const out = KnowledgeBaseService.selectRelevantDocs(scored, {
        topK: 5,
        liveDocIds: live,
        maxRelativeDistance: 1.5,
      });
      expect(out.map(item => item.metadata.documentId)).toEqual(['a', 'b']);
    });

    it('applies metadata filters before topK', () => {
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
      expect(out.map(item => item.metadata.documentId)).toEqual(['b', 'c']);
    });

    it('returns no result when all candidates are filtered out', () => {
      expect(
        KnowledgeBaseService.selectRelevantDocs([[doc('deleted'), 0.1]], {
          topK: 5,
          liveDocIds: live,
        }),
      ).toEqual([]);
    });

    it('respects topK after filtering', () => {
      const scored: Array<[Document, number]> = [
        [doc('a'), 0.1],
        [doc('b'), 0.11],
        [doc('c'), 0.12],
      ];
      expect(
        KnowledgeBaseService.selectRelevantDocs(scored, {
          topK: 2,
          liveDocIds: live,
        }),
      ).toHaveLength(2);
    });
  });

  describe('confidenceFromDistance()', () => {
    it('is bounded and monotonically decreasing', () => {
      expect(KnowledgeBaseService.confidenceFromDistance(0)).toBe(1);
      expect(KnowledgeBaseService.confidenceFromDistance(1)).toBeCloseTo(0.5);
      expect(
        KnowledgeBaseService.confidenceFromDistance(0.2),
      ).toBeGreaterThan(KnowledgeBaseService.confidenceFromDistance(2));
    });

    it('returns zero for invalid input', () => {
      expect(KnowledgeBaseService.confidenceFromDistance(NaN)).toBe(0);
      expect(KnowledgeBaseService.confidenceFromDistance(-1)).toBe(0);
    });
  });
});
