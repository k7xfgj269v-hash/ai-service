import { Inject, Injectable } from '@nestjs/common';
import {
  ChildRetrievalHit,
  EmbeddingProvider,
  GenerationRead,
  RAG_EMBEDDINGS,
  RetrievalOptions,
  StaleRagGenerationError,
} from '../domain/rag.types';
import { IndexGenerationStore } from '../indexing/index-generation.store';
import { RagRepository } from '../storage/rag.repository';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;
const OVERFETCH_MULTIPLIER = 4;
const MAX_OVERFETCH = 200;

@Injectable()
export class DenseRetrieverService {
  constructor(
    private readonly repository: RagRepository,
    private readonly generations: IndexGenerationStore,
    @Inject(RAG_EMBEDDINGS)
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async retrieve(
    query: string,
    options: RetrievalOptions = {},
  ): Promise<ChildRetrievalHit[]> {
    const limit = this.boundedLimit(options.limit);
    const vector = await this.embedQuery(query);
    let lastStaleError: StaleRagGenerationError | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.retrieveFromActiveGeneration(
          vector,
          limit,
          options,
        );
      } catch (error) {
        if (!(error instanceof StaleRagGenerationError)) {
          throw error;
        }
        lastStaleError = error;
      }
    }

    throw lastStaleError as StaleRagGenerationError;
  }

  private async retrieveFromActiveGeneration(
    vector: number[],
    limit: number,
    options: RetrievalOptions,
  ): Promise<ChildRetrievalHit[]> {
    const snapshot = await this.generations.getActiveSnapshot();
    const expectedGeneration =
      options.expectedGeneration || snapshot?.generation || null;

    if (!snapshot) {
      if (expectedGeneration) {
        throw new StaleRagGenerationError(expectedGeneration, null);
      }
      return [];
    }
    this.assertActiveGeneration(snapshot, expectedGeneration);

    if (snapshot.size === 0) {
      this.assertStillActive(snapshot.generation);
      return [];
    }
    if (vector.length !== snapshot.dimension) {
      throw new Error(
        `Query embedding dimension ${vector.length} does not match ` +
          `generation ${snapshot.generation} dimension ${snapshot.dimension}`,
      );
    }

    const candidates = this.normalizeCandidates(
      snapshot.search(vector, this.overfetchLimit(limit)),
    );
    const records = this.repository.resolveActiveChildren(
      snapshot.generation,
      candidates.map(candidate => candidate.childId),
      options.filter,
    );
    this.assertStillActive(snapshot.generation);

    const recordsById = new Map(
      records.map(record => [record.childId, record] as const),
    );
    return candidates
      .filter(candidate => recordsById.has(candidate.childId))
      .slice(0, limit)
      .map((candidate, index) => ({
        ...recordsById.get(candidate.childId)!,
        retrieval: 'dense',
        rank: index + 1,
        score: 1 / (1 + candidate.squaredL2),
        squaredL2: candidate.squaredL2,
      }));
  }

  private async embedQuery(query: string): Promise<number[]> {
    const vectors = await this.embeddings.embedDocuments([query]);
    if (vectors.length !== 1 || !Array.isArray(vectors[0])) {
      throw new Error('Embedding provider must return one query vector');
    }
    const vector = vectors[0];
    if (!vector.length || vector.some(value => !Number.isFinite(value))) {
      throw new Error('Query embedding must contain finite values');
    }
    return vector;
  }

  private assertActiveGeneration(
    snapshot: GenerationRead,
    expectedGeneration: string | null,
  ): void {
    if (
      snapshot.generation !== expectedGeneration ||
      !this.generations.isActiveGeneration(snapshot.generation)
    ) {
      throw new StaleRagGenerationError(
        expectedGeneration || snapshot.generation,
        this.repository.getCorpusState().activeGenerationId,
      );
    }
  }

  private assertStillActive(generation: string): void {
    if (!this.generations.isActiveGeneration(generation)) {
      throw new StaleRagGenerationError(
        generation,
        this.repository.getCorpusState().activeGenerationId,
      );
    }
  }

  private normalizeCandidates(
    candidates: Array<{ childId: string; squaredL2: number }>,
  ): Array<{ childId: string; squaredL2: number }> {
    const bestByChildId = new Map<string, number>();
    for (const candidate of candidates) {
      if (
        typeof candidate.childId !== 'string' ||
        !candidate.childId ||
        !Number.isFinite(candidate.squaredL2) ||
        candidate.squaredL2 < 0
      ) {
        continue;
      }
      const previous = bestByChildId.get(candidate.childId);
      if (previous === undefined || candidate.squaredL2 < previous) {
        bestByChildId.set(candidate.childId, candidate.squaredL2);
      }
    }
    return [...bestByChildId.entries()]
      .map(([childId, squaredL2]) => ({ childId, squaredL2 }))
      .sort((left, right) => {
        if (left.squaredL2 !== right.squaredL2) {
          return left.squaredL2 - right.squaredL2;
        }
        return left.childId < right.childId
          ? -1
          : left.childId > right.childId
            ? 1
            : 0;
      });
  }

  private boundedLimit(limit?: number): number {
    const requested =
      limit === undefined || !Number.isFinite(limit)
        ? DEFAULT_LIMIT
        : Math.floor(limit);
    return Math.min(MAX_LIMIT, Math.max(1, requested));
  }

  private overfetchLimit(limit: number): number {
    return Math.min(MAX_OVERFETCH, limit * OVERFETCH_MULTIPLIER);
  }
}
