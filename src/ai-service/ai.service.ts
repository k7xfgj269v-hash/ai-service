import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
} from '@langchain/core/messages';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import {
  RagAnswerResult,
  RagQueryService,
} from '../rag/rag-query.service';

export const CONVERSATION_REDIS = Symbol('CONVERSATION_REDIS');

const CONVERSATION_LOCK_TTL_MS = 15000;
const CONVERSATION_LOCK_RENEW_MS = 5000;
const CONVERSATION_LOCK_ACQUIRE_TIMEOUT_MS = 30000;
const CONVERSATION_LOCK_RETRY_MS = 50;
const MAX_CONTEXTUAL_QUERY_CHARS = 4000;

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

type ConversationLock = {
  key: string;
  token: string;
};

class ConversationLockTimeoutError extends Error {}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly maxHistoryLength = 20;
  private readonly conversationQueues = new Map<string, Promise<void>>();

  private static readonly CLEAR_KEYWORDS = [
    '/clear',
    '清除上下文',
    '清除对话',
  ];

  constructor(
    private readonly ragQueryService: RagQueryService,
    @Inject(CONVERSATION_REDIS) private readonly redis: Redis,
  ) {}

  async clearHistory(userId: string): Promise<string> {
    try {
      return await this.runInConversation(userId, () =>
        this.clearHistoryUnlocked(userId),
      );
    } catch (error) {
      if (!(error instanceof ConversationLockTimeoutError)) throw error;
      this.logger.warn(
        `Timed out waiting for conversation lock for user ${userId}`,
      );
      return '对话处理繁忙，请稍后再试。';
    }
  }

  async processQuery(params: {
    userId: string;
    userName: string;
    query: string;
  }): Promise<string> {
    return (await this.processQueryDetailed(params)).answer;
  }

  async processQueryDetailed(params: {
    userId: string;
    userName: string;
    query: string;
  }): Promise<RagAnswerResult> {
    try {
      return await this.runInConversation(params.userId, () =>
        this.processQueryDetailedUnlocked(params),
      );
    } catch (error) {
      if (!(error instanceof ConversationLockTimeoutError)) throw error;
      this.logger.warn(
        `Timed out waiting for conversation lock for user ${params.userId}`,
      );
      return this.localResult(
        params.query,
        '抱歉，我暂时无法回答您的问题。请稍后再试或联系人工客服。',
        true,
      );
    }
  }

  private async processQueryDetailedUnlocked(params: {
    userId: string;
    userName: string;
    query: string;
  }): Promise<RagAnswerResult> {
    const startTime = Date.now();

    try {
      const query = params.query.trim();
      this.logger.log(`Processing Expert query for user ${params.userId}`);

      if (AiService.CLEAR_KEYWORDS.some(keyword => query === keyword)) {
        return this.localResult(
          query,
          await this.clearHistoryUnlocked(params.userId),
          false,
        );
      }

      const history = await this.getHistory(params.userId);
      const result = await this.ragQueryService.answer({
        query: this.contextualQuery(query, history),
      });
      await this.appendHistory(params.userId, query, result.answer);

      this.logger.log(
        `Expert reply completed for user ${params.userId} in ${
          Date.now() - startTime
        }ms`,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `Expert query failed for user ${params.userId} after ${
          Date.now() - startTime
        }ms: ${error?.message}`,
      );
      return this.localResult(
        params.query,
        '抱歉，我暂时无法回答您的问题。请稍后再试或联系人工客服。',
        true,
      );
    }
  }

  private localResult(
    query: string,
    answer: string,
    abstained: boolean,
  ): RagAnswerResult {
    return {
      query: query.trim(),
      activeGeneration: null,
      evidence: [],
      context: '',
      estimatedTokens: 0,
      degraded: false,
      failedRetrievers: [],
      rerankerStatus: 'disabled',
      cache: {
        retrieval: 'disabled',
        context: 'disabled',
        version: 'local',
      },
      timings: {
        cacheMs: 0,
        retrievalMs: 0,
        contextMs: 0,
        generationMs: 0,
        totalMs: 0,
      },
      answer,
      citations: [],
      abstained,
      abstentionReasons: abstained
        ? ['invalid-generation-output']
        : [],
    };
  }

  private async clearHistoryUnlocked(userId: string): Promise<string> {
    try {
      await this.redis.del(`chat:${userId}`);
      this.logger.log(`Cleared conversation history for user ${userId}`);
    } catch (error) {
      this.logger.warn(
        `Failed to clear conversation history: ${error.message}`,
      );
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
      this.logger.warn(
        `Failed to read conversation history: ${error.message}`,
      );
      return [];
    }
  }

  private async appendHistory(
    userId: string,
    userMessage: string,
    aiMessage: string,
  ): Promise<void> {
    try {
      const history = await this.getHistory(userId);
      history.push(
        new HumanMessage(userMessage),
        new AIMessage(aiMessage),
      );

      const boundedHistory = history.slice(-(this.maxHistoryLength * 2));
      const serialized = boundedHistory.map(message => ({
        type: message instanceof HumanMessage ? 'human' : 'ai',
        content: String(message.content),
      }));

      await this.redis.setex(
        `chat:${userId}`,
        7200,
        JSON.stringify(serialized),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to persist conversation history: ${error.message}`,
      );
    }
  }

  private contextualQuery(
    query: string,
    history: BaseMessage[],
  ): string {
    if (!history.length) return query;

    const header = '对话历史（仅用于理解当前问题）：\n';
    const footer = `\n当前问题：${query}`;
    const budget = Math.max(
      0,
      MAX_CONTEXTUAL_QUERY_CHARS - header.length - footer.length,
    );
    const selected: string[] = [];
    let length = 0;

    for (const message of [...history].reverse()) {
      const line =
        message instanceof HumanMessage
          ? `用户：${message.content}`
          : `助手：${message.content}`;
      if (length + line.length + 1 > budget) break;
      selected.unshift(line);
      length += line.length + 1;
    }
    return `${header}${selected.join('\n')}${footer}`;
  }

  private async runInConversation<T>(
    userId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.conversationQueues.get(userId) || Promise.resolve();
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

  private async acquireConversationLock(
    userId: string,
  ): Promise<ConversationLock | null> {
    const lock: ConversationLock = {
      key: `chat-lock:${userId}`,
      token: randomUUID(),
    };
    const deadline =
      Date.now() + CONVERSATION_LOCK_ACQUIRE_TIMEOUT_MS;

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
        setTimeout(
          resolve,
          Math.min(CONVERSATION_LOCK_RETRY_MS, remaining),
        ),
      );
    }
  }

  private startConversationLockRenewal(
    lock: ConversationLock,
  ): () => Promise<void> {
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

  private async renewConversationLock(
    lock: ConversationLock,
  ): Promise<boolean> {
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
      this.logger.warn(
        `Conversation lock ownership was lost for ${lock.key}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to renew conversation lock: ${error.message}`,
      );
    }
    return false;
  }

  private async releaseConversationLock(
    lock: ConversationLock,
  ): Promise<void> {
    try {
      await this.redis.eval(
        RELEASE_LOCK_SCRIPT,
        1,
        lock.key,
        lock.token,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to release conversation lock: ${error.message}`,
      );
    }
  }
}
