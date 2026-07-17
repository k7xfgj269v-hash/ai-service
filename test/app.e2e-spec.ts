import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HealthModule } from '../src/health/health.module';
import { ReadinessProbe } from '../src/health/health.service';

describe('Health endpoints (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const PROBE = Symbol('E2E_READINESS_PROBE');
    const probe: ReadinessProbe = {
      name: 'e2e',
      check: () => true,
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        HealthModule.register([
          {
            token: PROBE,
            provider: { provide: PROBE, useValue: probe },
          },
        ]),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves liveness without external dependencies', async () => {
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('serves sanitized readiness results', async () => {
    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect({
        status: 'ready',
        checks: [{ name: 'e2e', status: 'up' }],
      });
  });
});
