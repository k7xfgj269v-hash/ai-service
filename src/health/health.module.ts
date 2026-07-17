import {
  DynamicModule,
  Module,
  Provider,
  Type,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiServiceModule } from '../ai-service/ai.module';
import { RagModule } from '../rag/rag.module';
import {
  ActiveIndexReadinessProbe,
  ConfigurationReadinessProbe,
  Fts5ReadinessProbe,
  RedisReadinessProbe,
  SqliteReadinessProbe,
  StorageReadinessProbe,
} from './core-readiness.probes';
import { HealthController } from './health.controller';
import {
  HealthService,
  READINESS_PROBES,
  ReadinessProbe,
} from './health.service';

export interface ReadinessProbeRegistration {
  token: string | symbol | Type<ReadinessProbe>;
  provider: Provider;
}

@Module({})
export class HealthModule {
  static registerCore(): DynamicModule {
    return {
      module: HealthModule,
      imports: [ConfigModule, AiServiceModule, RagModule],
      controllers: [HealthController],
      providers: [
        ConfigurationReadinessProbe,
        RedisReadinessProbe,
        SqliteReadinessProbe,
        Fts5ReadinessProbe,
        StorageReadinessProbe,
        ActiveIndexReadinessProbe,
        {
          provide: READINESS_PROBES,
          useFactory: (
            configuration: ConfigurationReadinessProbe,
            redis: RedisReadinessProbe,
            sqlite: SqliteReadinessProbe,
            fts5: Fts5ReadinessProbe,
            storage: StorageReadinessProbe,
            activeIndex: ActiveIndexReadinessProbe,
          ): ReadinessProbe[] => [
            configuration,
            redis,
            sqlite,
            fts5,
            storage,
            activeIndex,
          ],
          inject: [
            ConfigurationReadinessProbe,
            RedisReadinessProbe,
            SqliteReadinessProbe,
            Fts5ReadinessProbe,
            StorageReadinessProbe,
            ActiveIndexReadinessProbe,
          ],
        },
        HealthService,
      ],
      exports: [HealthService, READINESS_PROBES],
    };
  }

  static register(
    registrations: readonly ReadinessProbeRegistration[] = [],
  ): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [
        ...registrations.map(registration => registration.provider),
        {
          provide: READINESS_PROBES,
          useFactory: (...probes: ReadinessProbe[]) => probes,
          inject: registrations.map(registration => registration.token),
        },
        HealthService,
      ],
      exports: [HealthService, READINESS_PROBES],
    };
  }
}
