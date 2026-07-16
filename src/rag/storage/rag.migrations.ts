import Database from 'better-sqlite3';
import {
  deterministicId,
  normalizeForSparseSearch,
  stableJson,
} from '../domain/rag.types';

export const RAG_SCHEMA_VERSION = 1;

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(tableName),
  );
}

function tableColumns(db: Database.Database, tableName: string): string[] {
  return (
    db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
      name: string;
    }>
  ).map(row => row.name);
}

function preserveLegacyDocumentsTable(db: Database.Database): void {
  if (!tableExists(db, 'documents')) {
    return;
  }
  const columns = tableColumns(db, 'documents');
  if (columns.includes('source_identity')) {
    return;
  }
  if (tableExists(db, 'legacy_documents')) {
    throw new Error(
      'Cannot migrate legacy documents table because legacy_documents already exists',
    );
  }
  db.exec('ALTER TABLE documents RENAME TO legacy_documents');
}

function createNormalizedSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      source_identity TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('pdf', 'docx', 'markdown', 'text')),
      mime_type TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      current_version_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS document_versions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      content_sha256 TEXT NOT NULL,
      content TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
      parent_count INTEGER NOT NULL DEFAULT 0,
      child_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      UNIQUE(document_id, content_sha256)
    );

    CREATE TABLE IF NOT EXISTS parent_chunks (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL REFERENCES document_versions(id),
      document_id TEXT NOT NULL REFERENCES documents(id),
      ordinal INTEGER NOT NULL,
      content TEXT NOT NULL,
      heading_path_json TEXT NOT NULL DEFAULT '[]',
      estimated_tokens INTEGER NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL,
      UNIQUE(version_id, ordinal)
    );

    CREATE TABLE IF NOT EXISTS child_chunks (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL REFERENCES parent_chunks(id),
      version_id TEXT NOT NULL REFERENCES document_versions(id),
      document_id TEXT NOT NULL REFERENCES documents(id),
      ordinal INTEGER NOT NULL,
      content TEXT NOT NULL,
      normalized_content TEXT NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL,
      UNIQUE(parent_id, ordinal)
    );

    CREATE TABLE IF NOT EXISTS tags (
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      normalized_tag TEXT NOT NULL,
      PRIMARY KEY(document_id, normalized_tag)
    );

    CREATE TABLE IF NOT EXISTS ingestion_jobs (
      id TEXT PRIMARY KEY,
      source_identity TEXT NOT NULL,
      document_id TEXT REFERENCES documents(id),
      version_id TEXT REFERENCES document_versions(id),
      generation_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'staging', 'succeeded', 'noop', 'failed')),
      error TEXT,
      request_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS index_generations (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('staging', 'ready', 'active', 'retired', 'failed')),
      embedding_model TEXT,
      embedding_dimension INTEGER,
      vector_count INTEGER NOT NULL DEFAULT 0,
      manifest_sha256 TEXT,
      index_path TEXT,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      failure_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS generation_chunks (
      generation_id TEXT NOT NULL REFERENCES index_generations(id),
      vector_ordinal INTEGER NOT NULL,
      child_chunk_id TEXT NOT NULL REFERENCES child_chunks(id),
      PRIMARY KEY(generation_id, vector_ordinal),
      UNIQUE(generation_id, child_chunk_id)
    );

    CREATE TABLE IF NOT EXISTS corpus_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      active_generation_id TEXT REFERENCES index_generations(id),
      active_generation_sequence INTEGER NOT NULL DEFAULT 0,
      fts_tokenizer TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_documents_active
      ON documents(active, updated_at);
    CREATE INDEX IF NOT EXISTS idx_versions_document
      ON document_versions(document_id, active, created_at);
    CREATE INDEX IF NOT EXISTS idx_parent_chunks_document
      ON parent_chunks(document_id, active, ordinal);
    CREATE INDEX IF NOT EXISTS idx_child_chunks_document
      ON child_chunks(document_id, active, ordinal);
    CREATE INDEX IF NOT EXISTS idx_child_chunks_parent
      ON child_chunks(parent_id, active, ordinal);
    CREATE INDEX IF NOT EXISTS idx_jobs_status
      ON ingestion_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_generation_status
      ON index_generations(status, sequence);
    CREATE INDEX IF NOT EXISTS idx_generation_chunks_child
      ON generation_chunks(child_chunk_id, generation_id);
  `);
}

function ensureNormalizedChildContent(db: Database.Database): void {
  const columns = tableColumns(db, 'child_chunks');
  if (!columns.includes('normalized_content')) {
    db.exec(
      "ALTER TABLE child_chunks ADD COLUMN normalized_content TEXT NOT NULL DEFAULT ''",
    );
  }
  const rows = db
    .prepare(
      "SELECT id, content FROM child_chunks WHERE normalized_content = ''",
    )
    .all() as Array<{ id: string; content: string }>;
  const update = db.prepare(
    'UPDATE child_chunks SET normalized_content = ? WHERE id = ?',
  );
  for (const row of rows) {
    update.run(normalizeForSparseSearch(row.content), row.id);
  }
}

function ensureFtsTable(db: Database.Database): string {
  if (tableExists(db, 'child_chunks_fts')) {
    const row = db
      .prepare(
        "SELECT fts_tokenizer FROM corpus_state WHERE singleton = 1",
      )
      .get() as { fts_tokenizer?: string } | undefined;
    return row?.fts_tokenizer || 'trigram';
  }

  try {
    db.exec(`
      CREATE VIRTUAL TABLE child_chunks_fts USING fts5(
        content,
        child_chunk_id UNINDEXED,
        generation_id UNINDEXED,
        tokenize = 'trigram'
      )
    `);
    return 'trigram';
  } catch (trigramError) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE child_chunks_fts USING fts5(
          content,
          child_chunk_id UNINDEXED,
          generation_id UNINDEXED,
          tokenize = 'unicode61'
        )
      `);
      return 'unicode61';
    } catch {
      throw trigramError;
    }
  }
}

