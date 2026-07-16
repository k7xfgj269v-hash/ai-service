import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as path from 'path';
import {
  ChildChunk,
  ChildChunkRecord,
  ChunkedDocument,
  ChildRetrievalHit,
  CorpusGeneration,
  CorpusState,
  deterministicId,
  DocumentRecord,
  DocumentVersionRecord,
  GenerationChunk,
  IndexGenerationRecord,
  IngestionJobRecord,
  IngestionJobStatus,
  LoadedDocument,
  normalizeForSparseSearch,
  normalizeSourceIdentity,
  ParentChunk,
  ParentChunkRecord,
  RAG_DATABASE_PATH,
  RagChildRecord,
  RagMetadataFilter,
  stableJson,
  StaleRagGenerationError,
} from '../domain/rag.types';
import { RAG_SCHEMA_VERSION, runRagMigrations } from './rag.migrations';

interface PendingDocumentActivation {
  documentId: string;
  versionId: string;
  displayName: string;
  sourceType: LoadedDocument['sourceType'];
  mimeType: string;
  category: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

interface ActivateGenerationInput {
  generationId: string;
  indexPath: string;
  manifestSha256: string;
  embeddingDimension: number;
  vectorCount: number;
  jobId: string;
  document?: PendingDocumentActivation;
}

interface DocumentListFilter {
  category?: string;
  tags?: string[];
  includeInactive?: boolean;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(item => String(item)) : [];
  } catch {
    return [];
  }
}

