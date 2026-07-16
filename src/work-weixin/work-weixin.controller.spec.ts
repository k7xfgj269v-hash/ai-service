import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { WorkWeixinController } from './work-weixin.controller';
import { WorkWeixinService } from './work-weixin.service';

function createResponse() {
  const response = {
    status: jest.fn(),
    type: jest.fn(),
    send: jest.fn(),
  };
  response.status.mockReturnValue(response);
  response.type.mockReturnValue(response);
  response.send.mockReturnValue(response);
  return response as unknown as Response & {
    status: jest.Mock;
    type: jest.Mock;
    send: jest.Mock;
  };
}

function createController(allowTest = false) {
  const service = {
    verifyUrl: jest.fn(),
    parseEncryptedEnvelope: jest.fn(),
    handleMessage: jest.fn(),
    handlePlaintextTestCallback: jest.fn(),
    sendTextMessage: jest.fn(),
    getStatus: jest.fn(),
    refreshAccessToken: jest.fn(),
  };
  const configService = {
    get: jest.fn((key: string) =>
      key === 'WORK_WEIXIN_ALLOW_TEST' && allowTest ? 'true' : undefined,
    ),
  };
  return {
    controller: new WorkWeixinController(
      service as unknown as WorkWeixinService,
      configService as unknown as ConfigService,
    ),
    service,
  };
}

describe('WorkWeixinController', () => {
  it('keeps URL verification public behavior and rejects invalid challenges', () => {
    const { controller, service } = createController();
    const response = createResponse();
    service.verifyUrl.mockReturnValue(null);

    controller.verifyCallback('signature', 'timestamp', 'nonce', 'echo', response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.send).toHaveBeenCalledWith('验证失败');
  });

  it('rejects non-text callback bodies before parsing', async () => {
    const { controller, service } = createController();
    const response = createResponse();

    await controller.receiveMessage(
      'signature',
      'timestamp',
      'nonce',
      { body: { Encrypt: 'value' } } as any,
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(service.parseEncryptedEnvelope).not.toHaveBeenCalled();
    expect(service.handleMessage).not.toHaveBeenCalled();
  });

  it('returns success for an authenticated duplicate or no-reply callback', async () => {
    const { controller, service } = createController();
    const response = createResponse();
    service.parseEncryptedEnvelope.mockReturnValue('encrypted');
    service.handleMessage.mockResolvedValue('');

    await controller.receiveMessage(
      'signature',
      'timestamp',
      'nonce',
      { body: '<xml />' } as any,
      response,
    );

    expect(service.handleMessage).toHaveBeenCalledWith(
      'signature',
      'timestamp',
      'nonce',
      'encrypted',
    );
    expect(response.send).toHaveBeenCalledWith('success');
  });

  it('uses the explicitly enabled plaintext test path without ad hoc XML parsing', async () => {
    const { controller, service } = createController(true);
    const response = createResponse();
    service.handlePlaintextTestCallback.mockResolvedValue('<xml>reply</xml>');

    await controller.receiveMessage(
      'test_signature',
      'timestamp',
      'nonce',
      { body: Buffer.from('<xml>test</xml>') } as any,
      response,
    );

    expect(service.handlePlaintextTestCallback).toHaveBeenCalledWith(
      '<xml>test</xml>',
    );
    expect(service.parseEncryptedEnvelope).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(201);
    expect(response.type).toHaveBeenCalledWith('application/xml');
  });
});
