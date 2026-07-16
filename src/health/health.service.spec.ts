import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthModule } from './health.module';
import {
  HealthService,
  ReadinessProbe,
} from './health.service';

describe('HealthService', () => {
  it('reports liveness without invoking readiness dependencies', () => {
    const probe: ReadinessProbe = {
      name: 'storage',
      check: jest.fn(() => {
        throw new Error('must not run');
      }),
    };
    const service = new HealthService([probe]);

    expect(service.liveness()).toEqual({ status: 'ok' });
    expect(probe.check).not.toHaveBeenCalled();
  });

  it('collects injected readiness probes without accessing private fields', async () => {
    const STORAGE_PROBE = Symbol('STORAGE_PROBE');
    const CACHE_PROBE = Symbol('CACHE_PROBE');
    const storageProbe: ReadinessProbe = {
      name: 'storage',
      check: jest.fn(async () => true),
    };
    const cacheProbe: ReadinessProbe = {
      name: 'cache',
      check: jest.fn(() => undefined),
    };
    const module = await Test.createTestingModule({
      imports: [
        HealthModule.register([
          {
            token: STORAGE_PROBE,
            provider: { provide: STORAGE_PROBE, useValue: storageProbe },
          },
          {
            token: CACHE_PROBE,
            provider: { provide: CACHE_PROBE, useValue: cacheProbe },
          },
        ]),
      ],
    }).compile();

    const service = module.get(HealthService);

    await expect(service.readiness()).resolves.toEqual({
      status: 'ready',
      checks: [
        { name: 'storage', status: 'up' },
        { name: 'cache', status: 'up' },
      ],
    });
    expect(storageProbe.check).toHaveBeenCalledTimes(1);
    expect(cacheProbe.check).toHaveBeenCalledTimes(1);
  });

  it('reports failed probes without exposing exception details or unsafe names', async () => {
    const service = new HealthService([
      {
        name: '/srv/private/database?token=secret',
        check: async () => {
          throw new Error('/srv/private/database failed with token=secret');
        },
      },
    ]);

    const result = await service.readiness();
    const serialized = JSON.stringify(result);

    expect(result).toEqual({
      status: 'not_ready',
      checks: [{ name: 'probe-1', status: 'down' }],
    });
    expect(serialized).not.toContain('/srv/private');
    expect(serialized).not.toContain('secret');
  });

  it('maps an unready result to HTTP 503 with only the sanitized result', async () => {
    const service = new HealthService([
      { name: 'sqlite', check: () => false },
    ]);
    const controller = new HealthController(service);

    await expect(controller.readiness()).rejects.toEqual(
      new ServiceUnavailableException({
        status: 'not_ready',
        checks: [{ name: 'sqlite', status: 'down' }],
      }),
    );
  });
});
