import {
  ChildRetrievalHit,
  RagMetadataFilter,
  StaleRagGenerationError,
} from '../domain/rag.types';
import { RagRepository } from '../storage/rag.repository';
import { SparseRetrieverService } from './sparse-retriever.service';

function hit(
  childId: string,
  options: {
    bm25?: number;
    matchedTerms?: string[];
  } = {},
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
    documentName: `document-${childId}`,
    sourceIdentity: `source-${childId}`,
    sourceType: 'text',
    mimeType: 'text/plain',
    category: 'policy',
    tags: [],
    metadata: {},
    documentUpdatedAt: '2026-07-16T00:00:00.000Z',
    retrieval: 'sparse',
    rank: 99,
    score: -99,
    ...options,
  };
}

describe('SparseRetrieverService', () => {
  let repository: {
    getCorpusState: jest.Mock;
    searchActiveChildrenSparse: jest.Mock;
  };
  let service: SparseRetrieverService;

  beforeEach(() => {
    repository = {
      getCorpusState: jest.fn().mockReturnValue({
        activeGenerationId: 'gen_000000000001',
      }),
      searchActiveChildrenSparse: jest.fn().mockReturnValue([]),
    };
    service = new SparseRetrieverService(
      repository as unknown as RagRepository,
    );
  });

  it('normalizes Chinese text and emits overlapping quoted trigrams', () => {
    service.retrieve('  员工手册规定  ');

    expect(repository.searchActiveChildrenSparse).toHaveBeenCalledWith(
      'gen_000000000001',
      '"员工手" OR "工手册" OR "手册规" OR "册规定"',
      [],
      50,
      undefined,
    );
  });

  it('extracts mixed alphanumeric terms without exposing punctuation', () => {
    service.retrieve('  ＩＳＯ-27001 / OAuth2  ');

    expect(repository.searchActiveChildrenSparse).toHaveBeenCalledWith(
      'gen_000000000001',
      '"iso" OR "27001" OR "oauth2"',
      [],
      50,
      undefined,
    );
  });

  it('quotes extracted terms and discards malicious FTS syntax', () => {
    service.retrieve('policy" OR * NEAR(secret) title:admin');

    const matchQuery =
      repository.searchActiveChildrenSparse.mock.calls[0][1];
    expect(matchQuery).toBe(
      '"policy" OR "near" OR "secret" OR "title" OR "admin"',
    );
    expect(matchQuery).not.toContain('*');
    expect(matchQuery).not.toContain(':');
    expect(matchQuery).not.toContain('(');
    expect(matchQuery).not.toContain(')');
  });

  it('uses bounded literal fallback for one and two character terms', () => {
    service.retrieve('HR 制度 A 1');

    expect(repository.searchActiveChildrenSparse).toHaveBeenCalledWith(
      'gen_000000000001',
      '',
      ['hr', '制度', 'a', '1'],
      50,
      undefined,
    );
  });

  it('orders BM25 hits before literal hits, dedupes, and normalizes scores', () => {
    repository.searchActiveChildrenSparse.mockReturnValue([
      hit('literal-b', { matchedTerms: ['hr'] }),
      hit('fts-b', { bm25: -2 }),
      hit('fts-a', { bm25: -4 }),
      hit('literal-a', { matchedTerms: ['a'] }),
      hit('fts-a', { bm25: -3, matchedTerms: ['制度'] }),
    ]);

    const results = service.retrieve('制度 HR A');

    expect(results.map(result => result.childId)).toEqual([
      'fts-a',
      'fts-b',
      'literal-a',
      'literal-b',
    ]);
    expect(results.map(result => result.rank)).toEqual([1, 2, 3, 4]);
    expect(results[0].score).toBe(1);
    expect(results[1].score).toBeCloseTo(1 / 3);
    expect(results[2].score).toBe(0);
    expect(results.every(result => result.score >= 0 && result.score <= 1))
      .toBe(true);
    expect(results[0].matchedTerms).toEqual(['制度']);
  });

  it('passes metadata filters and bounded limits to repository search', () => {
    const filter: RagMetadataFilter = {
      documentIds: ['doc-1'],
      category: 'policy',
      tags: ['hr', 'internal'],
      updatedAfter: '2026-01-01T00:00:00.000Z',
      updatedBefore: '2026-12-31T23:59:59.999Z',
    };

    service.retrieve('employee handbook', { limit: 9999, filter });

    expect(repository.searchActiveChildrenSparse).toHaveBeenCalledWith(
      'gen_000000000001',
      '"employee" OR "handbook"',
      [],
      500,
      filter,
    );
  });

  it('retries once against the new active generation when the first is stale', () => {
    repository.getCorpusState
      .mockReturnValueOnce({ activeGenerationId: 'gen_000000000001' })
      .mockReturnValueOnce({ activeGenerationId: 'gen_000000000002' });
    repository.searchActiveChildrenSparse
      .mockImplementationOnce(() => {
        throw new StaleRagGenerationError(
          'gen_000000000001',
          'gen_000000000002',
        );
      })
      .mockReturnValueOnce([
        {
          ...hit('fresh', { bm25: -1 }),
          generation: 'gen_000000000002',
        },
      ]);

    const results = service.retrieve('policy');

    expect(repository.searchActiveChildrenSparse).toHaveBeenCalledTimes(2);
    expect(repository.searchActiveChildrenSparse.mock.calls[0][0]).toBe(
      'gen_000000000001',
    );
    expect(repository.searchActiveChildrenSparse.mock.calls[1][0]).toBe(
      'gen_000000000002',
    );
    expect(results[0].generation).toBe('gen_000000000002');
  });

  it('does not retry a second stale generation', () => {
    repository.getCorpusState
      .mockReturnValueOnce({ activeGenerationId: 'gen_000000000001' })
      .mockReturnValueOnce({ activeGenerationId: 'gen_000000000002' });
    repository.searchActiveChildrenSparse.mockImplementation(() => {
      throw new StaleRagGenerationError(
        'gen_000000000001',
        'gen_000000000002',
      );
    });

    expect(() => service.retrieve('policy')).toThrow(
      StaleRagGenerationError,
    );
    expect(repository.searchActiveChildrenSparse).toHaveBeenCalledTimes(2);
  });
});
