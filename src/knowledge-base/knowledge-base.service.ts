import { Injectable, Logger } from '@nestjs/common';
import { Document } from '@langchain/core/documents';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import {
  RagAnswerRequest,
  RagAnswerResult,
  RagQueryService,
  RagRetrieveRequest,
  RagRetrieveResult,
} from '../rag/rag-query.service';
import { RagIndexerService } from '../rag/indexing/rag-indexer.service';
import { RagRepository } from '../rag/storage/rag.repository';

export interface KnowledgeBaseConfig {
  tags?: string[];
  category?: string;
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
    metadata: Record<string, unknown>;
    score?: number;
  }>;
  confidence: number;
  processingTime: number;
}

@Injectable()
export class KnowledgeBaseService {
  private readonly logger = new Logger(KnowledgeBaseService.name);
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly indexer: RagIndexerService,
    private readonly repository: RagRepository,
    private readonly ragQuery: RagQueryService,
    private readonly configService: ConfigService,
  ) {}

  addDocument(
    filePath: string,
    fileName: string,
    fileType: string,
    config: KnowledgeBaseConfig = {},
  ): Promise<{
    success: boolean;
    message: string;
    documentId: string;
    chunkCount: number;
  }> {
    return this.serialize(async () => {
      const result = await this.indexer.ingest({
        sourceIdentity: this.sourceIdentity(fileName),
        filePath,
        fileName: path.basename(fileName),
        mimeType: fileType,
        category: config.category,
        tags: config.tags,
        embeddingModel: this.embeddingModel(),
      });
      return {
        success: true,
        message: `Document ${fileName} added to knowledge base successfully`,
        documentId: result.documentId,
        chunkCount: result.childCount,
      };
    });
  }

  retrieve(request: RagRetrieveRequest): Promise<RagRetrieveResult> {
    return this.ragQuery.retrieve(request);
  }

  answer(request: RagAnswerRequest): Promise<RagAnswerResult> {
    return this.ragQuery.answer(request);
  }

  async search(
    question: string,
    config?: {
      topK?: number;
      filter?: { category?: string; tags?: string[] };
    },
  ): Promise<SearchResult> {
    const result = await this.answer({
      query: question,
      limit: config?.topK,
      filter: config?.filter,
    });
    const sources = result.evidence.map(source => ({
      content: source.content,
      metadata: {
        ...source.metadata,
        sourceId: source.sourceId,
        parentId: source.parentId,
        documentId: source.documentId,
        versionId: source.versionId,
        fileName: source.documentName,
        fileType: source.mimeType,
        sourceIdentity: source.sourceIdentity,
        headingPath: [...source.headingPath],
        category: source.category,
        tags: [...source.tags],
        updatedAt: source.documentUpdatedAt,
      },
      score: source.confidence,
    }));
    return {
      answer: result.answer,
      sources,
      confidence: result.evidence[0]?.confidence || 0,
      processingTime: result.timings.totalMs,
    };
  }

  async getStats(): Promise<KnowledgeBaseStats> {
    const documents = this.repository.listDocuments();
    const versions = documents
      .map(document =>
        document.currentVersionId
          ? this.repository.getDocumentVersion(document.currentVersionId)
          : null,
      )
      .filter(Boolean);
    return {
      totalDocuments: documents.length,
      totalChunks: versions.reduce(
        (total, version) => total + version.childCount,
        0,
      ),
      categories: [
        ...new Set(documents.map(document => document.category).filter(Boolean)),
      ].sort(),
      lastUpdated:
        documents
          .map(document => document.updatedAt)
          .sort()
          .at(-1) || 'Never',
      vectorStorePath:
        this.repository.getActiveGeneration()?.indexPath || '',
    };
  }

  async listDocuments(
    filter: { category?: string; tags?: string[] } = {},
  ): Promise<DocumentMetadata[]> {
    return this.repository.listDocuments(filter).map(document => {
      const version = document.currentVersionId
        ? this.repository.getDocumentVersion(document.currentVersionId)
        : null;
      return {
        id: document.id,
        fileName: document.displayName,
        fileType: document.mimeType,
        uploadDate: version?.createdAt || document.createdAt,
        chunkCount: version?.childCount || 0,
        tags: [...document.tags],
        category: document.category,
      };
    });
  }

  removeDocument(
    documentId: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.serialize(async () => {
      if (!this.repository.deactivateDocument(documentId)) {
        return {
          success: false,
          message: `Document ${documentId} not found`,
        };
      }
      await this.indexer.rebuild(this.embeddingModel());
      return {
        success: true,
        message: `Document ${documentId} removed from knowledge base`,
      };
    });
  }

  clear(): Promise<{ success: boolean; message: string }> {
    return this.serialize(async () => {
      const removed = this.repository.clearCorpus();
      await this.indexer.rebuild(this.embeddingModel());
      return {
        success: true,
        message: `Knowledge base cleared successfully (${removed} documents removed)`,
      };
    });
  }

  rebuild(): Promise<{
    success: boolean;
    message: string;
    documentsProcessed: number;
  }> {
    return this.serialize(async () => {
      const documentsProcessed = this.repository.listDocuments().length;
      const result = await this.indexer.rebuild(this.embeddingModel());
      this.logger.log(
        `Activated RAG generation ${result.activeGenerationId} with ${result.vectorCount} vectors`,
      );
      return {
        success: true,
        message: 'Knowledge base rebuilt successfully',
        documentsProcessed,
      };
    });
  }

  static selectRelevantDocs(
    scored: Array<[Document, number]>,
    options: {
      topK: number;
      liveDocIds: Set<string>;
      filter?: { category?: string; tags?: string[] };
      maxRelativeDistance?: number;
    },
  ): Array<{ content: string; metadata: any; score: number }> {
    const surviving = [...scored]
      .sort((left, right) => left[1] - right[1])
      .filter(([document]) => {
        const documentId = document.metadata?.documentId;
        if (documentId && !options.liveDocIds.has(documentId)) return false;
        if (
          options.filter?.category &&
          document.metadata?.category !== options.filter.category
        ) {
          return false;
        }
        if (
          options.filter?.tags?.length &&
          !options.filter.tags.some(tag =>
            document.metadata?.tags?.includes(tag),
          )
        ) {
          return false;
        }
        return true;
      });
    if (!surviving.length) return [];

    const cutoff =
      surviving[0][1] * (options.maxRelativeDistance ?? 1.5);
    return surviving
      .filter(([, distance]) => distance <= cutoff)
      .slice(0, options.topK)
      .map(([document, distance]) => ({
        content: document.pageContent,
        metadata: document.metadata,
        score: distance,
      }));
  }

  static confidenceFromDistance(distance: number): number {
    return Number.isFinite(distance) && distance >= 0
      ? 1 / (1 + distance)
      : 0;
  }

  private sourceIdentity(fileName: string): string {
    return `document:${path
      .basename(fileName)
      .normalize('NFKC')
      .trim()
      .toLowerCase()}`;
  }

  private embeddingModel(): string | undefined {
    return this.configService.get<string>('EMBEDDING_MODEL');
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
