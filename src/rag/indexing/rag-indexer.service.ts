import { Inject, Injectable } from '@nestjs/common';
import {
  EmbeddingProvider,
  IngestDocumentRequest,
  IngestDocumentResult,
  RAG_EMBEDDINGS,
  RebuildIndexResult,
} from '../domain/rag.types';
import { DocumentLoaderService } from '../ingestion/document-loader.service';
import { StructureChunkerService } from '../ingestion/structure-chunker.service';
import {
  PendingDocumentActivation,
  RagRepository,
} from '../storage/rag.repository';
import { IndexGenerationStore } from './index-generation.store';

@Injectable()
export class RagIndexerService {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: RagRepository,
    private readonly loader: DocumentLoaderService,
    private readonly chunker: StructureChunkerService,
    private readonly generations: IndexGenerationStore,
    @Inject(RAG_EMBEDDINGS)
    private readonly embeddings: EmbeddingProvider,
  ) {}

  ingest(
    request: IngestDocumentRequest,
  ): Promise<IngestDocumentResult> {
    return this.serialize(() => this.ingestSerialized(request));
  }

  rebuild(embeddingModel?: string): Promise<RebuildIndexResult> {
    return this.serialize(() => this.rebuildSerialized(embeddingModel));
  }

  private async ingestSerialized(
    request: IngestDocumentRequest,
  ): Promise<IngestDocumentResult> {
    const job = this.repository.createIngestionJob(
      request.sourceIdentity,
      {
        fileName: request.fileName,
        mimeType: request.mimeType,
        category: request.category,
        tags: request.tags,
        embeddingModel: request.embeddingModel,
      },
    );
    let generationId: string | null = null;

    try {
      const loaded = await this.loader.load(request);
      const existing = this.repository.findDocumentBySourceIdentity(
        loaded.sourceIdentity,
      );
      const currentVersion =
        existing?.active && existing.currentVersionId
          ? this.repository.getCurrentVersion(existing.id)
          : null;
      if (
        existing?.active &&
        currentVersion?.contentSha256 === loaded.contentSha256
      ) {
        if (this.repository.metadataMatches(existing, loaded)) {
          this.repository.completeJobWithoutGeneration(
            job.id,
            existing.id,
            currentVersion.id,
            'noop',
          );
          return {
            jobId: job.id,
            documentId: existing.id,
            versionId: currentVersion.id,
            generationId: null,
            activeGenerationId:
              this.repository.getCorpusState().activeGenerationId,
            parentCount: currentVersion.parentCount,
            childCount: currentVersion.childCount,
            changed: false,
            status: 'unchanged',
          };
        }
        this.repository.updateDocumentMetadata(
          existing.id,
          loaded,
          job.id,
        );
        return {
          jobId: job.id,
          documentId: existing.id,
          versionId: currentVersion.id,
          generationId: null,
          activeGenerationId:
            this.repository.getCorpusState().activeGenerationId,
          parentCount: currentVersion.parentCount,
          childCount: currentVersion.childCount,
          changed: true,
          status: 'metadata-updated',
        };
      }

      const documentId =
        existing?.id || RagRepository.documentId(loaded.sourceIdentity);
      const versionId = RagRepository.versionId(
        documentId,
        loaded.contentSha256,
      );
      const chunked = this.chunker.chunk(loaded, {
        documentId,
        versionId,
      });
      this.repository.stageDocumentVersion(loaded, chunked, job.id);
      const generation = this.repository.createGeneration(
        request.embeddingModel || null,
        job.id,
      );
      generationId = generation.id;
      const candidates = this.repository.listGenerationCandidates({
        documentId,
        versionId,
      });
      const vectors = await this.embedCandidates(candidates);
      this.repository.stageGenerationSnapshot(generation.id, candidates);
      const staged = await this.generations.stageGeneration({
        generationId: generation.id,
        embeddingModel: request.embeddingModel || null,
        vectors,
        childChunkIds: candidates.map(candidate => candidate.child.id),
      });
      this.repository.markGenerationReady(generation.id, {
        embeddingDimension: staged.manifest.dimension,
        vectorCount: staged.manifest.vectorCount,
        manifestSha256: staged.manifestSha256,
      });
      const finalPath = await this.generations.promote(staged);
      const pending: PendingDocumentActivation = {
        documentId,
        versionId,
        displayName: loaded.fileName,
        sourceType: loaded.sourceType,
        mimeType: loaded.mimeType,
        category: loaded.category,
        tags: loaded.tags,
        metadata: loaded.metadata,
      };
      const state = this.repository.activateGeneration({
        generationId: generation.id,
        indexPath: finalPath,
        manifestSha256: staged.manifestSha256,
        embeddingDimension: staged.manifest.dimension,
        vectorCount: staged.manifest.vectorCount,
        jobId: job.id,
        document: pending,
      });
      return {
        jobId: job.id,
        documentId,
        versionId,
        generationId: generation.id,
        activeGenerationId: state.activeGenerationId,
        parentCount: chunked.parents.length,
        childCount: chunked.children.length,
        changed: true,
        status: 'indexed',
      };
    } catch (error) {
      if (generationId) {
        this.repository.failGeneration(generationId, error);
        await this.generations.discardStaging(generationId);
      }
      this.repository.failJob(job.id, error);
      throw error;
    }
  }

  private async rebuildSerialized(
    embeddingModel?: string,
  ): Promise<RebuildIndexResult> {
    const job = this.repository.createIngestionJob('__corpus_rebuild__', {
      embeddingModel,
    });
    let generationId: string | null = null;
    try {
      const generation = this.repository.createGeneration(
        embeddingModel || null,
        job.id,
      );
      generationId = generation.id;
      const candidates = this.repository.listGenerationCandidates();
      const vectors = await this.embedCandidates(candidates);
      this.repository.stageGenerationSnapshot(generation.id, candidates);
      const staged = await this.generations.stageGeneration({
        generationId: generation.id,
        embeddingModel: embeddingModel || null,
        vectors,
        childChunkIds: candidates.map(candidate => candidate.child.id),
      });
      this.repository.markGenerationReady(generation.id, {
        embeddingDimension: staged.manifest.dimension,
        vectorCount: staged.manifest.vectorCount,
        manifestSha256: staged.manifestSha256,
      });
      const finalPath = await this.generations.promote(staged);
      const state = this.repository.activateGeneration({
        generationId: generation.id,
        indexPath: finalPath,
        manifestSha256: staged.manifestSha256,
        embeddingDimension: staged.manifest.dimension,
        vectorCount: staged.manifest.vectorCount,
        jobId: job.id,
      });
      if (!state.activeGenerationId) {
        throw new Error('Rebuild did not activate a corpus generation');
      }
      return {
        jobId: job.id,
        generationId: generation.id,
        activeGenerationId: state.activeGenerationId,
        vectorCount: staged.manifest.vectorCount,
      };
    } catch (error) {
      if (generationId) {
        this.repository.failGeneration(generationId, error);
        await this.generations.discardStaging(generationId);
      }
      this.repository.failJob(job.id, error);
      throw error;
    }
  }

  private async embedCandidates(
    candidates: ReturnType<RagRepository['listGenerationCandidates']>,
  ): Promise<number[][]> {
    if (!candidates.length) {
      return [];
    }
    const texts = candidates.map(candidate => {
      const heading = candidate.parent.headingPath.join(' > ');
      return heading
        ? `${heading}\n${candidate.child.content}`
        : candidate.child.content;
    });
    const vectors = await this.embeddings.embedDocuments(texts);
    if (vectors.length !== candidates.length) {
      throw new Error(
        `Embedding provider returned ${vectors.length} vectors for ${candidates.length} chunks`,
      );
    }
    return vectors;
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
