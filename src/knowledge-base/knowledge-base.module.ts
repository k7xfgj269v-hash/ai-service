import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { KnowledgeBaseController } from './knowledge-base.controller';
import { WeixinSyncController } from './weixin-sync.controller';
import { KnowledgeBaseService } from './knowledge-base.service';
import { WeixinKnowledgeSyncService } from './weixin-sync.service';

@Module({
  imports: [ConfigModule],
  controllers: [KnowledgeBaseController, WeixinSyncController],
  providers: [KnowledgeBaseService, WeixinKnowledgeSyncService],
  exports: [KnowledgeBaseService, WeixinKnowledgeSyncService],
})
export class KnowledgeBaseModule {}
