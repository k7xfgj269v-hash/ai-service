export const DEFAULT_RRF_K = 60;

export interface RrfRankedList<T> {
  source: string;
  items: readonly T[];
  weight?: number;
}

export interface RrfOptions<T> {
  getId: (item: T) => string;
  k?: number;
  limit?: number;
}

export interface RrfContribution {
  source: string;
  rank: number;
  weight: number;
  score: number;
}

export interface RrfResult<T> {
  id: string;
  item: T;
  rank: number;
  score: number;
  bestRank: number;
  sourceCount: number;
  contributions: readonly RrfContribution[];
}

interface RrfAccumulator<T> {
  id: string;
  item: T;
  bestRank: number;
  contributions: RrfContribution[];
}

export function reciprocalRankFusion<T>(
  rankedLists: readonly RrfRankedList<T>[],
  options: RrfOptions<T>,
): RrfResult<T>[] {
  const k = options.k ?? DEFAULT_RRF_K;
  validateK(k);

  const limit = options.limit;
  if (limit !== undefined) {
    validateLimit(limit);
    if (limit === 0) return [];
  }

  const lists = [...rankedLists].sort((left, right) =>
    compareText(left.source, right.source),
  );
  validateSources(lists);

  const accumulators = new Map<string, RrfAccumulator<T>>();

  for (const list of lists) {
    const source = list.source.trim();
    const weight = list.weight ?? 1;
    validateWeight(weight, source);
    const seenIds = new Set<string>();

    list.items.forEach((item, index) => {
      const id = options.getId(item).trim();
      if (!id) {
        throw new Error(`RRF item at ${source}[${index}] has an empty ID`);
      }
      if (seenIds.has(id)) return;
      seenIds.add(id);

      const rank = index + 1;
      const contribution: RrfContribution = {
        source,
        rank,
        weight,
        score: weight / (k + rank),
      };
      const existing = accumulators.get(id);

      if (existing) {
        existing.bestRank = Math.min(existing.bestRank, rank);
        existing.contributions.push(contribution);
        return;
      }

      accumulators.set(id, {
        id,
        item,
        bestRank: rank,
        contributions: [contribution],
      });
    });
  }

  const fused = [...accumulators.values()]
    .map(accumulator => {
      const contributions = accumulator.contributions.sort(
        (left, right) =>
          compareText(left.source, right.source) || left.rank - right.rank,
      );
      const score = contributions.reduce(
        (total, contribution) => total + contribution.score,
        0,
      );

      return {
        id: accumulator.id,
        item: accumulator.item,
        rank: 0,
        score,
        bestRank: accumulator.bestRank,
        sourceCount: new Set(
          contributions.map(contribution => contribution.source),
        ).size,
        contributions,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.sourceCount - left.sourceCount ||
        left.bestRank - right.bestRank ||
        compareText(left.id, right.id),
    );

  const selected = limit === undefined ? fused : fused.slice(0, limit);
  return selected.map((result, index) => ({ ...result, rank: index + 1 }));
}

function validateK(k: number): void {
  if (!Number.isFinite(k) || k < 0) {
    throw new Error('RRF k must be a finite non-negative number');
  }
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('RRF limit must be a non-negative integer');
  }
}

function validateSources<T>(lists: readonly RrfRankedList<T>[]): void {
  const sources = new Set<string>();
  for (const list of lists) {
    const source = list.source.trim();
    if (!source) {
      throw new Error('RRF source must not be empty');
    }
    if (sources.has(source)) {
      throw new Error(`RRF source "${source}" is duplicated`);
    }
    sources.add(source);
  }
}

function validateWeight(weight: number, source: string): void {
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error(`RRF weight for "${source}" must be finite and positive`);
  }
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