function normalizeTags(tags: string[] = []): Array<{
  tag: string;
  normalized: string;
}> {
  const unique = new Map<string, string>();
  for (const value of tags) {
    const tag = String(value).normalize('NFKC').trim();
    const normalized = tag.toLowerCase();
    if (tag && !unique.has(normalized)) {
      unique.set(normalized, tag);
    }
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([normalized, tag]) => ({ tag, normalized }));
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

@Injectable()
export class RagRepository implements OnModuleDestroy {
  readonly db: Database.Database;
  private readonly ownsConnection: boolean;

  constructor(
    @Optional()
    @Inject(RAG_DATABASE_PATH)
    databasePathOrConnection?:
      | string
      | Database.Database,
  ) {
    if (
      databasePathOrConnection &&
      typeof databasePathOrConnection !== 'string'
    ) {
      this.db = databasePathOrConnection;
      this.ownsConnection = false;
    } else {
      const databasePath =
        typeof databasePathOrConnection === 'string'
          ? databasePathOrConnection
          : path.join(process.cwd(), 'data', 'knowledge-base.db');
      this.db = new Database(databasePath);
      this.ownsConnection = true;
    }
    runRagMigrations(this.db);
  }

  static documentId(sourceIdentity: string): string {
    return deterministicId('doc', normalizeSourceIdentity(sourceIdentity));
  }

  static versionId(documentId: string, contentSha256: string): string {
    return deterministicId('ver', documentId, contentSha256);
  }

  onModuleDestroy(): void {
    this.close();
  }

  close(): void {
    if (this.ownsConnection && this.db.open) {
      this.db.close();
    }
  }

  healthCheck(): boolean {
    const row = this.db.prepare('SELECT 1 AS ok').get() as { ok: number };
    return row.ok === 1;
  }

  getCorpusState(): CorpusState {
    const row = this.db
      .prepare('SELECT * FROM corpus_state WHERE singleton = 1')
      .get() as Record<string, unknown>;
    return {
      activeGenerationId: (row.active_generation_id as string) || null,
      activeGenerationSequence: Number(row.active_generation_sequence || 0),
      ftsTokenizer: String(row.fts_tokenizer || 'trigram'),
      schemaVersion: Number(row.schema_version || RAG_SCHEMA_VERSION),
      updatedAt: String(row.updated_at),
    };
  }

  getActiveGeneration(): IndexGenerationRecord | null {
    const state = this.getCorpusState();
    return state.activeGenerationId
      ? this.getGeneration(state.activeGenerationId)
      : null;
  }

  getGeneration(generationId: string): IndexGenerationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM index_generations WHERE id = ?')
      .get(generationId) as Record<string, unknown> | undefined;
    return row ? this.mapGeneration(row) : null;
  }

  getDocument(documentId: string): DocumentRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT d.*, COALESCE(json_group_array(t.tag)
            FILTER (WHERE t.tag IS NOT NULL), '[]') AS tags_json
          FROM documents d
          LEFT JOIN tags t ON t.document_id = d.id
          WHERE d.id = ?
          GROUP BY d.id
        `,
      )
      .get(documentId) as Record<string, unknown> | undefined;
    return row ? this.mapDocument(row) : null;
  }

  findDocumentBySourceIdentity(sourceIdentity: string): DocumentRecord | null {
    const normalized = normalizeSourceIdentity(sourceIdentity);
    const row = this.db
      .prepare(
        `
          SELECT d.*, COALESCE(json_group_array(t.tag)
            FILTER (WHERE t.tag IS NOT NULL), '[]') AS tags_json
          FROM documents d
          LEFT JOIN tags t ON t.document_id = d.id
          WHERE d.source_identity = ?
          GROUP BY d.id
        `,
      )
      .get(normalized) as Record<string, unknown> | undefined;
    return row ? this.mapDocument(row) : null;
  }

  listDocuments(filter: DocumentListFilter = {}): DocumentRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!filter.includeInactive) {
      where.push('d.active = 1');
    }
    if (filter.category) {
      where.push('d.category = ?');
      params.push(filter.category);
    }
    const rows = this.db
      .prepare(
        `
          SELECT d.*, COALESCE(json_group_array(t.tag)
            FILTER (WHERE t.tag IS NOT NULL), '[]') AS tags_json
          FROM documents d
          LEFT JOIN tags t ON t.document_id = d.id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          GROUP BY d.id
          ORDER BY d.updated_at DESC, d.id ASC
        `,
      )
      .all(...params) as Array<Record<string, unknown>>;
    const documents = rows.map(row => this.mapDocument(row));
    const requiredTags = normalizeTags(filter.tags).map(tag => tag.normalized);
    if (!requiredTags.length) {
      return documents;
    }
    return documents.filter(document => {
      const documentTags = new Set(
        document.tags.map(tag => tag.normalize('NFKC').toLowerCase()),
      );
      return requiredTags.every(tag => documentTags.has(tag));
    });
  }

  getDocumentVersion(versionId: string): DocumentVersionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM document_versions WHERE id = ?')
      .get(versionId) as Record<string, unknown> | undefined;
    return row ? this.mapVersion(row) : null;
  }

  getCurrentVersion(documentId: string): DocumentVersionRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT v.*
          FROM documents d
          JOIN document_versions v ON v.id = d.current_version_id
          WHERE d.id = ?
        `,
      )
      .get(documentId) as Record<string, unknown> | undefined;
    return row ? this.mapVersion(row) : null;
  }

  createIngestionJob(
    sourceIdentity: string,
    request: Record<string, unknown> = {},
  ): IngestionJobRecord {
    const normalized = normalizeSourceIdentity(sourceIdentity);
    const id = deterministicId(
      'job',
      normalized,
      new Date().toISOString(),
      process.hrtime.bigint().toString(),
    );
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
          INSERT INTO ingestion_jobs (
            id, source_identity, status, request_json, created_at, updated_at
          ) VALUES (?, ?, 'running', ?, ?, ?)
        `,
      )
      .run(id, normalized, stableJson(request), now, now);
    return this.getIngestionJob(id)!;
  }

  getIngestionJob(jobId: string): IngestionJobRecord | null {
    const row = this.db
      .prepare('SELECT * FROM ingestion_jobs WHERE id = ?')
      .get(jobId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      id: String(row.id),
      sourceIdentity: String(row.source_identity),
      documentId: (row.document_id as string) || null,
      versionId: (row.version_id as string) || null,
      generationId: (row.generation_id as string) || null,
      status: row.status as IngestionJobStatus,
      error: (row.error as string) || null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: (row.completed_at as string) || null,
    };
  }

  completeJobWithoutGeneration(
    jobId: string,
    documentId: string,
    versionId: string,
    status: 'noop' | 'succeeded',
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
          UPDATE ingestion_jobs
          SET document_id = ?, version_id = ?, status = ?, error = NULL,
              updated_at = ?, completed_at = ?
          WHERE id = ?
        `,
      )
      .run(documentId, versionId, status, now, now, jobId);
  }

  failJob(jobId: string, error: unknown): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
          UPDATE ingestion_jobs
          SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
          WHERE id = ?
        `,
      )
      .run(this.errorMessage(error), now, now, jobId);
  }

  stageDocumentVersion(
    loaded: LoadedDocument,
    chunked: ChunkedDocument,
    jobId: string,
  ): { documentId: string; versionId: string } {
    const sourceIdentity = normalizeSourceIdentity(loaded.sourceIdentity);
    const existing = this.findDocumentBySourceIdentity(sourceIdentity);
    const documentId = existing?.id || RagRepository.documentId(sourceIdentity);
    const versionId = RagRepository.versionId(
      documentId,
      loaded.contentSha256,
    );
    const now = new Date().toISOString();

    const stage = this.db.transaction(() => {
      this.db
        .prepare(
          `
            INSERT INTO documents (
              id, source_identity, display_name, source_type, mime_type,
              category, active, metadata_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
            ON CONFLICT(source_identity) DO NOTHING
          `,
        )
        .run(
          documentId,
          sourceIdentity,
          loaded.fileName,
          loaded.sourceType,
          loaded.mimeType,
          loaded.category,
          stableJson(loaded.metadata),
          now,
          now,
        );

      this.db
        .prepare(
          `
            INSERT INTO document_versions (
              id, document_id, content_sha256, content, active,
              parent_count, child_count, created_at
            ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)
            ON CONFLICT(document_id, content_sha256) DO UPDATE SET
              content = excluded.content,
              parent_count = excluded.parent_count,
              child_count = excluded.child_count
          `,
        )
        .run(
          versionId,
          documentId,
          loaded.contentSha256,
          loaded.text,
          chunked.parents.length,
          chunked.children.length,
          now,
        );

      const insertParent = this.db.prepare(`
        INSERT INTO parent_chunks (
          id, version_id, document_id, ordinal, content,
          heading_path_json, estimated_tokens, start_offset, end_offset,
          active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          heading_path_json = excluded.heading_path_json,
          estimated_tokens = excluded.estimated_tokens,
          start_offset = excluded.start_offset,
          end_offset = excluded.end_offset
      `);
      for (const parent of chunked.parents) {
        insertParent.run(
          parent.id,
          versionId,
          documentId,
          parent.ordinal,
          parent.content,
          stableJson(parent.headingPath),
          parent.estimatedTokens,
          parent.startOffset,
          parent.endOffset,
          now,
        );
      }

      const insertChild = this.db.prepare(`
        INSERT INTO child_chunks (
          id, parent_id, version_id, document_id, ordinal, content,
          normalized_content,
          estimated_tokens, start_offset, end_offset, active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          normalized_content = excluded.normalized_content,
          estimated_tokens = excluded.estimated_tokens,
          start_offset = excluded.start_offset,
          end_offset = excluded.end_offset
      `);
      for (const child of chunked.children) {
        insertChild.run(
          child.id,
          child.parentId,
          versionId,
          documentId,
          child.ordinal,
          child.content,
          normalizeForSparseSearch(child.content),
          child.estimatedTokens,
          child.startOffset,
          child.endOffset,
          now,
        );
      }

      this.db
        .prepare(
          `
            UPDATE ingestion_jobs
            SET document_id = ?, version_id = ?, status = 'staging',
                updated_at = ?
            WHERE id = ?
          `,
        )
        .run(documentId, versionId, now, jobId);
    });
    stage();
    return { documentId, versionId };
  }

  updateDocumentMetadata(
    documentId: string,
    loaded: LoadedDocument,
    jobId: string,
  ): void {
    const now = new Date().toISOString();
    const update = this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE documents
            SET display_name = ?, source_type = ?, mime_type = ?,
                category = ?, metadata_json = ?, updated_at = ?
            WHERE id = ? AND active = 1
          `,
        )
        .run(
          loaded.fileName,
          loaded.sourceType,
          loaded.mimeType,
          loaded.category,
          stableJson(loaded.metadata),
          now,
          documentId,
        );
      this.replaceTags(documentId, loaded.tags);
      const version = this.getCurrentVersion(documentId);
      if (!version) {
        throw new Error(`Active document ${documentId} has no current version`);
      }
      this.completeJobWithoutGeneration(
        jobId,
        documentId,
        version.id,
        'succeeded',
      );
    });
    update();
  }

  metadataMatches(document: DocumentRecord, loaded: LoadedDocument): boolean {
    const leftTags = normalizeTags(document.tags).map(tag => tag.normalized);
    const rightTags = normalizeTags(loaded.tags).map(tag => tag.normalized);
    return (
      document.displayName === loaded.fileName &&
      document.sourceType === loaded.sourceType &&
      document.mimeType === loaded.mimeType &&
      document.category === loaded.category &&
      stableJson(document.metadata) === stableJson(loaded.metadata) &&
      stableJson(leftTags) === stableJson(rightTags)
    );
  }

  createGeneration(
    embeddingModel: string | null,
    jobId: string,
  ): IndexGenerationRecord {
    const create = this.db.transaction(() => {
      const row = this.db
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM index_generations',
        )
        .get() as { next_sequence: number };
      const sequence = Number(row.next_sequence);
      const id = `gen_${String(sequence).padStart(12, '0')}`;
      const now = new Date().toISOString();
      this.db
        .prepare(
          `
            INSERT INTO index_generations (
              id, sequence, status, embedding_model, created_at
            ) VALUES (?, ?, 'staging', ?, ?)
          `,
        )
        .run(id, sequence, embeddingModel, now);
      this.db
        .prepare(
          `
            UPDATE ingestion_jobs
            SET generation_id = ?, status = 'staging', updated_at = ?
            WHERE id = ?
          `,
        )
        .run(id, now, jobId);
      return this.getGeneration(id)!;
    });
    return create();
  }

  listGenerationCandidates(pending?: {
    documentId: string;
    versionId: string;
  }): GenerationChunk[] {
    const params: unknown[] = [];
    const activeClause = pending
      ? 'c.active = 1 AND d.active = 1 AND c.document_id <> ?'
      : 'c.active = 1 AND d.active = 1';
    if (pending) {
      params.push(pending.documentId, pending.versionId);
    }
    const pendingClause = pending ? 'OR c.version_id = ?' : '';
    const rows = this.db
      .prepare(
        `
          SELECT
            c.id AS child_id,
            c.parent_id AS child_parent_id,
            c.version_id AS child_version_id,
            c.document_id AS child_document_id,
            c.ordinal AS child_ordinal,
            c.content AS child_content,
            c.normalized_content AS child_normalized_content,
            c.estimated_tokens AS child_estimated_tokens,
            c.start_offset AS child_start_offset,
            c.end_offset AS child_end_offset,
            c.active AS child_active,
            c.created_at AS child_created_at,
            p.id AS parent_id,
            p.version_id AS parent_version_id,
            p.document_id AS parent_document_id,
            p.ordinal AS parent_ordinal,
            p.content AS parent_content,
            p.heading_path_json AS parent_heading_path_json,
            p.estimated_tokens AS parent_estimated_tokens,
            p.start_offset AS parent_start_offset,
            p.end_offset AS parent_end_offset,
            p.active AS parent_active,
            p.created_at AS parent_created_at,
            d.*,
            COALESCE(json_group_array(t.tag)
              FILTER (WHERE t.tag IS NOT NULL), '[]') AS tags_json
          FROM child_chunks c
          JOIN parent_chunks p ON p.id = c.parent_id
          JOIN document_versions v ON v.id = c.version_id
          JOIN documents d ON d.id = c.document_id
          LEFT JOIN tags t ON t.document_id = d.id
          WHERE (
            (
              ${activeClause}
              AND p.active = 1
              AND v.active = 1
            )
            ${pendingClause}
          )
          GROUP BY c.id
          ORDER BY c.document_id ASC, c.version_id ASC,
                   p.ordinal ASC, c.ordinal ASC, c.id ASC
        `,
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((row, vectorOrdinal) => ({
      vectorOrdinal,
      child: this.mapChild(row, 'child_'),
      parent: this.mapParent(row, 'parent_'),
      document: this.mapDocument(row),
    }));
  }

  stageGenerationSnapshot(
    generationId: string,
    chunks: GenerationChunk[],
  ): void {
    const stage = this.db.transaction(() => {
      const generation = this.getGeneration(generationId);
      if (!generation || generation.status !== 'staging') {
        throw new Error(`Generation ${generationId} is not staging`);
      }
      this.db
        .prepare('DELETE FROM generation_chunks WHERE generation_id = ?')
        .run(generationId);
      this.db
        .prepare('DELETE FROM child_chunks_fts WHERE generation_id = ?')
        .run(generationId);

      const insertMapping = this.db.prepare(`
        INSERT INTO generation_chunks (
          generation_id, vector_ordinal, child_chunk_id
        ) VALUES (?, ?, ?)
      `);
      const insertFts = this.db.prepare(`
        INSERT INTO child_chunks_fts (
          content, child_chunk_id, generation_id
        ) VALUES (?, ?, ?)
      `);
      chunks.forEach((chunk, ordinal) => {
        if (chunk.vectorOrdinal !== ordinal) {
          throw new Error('Generation vector ordinals must be contiguous');
        }
        insertMapping.run(generationId, ordinal, chunk.child.id);
        insertFts.run(chunk.child.content, chunk.child.id, generationId);
      });
    });
    stage();
  }

  markGenerationReady(
    generationId: string,
    input: {
      embeddingDimension: number;
      vectorCount: number;
      manifestSha256: string;
    },
  ): void {
    const result = this.db
      .prepare(
        `
          UPDATE index_generations
          SET status = 'ready', embedding_dimension = ?, vector_count = ?,
              manifest_sha256 = ?, failure_reason = NULL
          WHERE id = ? AND status = 'staging'
        `,
      )
      .run(
        input.embeddingDimension,
        input.vectorCount,
        input.manifestSha256,
        generationId,
      );
    if (result.changes !== 1) {
      throw new Error(`Generation ${generationId} could not be marked ready`);
    }
  }

  activateGeneration(input: ActivateGenerationInput): CorpusState {
    const activate = this.db.transaction(() => {
      const generation = this.getGeneration(input.generationId);
      if (!generation || generation.status !== 'ready') {
        throw new Error(`Generation ${input.generationId} is not ready`);
      }
      const mappingCount = Number(
        (
          this.db
            .prepare(
              'SELECT COUNT(*) AS count FROM generation_chunks WHERE generation_id = ?',
            )
            .get(input.generationId) as { count: number }
        ).count,
      );
      if (
        mappingCount !== input.vectorCount ||
        generation.vectorCount !== input.vectorCount
      ) {
        throw new Error(
          `Generation ${input.generationId} vector count does not match its snapshot`,
        );
      }

      const now = new Date().toISOString();
      if (input.document) {
        const pending = input.document;
        this.db
          .prepare(
            'UPDATE document_versions SET active = 0 WHERE document_id = ?',
          )
          .run(pending.documentId);
        this.db
          .prepare('UPDATE parent_chunks SET active = 0 WHERE document_id = ?')
          .run(pending.documentId);
        this.db
          .prepare('UPDATE child_chunks SET active = 0 WHERE document_id = ?')
          .run(pending.documentId);
        const versionResult = this.db
          .prepare(
            `
              UPDATE document_versions
              SET active = 1, activated_at = ?
              WHERE id = ? AND document_id = ?
            `,
          )
          .run(now, pending.versionId, pending.documentId);
        if (versionResult.changes !== 1) {
          throw new Error(`Pending version ${pending.versionId} was not found`);
        }
        this.db
          .prepare(
            `
              UPDATE parent_chunks
              SET active = 1
              WHERE version_id = ?
                AND id IN (
                  SELECT c.parent_id
                  FROM generation_chunks gc
                  JOIN child_chunks c ON c.id = gc.child_chunk_id
                  WHERE gc.generation_id = ?
                    AND c.version_id = ?
                )
            `,
          )
          .run(
            pending.versionId,
            input.generationId,
            pending.versionId,
          );
        this.db
          .prepare(
            `
              UPDATE child_chunks
              SET active = 1
              WHERE version_id = ?
                AND id IN (
                  SELECT child_chunk_id
                  FROM generation_chunks
                  WHERE generation_id = ?
                )
            `,
          )
          .run(pending.versionId, input.generationId);
        this.db
          .prepare(
            `
              UPDATE documents
              SET display_name = ?, source_type = ?, mime_type = ?,
                  category = ?, active = 1, current_version_id = ?,
                  metadata_json = ?, updated_at = ?, deleted_at = NULL
              WHERE id = ?
            `,
          )
          .run(
            pending.displayName,
            pending.sourceType,
            pending.mimeType,
            pending.category,
            pending.versionId,
            stableJson(pending.metadata),
            now,
            pending.documentId,
          );
        this.replaceTags(pending.documentId, pending.tags);
      }

      const visibleCount = Number(
        (
          this.db
            .prepare(
              `
                SELECT COUNT(*) AS count
                FROM generation_chunks gc
                JOIN child_chunks c ON c.id = gc.child_chunk_id
                JOIN parent_chunks p ON p.id = c.parent_id
                JOIN document_versions v ON v.id = c.version_id
                JOIN documents d ON d.id = c.document_id
                WHERE gc.generation_id = ?
                  AND c.active = 1
                  AND p.active = 1
                  AND v.active = 1
                  AND d.active = 1
              `,
            )
            .get(input.generationId) as { count: number }
        ).count,
      );
      if (visibleCount !== input.vectorCount) {
        throw new Error(
          `Generation ${input.generationId} contains non-active chunks`,
        );
      }

      this.db
        .prepare(
          "UPDATE index_generations SET status = 'retired' WHERE status = 'active'",
        )
        .run();
      this.db
        .prepare(
          `
            UPDATE index_generations
            SET status = 'active', index_path = ?, manifest_sha256 = ?,
                embedding_dimension = ?, vector_count = ?,
                activated_at = ?, failure_reason = NULL
            WHERE id = ?
          `,
        )
        .run(
          input.indexPath,
          input.manifestSha256,
          input.embeddingDimension,
          input.vectorCount,
          now,
          input.generationId,
        );
      this.db
        .prepare(
          `
            UPDATE corpus_state
            SET active_generation_id = ?,
                active_generation_sequence = ?,
                updated_at = ?
            WHERE singleton = 1
          `,
        )
        .run(input.generationId, generation.sequence, now);
      this.db
        .prepare(
          `
            UPDATE ingestion_jobs
            SET status = 'succeeded', generation_id = ?, error = NULL,
                updated_at = ?, completed_at = ?
            WHERE id = ?
          `,
        )
        .run(input.generationId, now, now, input.jobId);
      return this.getCorpusState();
    });
    return activate();
  }

  failGeneration(generationId: string, error: unknown): void {
    this.db
      .prepare(
        `
          UPDATE index_generations
          SET status = 'failed', failure_reason = ?
          WHERE id = ? AND status IN ('staging', 'ready')
        `,
      )
      .run(this.errorMessage(error), generationId);
  }

  getGenerationChunkId(
    generationId: string,
    vectorOrdinal: number,
  ): string | null {
    const row = this.db
      .prepare(
        `
          SELECT child_chunk_id
          FROM generation_chunks
          WHERE generation_id = ? AND vector_ordinal = ?
        `,
      )
      .get(generationId, vectorOrdinal) as
      | { child_chunk_id: string }
      | undefined;
    return row?.child_chunk_id || null;
  }

  getChildChunksByIds(
    childChunkIds: string[],
    onlyActive = true,
  ): ChildChunkRecord[] {
    if (!childChunkIds.length) {
      return [];
    }
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM child_chunks
          WHERE id IN (${placeholders(childChunkIds.length)})
            ${onlyActive ? 'AND active = 1' : ''}
        `,
      )
      .all(...childChunkIds) as Array<Record<string, unknown>>;
    const byId = new Map(
      rows.map(row => {
        const chunk = this.mapChild(row);
        return [chunk.id, chunk] as const;
      }),
    );
    return childChunkIds
      .map(id => byId.get(id))
      .filter((chunk): chunk is ChildChunkRecord => Boolean(chunk));
  }

  resolveActiveChildren(
    expectedGeneration: CorpusGeneration,
    childIds: string[],
    filter: RagMetadataFilter = {},
  ): RagChildRecord[] {
    this.assertActiveGeneration(expectedGeneration);
    if (!childIds.length) {
      return [];
    }
    const rows = this.db
      .prepare(
        `
          SELECT
            c.id AS child_id,
            c.parent_id,
            c.document_id,
            c.version_id,
            c.content,
            c.normalized_content,
            c.estimated_tokens,
            p.content AS parent_content,
            p.estimated_tokens AS parent_estimated_tokens,
            p.heading_path_json,
            d.display_name AS document_name,
            d.source_identity,
            d.source_type,
            d.mime_type,
            d.category,
            d.metadata_json,
            d.updated_at AS document_updated_at,
            COALESCE(json_group_array(t.tag)
              FILTER (WHERE t.tag IS NOT NULL), '[]') AS tags_json
          FROM generation_chunks gc
          JOIN child_chunks c ON c.id = gc.child_chunk_id
          JOIN parent_chunks p ON p.id = c.parent_id
          JOIN document_versions v ON v.id = c.version_id
          JOIN documents d ON d.id = c.document_id
          LEFT JOIN tags t ON t.document_id = d.id
          WHERE gc.generation_id = ?
            AND c.id IN (${placeholders(childIds.length)})
            AND c.active = 1
            AND p.active = 1
            AND v.active = 1
            AND d.active = 1
          GROUP BY c.id
        `,
      )
      .all(expectedGeneration, ...childIds) as Array<Record<string, unknown>>;
    const byId = new Map(
      rows
        .map(row => this.mapRagChild(row, expectedGeneration))
        .filter(child => this.matchesMetadataFilter(child, filter))
        .map(child => [child.childId, child] as const),
    );
    return childIds
      .map(childId => byId.get(childId))
      .filter((child): child is RagChildRecord => Boolean(child));
  }

  searchActiveChildrenSparse(
    expectedGeneration: CorpusGeneration,
    matchQuery: string,
    literalTerms: string[],
    limit: number,
    filter: RagMetadataFilter = {},
  ): ChildRetrievalHit[] {
    this.assertActiveGeneration(expectedGeneration);
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 500));
    const { sql: filterSql, params: filterParams } =
      this.metadataFilterSql(filter);
    const ftsRows: Array<{ childId: string; bm25: number }> = [];

    if (matchQuery.trim()) {
      try {
        const rows = this.db
          .prepare(
            `
              SELECT
                f.child_chunk_id AS child_id,
                bm25(child_chunks_fts) AS bm25
              FROM child_chunks_fts f
              JOIN child_chunks c ON c.id = f.child_chunk_id
              JOIN parent_chunks p ON p.id = c.parent_id
              JOIN document_versions v ON v.id = c.version_id
              JOIN documents d ON d.id = c.document_id
              WHERE child_chunks_fts MATCH ?
                AND f.generation_id = ?
                AND c.active = 1
                AND p.active = 1
                AND v.active = 1
                AND d.active = 1
                ${filterSql}
              ORDER BY bm25 ASC, c.id ASC
              LIMIT ?
            `,
          )
          .all(
            matchQuery,
            expectedGeneration,
            ...filterParams,
            boundedLimit,
          ) as Array<{ child_id: string; bm25: number }>;
        ftsRows.push(
          ...rows.map(row => ({
            childId: row.child_id,
            bm25: Number(row.bm25),
          })),
        );
      } catch {
        // A malformed user MATCH expression must not prevent literal fallback.
      }
    }

    const normalizedLiteralTerms = [
      ...new Set(
        literalTerms
          .map(normalizeForSparseSearch)
          .filter(term => term && [...term].length <= 2),
      ),
    ].sort();
    let literalIds: string[] = [];
    if (normalizedLiteralTerms.length) {
      const literalClause = normalizedLiteralTerms
        .map(() => 'instr(c.normalized_content, ?) > 0')
        .join(' OR ');
      const rows = this.db
        .prepare(
          `
            SELECT c.id AS child_id
            FROM generation_chunks gc
            JOIN child_chunks c ON c.id = gc.child_chunk_id
            JOIN parent_chunks p ON p.id = c.parent_id
            JOIN document_versions v ON v.id = c.version_id
            JOIN documents d ON d.id = c.document_id
            WHERE gc.generation_id = ?
              AND c.active = 1
              AND p.active = 1
              AND v.active = 1
              AND d.active = 1
              AND (${literalClause})
              ${filterSql}
            ORDER BY c.id ASC
            LIMIT ?
          `,
        )
        .all(
          expectedGeneration,
          ...normalizedLiteralTerms,
          ...filterParams,
          boundedLimit,
        ) as Array<{ child_id: string }>;
      literalIds = rows.map(row => row.child_id);
    }

    const orderedIds = [
      ...ftsRows.map(row => row.childId),
      ...literalIds.filter(
        childId => !ftsRows.some(row => row.childId === childId),
      ),
    ];
    const records = this.resolveActiveChildren(
      expectedGeneration,
      orderedIds,
      filter,
    );
    const ftsById = new Map(ftsRows.map(row => [row.childId, row.bm25]));

    return records.slice(0, boundedLimit).map((record, index) => {
      const matchedTerms = normalizedLiteralTerms.filter(term =>
        record.normalizedContent.includes(term),
      );
      const bm25 = ftsById.get(record.childId);
      return {
        ...record,
        retrieval: 'sparse',
        rank: index + 1,
        score: bm25 === undefined ? matchedTerms.length : -bm25,
        ...(bm25 === undefined ? {} : { bm25 }),
        ...(matchedTerms.length ? { matchedTerms } : {}),
      };
    });
  }

  getParentChunksByIds(
    parentChunkIds: string[],
    onlyActive = true,
  ): ParentChunkRecord[] {
    if (!parentChunkIds.length) {
      return [];
    }
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM parent_chunks
          WHERE id IN (${placeholders(parentChunkIds.length)})
            ${onlyActive ? 'AND active = 1' : ''}
        `,
      )
      .all(...parentChunkIds) as Array<Record<string, unknown>>;
    const byId = new Map(
      rows.map(row => {
        const chunk = this.mapParent(row);
        return [chunk.id, chunk] as const;
      }),
    );
    return parentChunkIds
      .map(id => byId.get(id))
      .filter((chunk): chunk is ParentChunkRecord => Boolean(chunk));
  }

  deactivateDocument(documentId: string): boolean {
    const deactivate = this.db.transaction(() => {
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `
            UPDATE documents
            SET active = 0, updated_at = ?, deleted_at = ?
            WHERE id = ? AND active = 1
          `,
        )
        .run(now, now, documentId);
      if (result.changes === 0) {
        return false;
      }
      this.db
        .prepare('UPDATE document_versions SET active = 0 WHERE document_id = ?')
        .run(documentId);
      this.db
        .prepare('UPDATE parent_chunks SET active = 0 WHERE document_id = ?')
        .run(documentId);
      this.db
        .prepare('UPDATE child_chunks SET active = 0 WHERE document_id = ?')
        .run(documentId);
      return true;
    });
    return deactivate();
  }

  clearCorpus(): number {
    const clear = this.db.transaction(() => {
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `
            UPDATE documents
            SET active = 0, updated_at = ?, deleted_at = ?
            WHERE active = 1
          `,
        )
        .run(now, now);
      this.db.prepare('UPDATE document_versions SET active = 0').run();
      this.db.prepare('UPDATE parent_chunks SET active = 0').run();
      this.db.prepare('UPDATE child_chunks SET active = 0').run();
      return result.changes;
    });
    return clear();
  }

  private replaceTags(documentId: string, tags: string[]): void {
    this.db.prepare('DELETE FROM tags WHERE document_id = ?').run(documentId);
    const insert = this.db.prepare(
      'INSERT INTO tags (document_id, tag, normalized_tag) VALUES (?, ?, ?)',
    );
    for (const tag of normalizeTags(tags)) {
      insert.run(documentId, tag.tag, tag.normalized);
    }
  }

  private mapDocument(row: Record<string, unknown>): DocumentRecord {
    return {
      id: String(row.id),
      sourceIdentity: String(row.source_identity),
      displayName: String(row.display_name),
      sourceType: row.source_type as DocumentRecord['sourceType'],
      mimeType: String(row.mime_type),
      category: String(row.category),
      active: Boolean(row.active),
      currentVersionId: (row.current_version_id as string) || null,
      metadata: parseJsonObject(row.metadata_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      deletedAt: (row.deleted_at as string) || null,
      tags: parseStringArray(row.tags_json),
    };
  }

  private mapVersion(row: Record<string, unknown>): DocumentVersionRecord {
    return {
      id: String(row.id),
      documentId: String(row.document_id),
      contentSha256: String(row.content_sha256),
      content: String(row.content),
      active: Boolean(row.active),
      parentCount: Number(row.parent_count),
      childCount: Number(row.child_count),
      createdAt: String(row.created_at),
      activatedAt: (row.activated_at as string) || null,
    };
  }

  private mapParent(
    row: Record<string, unknown>,
    prefix = '',
  ): ParentChunkRecord {
    return {
      id: String(row[`${prefix}id`]),
      versionId: String(row[`${prefix}version_id`]),
      documentId: String(row[`${prefix}document_id`]),
      ordinal: Number(row[`${prefix}ordinal`]),
      content: String(row[`${prefix}content`]),
      headingPath: parseStringArray(row[`${prefix}heading_path_json`]),
      estimatedTokens: Number(row[`${prefix}estimated_tokens`]),
      startOffset: Number(row[`${prefix}start_offset`]),
      endOffset: Number(row[`${prefix}end_offset`]),
      active: Boolean(row[`${prefix}active`]),
      createdAt: String(row[`${prefix}created_at`]),
    };
  }

  private mapChild(
    row: Record<string, unknown>,
    prefix = '',
  ): ChildChunkRecord {
    return {
      id: String(row[`${prefix}id`]),
      parentId: String(row[`${prefix}parent_id`]),
      versionId: String(row[`${prefix}version_id`]),
      documentId: String(row[`${prefix}document_id`]),
      ordinal: Number(row[`${prefix}ordinal`]),
      content: String(row[`${prefix}content`]),
      normalizedContent: String(row[`${prefix}normalized_content`] || ''),
      estimatedTokens: Number(row[`${prefix}estimated_tokens`]),
      startOffset: Number(row[`${prefix}start_offset`]),
      endOffset: Number(row[`${prefix}end_offset`]),
      active: Boolean(row[`${prefix}active`]),
      createdAt: String(row[`${prefix}created_at`]),
    };
  }

  private mapGeneration(row: Record<string, unknown>): IndexGenerationRecord {
    return {
      id: String(row.id),
      sequence: Number(row.sequence),
      status: row.status as IndexGenerationRecord['status'],
      embeddingModel: (row.embedding_model as string) || null,
      embeddingDimension:
        row.embedding_dimension == null
          ? null
          : Number(row.embedding_dimension),
      vectorCount: Number(row.vector_count),
      manifestSha256: (row.manifest_sha256 as string) || null,
      indexPath: (row.index_path as string) || null,
      createdAt: String(row.created_at),
      activatedAt: (row.activated_at as string) || null,
      failureReason: (row.failure_reason as string) || null,
    };
  }

  private errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 2000);
  }

  private assertActiveGeneration(
    expectedGeneration: CorpusGeneration,
  ): void {
    const activeGeneration = this.getCorpusState().activeGenerationId;
    if (activeGeneration !== expectedGeneration) {
      throw new StaleRagGenerationError(
        expectedGeneration,
        activeGeneration,
      );
    }
  }

  private mapRagChild(
    row: Record<string, unknown>,
    generation: CorpusGeneration,
  ): RagChildRecord {
    return {
      generation,
      childId: String(row.child_id),
      parentId: String(row.parent_id),
      documentId: String(row.document_id),
      versionId: String(row.version_id),
      content: String(row.content),
      normalizedContent: String(row.normalized_content),
      estimatedTokens: Number(row.estimated_tokens),
      parentContent: String(row.parent_content),
      parentEstimatedTokens: Number(row.parent_estimated_tokens),
      headingPath: parseStringArray(row.heading_path_json),
      documentName: String(row.document_name),
      sourceIdentity: String(row.source_identity),
      sourceType: row.source_type as RagChildRecord['sourceType'],
      mimeType: String(row.mime_type),
      category: String(row.category),
      tags: parseStringArray(row.tags_json),
      metadata: parseJsonObject(row.metadata_json),
      documentUpdatedAt: String(row.document_updated_at),
    };
  }

  private matchesMetadataFilter(
    child: RagChildRecord,
    filter: RagMetadataFilter,
  ): boolean {
    if (
      filter.documentIds?.length &&
      !filter.documentIds.includes(child.documentId)
    ) {
      return false;
    }
    if (filter.category && child.category !== filter.category) {
      return false;
    }
    if (
      filter.updatedAfter &&
      child.documentUpdatedAt < filter.updatedAfter
    ) {
      return false;
    }
    if (
      filter.updatedBefore &&
      child.documentUpdatedAt > filter.updatedBefore
    ) {
      return false;
    }
    const requiredTags = normalizeTags(filter.tags).map(tag => tag.normalized);
    if (requiredTags.length) {
      const actualTags = new Set(
        child.tags.map(tag => tag.normalize('NFKC').toLowerCase()),
      );
      if (!requiredTags.every(tag => actualTags.has(tag))) {
        return false;
      }
    }
    return true;
  }

  private metadataFilterSql(filter: RagMetadataFilter): {
    sql: string;
    params: unknown[];
  } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.documentIds?.length) {
      clauses.push(
        `d.id IN (${placeholders(filter.documentIds.length)})`,
      );
      params.push(...filter.documentIds);
    }
    if (filter.category) {
      clauses.push('d.category = ?');
      params.push(filter.category);
    }
    if (filter.updatedAfter) {
      clauses.push('d.updated_at >= ?');
      params.push(filter.updatedAfter);
    }
    if (filter.updatedBefore) {
      clauses.push('d.updated_at <= ?');
      params.push(filter.updatedBefore);
    }
    for (const tag of normalizeTags(filter.tags)) {
      clauses.push(`
        EXISTS (
          SELECT 1 FROM tags filter_tag
          WHERE filter_tag.document_id = d.id
            AND filter_tag.normalized_tag = ?
        )
      `);
      params.push(tag.normalized);
    }
    return {
      sql: clauses.length ? `AND ${clauses.join(' AND ')}` : '',
      params,
    };
  }
}

export type {
  ActivateGenerationInput,
  DocumentListFilter,
  PendingDocumentActivation,
};
