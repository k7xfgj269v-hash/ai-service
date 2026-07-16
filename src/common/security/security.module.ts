import { CanActivate, ExecutionContext, Injectable, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminApiKeyGuard } from './api-key.guard';
import { InternalCallbackGuard } from './internal-callback.guard';

type RouteSecurityPolicy = 'public' | 'admin' | 'internal-callback';

const PUBLIC_LIVENESS_PATHS = new Set([
  '/health',
  '/health/live',
  '/health/liveness',
  '/healthz',
  '/livez',
  '/spec-callback/health',
]);

function normalizePath(path: string | undefined): string {
  const withoutQuery = (path || '/').split(/[?#]/, 1)[0];
  const withLeadingSlash = withoutQuery.startsWith('/')
    ? withoutQuery
    : `/${withoutQuery}`;
  const normalized = withLeadingSlash.replace(/\/{2,}/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

export function routeSecurityPolicy(
  method: string | undefined,
  path: string | undefined,
): RouteSecurityPolicy {
  const normalizedMethod = (method || '').toUpperCase();
  const normalizedPath = normalizePath(path);

  if (
    (normalizedMethod === 'GET' || normalizedMethod === 'POST') &&
    normalizedPath === '/work-weixin/callback'
  ) {
    return 'public';
  }

  if (normalizedMethod === 'POST' && normalizedPath === '/chat') {
    return 'public';
  }

  if (
    normalizedMethod === 'GET' &&
    PUBLIC_LIVENESS_PATHS.has(normalizedPath)
  ) {
    return 'public';
  }

  if (
    normalizedPath === '/spec-callback' ||
    normalizedPath.startsWith('/spec-callback/')
  ) {
    return 'internal-callback';
  }

  return 'admin';
}

@Injectable()
export class RouteSecurityGuard implements CanActivate {
  constructor(
    private readonly adminGuard: AdminApiKeyGuard,
    private readonly callbackGuard: InternalCallbackGuard,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      method?: string;
      originalUrl?: string;
      url?: string;
    }>();
    const policy = routeSecurityPolicy(
      request.method,
      request.originalUrl || request.url,
    );

    if (policy === 'public') return true;
    if (policy === 'internal-callback') {
      return this.callbackGuard.canActivate(context);
    }
    return this.adminGuard.canActivate(context);
  }
}

@Module({
  providers: [
    AdminApiKeyGuard,
    InternalCallbackGuard,
    {
      provide: APP_GUARD,
      useClass: RouteSecurityGuard,
    },
  ],
  exports: [AdminApiKeyGuard, InternalCallbackGuard],
})
export class SecurityModule {}
