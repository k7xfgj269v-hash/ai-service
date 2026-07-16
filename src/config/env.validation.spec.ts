import {
  parseCorsOrigins,
  readBoolean,
  validateEnvironment,
} from './env.validation';

const REQUIRED_ENV = {
  REDIS_URL: 'redis://localhost:6379',
  EXPERT_API_KEY: 'canonical-key',
};

describe('environment validation', () => {
  describe('Expert configuration', () => {
    it('resolves a canonical Expert and embedding profile', () => {
      const config = validateEnvironment({
        ...REQUIRED_ENV,
        EXPERT_API_BASE_URL: 'https://expert.example.com/v1',
        EXPERT_MODEL: 'expert-model',
        EXPERT_TEMPERATURE: '0.4',
        EXPERT_MAX_TOKENS: '4096',
        EMBEDDING_API_KEY: 'embedding-key',
        EMBEDDING_API_BASE_URL: 'https://embedding.example.com/v1',
        EMBEDDING_MODEL: 'embedding-model',
      });

      expect(config).toMatchObject({
        EXPERT_API_KEY: 'canonical-key',
        EXPERT_API_BASE_URL: 'https://expert.example.com/v1',
        EXPERT_MODEL: 'expert-model',
        EXPERT_TEMPERATURE: 0.4,
        EXPERT_MAX_TOKENS: 4096,
        EMBEDDING_API_KEY: 'embedding-key',
        EMBEDDING_API_BASE_URL: 'https://embedding.example.com/v1',
        EMBEDDING_MODEL: 'embedding-model',
      });
    });

    it('prefers canonical values over legacy values', () => {
      const config = validateEnvironment({
        ...REQUIRED_ENV,
        EXPERT_API_BASE_URL: 'https://canonical.example.com',
        EXPERT_MODEL: 'canonical-model',
        QWEN_API_KEY: 'legacy-qwen-key',
        QWEN_API_BASE_URL: 'https://legacy.example.com',
        QWEN_MODEL: 'legacy-model',
        DEEPSEEK_API_KEY: 'legacy-deepseek-key',
      });

      expect(config.EXPERT_API_KEY).toBe('canonical-key');
      expect(config.EXPERT_API_BASE_URL).toBe(
        'https://canonical.example.com',
      );
      expect(config.EXPERT_MODEL).toBe('canonical-model');
    });

    it('maps legacy Qwen variables into one Expert profile', () => {
      const config = validateEnvironment({
        REDIS_URL: 'rediss://cache.example.com',
        QWEN_API_KEY: 'qwen-key',
        QWEN_API_BASE_URL: 'https://qwen.example.com/v1',
        QWEN_MODEL: 'qwen-plus',
      });

      expect(config).toMatchObject({
        EXPERT_API_KEY: 'qwen-key',
        EXPERT_API_BASE_URL: 'https://qwen.example.com/v1',
        EXPERT_MODEL: 'qwen-plus',
        EMBEDDING_API_KEY: 'qwen-key',
        EMBEDDING_API_BASE_URL: 'https://qwen.example.com/v1',
      });
    });

    it('accepts a legacy DeepSeek key with Expert defaults', () => {
      const config = validateEnvironment({
        REDIS_URL: 'redis://localhost:6379',
        DEEPSEEK_API_KEY: 'deepseek-key',
      });

      expect(config).toMatchObject({
        EXPERT_API_KEY: 'deepseek-key',
        EXPERT_API_BASE_URL: 'https://api.deepseek.com',
        EXPERT_MODEL: 'deepseek-chat',
        EXPERT_TEMPERATURE: 0.2,
        EXPERT_MAX_TOKENS: 8192,
        EMBEDDING_API_KEY: 'deepseek-key',
        EMBEDDING_API_BASE_URL: 'https://api.deepseek.com',
        EMBEDDING_MODEL: 'text-embedding-v3',
      });
    });

    it('rejects configuration without a canonical or legacy Expert key', () => {
      expect(() =>
        validateEnvironment({ REDIS_URL: 'redis://localhost:6379' }),
      ).toThrow('EXPERT_API_KEY is required');
    });
  });

  describe('normalization and boundaries', () => {
    it('applies development defaults without mutating the input', () => {
      const input = { ...REQUIRED_ENV };
      const config = validateEnvironment(input);

      expect(config).toMatchObject({
        NODE_ENV: 'development',
        PORT: 3031,
        HTTP_BODY_LIMIT: '1mb',
        SWAGGER_ENABLED: 'true',
        WORK_WEIXIN_ENABLED: 'false',
        WORK_WEIXIN_ALLOW_TEST: 'false',
        KNOWLEDGE_BASE_AUTO_SYNC: 'false',
      });
      expect(input).toEqual(REQUIRED_ENV);
    });

    it.each([
      ['PORT', '1', 1],
      ['PORT', '65535', 65535],
      ['EXPERT_TEMPERATURE', '0', 0],
      ['EXPERT_TEMPERATURE', '2', 2],
      ['EXPERT_MAX_TOKENS', '1', 1],
      ['EXPERT_MAX_TOKENS', '131072', 131072],
    ])('accepts boundary %s=%s', (key, value, expected) => {
      const config = validateEnvironment({ ...REQUIRED_ENV, [key]: value });

      expect(config[key]).toBe(expected);
    });

    it('normalizes supported boolean spellings', () => {
      const config = validateEnvironment({
        ...REQUIRED_ENV,
        SWAGGER_ENABLED: 'OFF',
        WORK_WEIXIN_ALLOW_TEST: 'yes',
        KNOWLEDGE_BASE_AUTO_SYNC: true,
      });

      expect(config.SWAGGER_ENABLED).toBe('false');
      expect(config.WORK_WEIXIN_ALLOW_TEST).toBe('true');
      expect(config.KNOWLEDGE_BASE_AUTO_SYNC).toBe('true');
      expect(readBoolean('on', false)).toBe(true);
      expect(readBoolean('no', true)).toBe(false);
    });

    it('deduplicates valid CORS origins while preserving order', () => {
      expect(
        parseCorsOrigins(
          'https://app.example.com, http://localhost:3000, https://app.example.com',
        ),
      ).toEqual(['https://app.example.com', 'http://localhost:3000']);
    });
  });

  describe('invalid values', () => {
    it.each([
      ['REDIS_URL', 'https://cache.example.com', 'REDIS_URL must use'],
      ['EXPERT_API_BASE_URL', 'ftp://expert.example.com', 'must use'],
      ['EMBEDDING_API_BASE_URL', 'not a url', 'must be a valid URL'],
      ['CORS_ORIGINS', 'file:///tmp/app', 'CORS_ORIGINS must use'],
    ])('rejects invalid URL %s=%s', (key, value, message) => {
      expect(() =>
        validateEnvironment({ ...REQUIRED_ENV, [key]: value }),
      ).toThrow(message);
    });

    it.each([
      ['PORT', '0', 'PORT must be between 1 and 65535'],
      ['PORT', '65536', 'PORT must be between 1 and 65535'],
      ['PORT', '3.5', 'PORT must be an integer'],
      ['EXPERT_TEMPERATURE', '-0.1', 'must be between 0 and 2'],
      ['EXPERT_TEMPERATURE', 'Infinity', 'must be between 0 and 2'],
      ['EXPERT_MAX_TOKENS', '0', 'must be between 1 and 131072'],
      ['EXPERT_MAX_TOKENS', '1.5', 'must be an integer'],
    ])('rejects invalid numeric %s=%s', (key, value, message) => {
      expect(() =>
        validateEnvironment({ ...REQUIRED_ENV, [key]: value }),
      ).toThrow(message);
    });

    it.each([
      'SWAGGER_ENABLED',
      'WORK_WEIXIN_ENABLED',
      'WORK_WEIXIN_ALLOW_TEST',
      'KNOWLEDGE_BASE_AUTO_SYNC',
    ])('rejects malformed boolean %s', (key) => {
      expect(() =>
        validateEnvironment({ ...REQUIRED_ENV, [key]: 'sometimes' }),
      ).toThrow(`${key} must be a boolean`);
    });

    it('rejects invalid environment and body limit values', () => {
      expect(() =>
        validateEnvironment({ ...REQUIRED_ENV, NODE_ENV: 'staging' }),
      ).toThrow('NODE_ENV must be development, test, or production');
      expect(() =>
        validateEnvironment({ ...REQUIRED_ENV, HTTP_BODY_LIMIT: '1gb' }),
      ).toThrow('HTTP_BODY_LIMIT must be a byte size');
    });
  });

  describe('production credentials and disabled integrations', () => {
    const productionEnv = {
      ...REQUIRED_ENV,
      NODE_ENV: 'production',
      ADMIN_API_KEY: 'admin-secret',
    };

    it('requires the admin API key in production', () => {
      expect(() =>
        validateEnvironment({
          ...REQUIRED_ENV,
          NODE_ENV: 'production',
        }),
      ).toThrow('ADMIN_API_KEY is required');
    });

    it('keeps Swagger and integrations disabled by default in production', () => {
      const config = validateEnvironment(productionEnv);

      expect(config.SWAGGER_ENABLED).toBe('false');
      expect(config.WORK_WEIXIN_ENABLED).toBe('false');
      expect(config.KNOWLEDGE_BASE_AUTO_SYNC).toBe('false');
      expect(config.WORK_WEIXIN_SYNC_TOKEN).toBeUndefined();
    });

    it.each([
      { WORK_WEIXIN_ABILITY_ID: 'ability-id' },
      { KNOWLEDGE_BASE_AUTO_SYNC: 'true' },
    ])('requires a sync token when callback integration is active', (extra) => {
      expect(() =>
        validateEnvironment({ ...productionEnv, ...extra }),
      ).toThrow('WORK_WEIXIN_SYNC_TOKEN is required');
    });

    it('rejects the unsigned WeChat test callback mode in production', () => {
      expect(() =>
        validateEnvironment({
          ...productionEnv,
          WORK_WEIXIN_ALLOW_TEST: 'true',
        }),
      ).toThrow('WORK_WEIXIN_ALLOW_TEST cannot be enabled in production');
    });

    it('does not require WeChat provider credentials when disabled', () => {
      expect(() =>
        validateEnvironment({
          ...productionEnv,
          WORK_WEIXIN_ENABLED: 'false',
        }),
      ).not.toThrow();
    });

    it.each([
      'WORK_WEIXIN_CORP_ID',
      'WORK_WEIXIN_CORP_SECRET',
      'WORK_WEIXIN_AGENT_ID',
      'WORK_WEIXIN_TOKEN',
      'WORK_WEIXIN_ENCODING_AES_KEY',
    ])('requires %s when WeChat is enabled', (missingKey) => {
      const credentials: Record<string, string> = {
        WORK_WEIXIN_CORP_ID: 'corp-id',
        WORK_WEIXIN_CORP_SECRET: 'corp-secret',
        WORK_WEIXIN_AGENT_ID: 'agent-id',
        WORK_WEIXIN_TOKEN: 'callback-token',
        WORK_WEIXIN_ENCODING_AES_KEY: 'encoding-key',
      };
      delete credentials[missingKey];

      expect(() =>
        validateEnvironment({
          ...REQUIRED_ENV,
          WORK_WEIXIN_ENABLED: 'true',
          ...credentials,
        }),
      ).toThrow(`${missingKey} is required`);
    });
  });
});
