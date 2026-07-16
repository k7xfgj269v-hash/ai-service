import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  ChildRetrievalHit,
  RagChildRecord,
  RetrievalOptions,
  StaleRagGenerationError,
} from '../domain/rag.types';
import {
  DEFAULT_RERANK_INPUT_LIMIT,
  DEFAULT_RERANK_OUTPUT_LIMIT,
  DisabledRerankerAdapter,
  RerankerAdapter,
} from '../ranking/reranker.adapter';
import {
  DEFAULT_RRF_K,
  reciprocalRankFusion,
  RrfContribution,
} from '../ranking/rrf';
import { DenseRetrieverService } from './dense-retriever.service';
import { SparseRetrieverService } from './sparse-retriever.service';

export const RAG_RERANKER = Symbol('RAG_RERANKER');
export const HYBRID_RETRIEVAL_DEFAULTS = Symbol(
  'HYBRID_RETRIEVAL_DEFAULTS',
);

export const DEFAULT_DENSE_CANDIDATES = 50;
export const DEFAULT_SPARSE_CANDIDATES = 50;
export const DEFAULT_FUSED_CANDIDATES = 40;
export const DEFAULT_RERANK_TIMEOUT_MS = 1500;

const MAX_CANDIDATES = 500;

export type HybridRetrieverName = 'dense' | 'sparse';
export type RerankerStatus = 'disabled' | 'applied' | 'fallback';
export type RerankerFallbackReason =
  | 'timeout'
  | 'error'
  | 'invalid-response';

export interface HybridRetrievalOptions extends RetrievalOptions {
  denseLimit?: number;
  sparseLimit?: number;
  fusedLimit?: number;
  rrfK?: number;
  rerank?: boolean;
  rerankInputLimit?: number;
  rerankOutputLimit?: number;
  rerankTimeoutMs?: number;
}

export interface HybridRetrievalDefaults {
  denseLimit: number;
  sparseLimit: number;
  fusedLimit: number;
  rrfK: number;
  rerank: boolean;
  rerankInputLimit: number;
  rerankOutputLimit: number;
  rerankTimeoutMs: number;
}

export interface HybridRetrievalHit extends RagChildRecord {
  rank: number;
  score: number;
  confidence: number;
  rrfScore: number;
  sourceCount: number;
  retrievals: readonly HybridRetrieverName[];
  contributions: readonly RrfContribution[];
  rerankerScore?: number;
}

export interface HybridRetrievalResult {
  hits: readonly HybridRetrievalHit[];
  degraded: boolean;
  successfulRetrievers: readonly HybridRetrieverName[];
  failedRetrievers: readonly HybridRetrieverName[];
  rerankerStatus: RerankerStatus;
  rerankerFallbackReason?: RerankerFallbackReason;
}

export interface HybridRetrieverFailure {
  source: HybridRetrieverName;
  error: unknown;
}

export class HybridRetrievalError extends Error {
  constructor(readonly failures: readonly HybridRetrieverFailure[]) {
    super(
      `All hybrid retrievers failed: ${failures
        .map(failure => failure.source)
        .join(', ')}`,
    );
    this.name = 'HybridRetrievalError';
  }
}

interface SettledRetriever {
  source: HybridRetrieverName;
  result: PromiseSettledResult<ChildRetrievalHit[]>;
}

@Injectable()
export class HybridRetrievalService {
  private readonly reranker: RerankerAdapter;
  private readonly defaults: HybridRetrievalDefaults;

  constructor(
    private readonly denseRetriever: DenseRetrieverService,
    private readonly sparseRetriever: SparseRetrieverService,
    @Optional()
    @Inject(RAG_RERANKER)
    reranker?: RerankerAdapter,
    @Optional()
    @Inject(HYBRID_RETRIEVAL_DEFAULTS)
    defaults: Partial<HybridRetrievalDefaults> = {},
  ) {
    this.reranker = reranker || new DisabledRerankerAdapter();
    this.defaults = {
      denseLimit: DEFAULT_DENSE_CANDIDATES,
      sparseLimit: DEFAULT_SPARSE_CANDIDATES,
      fusedLimit: DEFAULT_FUSED_CANDIDATES,
      rrfK: DEFAULT_RRF_K,
      rerank: this.reranker.enabled,
      rerankInputLimit: DEFAULT_RERANK_INPUT_LIMIT,
      rerankOutputLimit: DEFAULT_RERANK_OUTPUT_LIMIT,
      rerankTimeoutMs: DEFAULT_RERANK_TIMEOUT_MS,
      ...defaults,
    };
  }

