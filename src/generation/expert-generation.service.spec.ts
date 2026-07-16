import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { ExpertGenerationService } from './expert-generation.service';

jest.mock('@langchain/openai', () => ({
  ChatOpenAI: jest.fn(),
}));

describe('ExpertGenerationService', () => {
  const ChatOpenAIMock = ChatOpenAI as unknown as jest.Mock;
  let invoke: jest.Mock;

  function createService(values: Record<string, string | number | undefined>) {
    const configService = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;

    return new ExpertGenerationService(configService);
  }

  beforeEach(() => {
    invoke = jest.fn();
    ChatOpenAIMock.mockReset();
    ChatOpenAIMock.mockImplementation(() => ({ invoke }));
  });

  it('constructs exactly one model from the canonical Expert profile', () => {
    const service = createService({
      EXPERT_API_KEY: ' canonical-key ',
      EXPERT_API_BASE_URL: ' https://expert.example/v1 ',
      EXPERT_MODEL: ' expert-model ',
      EXPERT_TEMPERATURE: '0.35',
      EXPERT_MAX_TOKENS: '4096',
      QWEN_API_KEY: 'legacy-qwen-key',
      DEEPSEEK_API_KEY: 'legacy-deepseek-key',
    });

    expect(service.isAvailable()).toBe(true);
    expect(ChatOpenAIMock).toHaveBeenCalledTimes(1);
    expect(ChatOpenAIMock).toHaveBeenCalledWith({
      apiKey: 'canonical-key',
      modelName: 'expert-model',
      temperature: 0.35,
      maxTokens: 4096,
      configuration: { baseURL: 'https://expert.example/v1' },
    });
  });

  it('does not fill a canonical profile from legacy provider variables', () => {
    const service = createService({
      EXPERT_API_KEY: 'expert-key',
      QWEN_API_BASE_URL: 'https://qwen.example/v1',
      QWEN_MODEL: 'qwen-custom',
      OPENAI_API_BASE_URL: 'https://deepseek.example/v1',
      AI_MODEL: 'deepseek-custom',
    });

    expect(service.isAvailable()).toBe(true);
    expect(ChatOpenAIMock).toHaveBeenCalledTimes(1);
    expect(ChatOpenAIMock).toHaveBeenCalledWith({
      apiKey: 'expert-key',
      modelName: 'qwen-plus',
      temperature: 0.2,
      maxTokens: 8192,
      configuration: undefined,
    });
  });

  it('selects the Qwen profile atomically with Qwen defaults', () => {
    const service = createService({
      QWEN_API_KEY: 'qwen-key',
      DEEPSEEK_API_KEY: 'deepseek-key',
      OPENAI_API_BASE_URL: 'https://deepseek.example/v1',
      AI_MODEL: 'deepseek-chat',
    });

    expect(service.isAvailable()).toBe(true);
    expect(ChatOpenAIMock).toHaveBeenCalledTimes(1);
    expect(ChatOpenAIMock).toHaveBeenCalledWith({
      apiKey: 'qwen-key',
      modelName: 'qwen-plus',
      temperature: 0.2,
      maxTokens: 8192,
      configuration: {
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
    });
  });

  it('selects the DeepSeek profile atomically with DeepSeek defaults', () => {
    const service = createService({
      QWEN_API_BASE_URL: 'https://qwen.example/v1',
      QWEN_MODEL: 'qwen-custom',
      DEEPSEEK_API_KEY: 'deepseek-key',
    });

    expect(service.isAvailable()).toBe(true);
    expect(ChatOpenAIMock).toHaveBeenCalledTimes(1);
    expect(ChatOpenAIMock).toHaveBeenCalledWith({
      apiKey: 'deepseek-key',
      modelName: 'deepseek-chat',
      temperature: 0.2,
      maxTokens: 8192,
      configuration: { baseURL: 'https://api.deepseek.com' },
    });
  });

  it('is unavailable and does not construct a model without any API key', async () => {
    const service = createService({});

    expect(service.isAvailable()).toBe(false);
    expect(ChatOpenAIMock).not.toHaveBeenCalled();
    await expect(service.generate('question')).rejects.toThrow(
      'Expert generation model is unavailable',
    );
  });

  it('performs one generation call and returns its text', async () => {
    invoke.mockResolvedValue({ content: 'expert reply' });
    const service = createService({ EXPERT_API_KEY: 'expert-key' });

    await expect(service.generate('expert prompt')).resolves.toBe('expert reply');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('expert prompt');
  });
});
