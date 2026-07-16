import { Inject, Injectable, Optional } from '@nestjs/common';
import { IndexFlatL2 } from 'faiss-node';
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'fs/promises';
import * as path from 'path';
import {
  CorpusGeneration,
  GenerationManifest,
  GenerationRead,
  RAG_INDEX_ROOT,
  sha256Hex,
  stableJson,
  StagedGeneration,
} from '../domain/rag.types';
import { RagRepository } from '../storage/rag.repository';

interface StageGenerationInput {
  generationId: CorpusGeneration;
  embeddingModel: string | null;
  vectors: number[][];
  childChunkIds: string[];
}

@Injectable()
export class IndexGenerationStore {
  readonly rootPath: string;

  constructor(
    private readonly repository: RagRepository,
    @Optional()
    @Inject(RAG_INDEX_ROOT)
    rootPath?: string,
  ) {
    this.rootPath = path.resolve(
      rootPath || path.join(process.cwd(), 'data', 'rag-indexes'),
    );
  }

  async stageGeneration(
    input: StageGenerationInput,
  ): Promise<StagedGeneration> {
    this.assertGenerationId(input.generationId);
    const { dimension, flattened } = this.validateVectors(
      input.vectors,
      input.childChunkIds,
    );
    await mkdir(this.rootPath, { recursive: true });
    const stagingPath = this.stagingPath(input.generationId);
    const finalPath = this.finalPath(input.generationId);
    if (
      (await this.pathExists(stagingPath)) ||
      (await this.pathExists(finalPath))
    ) {
      throw new Error(
        `Generation path already exists for ${input.generationId}`,
      );
    }
    await mkdir(stagingPath);

    let indexPath: string | null = null;
    let indexSha256: string | null = null;
    if (input.vectors.length) {
      const index = new IndexFlatL2(dimension);
      index.add(flattened);
      indexPath = path.join(stagingPath, 'faiss.index');
      index.write(indexPath);
      indexSha256 = sha256Hex(await readFile(indexPath));
    }
    const manifest: GenerationManifest = {
      formatVersion: 1,
      generationId: input.generationId,
      embeddingModel: input.embeddingModel,
      dimension,
      vectorCount: input.vectors.length,
      childChunkIds: [...input.childChunkIds],
      indexSha256,
    };
    const manifestBody = stableJson(manifest);
    const manifestPath = path.join(stagingPath, 'manifest.json');
    await writeFile(manifestPath, manifestBody, {
      encoding: 'utf8',
      flag: 'wx',
    });
    const staged: StagedGeneration = {
      generationId: input.generationId,
      stagingPath,
      indexPath,
      manifestPath,
      manifest,
      manifestSha256: sha256Hex(manifestBody),
    };
    await this.validateDirectory(stagingPath, input.generationId);
    return staged;
  }

  async promote(staged: StagedGeneration): Promise<string> {
    await this.validateDirectory(
      staged.stagingPath,
      staged.generationId,
    );
    const finalPath = this.finalPath(staged.generationId);
    if (await this.pathExists(finalPath)) {
      throw new Error(
        `Final generation ${staged.generationId} already exists`,
      );
    }
    await rename(staged.stagingPath, finalPath);
    await this.validateDirectory(finalPath, staged.generationId);
    return finalPath;
  }

  async discardStaging(generationId: CorpusGeneration): Promise<void> {
    this.assertGenerationId(generationId);
    const stagingPath = this.stagingPath(generationId);
    if (!(await this.pathExists(stagingPath))) {
      return;
    }
    const { rm } = await import('fs/promises');
    await rm(stagingPath, { recursive: true, force: true });
  }

  async getActiveSnapshot(): Promise<GenerationRead | null> {
    const active = this.repository.getActiveGeneration();
    if (!active) {
      return null;
    }
    if (!active.indexPath) {
      throw new Error(
        `Active generation ${active.id} has no immutable index path`,
      );
    }
    return this.readGeneration(active.id, active.indexPath);
  }

  async readActiveGeneration(): Promise<GenerationRead | null> {
    return this.getActiveSnapshot();
  }

  isActiveGeneration(generation: CorpusGeneration): boolean {
    return this.repository.getActiveGeneration()?.id === generation;
  }