  async retrieve(
    query: string,
    options: HybridRetrievalOptions = {},
  ): Promise<HybridRetrievalResult> {
    const normalizedQuery = String(query || '').normalize('NFKC').trim();
    if (!normalizedQuery) {
      throw new Error('RAG query must not be empty');
    }

    const denseLimit = this.boundedCandidates(
      options.denseLimit,
      this.defaults.denseLimit,
    );
    const sparseLimit = this.boundedCandidates(
      options.sparseLimit,
      this.defaults.sparseLimit,
    );
    const fusedLimit = this.boundedCandidates(
      options.fusedLimit ?? options.limit,
      this.defaults.fusedLimit,
    );
    const rrfK = this.nonNegativeNumber(options.rrfK, this.defaults.rrfK);
    const retrievalOptions: RetrievalOptions = {
      expectedGeneration: options.expectedGeneration,
      filter: options.filter,
    };

    const settledResults = await Promise.allSettled([
      this.denseRetriever
        .retrieve(normalizedQuery, {
          ...retrievalOptions,
          limit: denseLimit,
        })
        .then(hits =>
          this.assertExpectedGeneration(
            'dense',
            hits,
            options.expectedGeneration,
          ),
        ),
      Promise.resolve()
        .then(() =>
          this.sparseRetriever.retrieve(normalizedQuery, {
            ...retrievalOptions,
            limit: sparseLimit,
          }),
        )
        .then(hits =>
          this.assertExpectedGeneration(
            'sparse',
            hits,
            options.expectedGeneration,
          ),
        ),
    ]);
    const settled: SettledRetriever[] = [
      { source: 'dense', result: settledResults[0] },
      { source: 'sparse', result: settledResults[1] },
    ];
    const failures = settled
      .filter(
        (
          item,
        ): item is {
          source: HybridRetrieverName;
          result: PromiseRejectedResult;
        } => item.result.status === 'rejected',
      )
      .map(item => ({ source: item.source, error: item.result.reason }));

    if (failures.length === settled.length) {
      throw new HybridRetrievalError(failures);
    }

    const successful = settled
      .filter(
        (
          item,
        ): item is {
          source: HybridRetrieverName;
          result: PromiseFulfilledResult<ChildRetrievalHit[]>;
        } => item.result.status === 'fulfilled',
      )
      .sort((left, right) => compareText(left.source, right.source));
    const rankedLists = successful.map(item => ({
      source: item.source,
      items: this.normalizeRetrieverHits(item.result.value),
    }));
    const qualityByChild = new Map<string, number>();
    for (const list of rankedLists) {
      for (const hit of list.items) {
        qualityByChild.set(
          hit.childId,
          Math.max(
            qualityByChild.get(hit.childId) || 0,
            clampConfidence(hit.score),
          ),
        );
      }
    }

    const fused = reciprocalRankFusion(rankedLists, {
      getId: hit => hit.childId,
      k: rrfK,
      limit: fusedLimit,
    });
    const maximumRrfScore =
      successful.length === 0 ? 0 : successful.length / (rrfK + 1);
    const fusedHits = fused.map(result => {
      const rrfConfidence =
        maximumRrfScore > 0
          ? clampConfidence(result.score / maximumRrfScore)
          : 0;
      const confidence = clampConfidence(
        rrfConfidence * 0.5 +
          (qualityByChild.get(result.id) || 0) * 0.5,
      );
      return {
        ...result.item,
        rank: result.rank,
        score: confidence,
        confidence,
        rrfScore: result.score,
        sourceCount: result.sourceCount,
        retrievals: result.contributions
          .map(contribution => contribution.source as HybridRetrieverName)
          .sort(compareText),
        contributions: result.contributions,
      };
    });

    const reranked = await this.maybeRerank(
      normalizedQuery,
      fusedHits,
      options,
    );
    return {
      hits: reranked.hits,
      degraded: failures.length > 0,
      successfulRetrievers: successful.map(item => item.source),
      failedRetrievers: failures
        .map(failure => failure.source)
        .sort(compareText),
      rerankerStatus: reranked.status,
      ...(reranked.fallbackReason
        ? { rerankerFallbackReason: reranked.fallbackReason }
        : {}),
    };
  }

  private assertExpectedGeneration(
    source: HybridRetrieverName,
    hits: ChildRetrievalHit[],
    expectedGeneration?: string,
  ): ChildRetrievalHit[] {
    if (!expectedGeneration) {
      return hits;
    }
    const mismatched = hits.find(
      hit => hit.generation !== expectedGeneration,
    );
    if (mismatched) {
      throw new StaleRagGenerationError(
        expectedGeneration,
        mismatched.generation,
      );
    }
    return hits.map(hit => ({ ...hit, retrieval: source }));
  }

  private normalizeRetrieverHits(
    hits: readonly ChildRetrievalHit[],
  ): ChildRetrievalHit[] {
    const byId = new Map<string, ChildRetrievalHit>();
    for (const hit of hits) {
      const childId = hit.childId?.trim();
      if (!childId) {
        continue;
      }
      const existing = byId.get(childId);
      if (!existing || compareRetrieverHit(hit, existing) < 0) {
        byId.set(childId, hit);
      }
    }
    return [...byId.values()].sort(compareRetrieverHit);
  }

