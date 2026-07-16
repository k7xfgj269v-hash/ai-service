import { Module } from '@nestjs/common';
import { AdminApiKeyGuard } from './api-key.guard';
import { InternalCallbackGuard } from './internal-callback.guard';

@Module({
  providers: [AdminApiKeyGuard, InternalCallbackGuard],
  exports: [AdminApiKeyGuard, InternalCallbackGuard],
})
export class SecurityModule {}