function importLegacyDocumentMetadata(db: Database.Database): void {
  if (!tableExists(db, 'legacy_documents')) {
    return;
  }

  const rows = db.prepare('SELECT * FROM legacy_documents').all() as Array<
    Record<string, unknown>
  >;
  const insertDocument = db.prepare(`
    INSERT OR IGNORE INTO documents (
      id, source_identity, display_name, source_type, mime_type, category,
      active, current_version_id, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)
  `);
  const insertTag = db.prepare(`
    INSERT OR IGNORE INTO tags (document_id, tag, normalized_tag)
    VALUES (?, ?, ?)
  `);

  for (const row of rows) {
    const legacyId = String(row.id || deterministicId('legacy', row));
    const fileName = String(row.fileName || row.file_name || legacyId);
    const fileType = String(row.fileType || row.file_type || '').toLowerCase();
    const sourceType =
      fileType.includes('pdf')
        ? 'pdf'
        : fileType.includes('docx')
          ? 'docx'
          : fileType.includes('md')
            ? 'markdown'
            : 'text';
    const mimeType =
      sourceType === 'pdf'
        ? 'application/pdf'
        : sourceType === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : sourceType === 'markdown'
            ? 'text/markdown'
            : 'text/plain';
    const timestamp = String(
      row.uploadDate || row.upload_date || new Date(0).toISOString(),
    );
    const category = String(row.category || 'general');
    const metadata = {
      legacy: true,
      legacyChunkCount: Number(row.chunkCount || row.chunk_count || 0),
      legacyFileType: fileType,
    };

    insertDocument.run(
      legacyId,
      `legacy:${legacyId}`,
      fileName,
      sourceType,
      mimeType,
      category,
      stableJson(metadata),
      timestamp,
      timestamp,
    );

    let tags: unknown[] = [];
    try {
      const value =
        typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags;
      tags = Array.isArray(value) ? value : [];
    } catch {
      tags = [];
    }
    for (const value of tags) {
      const tag = String(value).trim();
      if (tag) {
        insertTag.run(legacyId, tag, tag.normalize('NFKC').toLowerCase());
      }
    }
  }
}

export function runRagMigrations(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');

  const migrate = db.transaction(() => {
    preserveLegacyDocumentsTable(db);
    createNormalizedSchema(db);
    ensureNormalizedChildContent(db);
    const tokenizer = ensureFtsTable(db);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO corpus_state (
        singleton, active_generation_id, active_generation_sequence,
        fts_tokenizer, schema_version, updated_at
      ) VALUES (1, NULL, 0, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        fts_tokenizer = excluded.fts_tokenizer,
        schema_version = excluded.schema_version,
        updated_at = excluded.updated_at
    `).run(tokenizer, RAG_SCHEMA_VERSION, now);
    importLegacyDocumentMetadata(db);
    db.pragma(`user_version = ${RAG_SCHEMA_VERSION}`);
  });

  migrate();
}
