import { ChildRetrievalHit, RagChildRecord } from '../domain/rag.types';
import { RerankerAdapter } from '../ranking/reranker.adapter';
import { DenseRetrieverService } from './dense-retriever.service';
import {
  HybridRetrievalError,
  HybridRetrievalService,
} from './hybrid-retrieval.service';
import { SparseRetrieverService } from './sparse-retriever.service';

function child(
  childId: string,
  retrieval: 'dense' | 'sparse',
  rank: number,
  score: number,
  overrides: Partial<RagChildRecord> = {},
): ChildRetrievalHit {
  return {
    generation: 'gen_000000000001',
    childId,
    parentId: `parent-${childId}`,
    documentId: `document-${childId}`,
    versionId: `version-${childId}`,
    content: `content-${childId}`,
    normalizedContent: `content-${childId}`,
    estimatedTokens: 10,
    parentContent: `parent-content-${childId}`,
    parentEstimatedTokens: 20,
    headingPath: [],
    documentName: `${childId}.md`,
    sourceIdentity: `/documents/${childId}.md`,
    sourceType: 'markdown',
    mimeType: 'text/markdown',
    category: 'policy',
    tags: ['hr'],
    metadata: {},
    documentUpdatedAt: '2026-07-16T00:00:00.000Z',
    retrieval,
    rank,
    score,
    ...overrides,
  };
}

describe('HybridRetrievalService', () => {
  let dense: { retrieve: jest.Mock };
  let sparse: { retrieve: jest.Mock };

  beforeEach(() => {
    dense = { retrieve: jest.fn() };
    sparse = { retrieve: jest.fn() };
  });

  function createService(
    reranker?: RerankerAdapter,
  ): HybridRetrievalService {
    return new HybridRetrievalService(
      dense as unknown as DenseRetrieverService,
      sparse as unknown as SparseRetrieverService,
      reranker,
    );
  }

  it('degrades to the successful retriever when the other backend fails', async () => {
    dense.retrieve.mockRejectedValue(new Error('embedding unavailable'));
    sparse.retrieve.mockReturnValue([
      child('child-b', 'sparse', 2, 0.6),
      child('child-a', 'sparse', 1, 0.9),
    ]);

    const result = await createService().retrieve('leave policy');

    expect(result.degraded).toBe(true);
    expect(result.failedRetrievers).toEqual(['dense']);
    expect(result.successfulRetrievers).toEqual(['sparse']);
    expect(result.hits.map(hit => hit.childId)).toEqual([
      'child-a',
      'child-b',
    ]);
    expect(result.hits[0].confidence).toBeGreaterThan(
      result.hits[1].confidence,
    );
  });

  it('fails only when both retrievers reject', async () => {
    dense.retrieve.mockRejectedValue(new Error('dense failed'));
    sparse.retrieve.mockImplementation(() => {
      throw new Error('sparse failed');
    });

    await expect(createService().retrieve('query')).rejects.toEqual(
      expect.objectContaining({
        name: HybridRetrievalError.name,
        failures: [
          expect.objectContaining({ source: 'dense' }),
          expect.objectContaining({ source: 'sparse' }),
        ],
      }),
    );
  });

  it('produces deterministic RRF ordering independent of completion order', async () => {
    let resolveDense: (hits: ChildRetrievalHit[]) => void;
    let resolveSparse: (hits: ChildRetrievalHit[]) => void;
    dense.retrieve.mockReturnValue(
      new Promise(resolve => {
        resolveDense = resolve;
      }),
    );
    sparse.retrieve.mockReturnValue(
      new Promise(resolve => {
        resolveSparse = resolve;
      }),
    );
    const pending = createService().retrieve('policy');

    resolveSparse!([
      child('child-b', 'sparse', 1, 0.8),
      child('child-a', 'sparse', 2, 0.8),
    ]);
    resolveDense!([
      child('child-a', 'dense', 1, 0.8),
      child('child-b', 'dense', 2, 0.8),
    ]);

    const result = await pending;

    expect(result.hits.map(hit => hit.childId)).toEqual([
      'child-a',
      'child-b',
    ]);
    expect(result.hits.map(hit => hit.retrievals)).toEqual([
      ['dense', 'sparse'],
      ['dense', 'sparse'],
    ]);
    expect(result.hits[0].rrfScore).toBeCloseTo(
      result.hits[1].rrfScore,
    );
  });

  it('applies valid reranker scores with deterministic ties', async () => {
    dense.retrieve.mockResolvedValue([
      child('child-a', 'dense', 1, 0.8),
      child('child-b', 'dense', 2, 0.8),
      child('child-c', 'dense', 3, 0.8),
    ]);
    sparse.retrieve.mockReturnValue([]);
    const reranker: RerankerAdapter = {
      enabled: true,
      rerank: jest.fn().mockResolvedValue([
        { id: 'child-b', score: 0.95 },
        { id: 'child-a', score: 0.7 },
      ]),
    };

    const result = await createService(reranker).retrieve('policy', {
      rerank: true,
      rerankOutputLimit: 3,
    });

    expect(result.rerankerStatus).toBe('applied');
    expect(result.hits.map(hit => hit.childId)).toEqual([
      'child-b',
      'child-a',
      'child-c',
    ]);
    expect(result.hits.map(hit => hit.rank)).toEqual([1, 2, 3]);
    expect(result.hits[0].rerankerScore).toBe(0.95);
  });

  it('aborts a timed-out reranker and falls back to fused ranks', async () => {
    dense.retrieve.mockResolvedValue([
      child('child-a', 'dense', 1, 0.9),
      child('child-b', 'dense', 2, 0.8),
    ]);
    sparse.retrieve.mockReturnValue([]);
    let observedSignal: AbortSignal | undefined;
    const reranker: RerankerAdapter = {
      enabled: true,
      rerank: jest.fn(request => {
        observedSignal = request.signal;
        return new Promise(() => undefined);
      }),
    };

    const result = await createService(reranker).retrieve('policy', {
      rerank: true,
      rerankTimeoutMs: 5,
    });

    expect(result.rerankerStatus).toBe('fallback');
    expect(result.rerankerFallbackReason).toBe('timeout');
    expect(result.hits.map(hit => hit.childId)).toEqual([
      'child-a',
      'child-b',
    ]);
    expect(observedSignal?.aborted).toBe(true);
  });
});
