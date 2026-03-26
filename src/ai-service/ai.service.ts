import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PromptsTemplate } from '../config/prompt';
import { PromptTemplates } from '../config/promptTemplate';
import { ChatOpenAI } from '@langchain/openai';
import { KnowledgeBaseService, SearchResult } from '../knowledge-base/knowledge-base.service';
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';
import Redis from 'ioredis';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private chatModel: ChatOpenAI | null = null;
  private expertChatModel: ChatOpenAI | null = null;
  private hrExpertMode: boolean;
  private userModeOverride: Map<string, boolean> = new Map();
  private redis: Redis;
  private readonly maxHistoryLength = 20;

  private static readonly EXIT_HR_KEYWORDS = ['退出专家模式', '退出HR模式', '切换普通模式', '/normal'];
  private static readonly ENTER_HR_KEYWORDS = ['进入专家模式', '进入HR模式', '切换专家模式', '/expert'];
  private static readonly CLEAR_KEYWORDS = ['/clear', '清除上下文', '清除对话'];

  constructor(
    private configService: ConfigService,
    private knowledgeBaseService: KnowledgeBaseService,
  ) {
    this.hrExpertMode = this.configService.get('HR_EXPERT_MODE') === 'true';
    this.redis = new Redis(this.configService.get<string>('REDIS_URL'));
    this.redis.on('error', (err) => this.logger.error('Redis 连接错误:', err.message));
    this.initializeChatModel();
    this.initializeExpertModel();
  }

  private initializeChatModel() {
    try {
      const apiKey = this.configService.get('DEEPSEEK_API_KEY');
      const baseURL = this.configService.get('OPENAI_API_BASE_URL');
      const modelName = this.configService.get('AI_MODEL') || 'deepseek-chat';

      if (!apiKey) {
        this.logger.error('DEEPSEEK_API_KEY 未配置');
        return;
      }

      this.chatModel = new ChatOpenAI({
        apiKey,
        modelName,
        temperature: 0.7,
        maxTokens: 8192,
        configuration: { baseURL },
      });

      this.logger.log(`DeepSeek 普通模式已初始化 - Model: ${modelName}`);
    } catch (error) {
      this.logger.error('初始化 DeepSeek 模型失败:', error);
    }
  }

  private initializeExpertModel() {
    try {
      const apiKey = this.configService.get('QWEN_API_KEY') || this.configService.get('DEEPSEEK_API_KEY');
      const baseURL = this.configService.get('QWEN_API_BASE_URL') || this.configService.get('OPENAI_API_BASE_URL');
      const modelName = this.configService.get('QWEN_MODEL') || 'qwen-plus';

      this.expertChatModel = new ChatOpenAI({
        apiKey,
        modelName,
        temperature: 0.7,
        maxTokens: 8192,
        configuration: { baseURL },
      });

      this.logger.log(`千问专家模式已初始化 - Model: ${modelName}`);
    } catch (error) {
      this.logger.error('初始化千问模型失败:', error);
    }
  }

  async clearHistory(userId: string): Promise<string> {
    try {
      await this.redis.del(`chat:${userId}`);
      this.logger.log(`已清除用户 ${userId} 的对话历史`);
    } catch (err) {
      this.logger.warn(`清除 Redis 历史失败: ${err.message}`);
    }
    return '对话上下文已清除。';
  }

  private async getHistory(userId: string): Promise<BaseMessage[]> {
    try {
      const raw = await this.redis.get(`chat:${userId}`);
      if (!raw) return [];
      const parsed: Array<{ type: string; content: string }> = JSON.parse(raw);
      return parsed.map(m => m.type === 'human' ? new HumanMessage(m.content) : new AIMessage(m.content));
    } catch (err) {
      this.logger.warn(`读取 Redis 历史失败，返回空历史: ${err.message}`);
      return [];
    }
  }

  private async appendHistory(userId: string, userMsg: string, aiMsg: string): Promise<void> {
    const history = await this.getHistory(userId);
    history.push(new HumanMessage(userMsg));
    history.push(new AIMessage(aiMsg));
    if (history.length > this.maxHistoryLength * 2) {
      history.splice(0, 2);
    }
    const serialized = history.map(m => ({
      type: m instanceof HumanMessage ? 'human' : 'ai',
      content: m.content as string,
    }));
    await this.redis.setex(`chat:${userId}`, 7200, JSON.stringify(serialized));
  }

  async processQuery(params: {
    userId: string;
    userName: string;
    query: string;
  }): Promise<string> {
    const startTime = Date.now();

    try {
      this.logger.log(`处理用户查询 - 用户: ${params.userId}, 问题: ${params.query}`);
      const query = params.query.trim();

      if (AiService.CLEAR_KEYWORDS.some(k => query === k)) {
        return await this.clearHistory(params.userId);
      }
      if (AiService.EXIT_HR_KEYWORDS.some(k => query === k)) {
        this.userModeOverride.set(params.userId, false);
        return '已切换到普通对话模式（DeepSeek）。发送"进入专家模式"可恢复HR专家模式。';
      }
      if (AiService.ENTER_HR_KEYWORDS.some(k => query === k)) {
        this.userModeOverride.delete(params.userId);
        return '已切换到HR专家模式（千问）。发送"退出专家模式"可切换到普通对话。';
      }

      const useHrMode = this.userModeOverride.has(params.userId)
        ? this.userModeOverride.get(params.userId)
        : this.hrExpertMode;

      if (useHrMode) {
        if (!this.expertChatModel) {
          return '抱歉，千问专家模式暂时不可用，请稍后再试。';
        }
        return await this.processWithKnowledgeBase(params, startTime);
      } else {
        if (!this.chatModel) {
          return '抱歉，AI服务暂时不可用，请稍后再试。';
        }
        return await this.processGeneral(params, startTime);
      }
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this.logger.error(`处理查询失败: ${error?.message}, 耗时: ${responseTime}ms`);
      return '抱歉，我暂时无法回答您的问题。请稍后再试或联系人工客服。';
    }
  }

  private async processWithKnowledgeBase(
    params: { userId: string; userName: string; query: string },
    startTime: number,
  ): Promise<string> {
    this.logger.log('使用HR专家模式（千问）+ 知识库RAG检索');

    let searchResult: SearchResult | null = null;
    let knowledgeBaseUsed = false;

    try {
      searchResult = await this.knowledgeBaseService.search(params.query, { topK: 3 });
      knowledgeBaseUsed = searchResult?.sources?.length > 0;
      if (knowledgeBaseUsed) {
        this.logger.log(`知识库检索成功，找到 ${searchResult.sources.length} 个相关文档`);
      }
    } catch (error) {
      this.logger.warn('知识库检索失败:', error.message);
    }

    const history = await this.getHistory(params.userId);
    const fullPrompt = this.buildHRExpertRAGPrompt(
      params.query,
      searchResult?.sources || [],
      history,
    );

    const response = await this.expertChatModel.invoke(fullPrompt);
    const reply = response.content as string;
    await this.appendHistory(params.userId, params.query, reply);

    const responseTime = Date.now() - startTime;
    this.logger.log(`AI回复(千问) - 用户: ${params.userId}, 耗时: ${responseTime}ms, 知识库命中: ${knowledgeBaseUsed}`);
    return reply;
  }

  private async processGeneral(
    params: { userId: string; userName: string; query: string },
    startTime: number,
  ): Promise<string> {
    this.logger.log('使用普通对话模式（DeepSeek）');

    const history = await this.getHistory(params.userId);
    const messages: BaseMessage[] = [
      new SystemMessage('你是一个友好的AI助手，请直接回答用户的问题。回答要简洁、准确、有帮助。'),
      ...history,
      new HumanMessage(params.query),
    ];

    const response = await this.chatModel.invoke(messages);
    const reply = response.content as string;
    await this.appendHistory(params.userId, params.query, reply);

    const responseTime = Date.now() - startTime;
    this.logger.log(`AI回复(DeepSeek) - 用户: ${params.userId}, 耗时: ${responseTime}ms`);
    return reply;
  }

  private buildHRExpertRAGPrompt(
    userQuery: string,
    sources: Array<{ content: string; metadata: any }>,
    history: BaseMessage[],
  ): string {
    const template = PromptTemplates.hrExpertRAG;

    const context =
      sources.length > 0
        ? sources
            .map(
              (s, index) =>
                `【文档 ${index + 1}】\n文件名: ${s.metadata?.fileName || '未知'}\n内容:\n${s.content}`,
            )
            .join('\n\n---\n\n')
        : '暂无相关知识库信息';

    const chatHistory =
      history.length > 0
        ? history
            .map(m => (m instanceof HumanMessage ? `用户: ${m.content}` : `助手: ${m.content}`))
            .join('\n')
        : '无历史对话';

    return template
      .replace('{context}', context)
      .replace('{chat_history}', chatHistory)
      .replace('{question}', userQuery);
  }
}
