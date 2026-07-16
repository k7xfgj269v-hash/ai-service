import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { OpenAIEmbeddings } from '@langchain/openai';
import * as path from 'path';
import { GenerationModule } from '../generation/generation.module';
import { CitationValidationService } from './answer/citation-validation.service';
import { EvidenceGateService } from './answer/evidence-gate.service';
import { ContextPackerService } from './context/context-packer.service';
import {
  RAG_DATABASE_PATH,
  RAG_EMBEDDINGS,
  RAG_INDEX_ROOT,
} from './domain/rag.types';
import { DocumentLoaderService } from './ingestion/document-loader.service';
import { StructureChunkerService } from './ingestion/structure-chunker.service';
import { IndexGenerationStore } from './indexing/index-generation.store';
import { RagIndexerService } from './indexing/rag-indexer.service';
import { RagQueryService } from './rag-query.service';
import { DenseRetrieverService } from './retrieval/dense-retriever.service';
import { HybridRetrievalService } from './retrieval/hybrid-retrieval.service';
import { SparseRetrieverService } from './retrieval/sparse-retriever.service';
import { RagRepository } from './storage/rag.repository';

@Module({
  imports: [ConfigModule, GenerationModule],
  providers: [
    {
      provide: RAG_DATABASE_PATH,
      useValue: path.join(process.cwd(), 'data', 'knowledge-base.db'),
    },
    {
      provide: RAG_INDEX_ROOT,
      useValue: path.join(process.cwd(), 'data', 'rag-indexes'),
    },
    {
      provide: RAG_EMBEDDINGS,
      useFactory: (configService: ConfigService) => {
        const baseURL = configService.get<string>(
          'EMBEDDING_API_BASE_URL',
        );
        return new OpenAIEmbeddings({
          apiKey: configService.get<string>('EMBEDDING_API_KEY'),
          modelName:
            configService.get<string>('EMBEDDING_MODEL') ||
            'text-embedding-v3',
          configuration: baseURL ? { baseURL } : undefined,
        });
      },
      inject: [ConfigService],
    },
    RagRepository,
    DocumentLoaderService,
    StructureChunkerService,
    IndexGenerationStore,
    RagIndexerService,
    DenseRetrieverService,
    SparseRetrieverService,
    HybridRetrievalService,
    ContextPackerService,
    EvidenceGateService,
    CitationValidationService,
    RagQueryService,
  ],
  exports: [
    RAG_DATABASE_PATH,
    RAG_INDEX_ROOT,
    RAG_EMBEDDINGS,
    RagRepository,
    DocumentLoaderService,
    StructureChunkerService,
    IndexGenerationStore,
    RagIndexerService,
    DenseRetrieverService,
    SparseRetrieverService,
    HybridRetrievalService,
    ContextPackerService,
    EvidenceGateService,
    CitationValidationService,
    RagQueryService,
  ],
})
export class RagModule {}