  async readGeneration(
    generation: CorpusGeneration,
    generationPath = this.finalPath(generation),
  ): Promise<GenerationRead> {
    const manifest = await this.validateDirectory(
      generationPath,
      generation,
    );
    const index =
      manifest.vectorCount > 0
        ? IndexFlatL2.read(path.join(generationPath, 'faiss.index'))
        : null;

    return {
      generation,
      dimension: manifest.dimension,
      size: manifest.vectorCount,
      search: (vector: number[], limit: number) => {
        if (!index || manifest.vectorCount === 0 || limit <= 0) {
          return [];
        }
        if (
          vector.length !== manifest.dimension ||
          vector.some(value => !Number.isFinite(value))
        ) {
          throw new Error(
            `Query vector must contain ${manifest.dimension} finite values`,
          );
        }
        const count = Math.min(
          Math.max(1, Math.floor(limit)),
          manifest.vectorCount,
        );
        const result = index.search(vector, count);
        return result.labels
          .map((label, indexPosition) => ({
            label,
            squaredL2: result.distances[indexPosition],
          }))
          .filter(
            item =>
              item.label >= 0 &&
              item.label < manifest.childChunkIds.length &&
              Number.isFinite(item.squaredL2),
          )
          .map(item => ({
            childId: manifest.childChunkIds[item.label],
            squaredL2: item.squaredL2,
          }));
      },
    };
  }

  private async validateDirectory(
    generationPath: string,
    expectedGeneration: CorpusGeneration,
  ): Promise<GenerationManifest> {
    const manifestPath = path.join(generationPath, 'manifest.json');
    const body = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(body) as GenerationManifest;
    if (
      manifest.formatVersion !== 1 ||
      manifest.generationId !== expectedGeneration ||
      !Number.isInteger(manifest.dimension) ||
      manifest.dimension < 0 ||
      !Number.isInteger(manifest.vectorCount) ||
      manifest.vectorCount < 0 ||
      !Array.isArray(manifest.childChunkIds) ||
      manifest.childChunkIds.length !== manifest.vectorCount ||
      new Set(manifest.childChunkIds).size !== manifest.childChunkIds.length
    ) {
      throw new Error(`Invalid manifest for ${expectedGeneration}`);
    }
    if (manifest.vectorCount === 0) {
      if (manifest.dimension !== 0 || manifest.indexSha256 !== null) {
        throw new Error(
          `Empty generation ${expectedGeneration} has invalid dimensions`,
        );
      }
      return manifest;
    }

    const indexPath = path.join(generationPath, 'faiss.index');
    const indexInfo = await stat(indexPath);
    if (!indexInfo.isFile()) {
      throw new Error(`FAISS index is missing for ${expectedGeneration}`);
    }
    const bytes = await readFile(indexPath);
    if (sha256Hex(bytes) !== manifest.indexSha256) {
      throw new Error(
        `FAISS checksum mismatch for ${expectedGeneration}`,
      );
    }
    const index = IndexFlatL2.read(indexPath);
    if (
      index.getDimension() !== manifest.dimension ||
      index.ntotal() !== manifest.vectorCount
    ) {
      throw new Error(
        `FAISS shape mismatch for ${expectedGeneration}`,
      );
    }
    return manifest;
  }

  private validateVectors(
    vectors: number[][],
    childChunkIds: string[],
  ): { dimension: number; flattened: number[] } {
    if (vectors.length !== childChunkIds.length) {
      throw new Error('Embedding and child ID counts must match');
    }
    if (new Set(childChunkIds).size !== childChunkIds.length) {
      throw new Error('Generation child IDs must be unique');
    }
    if (!vectors.length) {
      return { dimension: 0, flattened: [] };
    }
    const dimension = vectors[0].length;
    if (!dimension) {
      throw new Error('Embedding vectors must not be empty');
    }
    const flattened: number[] = [];
    for (const vector of vectors) {
      if (
        vector.length !== dimension ||
        vector.some(value => !Number.isFinite(value))
      ) {
        throw new Error(
          'Embedding vectors must have one finite, stable dimension',
        );
      }
      flattened.push(...vector);
    }
    return { dimension, flattened };
  }

  private stagingPath(generation: CorpusGeneration): string {
    return path.join(this.rootPath, `.staging-${generation}`);
  }

  private finalPath(generation: CorpusGeneration): string {
    this.assertGenerationId(generation);
    return path.join(this.rootPath, generation);
  }

  private assertGenerationId(generation: CorpusGeneration): void {
    if (!/^gen_\d{12}$/.test(generation)) {
      throw new Error(`Invalid generation ID: ${generation}`);
    }
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await stat(targetPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }
}

export type { StageGenerationInput };
