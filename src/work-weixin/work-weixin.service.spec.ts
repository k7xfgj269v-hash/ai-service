import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WorkWeixinService } from './work-weixin.service';
import { AiService } from '../ai-service/ai.service';

describe('WorkWeixinService', () => {
  let service: WorkWeixinService;

  const mockConfigService = {
    get: jest.fn((key: string, defaultVal?: any) => {
      const config: Record<string, string> = {
        WORK_WEIXIN_TOKEN: 'test_token_123',
        WORK_WEIXIN_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
        WORK_WEIXIN_CORP_ID: 'test_corp_id',
        WORK_WEIXIN_AGENT_ID: '1000002',
        WORK_WEIXIN_ENABLED: 'false',
      };
      return config[key] ?? defaultVal;
    }),
  };

  const mockAiService = {
    processQuery: jest.fn().mockResolvedValue('test AI response'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkWeixinService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AiService, useValue: mockAiService },
      ],
    }).compile();

    service = module.get<WorkWeixinService>(WorkWeixinService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getStatus()', () => {
    it('should return a status object', () => {
      const status = service.getStatus();
      expect(status).toBeDefined();
      expect(typeof status).toBe('object');
    });
  });

  describe('verifyUrl()', () => {
    it('should return null/falsy for invalid signature', () => {
      const result = service.verifyUrl('invalid_sig', '1234567890', 'random_nonce', 'test_echostr');
      expect(result).toBeFalsy();
    });

    it('should handle missing parameters gracefully', () => {
      expect(() => service.verifyUrl('', '', '', '')).not.toThrow();
    });
  });
});
