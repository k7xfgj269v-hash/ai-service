import {
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { request } from 'http';
import {
  AdminApiKeyGuard,
  constantTimeEqual,
} from './api-key.guard';
import { InternalCallbackGuard } from './internal-callback.guard';
import {
  routeSecurityPolicy,
  SecurityModule,
} from './security.module';

@Controller()
class SecurityTestController {
  @Post('chat')
  chat() {
    return { ok: true };
  }

  @Post('chat/clear')
  clearChat() {
    return { ok: true };
  }

  @Get('health/live')
  liveness() {
    return { ok: true };
  }

  @Get('work-weixin/callback')
  verifyWorkWeixin() {
    return { ok: true };
  }

  @Post('work-weixin/callback')
  receiveWorkWeixin() {
    return { ok: true };
  }

  @Post('spec-callback/wework-call')
  zoneCallback() {
    return { ok: true };
  }

  @Post('knowledge-base/add')
  uploadDocument() {
    return { ok: true };
  }
}

function contextWithHeader(
  name: string,
  value?: string | string[],
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: value === undefined ? {} : { [name]: value },
      }),
    }),
  } as ExecutionContext;
}

function configWith(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function httpRequest(
  app: INestApplication,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const address = app.getHttpServer().address() as AddressInfo;

  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: address.port,
        method,
        path,
        headers,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode || 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('security guards', () => {
  describe('constantTimeEqual()', () => {
    it('accepts identical secrets', () => {
      expect(constantTimeEqual('same-secret', 'same-secret')).toBe(true);
    });

    it('rejects different secrets even when their lengths differ', () => {
      expect(constantTimeEqual('short', 'a-much-longer-secret')).toBe(false);
      expect(constantTimeEqual('same-length-a', 'same-length-b')).toBe(false);
    });

    it.each([
      [undefined, 'expected'],
      ['supplied', undefined],
      ['', 'expected'],
      ['supplied', ''],
    ])('rejects missing secrets', (supplied, expected) => {
      expect(constantTimeEqual(supplied, expected)).toBe(false);
    });
  });

  describe('AdminApiKeyGuard', () => {
    it('allows the configured admin key', () => {
      const guard = new AdminApiKeyGuard(
        configWith({ ADMIN_API_KEY: 'admin-secret' }),
      );

      expect(
        guard.canActivate(contextWithHeader('x-admin-key', 'admin-secret')),
      ).toBe(true);
    });

    it('rejects an incorrect admin key without exposing the secret', () => {
      const guard = new AdminApiKeyGuard(
        configWith({ ADMIN_API_KEY: 'admin-secret' }),
      );

      expect(() =>
        guard.canActivate(contextWithHeader('x-admin-key', 'wrong')),
      ).toThrow(new UnauthorizedException('Invalid admin credentials'));
    });

    it.each([
      ['missing', undefined],
      ['array-valued', ['admin-secret']],
    ])('rejects a %s admin header', (_case, value) => {
      const guard = new AdminApiKeyGuard(
        configWith({ ADMIN_API_KEY: 'admin-secret' }),
      );

      expect(() =>
        guard.canActivate(contextWithHeader('x-admin-key', value)),
      ).toThrow(UnauthorizedException);
    });

    it('defaults to deny when the configured admin key is missing', () => {
      const guard = new AdminApiKeyGuard(configWith({}));

      expect(() =>
        guard.canActivate(contextWithHeader('x-admin-key', 'supplied')),
      ).toThrow(UnauthorizedException);
    });
  });

  describe('InternalCallbackGuard', () => {
    it('allows the configured internal callback token', () => {
      const guard = new InternalCallbackGuard(
        configWith({ WORK_WEIXIN_SYNC_TOKEN: 'sync-secret' }),
      );

      expect(
        guard.canActivate(
          contextWithHeader('x-weixin-sync-token', 'sync-secret'),
        ),
      ).toBe(true);
    });

    it('rejects an incorrect callback token without exposing the secret', () => {
      const guard = new InternalCallbackGuard(
        configWith({ WORK_WEIXIN_SYNC_TOKEN: 'sync-secret' }),
      );

      expect(() =>
        guard.canActivate(
          contextWithHeader('x-weixin-sync-token', 'incorrect'),
        ),
      ).toThrow(new UnauthorizedException('Invalid callback credentials'));
    });

    it.each([
      ['missing', undefined],
      ['array-valued', ['sync-secret']],
    ])('rejects a %s callback header', (_case, value) => {
      const guard = new InternalCallbackGuard(
        configWith({ WORK_WEIXIN_SYNC_TOKEN: 'sync-secret' }),
      );

      expect(() =>
        guard.canActivate(contextWithHeader('x-weixin-sync-token', value)),
      ).toThrow(UnauthorizedException);
    });

    it('defaults to deny when the configured callback token is missing', () => {
      const guard = new InternalCallbackGuard(configWith({}));

      expect(() =>
        guard.canActivate(
          contextWithHeader('x-weixin-sync-token', 'supplied'),
        ),
      ).toThrow(UnauthorizedException);
    });
  });

  describe('routeSecurityPolicy()', () => {
    it.each([
      ['POST', '/chat'],
      ['GET', '/health/live'],
      ['GET', '/work-weixin/callback'],
      ['POST', '/work-weixin/callback'],
      ['GET', '/spec-callback/health'],
    ])('keeps %s %s public', (method, path) => {
      expect(routeSecurityPolicy(method, path)).toBe('public');
    });

    it.each([
      ['POST', '/spec-callback/wework-call'],
      ['POST', '/spec-callback/ai-query'],
    ])('protects %s %s with the callback token', (method, path) => {
      expect(routeSecurityPolicy(method, path)).toBe('internal-callback');
    });

    it.each([
      ['POST', '/chat/clear'],
      ['POST', '/knowledge-base/add'],
      ['GET', '/knowledge-base/documents'],
      ['POST', '/work-weixin/send'],
      ['POST', '/work-weixin/refresh-token'],
      ['POST', '/weixin-knowledge-sync/sync-now'],
      ['GET', '/unclassified-route'],
    ])('defaults %s %s to admin authentication', (method, path) => {
      expect(routeSecurityPolicy(method, path)).toBe('admin');
    });
  });

  describe('global route security guard', () => {
    let app: INestApplication;

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
        controllers: [SecurityTestController],
      }).compile();

      app = moduleRef.createNestApplication();
      await app.listen(0, '127.0.0.1');
    });

    afterAll(async () => {
      await app.close();
    });

    it.each([
      ['POST', '/chat'],
      ['GET', '/health/live'],
      ['GET', '/work-weixin/callback'],
      ['POST', '/work-weixin/callback'],
    ])('allows public %s %s without credentials', async (method, path) => {
      expect(await httpRequest(app, method, path)).toBeLessThan(400);
    });

    it.each([
      ['missing', {}],
      ['invalid', { 'x-admin-key': 'wrong' }],
    ])('rejects a privileged route with %s admin credentials', async (_case, headers) => {
      expect(
        await httpRequest(app, 'POST', '/knowledge-base/add', headers),
      ).toBe(401);
    });

    it('allows a privileged route with the configured admin key', async () => {
      expect(
        await httpRequest(app, 'POST', '/knowledge-base/add', {
          'x-admin-key': 'admin-secret',
        }),
      ).toBeLessThan(400);
    });

    it.each([
      ['missing', {}],
      ['invalid', { 'x-weixin-sync-token': 'wrong' }],
    ])('rejects a zone callback with a %s sync token', async (_case, headers) => {
      expect(
        await httpRequest(app, 'POST', '/spec-callback/wework-call', headers),
      ).toBe(401);
    });

    it('allows a zone callback with the configured sync token', async () => {
      expect(
        await httpRequest(app, 'POST', '/spec-callback/wework-call', {
          'x-weixin-sync-token': 'sync-secret',
        }),
      ).toBeLessThan(400);
    });
  });
});
