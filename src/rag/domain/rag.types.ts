import { createHash } from 'crypto';

export type DocumentSourceType = 'pdf' | 'docx' | 'markdown' | 'text';
export type IngestionJobStatus =
  | 'running'
  | 'staging'
  | 'succeeded'
  | 'noop'
  | 'failed';
export type IndexGenerationStatus =
  | 'staging'
  | 'ready'
  | 'active'
  | 'retired'
  | 'failed';
export type CorpusGeneration = string;

export interface RagMetadataFilter {
  documentIds?: string[];
  category?: string;
  tags?: string[];
  updatedAfter?: string;
  updatedBefore?: string;
}

export interface RetrievalOptions {
  expectedGeneration?: CorpusGeneration;
  limit?: number;
  filter?: RagMetadataFilter;
}

export interface DocumentLoadInput {
  sourceIdentity: string;
  filePath?: string;
  content?: string | Buffer;
  fileName?: string;
  mimeType?: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface LoadedSection {
  ordinal: number;
  text: string;
  headingPath: string[];
  pageNumber?: number;
  startOffset: number;
  endOffset: number;
}

export interface LoadedDocument {
  sourceIdentity: string;
  fileName: string;
  sourceType: DocumentSourceType;
  mimeType: string;
  contentSha256: string;
  text: string;
  sections: LoadedSection[];
  category: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface ParentChunk {
  id: string;
  documentId: string;
  versionId: string;
  ordinal: number;
  content: string;
  headingPath: string[];
  estimatedTokens: number;
  startOffset: number;
  endOffset: number;
}

export interface ChildChunk {
  id: string;
  parentId: string;
  documentId: string;
  versionId: string;
  ordinal: number;
  content: string;
  estimatedTokens: number;
  startOffset: number;
  endOffset: number;
}

export interface ChunkedDocument {
  parents: ParentChunk[];
  children: ChildChunk[];
}

export interface DocumentRecord {
  id: string;
  sourceIdentity: string;
  displayName: string;
  sourceType: DocumentSourceType;
  mimeType: string;
  category: string;
  active: boolean;
  currentVersionId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  tags: string[];
}

export interface DocumentVersionRecord {
  id: string;
  documentId: string;
  contentSha256: string;
  content: string;
  active: boolean;
  parentCount: number;
  childCount: number;
  createdAt: string;
  activatedAt: string | null;
}

export interface ParentChunkRecord extends ParentChunk {
  active: boolean;
  createdAt: string;
}

export interface ChildChunkRecord extends ChildChunk {
  normalizedContent: string;
  active: boolean;
  createdAt: string;
}

export interface IngestionJobRecord {
  id: string;
  sourceIdentity: string;
  documentId: string | null;
  versionId: string | null;
  generationId: string | null;
  status: IngestionJobStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface IndexGenerationRecord {
  id: string;
  sequence: number;
  status: IndexGenerationStatus;
  embeddingModel: string | null;
  embeddingDimension: number | null;
  vectorCount: number;
  manifestSha256: string | null;
  indexPath: string | null;
  createdAt: string;
  activatedAt: string | null;
  failureReason: string | null;
}

export interface CorpusState {
  activeGenerationId: string | null;
  activeGenerationSequence: number;
  ftsTokenizer: string;
  schemaVersion: number;
  updatedAt: string;
}

export interface GenerationChunk {
  vectorOrdinal: number;
  child: ChildChunkRecord;
  parent: ParentChunkRecord;
  document: DocumentRecord;
}

export interface GenerationRead {
  generation: CorpusGeneration;
  dimension: number;
  size: number;
  search(
    vector: number[],
    limit: number,
  ): Array<{ childId: string; squaredL2: number }>;
}

export interface RagChildRecord {
  generation: CorpusGeneration;
  childId: string;
  parentId: string;
  documentId: string;
  versionId: string;
  content: string;
  normalizedContent: string;
  estimatedTokens: number;
  parentContent: string;
  parentEstimatedTokens: number;
  headingPath: string[];
  documentName: string;
  sourceIdentity: string;
  sourceType: DocumentSourceType;
  mimeType: string;
  category: string;
  tags: string[];
  metadata: Record<string, unknown>;
  documentUpdatedAt: string;
}

export interface ChildRetrievalHit extends RagChildRecord {
  retrieval: 'dense' | 'sparse';
  rank: number;
  score: number;
  squaredL2?: number;
  bm25?: number;
  matchedTerms?: string[];
}

export class StaleRagGenerationError extends Error {
  constructor(
    readonly expectedGeneration: CorpusGeneration,
    readonly activeGeneration: CorpusGeneration | null,
  ) {
    super(
      `RAG generation ${expectedGeneration} is stale; active generation is ${
        activeGeneration || 'none'
      }`,
    );
    this.name = 'StaleRagGenerationError';
  }
}

export interface GenerationManifest {
  formatVersion: 1;
  generationId: string;
  embeddingModel: string | null;
  dimension: number;
  vectorCount: number;
  childChunkIds: string[];
  indexSha256: string | null;
}

export interface StagedGeneration {
  generationId: string;
  stagingPath: string;
  indexPath: string | null;
  manifestPath: string;
  manifest: GenerationManifest;
  manifestSha256: string;
}

export interface EmbeddingProvider {
  embedDocuments(texts: string[]): Promise<number[][]>;
}

export interface IngestDocumentRequest extends DocumentLoadInput {
  embeddingModel?: string;
}

export interface IngestDocumentResult {
  jobId: string;
  documentId: string;
  versionId: string;
  generationId: string | null;
  activeGenerationId: string | null;
  parentCount: number;
  childCount: number;
  changed: boolean;
  status: 'indexed' | 'unchanged' | 'metadata-updated';
}

export interface RebuildIndexResult {
  jobId: string;
  generationId: string;
  activeGenerationId: string;
  vectorCount: number;
}

export const RAG_EMBEDDINGS = Symbol('RAG_EMBEDDINGS');
export const RAG_DATABASE_PATH = Symbol('RAG_DATABASE_PATH');
export const RAG_INDEX_ROOT = Symbol('RAG_INDEX_ROOT');

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function deterministicId(prefix: string, ...parts: unknown[]): string {
  const encoded = parts.map(part => stableJson(part)).join('\u001f');
  return `${prefix}_${sha256Hex(encoded).slice(0, 40)}`;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

export function normalizeSourceIdentity(sourceIdentity: string): string {
  const normalized = sourceIdentity.normalize('NFKC').trim();
  if (!normalized) {
    throw new Error('sourceIdentity must not be empty');
  }
  return normalized;
}

export function normalizeForSparseSearch(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}
