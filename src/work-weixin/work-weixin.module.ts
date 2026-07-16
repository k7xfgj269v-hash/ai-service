import {
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { WorkWeixinController } from './work-weixin.controller';
import {
  CALLBACK_REDIS,
  CallbackReplayStore,
  createCallbackRedisOptions,
  WorkWeixinService,
} from './work-weixin.service';
import { WeworkSpecCallbackController } from './wework-spec-callback.controller';
import { WeworkSpecCallbackService } from './wework-spec-callback.service';
import { AiServiceModule } from '../ai-service/ai.module';
import { KnowledgeBaseModule } from '../knowledge-base/knowledge-base.module';

@Injectable()
class CallbackRedisClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CallbackRedisClient.name);
  readonly client: Redis;

  constructor(configService: ConfigService) {
    this.client = new Redis(
      configService.get<string>('REDIS_URL'),
      createCallbackRedisOptions(),
    );
    this.client.on('error', () => {
      this.logger.warn('Callback Redis connection error');
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
    } catch {
      this.logger.warn('Callback Redis unavailable during startup');
    }
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}

@Module({
  imports: [ConfigModule, AiServiceModule, KnowledgeBaseModule],
  controllers: [WorkWeixinController, WeworkSpecCallbackController],
  providers: [
    CallbackRedisClient,
    {
      provide: CALLBACK_REDIS,
      useFactory: (owner: CallbackRedisClient) => owner.client,
      inject: [CallbackRedisClient],
    },
    CallbackReplayStore,
    WorkWeixinService,
    WeworkSpecCallbackService,
  ],
  exports: [WorkWeixinService, WeworkSpecCallbackService],
})
export class WorkWeixinModule {}
