import { Injectable } from '@nestjs/common';
import {
  ChildRetrievalHit,
  RetrievalOptions,
  StaleRagGenerationError,
} from '../domain/rag.types';
import { RagRepository } from '../storage/rag.repository';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_QUERY_LENGTH = 512;
const MAX_TERM_LENGTH = 64;
const MAX_FTS_TERMS = 32;
const MAX_LITERAL_TERMS = 16;
const HAN_CHARACTER = /\p{Script=Han}/u;
const LETTER_OR_NUMBER = /[\p{Letter}\p{Number}]/u;

interface SparseSearchPlan {
  matchQuery: string;
  literalTerms: string[];
}

@Injectable()
export class SparseRetrieverService {
  constructor(private readonly repository: RagRepository) {}

  retrieve(
    query: string,
    options: RetrievalOptions = {},
  ): ChildRetrievalHit[] {
    const plan = this.buildSearchPlan(query);
    if (!plan.matchQuery && !plan.literalTerms.length) {
      return [];
    }

    const limit = this.boundLimit(options.limit);
    let generation =
      options.expectedGeneration ||
      this.repository.getCorpusState().activeGenerationId;
    if (!generation) {
      return [];
    }

    let hits: ChildRetrievalHit[];
    try {
      hits = this.search(generation, plan, limit, options);
    } catch (error) {
      if (!(error instanceof StaleRagGenerationError)) {
        throw error;
      }
      generation = this.repository.getCorpusState().activeGenerationId;
      if (!generation) {
        return [];
      }
      hits = this.search(generation, plan, limit, options);
    }

    return this.normalizeHits(hits, limit);
  }

  private search(
    generation: string,
    plan: SparseSearchPlan,
    limit: number,
    options: RetrievalOptions,
  ): ChildRetrievalHit[] {
    return this.repository.searchActiveChildrenSparse(
      generation,
      plan.matchQuery,
      plan.literalTerms,
      limit,
      options.filter,
    );
  }

  private buildSearchPlan(query: string): SparseSearchPlan {
    const normalized = this.normalizeQuery(query);
    const ftsTerms: string[] = [];
    const literalTerms: string[] = [];
    const seenFts = new Set<string>();
    const seenLiteral = new Set<string>();

    for (const token of this.extractTokens(normalized)) {
      const characters = [...token.value];
      if (token.han && characters.length >= 3) {
        for (let index = 0; index <= characters.length - 3; index += 1) {
          this.addBoundedTerm(
            characters.slice(index, index + 3).join(''),
            ftsTerms,
            seenFts,
            MAX_FTS_TERMS,
          );
        }
      } else if (characters.length <= 2) {
        this.addBoundedTerm(
          token.value,
          literalTerms,
          seenLiteral,
          MAX_LITERAL_TERMS,
        );
      } else {
        this.addBoundedTerm(
          characters.slice(0, MAX_TERM_LENGTH).join(''),
          ftsTerms,
          seenFts,
          MAX_FTS_TERMS,
        );
      }
      if (
        ftsTerms.length >= MAX_FTS_TERMS &&
        literalTerms.length >= MAX_LITERAL_TERMS
      ) {
        break;
      }
    }

    return {
      matchQuery: ftsTerms.map(term => this.quoteFtsTerm(term)).join(' OR '),
      literalTerms,
    };
  }

  private normalizeQuery(query: string): string {
    return [...String(query || '').normalize('NFKC').trim().replace(/\s+/g, ' ')]
      .slice(0, MAX_QUERY_LENGTH)
      .join('')
      .trim()
      .toLowerCase();
  }

  private extractTokens(
    query: string,
  ): Array<{ value: string; han: boolean }> {
    const tokens: Array<{ value: string; han: boolean }> = [];
    let value = '';
    let han: boolean | null = null;

    const flush = () => {
      if (value) {
        tokens.push({ value, han: Boolean(han) });
        value = '';
        han = null;
      }
    };

    for (const character of query) {
      const isHan = HAN_CHARACTER.test(character);
      if (!isHan && !LETTER_OR_NUMBER.test(character)) {
        flush();
        continue;
      }
      if (han !== null && han !== isHan) {
        flush();
      }
      han = isHan;
      value += character;
    }
    flush();
    return tokens;
  }

  private addBoundedTerm(
    term: string,
    terms: string[],
    seen: Set<string>,
    maximum: number,
  ): void {
    if (!term || terms.length >= maximum || seen.has(term)) {
      return;
    }
    seen.add(term);
    terms.push(term);
  }

  private quoteFtsTerm(term: string): string {
    return `"${term.replace(/"/g, '""')}"`;
  }

  private boundLimit(limit?: number): number {
    if (!Number.isFinite(limit)) {
      return DEFAULT_LIMIT;
    }
    return Math.max(1, Math.min(Math.floor(limit), MAX_LIMIT));
  }

  private normalizeHits(
    hits: ChildRetrievalHit[],
    limit: number,
  ): ChildRetrievalHit[] {
    const grouped = new Map<
      string,
      { hit: ChildRetrievalHit; matchedTerms: Set<string> }
    >();

    for (const hit of hits) {
      const existing = grouped.get(hit.childId);
      if (!existing) {
        grouped.set(hit.childId, {
          hit,
          matchedTerms: new Set(hit.matchedTerms || []),
        });
        continue;
      }
      for (const term of hit.matchedTerms || []) {
        existing.matchedTerms.add(term);
      }
      if (this.compareHits(hit, existing.hit) < 0) {
        existing.hit = hit;
      }
    }

    const ordered = [...grouped.values()]
      .map(entry => ({
        ...entry.hit,
        ...(entry.matchedTerms.size
          ? { matchedTerms: [...entry.matchedTerms].sort(this.compareText) }
          : {}),
      }))
      .sort((left, right) => this.compareHits(left, right))
      .slice(0, limit);
    const finiteBm25 = ordered
      .map(hit => hit.bm25)
      .filter((value): value is number => Number.isFinite(value));
    const bestBm25 = finiteBm25.length
      ? Math.min(...finiteBm25)
      : null;

    return ordered.map((hit, index) => {
      const bm25 = Number.isFinite(hit.bm25) ? hit.bm25 : undefined;
      const score =
        bm25 !== undefined && bestBm25 !== null
          ? 1 / (1 + Math.max(0, bm25 - bestBm25))
          : bestBm25 === null
            ? 1
            : 0;
      const normalized: ChildRetrievalHit = {
        ...hit,
        rank: index + 1,
        score: Math.max(0, Math.min(1, score)),
      };
      if (bm25 === undefined) {
        delete normalized.bm25;
      }
      return normalized;
    });
  }

  private compareHits(
    left: ChildRetrievalHit,
    right: ChildRetrievalHit,
  ): number {
    const leftHasBm25 = Number.isFinite(left.bm25);
    const rightHasBm25 = Number.isFinite(right.bm25);
    if (leftHasBm25 !== rightHasBm25) {
      return leftHasBm25 ? -1 : 1;
    }
    if (leftHasBm25 && rightHasBm25 && left.bm25 !== right.bm25) {
      return (left.bm25 as number) - (right.bm25 as number);
    }
    return this.compareText(left.childId, right.childId);
  }

  private compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
  }
}
