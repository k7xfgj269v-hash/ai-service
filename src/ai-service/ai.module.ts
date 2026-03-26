import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiService } from './ai.service';
import { KnowledgeBaseModule } from '../knowledge-base/knowledge-base.module';

@Module({
  imports: [ConfigModule, KnowledgeBaseModule],
  providers: [AiService],
  exports: [AiService],
})
export class AiServiceModule {}
