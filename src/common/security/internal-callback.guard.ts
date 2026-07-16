import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constantTimeEqual } from './api-key.guard';

@Injectable()
export class InternalCallbackGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
    }>();
    const value = request.headers?.['x-weixin-sync-token'];
    const supplied = typeof value === 'string' ? value : undefined;
    const expected = this.configService.get<string>('WORK_WEIXIN_SYNC_TOKEN');

    if (!constantTimeEqual(supplied, expected)) {
      throw new UnauthorizedException('Invalid callback credentials');
    }
    return true;
  }
}
