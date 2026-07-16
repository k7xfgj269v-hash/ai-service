import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { KnowledgeBaseController } from './knowledge-base.controller';
import { WeixinSyncController } from './weixin-sync.controller';
import { KnowledgeBaseService } from './knowledge-base.service';
import { WeixinKnowledgeSyncService } from './weixin-sync.service';
import { RagModule } from '../rag/rag.module';

@Module({
  imports: [ConfigModule, RagModule],
  controllers: [KnowledgeBaseController, WeixinSyncController],
  providers: [KnowledgeBaseService, WeixinKnowledgeSyncService],
  exports: [KnowledgeBaseService, WeixinKnowledgeSyncService, RagModule],
})
export class KnowledgeBaseModule {}
