import {
  EmbeddingProvider,
  GenerationRead,
  RagChildRecord,
  RagMetadataFilter,
  StaleRagGenerationError,
} from '../domain/rag.types';
import { IndexGenerationStore } from '../indexing/index-generation.store';
import { RagRepository } from '../storage/rag.repository';
import { DenseRetrieverService } from './dense-retriever.service';

function child(
  childId: string,
  overrides: Partial<RagChildRecord> = {},
): RagChildRecord {
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
    ...overrides,
  };
}

function snapshot(
  generation: string,
  search: GenerationRead['search'],
  dimension = 2,
  size = 20,
): GenerationRead {
  return { generation, dimension, size, search };
}

describe('DenseRetrieverService', () => {
  let repository: jest.Mocked<
    Pick<RagRepository, 'getCorpusState' | 'resolveActiveChildren'>
  >;
  let generations: jest.Mocked<
    Pick<
      IndexGenerationStore,
      'getActiveSnapshot' | 'isActiveGeneration'
    >
  >;
  let embeddings: jest.Mocked<EmbeddingProvider>;
  let service: DenseRetrieverService;

  beforeEach(() => {
    repository = {
      getCorpusState: jest.fn().mockReturnValue({
        activeGenerationId: 'gen_000000000001',
      }),
      resolveActiveChildren: jest.fn(),
    };
    generations = {
      getActiveSnapshot: jest.fn(),
      isActiveGeneration: jest.fn().mockReturnValue(true),
    };
    embeddings = {
      embedDocuments: jest.fn().mockResolvedValue([[0.25, 0.75]]),
    };
    service = new DenseRetrieverService(
      repository as unknown as RagRepository,
      generations as unknown as IndexGenerationStore,
      embeddings,
    );
  });

  it('deduplicates valid distances, orders deterministically, and normalizes scores', async () => {
    const search = jest.fn().mockReturnValue([
      { childId: 'child-b', squaredL2: 2 },
      { childId: 'child-a', squaredL2: 1 },
      { childId: 'child-b', squaredL2: 0.5 },
      { childId: 'child-c', squaredL2: 1 },
      { childId: 'child-nan', squaredL2: Number.NaN },
      { childId: 'child-negative', squaredL2: -1 },
      { childId: 'child-infinite', squaredL2: Number.POSITIVE_INFINITY },
      { childId: '', squaredL2: 0 },
    ]);
    generations.getActiveSnapshot.mockResolvedValue(
      snapshot('gen_000000000001', search),
    );
    repository.resolveActiveChildren.mockImplementation(
      (_generation, childIds) =>
        [...childIds].reverse().map(childId => child(childId)),
    );

    const result = await service.retrieve('leave policy', { limit: 3 });

    expect(embeddings.embedDocuments).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith([0.25, 0.75], 12);
    expect(repository.resolveActiveChildren).toHaveBeenCalledWith(
      'gen_000000000001',
      ['child-b', 'child-a', 'child-c'],
      undefined,
    );
    expect(result.map(hit => hit.childId)).toEqual([
      'child-b',
      'child-a',
      'child-c',
    ]);
    expect(result.map(hit => hit.rank)).toEqual([1, 2, 3]);
    expect(result.map(hit => hit.retrieval)).toEqual([
      'dense',
      'dense',
      'dense',
    ]);
    expect(result[0].squaredL2).toBe(0.5);
    expect(result[0].score).toBeCloseTo(1 / 1.5);
    expect(result[1].score).toBeCloseTo(0.5);
  });

  it.each([
    { requested: 0, expectedSearchLimit: 4, expectedHits: 1 },
    { requested: 80, expectedSearchLimit: 200, expectedHits: 50 },
  ])(
    'clamps limit $requested and bounds overfetch',
    async ({ requested, expectedSearchLimit, expectedHits }) => {
      const candidates = Array.from({ length: 60 }, (_, index) => ({
        childId: `child-${String(index).padStart(2, '0')}`,
        squaredL2: index,
      }));
      const search = jest.fn().mockReturnValue(candidates);
      generations.getActiveSnapshot.mockResolvedValue(
        snapshot('gen_000000000001', search, 2, 60),
      );
      repository.resolveActiveChildren.mockImplementation(
        (_generation, childIds) => childIds.map(childId => child(childId)),
      );

      const result = await service.retrieve('query', { limit: requested });

      expect(search).toHaveBeenCalledWith(
        [0.25, 0.75],
        expectedSearchLimit,
      );
      expect(result).toHaveLength(expectedHits);
    },
  );

  it('uses authoritative SQLite resolution for filters and deleted IDs', async () => {
    const filter: RagMetadataFilter = {
      documentIds: ['document-child-b'],
      category: 'policy',
      tags: ['hr'],
      updatedAfter: '2026-07-01T00:00:00.000Z',
    };
    generations.getActiveSnapshot.mockResolvedValue(
      snapshot('gen_000000000001', () => [
        { childId: 'deleted-child', squaredL2: 0.1 },
        { childId: 'filtered-child', squaredL2: 0.2 },
        { childId: 'child-b', squaredL2: 0.3 },
      ]),
    );
    repository.resolveActiveChildren.mockReturnValue([child('child-b')]);

    const result = await service.retrieve('query', { limit: 5, filter });

    expect(repository.resolveActiveChildren).toHaveBeenCalledWith(
      'gen_000000000001',
      ['deleted-child', 'filtered-child', 'child-b'],
      filter,
    );
    expect(result.map(hit => hit.childId)).toEqual(['child-b']);
    expect(result[0].rank).toBe(1);
  });

  it('retries one generation change without embedding again', async () => {
    const firstSearch = jest.fn().mockReturnValue([
      { childId: 'old-child', squaredL2: 0.1 },
    ]);
    const secondSearch = jest.fn().mockReturnValue([
      { childId: 'new-child', squaredL2: 0.2 },
    ]);
    generations.getActiveSnapshot
      .mockResolvedValueOnce(
        snapshot('gen_000000000001', firstSearch),
      )
      .mockResolvedValueOnce(
        snapshot('gen_000000000002', secondSearch),
      );
    generations.isActiveGeneration
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);
    repository.getCorpusState.mockReturnValue({
      activeGenerationId: 'gen_000000000002',
    } as ReturnType<RagRepository['getCorpusState']>);
    repository.resolveActiveChildren
      .mockReturnValueOnce([child('old-child')])
      .mockReturnValueOnce([
        child('new-child', { generation: 'gen_000000000002' }),
      ]);

    const result = await service.retrieve('query', { limit: 1 });

    expect(embeddings.embedDocuments).toHaveBeenCalledTimes(1);
    expect(generations.getActiveSnapshot).toHaveBeenCalledTimes(2);
    expect(firstSearch).toHaveBeenCalledTimes(1);
    expect(secondSearch).toHaveBeenCalledTimes(1);
    expect(result.map(hit => hit.childId)).toEqual(['new-child']);
  });

  it('throws StaleRagGenerationError after one stale retry', async () => {
    generations.getActiveSnapshot.mockResolvedValue(
      snapshot('gen_000000000002', jest.fn()),
    );
    generations.isActiveGeneration.mockReturnValue(false);
    repository.getCorpusState.mockReturnValue({
      activeGenerationId: 'gen_000000000003',
    } as ReturnType<RagRepository['getCorpusState']>);

    await expect(
      service.retrieve('query', {
        expectedGeneration: 'gen_000000000001',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'StaleRagGenerationError',
        expectedGeneration: 'gen_000000000001',
        activeGeneration: 'gen_000000000003',
      }),
    );
    expect(generations.getActiveSnapshot).toHaveBeenCalledTimes(2);
    expect(embeddings.embedDocuments).toHaveBeenCalledTimes(1);
  });

  it('rejects a changed generation dimension after retrying stale data', async () => {
    const firstSearch = jest.fn();
    const secondSearch = jest.fn();
    generations.getActiveSnapshot
      .mockResolvedValueOnce(
        snapshot('gen_000000000001', firstSearch, 2),
      )
      .mockResolvedValueOnce(
        snapshot('gen_000000000002', secondSearch, 3),
      );
    generations.isActiveGeneration
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    repository.getCorpusState.mockReturnValue({
      activeGenerationId: 'gen_000000000002',
    } as ReturnType<RagRepository['getCorpusState']>);

    await expect(service.retrieve('query')).rejects.toThrow(
      'Query embedding dimension 2 does not match generation ' +
        'gen_000000000002 dimension 3',
    );
    expect(embeddings.embedDocuments).toHaveBeenCalledTimes(1);
    expect(firstSearch).not.toHaveBeenCalled();
    expect(secondSearch).not.toHaveBeenCalled();
  });

  it('propagates authoritative stale-generation errors through the retry bound', async () => {
    generations.getActiveSnapshot.mockResolvedValue(
      snapshot('gen_000000000001', () => [
        { childId: 'child-a', squaredL2: 0.1 },
      ]),
    );
    repository.resolveActiveChildren.mockImplementation(() => {
      throw new StaleRagGenerationError(
        'gen_000000000001',
        'gen_000000000002',
      );
    });

    await expect(service.retrieve('query')).rejects.toBeInstanceOf(
      StaleRagGenerationError,
    );
    expect(repository.resolveActiveChildren).toHaveBeenCalledTimes(2);
    expect(embeddings.embedDocuments).toHaveBeenCalledTimes(1);
  });
});
