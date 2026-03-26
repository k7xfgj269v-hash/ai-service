import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// @ts-ignore
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
// @ts-ignore
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { OpenAIEmbeddings } from '@langchain/openai';
import { FaissStore } from '@langchain/community/vectorstores/faiss';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { RunnableSequence } from '@langchain/core/runnables';
import { Document } from '@langchain/core/documents';
import * as fs from 'fs';
import * as path from 'path';
import Redis from 'ioredis';
import Database from 'better-sqlite3';

export interface KnowledgeBaseConfig {
  openai_api_key?: string;
  openai_api_base_url?: string;
  model?: string;
  temperature?: number;
  chunkSize?: number;
  chunkOverlap?: number;
}

export interface DocumentMetadata {
  id: string;
  fileName: string;
  fileType: string;
  uploadDate: string;
  chunkCount: number;
  tags?: string[];
  category?: string;
}

export interface KnowledgeBaseStats {
  totalDocuments: number;
  totalChunks: number;
  categories: string[];
  lastUpdated: string;
  vectorStorePath: string;
}

export interface SearchResult {
  answer: string;
  sources: Array<{
    content: string;
    metadata: any;
    score?: number;
  }>;
  confidence: number;
  processingTime: number;
}

@Injectable()
export class KnowledgeBaseService {
  private readonly logger = new Logger(KnowledgeBaseService.name);
  private vectorStore: FaissStore | null = null;
  private readonly vectorStorePath: string;
  private readonly documentsPath: string;
  private readonly metadataPath: string;
  private db: Database.Database;
  private redis: Redis;

  constructor(private configService: ConfigService) {
    // Initialize paths
    this.documentsPath = path.join(process.cwd(), 'uploads', 'documents');
    this.vectorStorePath = path.join(process.cwd(), 'data', 'vectorstore');
    this.metadataPath = path.join(process.cwd(), 'data', 'knowledge-base-metadata.json');

    // Ensure directories exist
    this.ensureDirectories();

    // Initialize SQLite for metadata persistence
    const dbPath = path.join(process.cwd(), 'data', 'knowledge-base.db');
    this.db = new Database(dbPath);
    this.initSqliteSchema();
    this.migrateFromJson();

    // Initialize Redis for search result caching
    this.redis = new Redis(this.configService.get<string>('REDIS_URL'));
    this.redis.on('error', (err) => this.logger.warn('Redis error (KB):', err.message));

    // Load existing vector store if available
    this.initializeVectorStore();
  }

