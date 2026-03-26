import { Controller, Post, Get, Delete, Body } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WeixinKnowledgeSyncService } from './weixin-sync.service';
import {
  StartAutoSyncDto,
  SyncResponseDto,
  SyncStatusDto,
  ManualUpdateResponseDto,
} from './weixin-sync.dto';

@ApiTags('weixin-knowledge-sync')
@Controller('weixin-knowledge-sync')
export class WeixinSyncController {
  constructor(
    private readonly weixinSyncService: WeixinKnowledgeSyncService,
  ) {}

  @Post('start')
  @ApiOperation({ summary: '启动企业微信聊天记录自动同步' })
  @ApiResponse({
    status: 200,
    description: '自动同步已启动',
    type: SyncResponseDto,
  })
  async startAutoSync(
    @Body() body: StartAutoSyncDto,
  ): Promise<SyncResponseDto> {
    await this.weixinSyncService.startAutoSync({
      enabled: body.enabled,
      syncInterval: body.syncInterval,
      autoUpdate: body.autoUpdate,
      minRecordsForUpdate: body.minRecordsForUpdate,
    });

    return {
      success: true,
      recordsProcessed: 0,
      message: '企业微信聊天记录自动同步已启动',
    };
  }

  @Post('stop')
  @ApiOperation({ summary: '停止自动同步' })
  @ApiResponse({
    status: 200,
    description: '自动同步已停止',
  })
  async stopAutoSync(): Promise<{ success: boolean; message: string }> {
    this.weixinSyncService.stopAutoSync();
    return {
      success: true,
      message: '企业微信聊天记录自动同步已停止',
    };
  }

  @Post('sync-now')
  @ApiOperation({ summary: '立即执行一次同步' })
  @ApiResponse({
    status: 200,
    description: '同步完成',
    type: SyncResponseDto,
  })
  async syncNow(@Body() body: StartAutoSyncDto): Promise<SyncResponseDto> {
    return await this.weixinSyncService.syncChatRecords({
      enabled: body.enabled,
      syncInterval: body.syncInterval,
      autoUpdate: body.autoUpdate,
      minRecordsForUpdate: body.minRecordsForUpdate,
    });
  }

  @Post('update-knowledge-base')
  @ApiOperation({ summary: '手动触发知识库更新' })
  @ApiResponse({
    status: 200,
    description: '知识库更新完成',
    type: ManualUpdateResponseDto,
  })
  async updateKnowledgeBase(): Promise<ManualUpdateResponseDto> {
    return await this.weixinSyncService.manualUpdateKnowledgeBase();
  }

  @Get('status')
  @ApiOperation({ summary: '获取同步状态' })
  @ApiResponse({
    status: 200,
    description: '同步状态',
    type: SyncStatusDto,
  })
  async getSyncStatus(): Promise<SyncStatusDto> {
    return this.weixinSyncService.getSyncStatus();
  }

  @Delete('clear-cache')
  @ApiOperation({ summary: '清空聊天记录缓存' })
  @ApiResponse({
    status: 200,
    description: '缓存已清空',
  })
  async clearCache(): Promise<{ success: boolean; message: string }> {
    this.weixinSyncService.clearCache();
    return {
      success: true,
      message: '聊天记录缓存已清空',
    };
  }
}
