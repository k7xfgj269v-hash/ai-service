import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, Min } from 'class-validator';

/**
 * 启动自动同步 DTO
 */
export class StartAutoSyncDto {
  @ApiProperty({
    description: '是否启用自动同步',
    example: true,
    default: true,
  })
  @IsBoolean()
  enabled: boolean;

  @ApiProperty({
    description: '同步间隔（分钟）',
    example: 30,
    default: 30,
  })
  @IsNumber()
  @Min(1)
  syncInterval: number;

  @ApiProperty({
    description: '是否自动更新知识库',
    example: true,
    default: true,
  })
  @IsBoolean()
  autoUpdate: boolean;

  @ApiProperty({
    description: '触发更新的最小记录数',
    example: 50,
    default: 50,
  })
  @IsNumber()
  @Min(1)
  minRecordsForUpdate: number;
}

/**
 * 同步响应 DTO
 */
export class SyncResponseDto {
  @ApiProperty({ description: '是否成功' })
  success: boolean;

  @ApiProperty({ description: '处理的记录数' })
  recordsProcessed: number;

  @ApiProperty({ description: '消息' })
  message: string;
}

/**
 * 同步状态 DTO
 */
export class SyncStatusDto {
  @ApiProperty({ description: '是否正在运行' })
  isRunning: boolean;

  @ApiProperty({ description: '缓存的记录数' })
  cachedRecords: number;

  @ApiProperty({ description: '上次重建时间' })
  lastRebuildTime: string;

  @ApiProperty({ description: '距下次重建' })
  nextRebuildIn: string;
}

/**
 * 手动更新响应 DTO
 */
export class ManualUpdateResponseDto {
  @ApiProperty({ description: '是否成功' })
  success: boolean;

  @ApiProperty({ description: '消息' })
  message: string;

  @ApiProperty({ description: '处理的记录数' })
  recordsProcessed: number;
}
