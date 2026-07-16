import {
  DynamicModule,
  Module,
  Provider,
  Type,
} from '@nestjs/common';
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
