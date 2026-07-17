import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import * as path from 'path';
import Redis from 'ioredis';
import { CONVERSATION_REDIS } from '../ai-service/ai.service';
import { IndexGenerationStore } from '../rag/indexing/index-generation.store';
import { RagRepository } from '../rag/storage/rag.repository';
import { ReadinessProbe } from './health.service';

@Injectable()
export class ConfigurationReadinessProbe implements ReadinessProbe {
  readonly name = 'configuration';

  constructor(private readonly configService: ConfigService) {}

  check(): boolean {
    const required = [
      'REDIS_URL',
      'EXPERT_API_KEY',
      'EXPERT_API_BASE_URL',
      'EXPERT_MODEL',
      'EMBEDDING_API_KEY',
      'EMBEDDING_API_BASE_URL',
      'EMBEDDING_MODEL',
    ];
    if (this.configService.get<string>('NODE_ENV') === 'production') {
      required.push('ADMIN_API_KEY');
    }
    return required.every(key => {
      const value = this.configService.get<unknown>(key);
      return value !== undefined && String(value).trim().length > 0;
    });
  }
}

@Injectable()
export class RedisReadinessProbe implements ReadinessProbe {
  readonly name = 'redis';

  constructor(
    @Inject(CONVERSATION_REDIS) private readonly redis: Redis,
  ) {}

  async check(): Promise<boolean> {
    return (await this.redis.ping()) === 'PONG';
  }
}

@Injectable()
export class SqliteReadinessProbe implements ReadinessProbe {
  readonly name = 'sqlite';

  constructor(private readonly repository: RagRepository) {}

  check(): boolean {
    return this.repository.healthCheck();
  }
}

@Injectable()
export class Fts5ReadinessProbe implements ReadinessProbe {
  readonly name = 'fts5';

  check(): boolean {
    const database = new Database(':memory:');
    try {
      database.exec(`
        CREATE VIRTUAL TABLE readiness_fts USING fts5(
          content,
          tokenize = 'trigram'
        );
        INSERT INTO readiness_fts(content) VALUES ('health readiness');
      `);
      const row = database
        .prepare(
          'SELECT COUNT(*) AS count FROM readiness_fts WHERE readiness_fts MATCH ?',
        )
        .get('alth') as { count: number };
      return row.count === 1;
    } finally {
      database.close();
    }
  }
}

@Injectable()
export class StorageReadinessProbe implements ReadinessProbe {
  readonly name = 'storage';

  constructor(private readonly indexStore: IndexGenerationStore) {}

  async check(): Promise<boolean> {
    await mkdir(this.indexStore.rootPath, { recursive: true });
    const probePath = path.join(
      this.indexStore.rootPath,
      `.health-${randomUUID()}`,
    );
    try {
      await writeFile(probePath, 'ok', { encoding: 'utf8', flag: 'wx' });
      return true;
    } finally {
      await unlink(probePath).catch(() => undefined);
    }
  }
}

@Injectable()
export class ActiveIndexReadinessProbe implements ReadinessProbe {
  readonly name = 'faiss';

  constructor(
    private readonly repository: RagRepository,
    private readonly indexStore: IndexGenerationStore,
  ) {}

  async check(): Promise<boolean> {
    const active = this.repository.getActiveGeneration();
    if (!active) {
      return this.repository.listDocuments().length === 0;
    }
    const snapshot = await this.indexStore.getActiveSnapshot();
    return snapshot?.generation === active.id;
  }
}
