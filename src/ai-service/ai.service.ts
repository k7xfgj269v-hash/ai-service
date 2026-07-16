import { Inject, Injectable, Logger } from '@nestjs/common';
import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import { Document } from '@langchain/core/documents';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { PromptTemplates } from '../config/promptTemplate';
import { ExpertGenerationService } from '../generation/expert-generation.service';
import { KnowledgeBaseService } from '../knowledge-base/knowledge-base.service';

export const CONVERSATION_REDIS = Symbol('CONVERSATION_REDIS');

const CONVERSATION_LOCK_TTL_MS = 15000;
const CONVERSATION_LOCK_RENEW_MS = 5000;
const CONVERSATION_LOCK_ACQUIRE_TIMEOUT_MS = 30000;
const CONVERSATION_LOCK_RETRY_MS = 50;

const RENEW_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

type EvidenceSource = {
  content: string;
  metadata: Record<string, any>;
  score?: number;
};

type ConversationLock = {
  key: string;
  token: string;
};

type InterimKnowledgeBase = {
  vectorStore: {
    similaritySearchWithScore(query: string, k: number): Promise<Array<[Document, number]>>;
  } | null;
  db: {
    prepare(sql: string): {
      get(): any;
      all(): any[];
    };
  };
};

class ConversationLockTimeoutError extends Error {}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly maxHistoryLength = 20;
  private readonly conversationQueues = new Map<string, Promise<void>>();

  private static readonly CLEAR_KEYWORDS = ['/clear', '清除上下文', '清除对话'];

  constructor(
    private readonly knowledgeBaseService: KnowledgeBaseService,
    private readonly expertGenerationService: ExpertGenerationService,
    @Inject(CONVERSATION_REDIS) private readonly redis: Redis,
  ) {}

  async clearHistory(userId: string): Promise<string> {
    try {
      return await this.runInConversation(userId, () => this.clearHistoryUnlocked(userId));
    } catch (error) {
      if (!(error instanceof ConversationLockTimeoutError)) throw error;
      this.logger.warn(`Timed out waiting for conversation lock for user ${userId}`);
      return '对话处理繁忙，请稍后再试。';
    }
  }

  async processQuery(params: {
    userId: string;
    userName: string;
    query: string;
  }): Promise<string> {
    try {
      return await this.runInConversation(params.userId, () =>
        this.processQueryUnlocked(params),
      );
    } catch (error) {
      if (!(error instanceof ConversationLockTimeoutError)) throw error;
      this.logger.warn(`Timed out waiting for conversation lock for user ${params.userId}`);
      return '抱歉，我暂时无法回答您的问题。请稍后再试或联系人工客服。';
    }
  }

  private async processQueryUnlocked(params: {
    userId: string;
    userName: string;
    query: string;
  }): Promise<string> {
    const startTime = Date.now();

    try {
      const query = params.query.trim();
      this.logger.log(`Processing Expert query for user ${params.userId}`);

      if (AiService.CLEAR_KEYWORDS.some(keyword => query === keyword)) {
        return this.clearHistoryUnlocked(params.userId);
      }

      if (!this.expertGenerationService.isAvailable()) {
        return '抱歉，AI服务暂时不可用，请稍后再试。';
      }

      const [sources, history] = await Promise.all([
        this.retrieveInterimEvidence(query),
        this.getHistory(params.userId),
      ]);
      const prompt = this.buildExpertRAGPrompt(query, sources, history);
      const reply = await this.expertGenerationService.generate(prompt);

      await this.appendHistory(params.userId, query, reply);

      const responseTime = Date.now() - startTime;
      this.logger.log(
        `Expert reply completed for user ${params.userId} in ${responseTime}ms with ${sources.length} evidence sources`,
      );
      return reply;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this.logger.error(
        `Expert query failed for user ${params.userId} after ${responseTime}ms: ${error?.message}`,
      );
      return '抱歉，我暂时无法回答您的问题。请稍后再试或联系人工客服。';
    }
  }

  private async clearHistoryUnlocked(userId: string): Promise<string> {
    try {
      await this.redis.del(`chat:${userId}`);
      this.logger.log(`Cleared conversation history for user ${userId}`);
    } catch (error) {
      this.logger.warn(`Failed to clear conversation history: ${error.message}`);
    }
    return '对话上下文已清除。';
  }

  private async getHistory(userId: string): Promise<BaseMessage[]> {
    try {
      const raw = await this.redis.get(`chat:${userId}`);
      if (!raw) return [];

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      return parsed.flatMap(message => {
        if (
          !message ||
          typeof message.content !== 'string' ||
          !['human', 'ai'].includes(message.type)
        ) {
          return [];
        }
        return [
          message.type === 'human'
            ? new HumanMessage(message.content)
            : new AIMessage(message.content),
        ];
      });
    } catch (error) {
      this.logger.warn(`Failed to read conversation history: ${error.message}`);
      return [];
    }
  }

  private async appendHistory(userId: string, userMessage: string, aiMessage: string): Promise<void> {
    try {
      const history = await this.getHistory(userId);
      history.push(new HumanMessage(userMessage), new AIMessage(aiMessage));

      const boundedHistory = history.slice(-(this.maxHistoryLength * 2));
      const serialized = boundedHistory.map(message => ({
        type: message instanceof HumanMessage ? 'human' : 'ai',
        content: String(message.content),
      }));

      await this.redis.setex(`chat:${userId}`, 7200, JSON.stringify(serialized));
    } catch (error) {
      this.logger.warn(`Failed to persist conversation history: ${error.message}`);
    }
  }

  private async retrieveInterimEvidence(query: string): Promise<EvidenceSource[]> {
    try {
      const knowledgeBase = this.knowledgeBaseService as unknown as InterimKnowledgeBase;
      if (!knowledgeBase.vectorStore) return [];

      const topK = 3;
      const totalChunks =
        Number(
          knowledgeBase.db
            .prepare('SELECT SUM(chunkCount) as total FROM documents')
            .get()?.total,
        ) || 0;
      const fetchK = Math.min(topK * 4, Math.max(1, totalChunks));
      const scored = await knowledgeBase.vectorStore.similaritySearchWithScore(query, fetchK);
      const liveDocIds = new Set<string>(
        knowledgeBase.db
          .prepare('SELECT id FROM documents')
          .all()
          .map(row => row.id),
      );

      return KnowledgeBaseService.selectRelevantDocs(scored, {
        topK,
        liveDocIds,
        maxRelativeDistance: 1.5,
      });
    } catch (error) {
      this.logger.warn(`Knowledge base evidence retrieval failed: ${error.message}`);
      return [];
    }
  }

  private buildExpertRAGPrompt(
    userQuery: string,
    sources: EvidenceSource[],
    history: BaseMessage[],
  ): string {
    const context =
      sources.length > 0
        ? sources
            .map(
              (source, index) =>
                `【文档 ${index + 1}】\n文件名: ${source.metadata?.fileName || '未知'}\n内容:\n${source.content}`,
            )
            .join('\n\n---\n\n')
        : '暂无相关知识库信息';

    const chatHistory =
      history.length > 0
        ? history
            .map(message =>
              message instanceof HumanMessage
                ? `用户: ${message.content}`
                : `助手: ${message.content}`,
            )
            .join('\n')
        : '无历史对话';

    return PromptTemplates.expertRAG
      .replace('{context}', () => context)
      .replace('{chat_history}', () => chatHistory)
      .replace('{question}', () => userQuery);
  }

  private async runInConversation<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.conversationQueues.get(userId) || Promise.resolve();
    let release: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    this.conversationQueues.set(userId, current);

    await previous.catch(() => undefined);
    try {
      const lock = await this.acquireConversationLock(userId);
      if (!lock) {
        return await operation();
      }

      const stopRenewal = this.startConversationLockRenewal(lock);
      try {
        return await operation();
      } finally {
        await stopRenewal();
        await this.releaseConversationLock(lock);
      }
    } finally {
      release();
      if (this.conversationQueues.get(userId) === current) {
        this.conversationQueues.delete(userId);
      }
    }
  }

  private async acquireConversationLock(userId: string): Promise<ConversationLock | null> {
    const lock: ConversationLock = {
      key: `chat-lock:${userId}`,
      token: randomUUID(),
    };
    const deadline = Date.now() + CONVERSATION_LOCK_ACQUIRE_TIMEOUT_MS;

    while (true) {
      try {
        const acquired = await this.redis.set(
          lock.key,
          lock.token,
          'PX',
          CONVERSATION_LOCK_TTL_MS,
          'NX',
        );
        if (acquired === 'OK') {
          return lock;
        }
      } catch (error) {
        this.logger.warn(
          `Conversation Redis lock unavailable; using local ordering: ${error.message}`,
        );
        return null;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ConversationLockTimeoutError();
      }
      await new Promise(resolve =>
        setTimeout(resolve, Math.min(CONVERSATION_LOCK_RETRY_MS, remaining)),
      );
    }
  }

  private startConversationLockRenewal(lock: ConversationLock): () => Promise<void> {
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    let renewal: Promise<void> | null = null;

    const schedule = () => {
      timer = setTimeout(() => {
        renewal = this.renewConversationLock(lock)
          .then(owned => {
            if (!owned) stopped = true;
          })
          .finally(() => {
            renewal = null;
            if (!stopped) schedule();
          });
      }, CONVERSATION_LOCK_RENEW_MS);
      timer.unref();
    };

    schedule();
    return async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (renewal) await renewal;
    };
  }

  private async renewConversationLock(lock: ConversationLock): Promise<boolean> {
    try {
      const renewed = await this.redis.eval(
        RENEW_LOCK_SCRIPT,
        1,
        lock.key,
        lock.token,
        String(CONVERSATION_LOCK_TTL_MS),
      );
      if (Number(renewed) === 1) {
        return true;
      }
      this.logger.warn(`Conversation lock ownership was lost for ${lock.key}`);
    } catch (error) {
      this.logger.warn(`Failed to renew conversation lock: ${error.message}`);
    }
    return false;
  }

  private async releaseConversationLock(lock: ConversationLock): Promise<void> {
    try {
      await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, lock.key, lock.token);
    } catch (error) {
      this.logger.warn(`Failed to release conversation lock: ${error.message}`);
    }
  }
}
