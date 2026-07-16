import {
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AiService } from './ai.service';
import { KnowledgeBaseModule } from '../knowledge-base/knowledge-base.module';
import { GenerationModule } from '../generation/generation.module';
import { CONVERSATION_REDIS } from './ai.service';

@Injectable()
class ConversationRedisClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConversationRedisClient.name);
  readonly client: Redis;

  constructor(configService: ConfigService) {
    this.client = new Redis(configService.get<string>('REDIS_URL'), {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      retryStrategy: () => null,
    });
    this.client.on('error', err => {
      this.logger.warn(`Conversation Redis error: ${err.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
    } catch (error) {
      this.logger.warn(`Conversation Redis unavailable: ${error.message}`);
    }
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}

@Module({
  imports: [ConfigModule, KnowledgeBaseModule, GenerationModule],
  providers: [
    ConversationRedisClient,
    {
      provide: CONVERSATION_REDIS,
      useFactory: (owner: ConversationRedisClient) => owner.client,
      inject: [ConversationRedisClient],
    },
    AiService,
  ],
  exports: [AiService],
})
export class AiServiceModule {}