  private initSqliteSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        fileName TEXT NOT NULL,
        fileType TEXT NOT NULL,
        uploadDate TEXT NOT NULL,
        chunkCount INTEGER NOT NULL DEFAULT 0,
        tags TEXT DEFAULT '[]',
        category TEXT DEFAULT 'general'
      )
    `);
    this.logger.log('SQLite metadata schema initialized');
  }

  private migrateFromJson(): void {
    if (!fs.existsSync(this.metadataPath)) return;
    const count = (this.db.prepare('SELECT COUNT(*) as c FROM documents').get() as any).c;
    if (count > 0) return; // already migrated
    try {
      const raw = fs.readFileSync(this.metadataPath, 'utf-8');
      const data: Record<string, DocumentMetadata> = JSON.parse(raw);
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO documents (id, fileName, fileType, uploadDate, chunkCount, tags, category) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      const migrate = this.db.transaction((entries: [string, DocumentMetadata][]) => {
        for (const [, doc] of entries) {
          insert.run(doc.id, doc.fileName, doc.fileType, doc.uploadDate, doc.chunkCount,
            JSON.stringify(doc.tags || []), doc.category || 'general');
        }
      });
      migrate(Object.entries(data));
      this.logger.log(`Migrated ${Object.keys(data).length} documents from JSON to SQLite`);
    } catch (err) {
      this.logger.warn('JSON to SQLite migration failed:', err.message);
    }
  }

  private rowToMetadata(row: any): DocumentMetadata {
    return { ...row, tags: JSON.parse(row.tags || '[]') };
  }

  /**
   * Ensure necessary directories exist
   */
  private ensureDirectories(): void {
    [this.documentsPath, this.vectorStorePath, path.dirname(this.metadataPath)].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        this.logger.log(`Created directory: ${dir}`);
      }
    });
  }

  /**
   * Initialize vector store
   */
  private async initializeVectorStore(): Promise<void> {
    const indexPath = path.join(this.vectorStorePath, 'faiss.index');
    if (fs.existsSync(indexPath)) {
      try {
        await this.loadVectorStore();
        this.logger.log('Knowledge base initialized with existing vector store');
      } catch (error) {
        this.logger.warn('Failed to load existing vector store:', error.message);
      }
    } else {
      this.logger.log('No existing vector store found. Will create new one when documents are added.');
    }
  }

  /**
   * Get embeddings instance
   */
  private getEmbeddings(config?: KnowledgeBaseConfig): OpenAIEmbeddings {
    const embeddingApiKey =
      this.configService.get<string>('EMBEDDING_API_KEY') ||
      config?.openai_api_key ||
      this.configService.get<string>('DEEPSEEK_API_KEY');
    const embeddingBaseUrl =
      this.configService.get<string>('EMBEDDING_API_BASE_URL') ||
      config?.openai_api_base_url ||
      this.configService.get<string>('OPENAI_API_BASE_URL');
    const embeddingModel =
      this.configService.get<string>('EMBEDDING_MODEL') || 'text-embedding-v3';

    return new OpenAIEmbeddings({
      apiKey: embeddingApiKey,
      modelName: embeddingModel,
      configuration: { baseURL: embeddingBaseUrl },
    });
  }

  /**
   * Get chat model instance
   */
  private getChatModel(config?: KnowledgeBaseConfig): ChatOpenAI {
    const apiKey =
      this.configService.get<string>('QWEN_API_KEY') ||
      config?.openai_api_key ||
      this.configService.get<string>('DEEPSEEK_API_KEY');
    const baseURL =
      this.configService.get<string>('QWEN_API_BASE_URL') ||
      config?.openai_api_base_url ||
      this.configService.get<string>('OPENAI_API_BASE_URL');
    const modelName =
      config?.model || this.configService.get<string>('QWEN_MODEL') || 'qwen-plus';

    return new ChatOpenAI({
      modelName,
      temperature: config?.temperature || 0.7,
      configuration: { apiKey, baseURL },
    });
  }

  /**
   * Load existing vector store
   */
  private async loadVectorStore(config?: KnowledgeBaseConfig): Promise<void> {
    try {
      const embeddings = this.getEmbeddings(config);
      this.vectorStore = await FaissStore.load(this.vectorStorePath, embeddings);
      this.logger.log('Vector store loaded successfully');
    } catch (error) {
      this.logger.error('Failed to load vector store:', error.message);
      throw error;
    }
  }

  /**
   * Save vector store
   */
  private async saveVectorStore(): Promise<void> {
    if (this.vectorStore) {
      await this.vectorStore.save(this.vectorStorePath);
      this.logger.log('Vector store saved successfully');
    }
  }

  /**
   * Add document to knowledge base
   */
  async addDocument(
    filePath: string,
    fileName: string,
    fileType: string,
    config?: KnowledgeBaseConfig & { tags?: string[]; category?: string },
  ): Promise<{
    success: boolean;
    message: string;
    documentId: string;
    chunkCount: number;
  }> {
    const startTime = Date.now();
    try {
      this.logger.log(`Adding document to knowledge base: ${fileName}`);

      const docs = await this.loadDocument(filePath, fileName);
      this.logger.log(`Loaded ${docs.length} document(s)`);

      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: config?.chunkSize || 1000,
        chunkOverlap: config?.chunkOverlap || 200,
      });
      const splitDocs = await splitter.splitDocuments(docs);
      this.logger.log(`Split into ${splitDocs.length} chunks`);

      const documentId = this.generateDocumentId(fileName);

      splitDocs.forEach((doc, index) => {
        doc.metadata = {
          ...doc.metadata,
          documentId,
          fileName,
          fileType,
          uploadDate: new Date().toISOString(),
          chunkIndex: index,
          totalChunks: splitDocs.length,
          tags: config?.tags || [],
          category: config?.category || 'general',
        };
      });

      const embeddings = this.getEmbeddings(config);

      if (!this.vectorStore) {
        this.vectorStore = await FaissStore.fromDocuments(splitDocs, embeddings);
        this.logger.log('Created new vector store');
      } else {
        await this.vectorStore.addDocuments(splitDocs);
        this.logger.log('Added documents to existing vector store');
      }

      await this.saveVectorStore();

      // Persist metadata to SQLite
      try {
        this.db.prepare(
          'INSERT OR REPLACE INTO documents (id, fileName, fileType, uploadDate, chunkCount, tags, category) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(documentId, fileName, fileType, new Date().toISOString(), splitDocs.length,
          JSON.stringify(config?.tags || []), config?.category || 'general');
      } catch (dbErr) {
        this.logger.error('SQLite metadata write failed:', dbErr.message);
        // Vector store saved but metadata missing — log for manual reconciliation
      }

      const processingTime = Date.now() - startTime;
      this.logger.log(`Document added successfully in ${processingTime}ms: ${fileName}`);

      return {
        success: true,
        message: `Document ${fileName} added to knowledge base successfully`,
        documentId,
        chunkCount: splitDocs.length,
      };
    } catch (error) {
      this.logger.error('Failed to add document:', error);
      throw error;
    }
  }

  /**
   * Load document based on file type
   */
  private async loadDocument(filePath: string, fileName: string): Promise<Document[]> {
    const fileExtension = path.extname(fileName).toLowerCase();

    switch (fileExtension) {
      case '.pdf':
        const pdfLoader = new PDFLoader(filePath);
        return await pdfLoader.load();
      case '.txt':
      case '.md':
        const textContent = fs.readFileSync(filePath, 'utf-8');
        return [new Document({ pageContent: textContent, metadata: { source: filePath } })];
      case '.docx':
        const docxLoader = new DocxLoader(filePath);
        return await docxLoader.load();
      default:
        throw new Error(`Unsupported file type: ${fileExtension}`);
    }
  }

  /**
   * Generate unique document ID
   */
  private generateDocumentId(fileName: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 9);
    return `${fileName}-${timestamp}-${random}`;
  }

  /**
   * Search knowledge base with RAG (Redis-cached)
   */
  async search(
    question: string,
    config?: KnowledgeBaseConfig & {
      topK?: number;
      filter?: { category?: string; tags?: string[] };
    },
  ): Promise<SearchResult> {
    const startTime = Date.now();
    try {
      if (!this.vectorStore) {
        this.logger.warn('Knowledge base is empty. Returning empty search result.');
        return { answer: '', sources: [], confidence: 0, processingTime: Date.now() - startTime };
      }

      // Redis cache check (cache entire search result, TTL 1 day)
      const cacheKey = `search:${require('crypto').createHash('sha256').update(question).digest('hex')}:k${config?.topK || 4}`;
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          this.logger.log(`搜索结果命中缓存: ${cacheKey.slice(0, 30)}...`);
          return JSON.parse(cached) as SearchResult;
        }
      } catch (cacheErr) {
        this.logger.warn('Redis 缓存读取失败，继续正常搜索:', cacheErr.message);
      }

      const topK = config?.topK || 4;

      // 自适应 k：不超过实际 chunk 总数，避免 Faiss 降级警告
      const totalChunks = ((this.db.prepare('SELECT SUM(chunkCount) as total FROM documents').get() as any)?.total as number) || 0;
      const adaptiveK = Math.min(topK, Math.max(1, totalChunks));

      const retriever = this.vectorStore.asRetriever({ k: adaptiveK });
      const relevantDocs = await retriever.invoke(question);
      this.logger.log(`Retrieved ${relevantDocs.length} relevant documents`);

      let filteredDocs = relevantDocs;
      if (config?.filter) {
        filteredDocs = relevantDocs.filter(doc => {
          const filter = config.filter;
          if (!filter) return true;
          if (filter.category && doc.metadata.category !== filter.category) return false;
          if (filter.tags && filter.tags.length > 0 &&
              !filter.tags.some(tag => doc.metadata.tags?.includes(tag))) return false;
          return true;
        });
      }

      const context = filteredDocs
        .map((doc, index) => `[Document ${index + 1}]\n${doc.pageContent}`)
        .join('\n\n');

      const promptTemplate = PromptTemplate.fromTemplate(`
