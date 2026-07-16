import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  DocumentSourceType,
  ParentChunkRecord,
} from '../domain/rag.types';
import { HybridRetrievalHit } from '../retrieval/hybrid-retrieval.service';
import { RagRepository } from '../storage/rag.repository';

export const CONTEXT_PACKER_DEFAULTS = Symbol('CONTEXT_PACKER_DEFAULTS');

export const DEFAULT_CONTEXT_TOKEN_BUDGET = 6000;
export const DEFAULT_CONTEXT_PARENT_LIMIT = 6;
export const DEFAULT_CONTEXT_PARENTS_PER_DOCUMENT = 2;

export interface ContextPackingOptions {
  tokenBudget?: number;
  maxParents?: number;
  maxParentsPerDocument?: number;
}

export interface ContextPackerDefaults {
  tokenBudget: number;
  maxParents: number;
  maxParentsPerDocument: number;
}

export interface ContextPackingSelection {
  parentIds: readonly string[];
}

export interface PackedContextSource {
  sourceId: string;
  rank: number;
  parentId: string;
  documentId: string;
  versionId: string;
  childIds: readonly string[];
  content: string;
  headingPath: readonly string[];
  estimatedTokens: number;
  confidence: number;
  rrfScore: number;
  documentName: string;
  sourceIdentity: string;
  sourceType: DocumentSourceType;
  mimeType: string;
  category: string;
  tags: readonly string[];
  metadata: Readonly<Record<string, unknown>>;
  documentUpdatedAt: string;
}

export interface PackedContext {
  sources: readonly PackedContextSource[];
  context: string;
  estimatedTokens: number;
  tokenBudget: number;
  omittedParentCount: number;
}

interface ParentCandidate {
  parentId: string;
  documentId: string;
  representative: HybridRetrievalHit;
  hits: HybridRetrievalHit[];
  bestRank: number;
  confidence: number;
  rrfScore: number;
}

@Injectable()
export class ContextPackerService {
  private readonly defaults: ContextPackerDefaults;

  constructor(
    private readonly repository: RagRepository,
    @Optional()
    @Inject(CONTEXT_PACKER_DEFAULTS)
    defaults: Partial<ContextPackerDefaults> = {},
  ) {
    this.defaults = {
      tokenBudget: DEFAULT_CONTEXT_TOKEN_BUDGET,
      maxParents: DEFAULT_CONTEXT_PARENT_LIMIT,
      maxParentsPerDocument: DEFAULT_CONTEXT_PARENTS_PER_DOCUMENT,
      ...defaults,
    };
  }

  pack(
    hits: readonly HybridRetrievalHit[],
    options: ContextPackingOptions = {},
    selection?: ContextPackingSelection,
  ): PackedContext {
    const tokenBudget = this.nonNegativeInteger(
      options.tokenBudget,
      this.defaults.tokenBudget,
      'tokenBudget',
    );
    const maxParents = this.nonNegativeInteger(
      options.maxParents,
      this.defaults.maxParents,
      'maxParents',
    );
    const maxParentsPerDocument = this.nonNegativeInteger(
      options.maxParentsPerDocument,
      this.defaults.maxParentsPerDocument,
      'maxParentsPerDocument',
    );
    if (
      tokenBudget === 0 ||
      maxParents === 0 ||
      maxParentsPerDocument === 0 ||
      hits.length === 0
    ) {
      return {
        sources: [],
        context: '',
        estimatedTokens: 0,
        tokenBudget,
        omittedParentCount: new Set(hits.map(hit => hit.parentId)).size,
      };
    }

    const candidates = this.groupParentCandidates(hits);
    const hydrated = this.hydrateParents(candidates);
    const ordered = selection
      ? this.applySelection(hydrated, selection)
      : this.diversify(hydrated, maxParentsPerDocument);
    const selected: Array<{
      candidate: ParentCandidate;
      parent: ParentChunkRecord;
      tokens: number;
    }> = [];
    const documentCounts = new Map<string, number>();
    let estimatedTokens = 0;

    for (const item of ordered) {
      if (selected.length >= maxParents) {
        break;
      }
      const documentCount = documentCounts.get(item.candidate.documentId) || 0;
      if (documentCount >= maxParentsPerDocument) {
        continue;
      }
      const tokens = this.parentTokens(item.parent);
      if (estimatedTokens + tokens > tokenBudget) {
        continue;
      }
      selected.push({ ...item, tokens });
      estimatedTokens += tokens;
      documentCounts.set(item.candidate.documentId, documentCount + 1);
    }

    const sources = selected.map((item, index) =>
      this.toPackedSource(item.candidate, item.parent, item.tokens, index),
    );
    return {
      sources,
      context: sources.map(source => this.formatSource(source)).join('\n\n'),
      estimatedTokens,
      tokenBudget,
      omittedParentCount: Math.max(0, hydrated.length - sources.length),
    };
  }

