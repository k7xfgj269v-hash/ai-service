import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';

export function constantTimeEqual(
  supplied: string | undefined,
  expected: string | undefined,
): boolean {
  if (!supplied || !expected) return false;

  const suppliedDigest = createHash('sha256').update(supplied).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function readHeader(
  request: { headers?: Record<string, string | string[] | undefined> },
  name: string,
): string | undefined {
  const value = request.headers?.[name];
  return typeof value === 'string' ? value : undefined;
}

@Injectable()
export class AdminApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const supplied = readHeader(request, 'x-admin-key');
    const expected = this.configService.get<string>('ADMIN_API_KEY');

    if (!constantTimeEqual(supplied, expected)) {
      throw new UnauthorizedException('Invalid admin credentials');
    }
    return true;
  }
}
