import { ExpertGenerationService } from '../generation/expert-generation.service';
import { CitationValidationService } from './answer/citation-validation.service';
import { EvidenceGateService } from './answer/evidence-gate.service';
import {
  ContextPackerService,
  PackedContext,
  PackedContextSource,
} from './context/context-packer.service';
import { HybridRetrievalResult, HybridRetrievalService } from './retrieval/hybrid-retrieval.service';
import {
  RAG_QUERY_CACHE_VERSION,
  RagQueryCache,
  RagQueryService,
} from './rag-query.service';
import { RagRepository } from './storage/rag.repository';

function source(confidence: number): PackedContextSource {
  return {
    sourceId: 'S1',
    rank: 1,
    parentId: 'parent-1',
    documentId: 'document-1',
    versionId: 'version-1',
    childIds: ['child-1'],
    content: 'Employees receive ten days of annual leave.',
    headingPath: ['Leave'],
    estimatedTokens: 12,
    confidence,
    rrfScore: 0.03,
    documentName: 'handbook.md',
    sourceIdentity: '/documents/handbook.md',
    sourceType: 'markdown',
    mimeType: 'text/markdown',
    category: 'policy',
    tags: ['hr'],
    metadata: {},
    documentUpdatedAt: '2026-07-16T00:00:00.000Z',
  };
}

function packed(confidence?: number): PackedContext {
  const sources = confidence === undefined ? [] : [source(confidence)];
  return {
    sources,
    context: sources.map(item => JSON.stringify(item)).join('\n'),
    estimatedTokens: sources.reduce(
      (total, item) => total + item.estimatedTokens,
      0,
    ),
    tokenBudget: 6000,
    omittedParentCount: 0,
  };
}

function retrieval(): HybridRetrievalResult {
  return {
    hits: [],
    degraded: false,
    successfulRetrievers: ['dense', 'sparse'],
    failedRetrievers: [],
    rerankerStatus: 'disabled',
  };
}

describe('RagQueryService', () => {
  let hybrid: { retrieve: jest.Mock };
  let contextPacker: { pack: jest.Mock };
  let expert: { generate: jest.Mock };
  let repository: {
    getCorpusState: jest.Mock;
    resolveActiveChildren: jest.Mock;
  };

  beforeEach(() => {
    hybrid = { retrieve: jest.fn().mockResolvedValue(retrieval()) };
    contextPacker = { pack: jest.fn().mockReturnValue(packed()) };
    expert = { generate: jest.fn() };
    repository = {
      getCorpusState: jest.fn().mockReturnValue({
        activeGenerationId: 'gen_000000000001',
      }),
      resolveActiveChildren: jest.fn().mockReturnValue([]),
    };
  });

  function createService(cache?: RagQueryCache): RagQueryService {
    return new RagQueryService(
      hybrid as unknown as HybridRetrievalService,
      contextPacker as unknown as ContextPackerService,
      new EvidenceGateService(),
      new CitationValidationService(),
      expert as unknown as ExpertGenerationService,
      repository as unknown as RagRepository,
      cache,
    );
  }

  it('keeps retrieve generation-free even when no corpus generation exists', async () => {
    repository.getCorpusState.mockReturnValue({
      activeGenerationId: null,
    });

    const result = await createService().retrieve({
      query: 'annual leave',
    });

    expect(result.activeGeneration).toBeNull();
    expect(hybrid.retrieve).toHaveBeenCalledTimes(1);
    expect(expert.generate).not.toHaveBeenCalled();
    expect(result.timings.generationMs).toBe(0);
  });

  it('abstains on weak evidence without calling the Expert generator', async () => {
    contextPacker.pack.mockReturnValue(packed(0.2));

    const result = await createService().answer({
      query: 'How much annual leave is provided?',
    });

    expect(result.abstained).toBe(true);
    expect(result.citations).toEqual([]);
    expect(result.abstentionReasons).toContain('weak-top-evidence');
    expect(expert.generate).not.toHaveBeenCalled();
  });

  it('uses valid evidence for exactly one strict Expert generation call', async () => {
    contextPacker.pack.mockReturnValue(packed(0.9));
    expert.generate.mockResolvedValue(
      JSON.stringify({
        answer: 'Employees receive ten days of annual leave.',
        citationIds: ['S1'],
      }),
    );

    const result = await createService().answer({
      query: 'How much annual leave is provided?',
    });

    expect(expert.generate).toHaveBeenCalledTimes(1);
    expect(expert.generate.mock.calls[0][0]).toContain(
      '只能依据下方 EVIDENCE_JSON',
    );
    expect(expert.generate.mock.calls[0][0]).toContain(
      '"citationIds":["S1"]',
    );
    expect(result).toEqual(
      expect.objectContaining({
        answer: 'Employees receive ten days of annual leave.',
        abstained: false,
        citations: [
          expect.objectContaining({
            id: 'S1',
            documentId: 'document-1',
          }),
        ],
        activeGeneration: 'gen_000000000001',
      }),
    );
    expect(result.timings.generationMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects an unknown citation after one call and never retries generation', async () => {
    contextPacker.pack.mockReturnValue(packed(0.9));
    expert.generate.mockResolvedValue(
      JSON.stringify({
        answer: 'Unsupported answer.',
        citationIds: ['S9'],
      }),
    );

    const result = await createService().answer({
      query: 'How much annual leave is provided?',
    });

    expect(expert.generate).toHaveBeenCalledTimes(1);
    expect(result.abstained).toBe(true);
    expect(result.abstentionReasons).toEqual(['invalid-citations']);
    expect(result.citations).toEqual([]);
  });

  it('versions retrieval and context cache keys by active generation', async () => {
    const cache: RagQueryCache = {
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue('OK'),
    };
    const service = createService(cache);

    await service.retrieve({ query: 'annual leave' });
    repository.getCorpusState.mockReturnValue({
      activeGenerationId: 'gen_000000000002',
    });
    await service.retrieve({ query: 'annual leave' });

    const getKeys = (cache.get as jest.Mock).mock.calls.map(call => call[0]);
    expect(getKeys).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `rag-query:${RAG_QUERY_CACHE_VERSION}:gen_000000000001:retrieval:`,
        ),
        expect.stringContaining(
          `rag-query:${RAG_QUERY_CACHE_VERSION}:gen_000000000001:context:`,
        ),
        expect.stringContaining(
          `rag-query:${RAG_QUERY_CACHE_VERSION}:gen_000000000002:retrieval:`,
        ),
        expect.stringContaining(
          `rag-query:${RAG_QUERY_CACHE_VERSION}:gen_000000000002:context:`,
        ),
      ]),
    );
    const payloads = (cache.setex as jest.Mock).mock.calls.map(call =>
      JSON.parse(call[2]),
    );
    expect(payloads.every(payload => payload.cacheVersion === 'v1')).toBe(
      true,
    );
  });

  it('continues retrieval when Redis cache reads and writes fail', async () => {
    const cache: RagQueryCache = {
      get: jest.fn().mockRejectedValue(new Error('redis unavailable')),
      setex: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    };

    const result = await createService(cache).retrieve({
      query: 'annual leave',
    });

    expect(hybrid.retrieve).toHaveBeenCalledTimes(1);
    expect(contextPacker.pack).toHaveBeenCalledTimes(1);
    expect(result.cache).toEqual({
      retrieval: 'error',
      context: 'error',
      version: 'v1',
    });
  });
});
