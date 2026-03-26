import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WorkWeixinController } from './work-weixin.controller';
import { WorkWeixinService } from './work-weixin.service';
import { WeworkSpecCallbackController } from './wework-spec-callback.controller';
import { WeworkSpecCallbackService } from './wework-spec-callback.service';
import { AiServiceModule } from '../ai-service/ai.module';
import { KnowledgeBaseModule } from '../knowledge-base/knowledge-base.module';

@Module({
  imports: [ConfigModule, AiServiceModule, KnowledgeBaseModule],
  controllers: [WorkWeixinController, WeworkSpecCallbackController],
  providers: [WorkWeixinService, WeworkSpecCallbackService],
  exports: [WorkWeixinService, WeworkSpecCallbackService],
})
export class WorkWeixinModule {}
