import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';

type ExpertProfile = {
  apiKey: string;
  baseURL?: string;
  modelName: string;
};

@Injectable()
export class ExpertGenerationService {
  private readonly logger = new Logger(ExpertGenerationService.name);
  private readonly model: ChatOpenAI | null;

  constructor(private readonly configService: ConfigService) {
    const profile = this.resolveProfile();
    if (!profile) {
      this.model = null;
      this.logger.error('Expert API key is not configured');
      return;
    }

    this.model = new ChatOpenAI({
      apiKey: profile.apiKey,
      modelName: profile.modelName,
      temperature: this.resolveNumber('EXPERT_TEMPERATURE', 0.2),
      maxTokens: this.resolveNumber('EXPERT_MAX_TOKENS', 8192),
      configuration: profile.baseURL ? { baseURL: profile.baseURL } : undefined,
    });
  }

  isAvailable(): boolean {
    return this.model !== null;
  }

  async generate(prompt: string): Promise<string> {
    if (!this.model) {
      throw new Error('Expert generation model is unavailable');
    }

    const response = await this.model.invoke(prompt);
    if (typeof response.content === 'string') {
      return response.content;
    }

    if (Array.isArray(response.content)) {
      return response.content
        .map(part => {
          if (typeof part === 'string') return part;
          return 'text' in part ? String(part.text) : '';
        })
        .join('');
    }

    return String(response.content ?? '');
  }

  private resolveProfile(): ExpertProfile | null {
    const canonicalApiKey = this.resolveString('EXPERT_API_KEY');
    if (canonicalApiKey) {
      return {
        apiKey: canonicalApiKey,
        baseURL: this.resolveString('EXPERT_API_BASE_URL'),
        modelName: this.resolveString('EXPERT_MODEL') || 'qwen-plus',
      };
    }

    const qwenApiKey = this.resolveString('QWEN_API_KEY');
    if (qwenApiKey) {
      return {
        apiKey: qwenApiKey,
        baseURL:
          this.resolveString('QWEN_API_BASE_URL') ||
          'https://dashscope.aliyuncs.com/compatible-mode/v1',
        modelName: this.resolveString('QWEN_MODEL') || 'qwen-plus',
      };
    }

    const deepSeekApiKey = this.resolveString('DEEPSEEK_API_KEY');
    if (deepSeekApiKey) {
      return {
        apiKey: deepSeekApiKey,
        baseURL:
          this.resolveString('OPENAI_API_BASE_URL') || 'https://api.deepseek.com',
        modelName: this.resolveString('AI_MODEL') || 'deepseek-chat',
      };
    }

    return null;
  }

  private resolveString(key: string): string | undefined {
    const value = this.configService.get<string>(key);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    return undefined;
  }

  private resolveNumber(key: string, fallback: number): number {
    const raw = this.configService.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') {
      return fallback;
    }

    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }
}
