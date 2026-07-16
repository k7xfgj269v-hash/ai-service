import { ParentChunkRecord, RagChildRecord } from '../domain/rag.types';
import { HybridRetrievalHit } from '../retrieval/hybrid-retrieval.service';
import { RagRepository } from '../storage/rag.repository';
import { ContextPackerService } from './context-packer.service';

function hit(
  childId: string,
  parentId: string,
  documentId: string,
  rank: number,
  confidence = 0.8,
  overrides: Partial<RagChildRecord> = {},
): HybridRetrievalHit {
  return {
    generation: 'gen_000000000001',
    childId,
    parentId,
    documentId,
    versionId: `version-${documentId}`,
    content: `child-content-${childId}`,
    normalizedContent: `child-content-${childId}`,
    estimatedTokens: 10,
    parentContent: `stale-parent-content-${parentId}`,
    parentEstimatedTokens: 999,
    headingPath: ['stale'],
    documentName: `${documentId}.md`,
    sourceIdentity: `/documents/${documentId}.md`,
    sourceType: 'markdown',
    mimeType: 'text/markdown',
    category: 'policy',
    tags: ['hr'],
    metadata: {},
    documentUpdatedAt: '2026-07-16T00:00:00.000Z',
    rank,
    score: confidence,
    confidence,
    rrfScore: 0.03,
    sourceCount: 2,
    retrievals: ['dense', 'sparse'],
    contributions: [],
    ...overrides,
  };
}

function parent(
  parentId: string,
  documentId: string,
  tokens: number,
): ParentChunkRecord {
  return {
    id: parentId,
    documentId,
    versionId: `version-${documentId}`,
    ordinal: 0,
    content: `hydrated-content-${parentId}`,
    headingPath: ['Handbook', parentId],
    estimatedTokens: tokens,
    startOffset: 0,
    endOffset: 20,
    active: true,
    createdAt: '2026-07-16T00:00:00.000Z',
  };
}

describe('ContextPackerService', () => {
  let repository: { getParentChunksByIds: jest.Mock };
  let service: ContextPackerService;

  beforeEach(() => {
    repository = { getParentChunksByIds: jest.fn() };
    service = new ContextPackerService(
      repository as unknown as RagRepository,
    );
  });

  it('hydrates authoritative parents, rotates documents, and assigns stable source IDs', () => {
    const hits = [
      hit('a-1', 'parent-a-1', 'document-a', 1),
      hit('a-2', 'parent-a-2', 'document-a', 2),
      hit('b-1', 'parent-b-1', 'document-b', 3),
    ];
    const parents = [
      parent('parent-a-1', 'document-a', 4),
      parent('parent-a-2', 'document-a', 4),
      parent('parent-b-1', 'document-b', 4),
    ];
    repository.getParentChunksByIds.mockReturnValue([...parents].reverse());

    const packed = service.pack([...hits].reverse(), {
      tokenBudget: 12,
      maxParents: 3,
      maxParentsPerDocument: 2,
    });

    expect(repository.getParentChunksByIds).toHaveBeenCalledWith([
      'parent-a-1',
      'parent-a-2',
      'parent-b-1',
    ]);
    expect(packed.sources.map(source => source.parentId)).toEqual([
      'parent-a-1',
      'parent-b-1',
      'parent-a-2',
    ]);
    expect(packed.sources.map(source => source.sourceId)).toEqual([
      'S1',
      'S2',
      'S3',
    ]);
    expect(packed.sources[0].content).toBe(
      'hydrated-content-parent-a-1',
    );
    expect(packed.sources[0].headingPath).toEqual([
      'Handbook',
      'parent-a-1',
    ]);
    expect(packed.estimatedTokens).toBe(12);
  });

  it('skips an oversized parent and continues packing within the token budget', () => {
    const hits = [
      hit('large', 'parent-large', 'document-a', 1),
      hit('small', 'parent-small', 'document-b', 2),
    ];
    repository.getParentChunksByIds.mockReturnValue([
      parent('parent-large', 'document-a', 9),
      parent('parent-small', 'document-b', 4),
    ]);

    const packed = service.pack(hits, {
      tokenBudget: 5,
      maxParents: 2,
      maxParentsPerDocument: 1,
    });

    expect(packed.sources).toHaveLength(1);
    expect(packed.sources[0]).toEqual(
      expect.objectContaining({
        sourceId: 'S1',
        parentId: 'parent-small',
        estimatedTokens: 4,
      }),
    );
    expect(packed.omittedParentCount).toBe(1);
  });

  it('rehydrates a cached parent selection without trusting cached content', () => {
    const hits = [
      hit('a', 'parent-a', 'document-a', 1),
      hit('b', 'parent-b', 'document-b', 2),
    ];
    repository.getParentChunksByIds.mockReturnValue([
      parent('parent-a', 'document-a', 3),
      parent('parent-b', 'document-b', 3),
    ]);

    const packed = service.pack(
      hits,
      { tokenBudget: 10, maxParents: 2 },
      { parentIds: ['parent-b', 'parent-a'] },
    );

    expect(packed.sources.map(source => source.parentId)).toEqual([
      'parent-b',
      'parent-a',
    ]);
    expect(packed.sources.map(source => source.content)).toEqual([
      'hydrated-content-parent-b',
      'hydrated-content-parent-a',
    ]);
  });
});
