type Environment = Record<string, unknown>;

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function requireString(config: Environment, key: string): string {
  const value = optionalString(config[key]);
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function parseInteger(
  value: unknown,
  key: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const normalized = optionalString(value);
  if (normalized === undefined) return defaultValue;

  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${key} must be an integer`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseNumber(
  value: unknown,
  key: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const normalized = optionalString(value);
  if (normalized === undefined) return defaultValue;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} must be between ${min} and ${max}`);
  }
  return parsed;
}

function validateUrl(value: string, key: string, protocols: string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid URL`);
  }

  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${key} must use ${protocols.join(' or ')}`);
  }
  return value;
}

function validateOptionalUrl(
  config: Environment,
  key: string,
  protocols: string[],
): void {
  const value = optionalString(config[key]);
  if (value) config[key] = validateUrl(value, key, protocols);
}

function normalizeBoolean(
  config: Environment,
  key: string,
  defaultValue: boolean,
): void {
  const value = config[key];
  if (value === undefined || value === '') {
    config[key] = String(defaultValue);
    return;
  }

  if (typeof value === 'boolean') {
    config[key] = String(value);
    return;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!TRUE_VALUES.has(normalized) && !FALSE_VALUES.has(normalized)) {
    throw new Error(`${key} must be a boolean`);
  }
  config[key] = String(TRUE_VALUES.has(normalized));
}

export function readBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

export function parseCorsOrigins(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  for (const origin of origins) {
    validateUrl(origin, 'CORS_ORIGINS', ['http:', 'https:']);
  }
  return [...new Set(origins)];
}

export function validateEnvironment(input: Environment): Environment {
  const config = { ...input };
  const nodeEnv = optionalString(config.NODE_ENV) || 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }
  config.NODE_ENV = nodeEnv;
  config.PORT = parseInteger(config.PORT, 'PORT', 3031, 1, 65535);
  config.HTTP_BODY_LIMIT = optionalString(config.HTTP_BODY_LIMIT) || '1mb';
  if (!/^\d+(?:b|kb|mb)$/i.test(String(config.HTTP_BODY_LIMIT))) {
    throw new Error('HTTP_BODY_LIMIT must be a byte size such as 512kb or 1mb');
  }

  normalizeBoolean(config, 'SWAGGER_ENABLED', nodeEnv !== 'production');
  normalizeBoolean(config, 'WORK_WEIXIN_ENABLED', false);
  normalizeBoolean(config, 'WORK_WEIXIN_ALLOW_TEST', false);
  normalizeBoolean(config, 'KNOWLEDGE_BASE_AUTO_SYNC', false);
  parseCorsOrigins(config.CORS_ORIGINS);

  const redisUrl = requireString(config, 'REDIS_URL');
  config.REDIS_URL = validateUrl(redisUrl, 'REDIS_URL', ['redis:', 'rediss:']);

  const expertApiKey =
    optionalString(config.EXPERT_API_KEY) ||
    optionalString(config.QWEN_API_KEY) ||
    optionalString(config.DEEPSEEK_API_KEY);
  if (!expertApiKey) {
    throw new Error(
      'EXPERT_API_KEY is required (legacy QWEN_API_KEY or DEEPSEEK_API_KEY is accepted)',
    );
  }

  config.EXPERT_API_KEY = expertApiKey;
  config.EXPERT_API_BASE_URL =
    optionalString(config.EXPERT_API_BASE_URL) ||
    optionalString(config.QWEN_API_BASE_URL) ||
    optionalString(config.OPENAI_API_BASE_URL) ||
    'https://api.deepseek.com';
  config.EXPERT_MODEL =
    optionalString(config.EXPERT_MODEL) ||
    optionalString(config.QWEN_MODEL) ||
    optionalString(config.AI_MODEL) ||
    'deepseek-chat';
  config.EXPERT_TEMPERATURE = parseNumber(
    config.EXPERT_TEMPERATURE,
    'EXPERT_TEMPERATURE',
    0.2,
    0,
    2,
  );
  config.EXPERT_MAX_TOKENS = parseInteger(
    config.EXPERT_MAX_TOKENS,
    'EXPERT_MAX_TOKENS',
    8192,
    1,
    131072,
  );

  config.EMBEDDING_API_KEY =
    optionalString(config.EMBEDDING_API_KEY) || expertApiKey;
  config.EMBEDDING_API_BASE_URL =
    optionalString(config.EMBEDDING_API_BASE_URL) ||
    config.EXPERT_API_BASE_URL;
  config.EMBEDDING_MODEL =
    optionalString(config.EMBEDDING_MODEL) || 'text-embedding-v3';

  validateOptionalUrl(config, 'EXPERT_API_BASE_URL', ['http:', 'https:']);
  validateOptionalUrl(config, 'EMBEDDING_API_BASE_URL', ['http:', 'https:']);

  if (nodeEnv === 'production') {
    config.ADMIN_API_KEY = requireString(config, 'ADMIN_API_KEY');
    if (
      optionalString(config.WORK_WEIXIN_ABILITY_ID) ||
      readBoolean(config.KNOWLEDGE_BASE_AUTO_SYNC, false)
    ) {
      config.WORK_WEIXIN_SYNC_TOKEN = requireString(
        config,
        'WORK_WEIXIN_SYNC_TOKEN',
      );
    }
    if (readBoolean(config.WORK_WEIXIN_ALLOW_TEST, false)) {
      throw new Error('WORK_WEIXIN_ALLOW_TEST cannot be enabled in production');
    }
  }

  if (readBoolean(config.WORK_WEIXIN_ENABLED, false)) {
    for (const key of [
      'WORK_WEIXIN_CORP_ID',
      'WORK_WEIXIN_CORP_SECRET',
      'WORK_WEIXIN_AGENT_ID',
      'WORK_WEIXIN_TOKEN',
      'WORK_WEIXIN_ENCODING_AES_KEY',
    ]) {
      config[key] = requireString(config, key);
    }
  }

  return config;
}