  private async maybeRerank(
    query: string,
    hits: readonly HybridRetrievalHit[],
    options: HybridRetrievalOptions,
  ): Promise<{
    hits: readonly HybridRetrievalHit[];
    status: RerankerStatus;
    fallbackReason?: RerankerFallbackReason;
  }> {
    const enabled =
      options.rerank ?? (this.defaults.rerank && this.reranker.enabled);
    if (!enabled || !this.reranker.enabled || hits.length === 0) {
      return { hits, status: 'disabled' };
    }

    const inputLimit = this.boundedCandidates(
      options.rerankInputLimit,
      this.defaults.rerankInputLimit,
    );
    const outputLimit = Math.min(
      inputLimit,
      this.boundedCandidates(
        options.rerankOutputLimit,
        this.defaults.rerankOutputLimit,
      ),
    );
    const timeoutMs = this.positiveInteger(
      options.rerankTimeoutMs,
      this.defaults.rerankTimeoutMs,
    );
    const candidates = hits.slice(0, inputLimit);
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;

    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new RerankerTimeoutError();
          controller.abort(error);
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      });
      const scores = await Promise.race([
        Promise.resolve().then(() =>
          this.reranker.rerank({
            query,
            candidates: candidates.map(hit => ({
              id: hit.childId,
              text: hit.content,
              metadata: {
                documentId: hit.documentId,
                parentId: hit.parentId,
                category: hit.category,
                tags: hit.tags,
              },
            })),
            topK: outputLimit,
            signal: controller.signal,
          }),
        ),
        timeout,
      ]);
      const scoresById = this.normalizeRerankerScores(
        scores,
        new Set(candidates.map(hit => hit.childId)),
      );
      if (scoresById.size === 0) {
        return {
          hits,
          status: 'fallback',
          fallbackReason: 'invalid-response',
        };
      }

      const reranked = [...candidates]
        .sort((left, right) => {
          const leftScore = scoresById.get(left.childId);
          const rightScore = scoresById.get(right.childId);
          if (leftScore !== undefined && rightScore === undefined) return -1;
          if (leftScore === undefined && rightScore !== undefined) return 1;
          if (
            leftScore !== undefined &&
            rightScore !== undefined &&
            leftScore !== rightScore
          ) {
            return rightScore - leftScore;
          }
          return left.rank - right.rank || compareText(left.childId, right.childId);
        })
        .slice(0, outputLimit)
        .map((hit, index) => ({
          ...hit,
          rank: index + 1,
          ...(scoresById.has(hit.childId)
            ? { rerankerScore: scoresById.get(hit.childId) }
            : {}),
        }));
      return { hits: reranked, status: 'applied' };
    } catch (error) {
      return {
        hits,
        status: 'fallback',
        fallbackReason:
          error instanceof RerankerTimeoutError ? 'timeout' : 'error',
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private normalizeRerankerScores(
    scores: readonly { id: string; score: number }[],
    allowedIds: ReadonlySet<string>,
  ): Map<string, number> {
    const normalized = new Map<string, number>();
    for (const item of scores) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (!id || !allowedIds.has(id) || !Number.isFinite(item.score)) {
        continue;
      }
      const previous = normalized.get(id);
      if (previous === undefined || item.score > previous) {
        normalized.set(id, item.score);
      }
    }
    return normalized;
  }

  private boundedCandidates(value: number | undefined, fallback: number): number {
    const normalized = this.positiveInteger(value, fallback);
    return Math.min(normalized, MAX_CANDIDATES);
  }

  private positiveInteger(value: number | undefined, fallback: number): number {
    const selected = value ?? fallback;
    if (!Number.isFinite(selected) || selected <= 0) {
      throw new Error('Hybrid retrieval limits must be positive numbers');
    }
    return Math.max(1, Math.floor(selected));
  }

  private nonNegativeNumber(value: number | undefined, fallback: number): number {
    const selected = value ?? fallback;
    if (!Number.isFinite(selected) || selected < 0) {
      throw new Error('RRF k must be a finite non-negative number');
    }
    return selected;
  }
}

class RerankerTimeoutError extends Error {}

function compareRetrieverHit(
  left: ChildRetrievalHit,
  right: ChildRetrievalHit,
): number {
  const leftRank = Number.isFinite(left.rank)
    ? Math.max(1, Math.floor(left.rank))
    : Number.MAX_SAFE_INTEGER;
  const rightRank = Number.isFinite(right.rank)
    ? Math.max(1, Math.floor(right.rank))
    : Number.MAX_SAFE_INTEGER;
  return (
    leftRank - rightRank ||
    clampConfidence(right.score) - clampConfidence(left.score) ||
    compareText(left.childId, right.childId)
  );
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
