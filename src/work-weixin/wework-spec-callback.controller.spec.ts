import {
  Controller,
  INestApplication,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { request } from 'http';
import { SecurityModule } from '../common/security/security.module';
import { WeworkSpecCallbackController } from './wework-spec-callback.controller';
import { WeworkSpecCallbackService } from './wework-spec-callback.service';

function httpRequest(
  app: INestApplication,
  method: string,
  path: string,
  token?: string,
): Promise<number> {
  const address = app.getHttpServer().address() as AddressInfo;
  const body = JSON.stringify({ test: true });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: address.port,
        method,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...(token ? { 'x-weixin-sync-token': token } : {}),
        },
      },
      response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode || 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

@Controller()
class NoopController {}

describe('WeworkSpecCallbackController security integration', () => {
  let app: INestApplication;
  const callbackService = {
    handleWeworkCallForward: jest.fn().mockResolvedValue({
      success: true,
      message: 'ok',
    }),
    handleAiQuery: jest.fn().mockResolvedValue({
      errcode: 0,
      errmsg: 'ok',
      reply: 'reply',
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              ADMIN_API_KEY: 'admin-secret',
              WORK_WEIXIN_SYNC_TOKEN: 'sync-secret',
            }),
          ],
        }),
        SecurityModule,
      ],
      controllers: [WeworkSpecCallbackController, NoopController],
      providers: [
        {
          provide: WeworkSpecCallbackService,
          useValue: callbackService,
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps zone health public', async () => {
    expect(await httpRequest(app, 'GET', '/spec-callback/health')).toBe(200);
  });

  it('requires the T01 internal callback token for zone callback routes', async () => {
    expect(
      await httpRequest(app, 'POST', '/spec-callback/wework-call'),
    ).toBe(401);
    expect(
      await httpRequest(
        app,
        'POST',
        '/spec-callback/wework-call',
        'sync-secret',
      ),
    ).toBe(201);
    expect(callbackService.handleWeworkCallForward).toHaveBeenCalled();
  });

  it('keeps AI query under the same internal callback token', async () => {
    expect(
      await httpRequest(app, 'POST', '/spec-callback/ai-query', 'wrong'),
    ).toBe(401);
    expect(
      await httpRequest(
        app,
        'POST',
        '/spec-callback/ai-query',
        'sync-secret',
      ),
    ).toBe(201);
  });
});
