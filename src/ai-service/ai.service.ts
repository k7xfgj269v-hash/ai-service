import { Inject, Injectable, Logger } from '@nestjs/common';
import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import { Document } from '@langchain/core/documents';
import Redis from 'ioredis';
import { PromptTemplates } from '../config/promptTemplate';
import { ExpertGenerationService } from '../generation/expert-generation.service';
import { KnowledgeBaseService } from '../knowledge-base/knowledge-base.service';

export const CONVERSATION_REDIS = Symbol('CONVERSATION_REDIS');

type EvidenceSource = {
  content: string;
  metadata: Record<string, any>;
  score?: number;
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
    return this.runInConversation(userId, () => this.clearHistoryUnlocked(userId));
  }

  async processQuery(params: {
    userId: string;
    userName: string;
    query: string;
  }): Promise<string> {
    return this.runInConversation(params.userId, () => this.processQueryUnlocked(params));
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
      return await operation();
    } finally {
      release();
      if (this.conversationQueues.get(userId) === current) {
        this.conversationQueues.delete(userId);
      }
    }
  }
}
