import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdminApiKeyGuard,
  constantTimeEqual,
} from './api-key.guard';
import { InternalCallbackGuard } from './internal-callback.guard';

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
});