  private groupParentCandidates(
    hits: readonly HybridRetrievalHit[],
  ): ParentCandidate[] {
    const orderedHits = [...hits].sort(
      (left, right) =>
        left.rank - right.rank || compareText(left.childId, right.childId),
    );
    const grouped = new Map<string, ParentCandidate>();

    for (const hit of orderedHits) {
      const parentId = hit.parentId?.trim();
      if (!parentId) {
        continue;
      }
      const existing = grouped.get(parentId);
      if (!existing) {
        grouped.set(parentId, {
          parentId,
          documentId: hit.documentId,
          representative: hit,
          hits: [hit],
          bestRank: hit.rank,
          confidence: clampConfidence(hit.confidence),
          rrfScore: finiteNonNegative(hit.rrfScore),
        });
        continue;
      }
      existing.hits.push(hit);
      existing.bestRank = Math.min(existing.bestRank, hit.rank);
      existing.confidence = Math.max(
        existing.confidence,
        clampConfidence(hit.confidence),
      );
      existing.rrfScore = Math.max(
        existing.rrfScore,
        finiteNonNegative(hit.rrfScore),
      );
      if (
        hit.rank < existing.representative.rank ||
        (hit.rank === existing.representative.rank &&
          compareText(hit.childId, existing.representative.childId) < 0)
      ) {
        existing.representative = hit;
      }
    }

    return [...grouped.values()].sort(
      (left, right) =>
        left.bestRank - right.bestRank ||
        compareText(left.parentId, right.parentId),
    );
  }

  private hydrateParents(
    candidates: readonly ParentCandidate[],
  ): Array<{ candidate: ParentCandidate; parent: ParentChunkRecord }> {
    const parents = this.repository.getParentChunksByIds(
      candidates.map(candidate => candidate.parentId),
    );
    const byId = new Map(parents.map(parent => [parent.id, parent] as const));
    return candidates.flatMap(candidate => {
      const parent = byId.get(candidate.parentId);
      if (
        !parent ||
        parent.documentId !== candidate.documentId ||
        parent.versionId !== candidate.representative.versionId
      ) {
        return [];
      }
      return [{ candidate, parent }];
    });
  }

  private diversify(
    hydrated: readonly {
      candidate: ParentCandidate;
      parent: ParentChunkRecord;
    }[],
    maxParentsPerDocument: number,
  ): Array<{ candidate: ParentCandidate; parent: ParentChunkRecord }> {
    const documentOrder: string[] = [];
    const byDocument = new Map<
      string,
      Array<{ candidate: ParentCandidate; parent: ParentChunkRecord }>
    >();
    for (const item of hydrated) {
      if (!byDocument.has(item.candidate.documentId)) {
        documentOrder.push(item.candidate.documentId);
        byDocument.set(item.candidate.documentId, []);
      }
      byDocument.get(item.candidate.documentId)!.push(item);
    }

    const diversified: Array<{
      candidate: ParentCandidate;
      parent: ParentChunkRecord;
    }> = [];
    for (let round = 0; round < maxParentsPerDocument; round += 1) {
      for (const documentId of documentOrder) {
        const item = byDocument.get(documentId)?.[round];
        if (item) {
          diversified.push(item);
        }
      }
    }
    return diversified;
  }

  private applySelection(
    hydrated: readonly {
      candidate: ParentCandidate;
      parent: ParentChunkRecord;
    }[],
    selection: ContextPackingSelection,
  ): Array<{ candidate: ParentCandidate; parent: ParentChunkRecord }> {
    const byParent = new Map(
      hydrated.map(item => [item.candidate.parentId, item] as const),
    );
    const seen = new Set<string>();
    return selection.parentIds.flatMap(parentId => {
      const normalized = String(parentId || '').trim();
      if (!normalized || seen.has(normalized)) {
        return [];
      }
      seen.add(normalized);
      const item = byParent.get(normalized);
      return item ? [item] : [];
    });
  }

  private toPackedSource(
    candidate: ParentCandidate,
    parent: ParentChunkRecord,
    estimatedTokens: number,
    index: number,
  ): PackedContextSource {
    const representative = candidate.representative;
    return {
      sourceId: `S${index + 1}`,
      rank: index + 1,
      parentId: parent.id,
      documentId: parent.documentId,
      versionId: parent.versionId,
      childIds: candidate.hits
        .slice()
        .sort(
          (left, right) =>
            left.rank - right.rank ||
            compareText(left.childId, right.childId),
        )
        .map(hit => hit.childId),
      content: parent.content,
      headingPath: [...parent.headingPath],
      estimatedTokens,
      confidence: candidate.confidence,
      rrfScore: candidate.rrfScore,
      documentName: representative.documentName,
      sourceIdentity: representative.sourceIdentity,
      sourceType: representative.sourceType,
      mimeType: representative.mimeType,
      category: representative.category,
      tags: [...representative.tags],
      metadata: { ...representative.metadata },
      documentUpdatedAt: representative.documentUpdatedAt,
    };
  }

  private formatSource(source: PackedContextSource): string {
    return JSON.stringify({
      id: source.sourceId,
      document: source.documentName,
      heading: source.headingPath,
      content: source.content,
    });
  }

  private parentTokens(parent: ParentChunkRecord): number {
    if (
      Number.isFinite(parent.estimatedTokens) &&
      parent.estimatedTokens > 0
    ) {
      return Math.max(1, Math.ceil(parent.estimatedTokens));
    }
    return Math.max(1, Math.ceil([...parent.content].length / 2));
  }

  private nonNegativeInteger(
    value: number | undefined,
    fallback: number,
    name: string,
  ): number {
    const selected = value ?? fallback;
    if (!Number.isFinite(selected) || selected < 0) {
      throw new Error(`${name} must be a finite non-negative number`);
    }
    return Math.floor(selected);
  }
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
