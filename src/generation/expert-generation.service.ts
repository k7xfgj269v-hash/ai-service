import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';

@Injectable()
export class ExpertGenerationService {
  private readonly logger = new Logger(ExpertGenerationService.name);
  private readonly model: ChatOpenAI | null;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.resolveString(
      'EXPERT_API_KEY',
      'QWEN_API_KEY',
      'DEEPSEEK_API_KEY',
    );

    if (!apiKey) {
      this.model = null;
      this.logger.error('Expert API key is not configured');
      return;
    }

    const baseURL = this.resolveString(
      'EXPERT_API_BASE_URL',
      'QWEN_API_BASE_URL',
      'OPENAI_API_BASE_URL',
    );
    const modelName =
      this.resolveString('EXPERT_MODEL', 'QWEN_MODEL', 'AI_MODEL') || 'qwen-plus';

    this.model = new ChatOpenAI({
      apiKey,
      modelName,
      temperature: this.resolveNumber('EXPERT_TEMPERATURE', 0.2),
      maxTokens: this.resolveNumber('EXPERT_MAX_TOKENS', 8192),
      configuration: baseURL ? { baseURL } : undefined,
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

  private resolveString(...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = this.configService.get<string>(key);
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
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