You are a professional knowledge base assistant. Answer the user's question based on the provided document content.

Document Content:
{context}

User Question: {question}

Please provide an accurate and detailed answer based on the above document content. If the documents don't contain relevant information, clearly state that.

Requirements:
1. Answer should be comprehensive and well-structured
2. Cite specific information from the documents
3. If uncertain, acknowledge the limitations
4. Use clear and professional language
`);

      const model = this.getChatModel(config);
      const chain = RunnableSequence.from([promptTemplate, model, new StringOutputParser()]);
      const answer = await chain.invoke({ context, question });

      const processingTime = Date.now() - startTime;
      const confidence = this.calculateConfidence(filteredDocs, question);

      const result: SearchResult = {
        answer,
        sources: filteredDocs.map(doc => ({ content: doc.pageContent, metadata: doc.metadata })),
        confidence,
        processingTime,
      };

      // Cache result in Redis (86400s = 1 day)
      try {
        await this.redis.setex(cacheKey, 86400, JSON.stringify(result));
      } catch (cacheErr) {
        this.logger.warn('Redis 缓存写入失败:', cacheErr.message);
      }

      return result;
    } catch (error) {
      this.logger.error('Search error:', error);
      throw error;
    }
  }

  /**
   * Calculate confidence score
   */
  private calculateConfidence(docs: Document[], question: string): number {
    if (docs.length === 0) return 0;
    const baseConfidence = Math.min(docs.length / 4, 1) * 0.7;
    const lengthBonus = docs.reduce((sum, doc) => sum + doc.pageContent.length, 0) / (docs.length * 1000) * 0.3;
    return Math.min(baseConfidence + lengthBonus, 1);
  }

  /**
   * Get knowledge base statistics
   */
  async getStats(): Promise<KnowledgeBaseStats> {
    const rows = this.db.prepare('SELECT category, SUM(chunkCount) as chunks, MAX(uploadDate) as latest FROM documents GROUP BY category').all() as any[];
    const allRows = this.db.prepare('SELECT COUNT(*) as total, SUM(chunkCount) as totalChunks, MAX(uploadDate) as lastUpdated FROM documents').get() as any;

    return {
      totalDocuments: allRows?.total || 0,
      totalChunks: allRows?.totalChunks || 0,
      categories: rows.map(r => r.category).filter(Boolean),
      lastUpdated: allRows?.lastUpdated || 'Never',
      vectorStorePath: this.vectorStorePath,
    };
  }

  /**
   * List all documents in knowledge base
   */
  async listDocuments(filter?: { category?: string; tags?: string[] }): Promise<DocumentMetadata[]> {
    let rows: any[];
    if (filter?.category) {
      rows = this.db.prepare('SELECT * FROM documents WHERE category = ?').all(filter.category) as any[];
    } else {
      rows = this.db.prepare('SELECT * FROM documents').all() as any[];
    }
    let docs = rows.map(r => this.rowToMetadata(r));
    if (filter?.tags && filter.tags.length > 0) {
      docs = docs.filter(doc => filter.tags!.some(tag => doc.tags?.includes(tag)));
    }
    return docs;
  }

  /**
   * Remove document from knowledge base
   */
  async removeDocument(documentId: string): Promise<{ success: boolean; message: string }> {
    try {
      const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId) as any;
      if (!row) throw new Error('Document not found: ' + documentId);

      const docMeta = this.rowToMetadata(row);
      const safeFileName = path.basename(docMeta.fileName);
      const files = fs.readdirSync(this.documentsPath);
      for (const file of files) {
        if (file.includes(documentId) || file === safeFileName) {
          const fp = path.join(this.documentsPath, file);
          // Verify path is within documentsPath to prevent path traversal
          if (fs.existsSync(fp) && fp.startsWith(this.documentsPath)) {
            fs.unlinkSync(fp);
            this.logger.log('Deleted source file: ' + file);
          }
        }
      }

      this.db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
      this.logger.warn('Document removed. Consider rebuilding vector store for complete removal.');

      return { success: true, message: 'Document ' + documentId + ' removed from knowledge base' };
    } catch (error) {
      this.logger.error('Failed to remove document:', error);
      throw error;
    }
  }

  /**
   * Clear entire knowledge base
   */
  async clear(): Promise<{ success: boolean; message: string }> {
    try {
      this.vectorStore = null;
      this.db.prepare('DELETE FROM documents').run();

      if (fs.existsSync(this.vectorStorePath)) {
        fs.rmSync(this.vectorStorePath, { recursive: true, force: true });
        fs.mkdirSync(this.vectorStorePath, { recursive: true });
      }
      if (fs.existsSync(this.metadataPath)) {
        fs.unlinkSync(this.metadataPath);
      }

      this.logger.log('Knowledge base cleared successfully');
      return { success: true, message: 'Knowledge base cleared successfully' };
    } catch (error) {
      this.logger.error('Failed to clear knowledge base:', error);
      throw error;
    }
  }

  /**
   * Rebuild vector store from existing documents
   */
  async rebuild(config?: KnowledgeBaseConfig): Promise<{
    success: boolean;
    message: string;
    documentsProcessed: number;
  }> {
    try {
      this.logger.log('Rebuilding knowledge base...');
      this.vectorStore = null;

      const files = fs.readdirSync(this.documentsPath);
      let processedCount = 0;

      for (const file of files) {
        const filePath = path.join(this.documentsPath, file);
        const stats = fs.statSync(filePath);
        if (stats.isFile()) {
          try {
            await this.addDocument(filePath, file, path.extname(file), config);
            processedCount++;
          } catch (error) {
            this.logger.error(`Failed to process ${file}:`, error.message);
          }
        }
      }

      this.logger.log(`Knowledge base rebuilt with ${processedCount} documents`);
      return { success: true, message: 'Knowledge base rebuilt successfully', documentsProcessed: processedCount };
    } catch (error) {
      this.logger.error('Failed to rebuild knowledge base:', error);
      throw error;
    }
  }
}
