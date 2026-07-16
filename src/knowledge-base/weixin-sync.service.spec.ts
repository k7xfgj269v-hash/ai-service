import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KnowledgeBaseService } from './knowledge-base.service';
import { WeixinKnowledgeSyncService } from './weixin-sync.service';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('WeixinKnowledgeSyncService reliability', () => {
  let roots: string[];
  let services: WeixinKnowledgeSyncService[];
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    roots = [];
    services = [];
    cwdSpy = jest.spyOn(process, 'cwd');
  });

  afterEach(async () => {
    for (const service of services) {
      await service.onModuleDestroy();
    }
    jest.useRealTimers();
    jest.restoreAllMocks();
    for (const root of roots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-sync-'));
    roots.push(root);
    cwdSpy.mockReturnValue(root);
    return root;
  }

  function makeConfig(
    overrides: Record<string, string> = {},
  ): ConfigService {
    const values: Record<string, string> = {
      KB_REBUILD_DAYS: '3',
      KNOWLEDGE_BASE_AUTO_SYNC: 'false',
      MIN_RECORDS_FOR_UPDATE: '10',
      SYNC_INTERVAL_MINUTES: '30',
      ...overrides,
    };
    return {
      get: jest.fn((key: string, defaultValue?: string) =>
        values[key] ?? defaultValue,
      ),
    } as unknown as ConfigService;
  }

  function makeKnowledgeBase(
    addDocument: jest.Mock = jest.fn().mockResolvedValue({
      success: true,
      message: 'ok',
      documentId: 'document',
      chunkCount: 1,
    }),
  ): KnowledgeBaseService {
    return {
      addDocument,
      clear: jest.fn().mockResolvedValue(undefined),
    } as unknown as KnowledgeBaseService;
  }

  function makeService(
    knowledgeBaseService = makeKnowledgeBase(),
    config = makeConfig(),
  ): WeixinKnowledgeSyncService {
    const service = new WeixinKnowledgeSyncService(
      config,
      knowledgeBaseService,
    );
    services.push(service);
    return service;
  }

  function pendingJsonFiles(root: string): string[] {
    const pendingPath = path.join(root, 'data', 'weixin-sync', 'pending');
    return fs
      .readdirSync(pendingPath)
      .filter((file) => file.endsWith('.json'))
      .sort();
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) {
        return;
      }
      await Promise.resolve();
    }
    throw new Error('condition was not reached');
  }

  it('uses stable fallback IDs and secure pending permissions without Date.now', async () => {
    const root = makeRoot();
    const service = makeService();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(111).mockReturnValueOnce(999);
    const message = {
      from: 'user-1',
      from_name: 'Alice',
      content: 'same message',
      msg_type: 'text',
    };

    await service.ingestChatRecords([message]);
    await service.ingestChatRecords([message]);

    const pendingPath = path.join(root, 'data', 'weixin-sync', 'pending');
    const files = pendingJsonFiles(root);
    expect(files).toHaveLength(1);
    expect(fs.statSync(pendingPath).mode & 0o777).toBe(0o700);

    const recordPath = path.join(pendingPath, files[0]);
    expect(fs.statSync(recordPath).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    expect(persisted.record.timestamp).toBe(0);
    expect(persisted.record.id).toBe(`weixin-${persisted.sourceHash}`);
    expect(files[0]).toBe(`${persisted.sourceHash}.json`);
  });

  it('uses deterministic source and batch hashes independent of input order', async () => {
    const firstRoot = makeRoot();
    const firstDocuments: Array<{ fileName: string; content: string }> = [];
    const firstAdd = jest.fn(
      async (filePath: string, fileName: string) => {
        firstDocuments.push({
          fileName,
          content: fs.readFileSync(filePath, 'utf8'),
        });
        return {
          success: true,
          message: 'ok',
          documentId: 'first',
          chunkCount: 1,
        };
      },
    );
    const firstService = makeService(makeKnowledgeBase(firstAdd));
    const messages = [
      {
        msg_id: 'message-b',
        from: 'user-2',
        content: 'second',
        send_time: 1_700_000_002,
        msg_type: 'text',
      },
      {
        msg_id: 'message-a',
        from: 'user-1',
        content: 'first',
        send_time: 1_700_000_001,
        msg_type: 'text',
      },
    ];
    await firstService.ingestChatRecords(messages);
    await firstService.manualUpdateKnowledgeBase();

    const secondRoot = makeRoot();
    const secondDocuments: Array<{ fileName: string; content: string }> = [];
    const secondAdd = jest.fn(
      async (filePath: string, fileName: string) => {
        secondDocuments.push({
          fileName,
          content: fs.readFileSync(filePath, 'utf8'),
        });
        return {
          success: true,
          message: 'ok',
          documentId: 'second',
          chunkCount: 1,
        };
      },
    );
    const secondService = makeService(makeKnowledgeBase(secondAdd));
    await secondService.ingestChatRecords([...messages].reverse());
    await secondService.manualUpdateKnowledgeBase();

    expect(firstDocuments).toEqual(secondDocuments);
    expect(
      fs.readdirSync(path.join(firstRoot, 'data', 'weixin-sync')),
    ).toContain(firstDocuments[0].fileName);
    expect(
      fs.readdirSync(path.join(secondRoot, 'data', 'weixin-sync')),
    ).toContain(secondDocuments[0].fileName);
  });

  it('does not index notification envelopes or token values', async () => {
    const root = makeRoot();
    const indexedContent: string[] = [];
    const addDocument = jest.fn(async (filePath: string) => {
      indexedContent.push(fs.readFileSync(filePath, 'utf8'));
      return {
        success: true,
        message: 'ok',
        documentId: 'document',
        chunkCount: 1,
      };
    });
    const service = makeService(
      makeKnowledgeBase(addDocument),
      makeConfig({ MIN_RECORDS_FOR_UPDATE: '1' }),
    );

    await service.ingestChatRecords([
      {
        msg_id: 'notification',
        from: 'wework_callback',
        content: JSON.stringify({
          event_type: 'conversation_new_message',
          conversation_new_message: { token: 'never-index-this-token' },
        }),
        send_time: 1_700_000_001,
        msg_type: 'spec_callback',
      },
      {
        msg_id: 'chat-message',
        from: 'user-1',
        content: JSON.stringify({
          content: 'actual chat content',
          token: 'also-never-index-this-token',
        }),
        send_time: 1_700_000_002,
        msg_type: 'text',
      },
    ]);

    expect(addDocument).toHaveBeenCalledTimes(1);
    expect(indexedContent[0]).toContain('actual chat content');
    expect(indexedContent[0]).not.toContain('never-index-this-token');
    expect(indexedContent[0]).not.toContain('also-never-index-this-token');
    expect(pendingJsonFiles(root)).toHaveLength(0);
  });

  it('retains failed records and retries the same deterministic batch', async () => {
    const root = makeRoot();
    const addDocument = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({
        success: true,
        message: 'ok',
        documentId: 'document',
        chunkCount: 1,
      });
    const service = makeService(
      makeKnowledgeBase(addDocument),
      makeConfig({ MIN_RECORDS_FOR_UPDATE: '1' }),
    );

    await service.ingestChatRecords([
      {
        msg_id: 'retry-message',
        from: 'user-1',
        content: 'retry me',
        send_time: 1_700_000_001,
      },
    ]);

    expect(pendingJsonFiles(root)).toHaveLength(1);
    expect(
      fs
        .readdirSync(path.join(root, 'data', 'weixin-sync', 'pending'))
        .filter((file) => file.endsWith('.batch.txt')),
    ).toHaveLength(0);

    const result = await service.manualUpdateKnowledgeBase();

    expect(result).toEqual({
      success: true,
      message: '知识库更新成功',
      recordsProcessed: 1,
    });
    expect(addDocument).toHaveBeenCalledTimes(2);
    expect(addDocument.mock.calls[0][1]).toBe(
      addDocument.mock.calls[1][1],
    );
    expect(pendingJsonFiles(root)).toHaveLength(0);
  });

  it('serializes flushes and deletes only files captured by each successful snapshot', async () => {
    const root = makeRoot();
    const firstFlush = deferred<void>();
    const secondFlush = deferred<void>();
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const addDocument = jest.fn(async () => {
      const callIndex = addDocument.mock.calls.length;
      activeCalls++;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      await (callIndex === 1 ? firstFlush.promise : secondFlush.promise);
      activeCalls--;
      return {
        success: true,
        message: 'ok',
        documentId: `document-${callIndex}`,
        chunkCount: 1,
      };
    });
    const service = makeService(
      makeKnowledgeBase(addDocument),
      makeConfig({ MIN_RECORDS_FOR_UPDATE: '1' }),
    );

    const firstIngest = service.ingestChatRecords([
      {
        msg_id: 'first-message',
        from: 'user-1',
        content: 'first',
        send_time: 1_700_000_001,
      },
    ]);
    await waitFor(() => addDocument.mock.calls.length === 1);

    const secondIngest = service.ingestChatRecords([
      {
        msg_id: 'second-message',
        from: 'user-2',
        content: 'second',
        send_time: 1_700_000_002,
      },
    ]);
    expect(pendingJsonFiles(root)).toHaveLength(2);

    firstFlush.resolve(undefined);
    await waitFor(() => addDocument.mock.calls.length === 2);

    const remainingFiles = pendingJsonFiles(root);
    expect(remainingFiles).toHaveLength(1);
    const remaining = JSON.parse(
      fs.readFileSync(
        path.join(
          root,
          'data',
          'weixin-sync',
          'pending',
          remainingFiles[0],
        ),
        'utf8',
      ),
    );
    expect(remaining.record.id).toBe('second-message');
    expect(maxActiveCalls).toBe(1);

    secondFlush.resolve(undefined);
    await Promise.all([firstIngest, secondIngest]);
    expect(pendingJsonFiles(root)).toHaveLength(0);
  });

  it('recovers pending records after restart and suppresses completed duplicates', async () => {
    const root = makeRoot();
    const firstService = makeService();
    const message = {
      msg_id: 'restart-message',
      from: 'user-1',
      content: 'persist across restart',
      send_time: 1_700_000_001,
    };
    await firstService.ingestChatRecords([message]);
    expect(pendingJsonFiles(root)).toHaveLength(1);

    const recoveredAdd = jest.fn().mockResolvedValue({
      success: true,
      message: 'ok',
      documentId: 'recovered',
      chunkCount: 1,
    });
    const recoveredService = makeService(
      makeKnowledgeBase(recoveredAdd),
    );
    expect(recoveredService.getSyncStatus().cachedRecords).toBe(1);
    await recoveredService.manualUpdateKnowledgeBase();
    expect(pendingJsonFiles(root)).toHaveLength(0);

    const duplicateAdd = jest.fn().mockResolvedValue({
      success: true,
      message: 'ok',
      documentId: 'duplicate',
      chunkCount: 1,
    });
    const restartedService = makeService(
      makeKnowledgeBase(duplicateAdd),
    );
    await restartedService.ingestChatRecords([message]);

    expect(restartedService.getSyncStatus().cachedRecords).toBe(0);
    expect(duplicateAdd).not.toHaveBeenCalled();
  });

  it('keeps one timer and waits for an active flush during shutdown', async () => {
    jest.useFakeTimers();
    makeRoot();
    const flush = deferred<void>();
    const addDocument = jest.fn(async () => {
      await flush.promise;
      return {
        success: true,
        message: 'ok',
        documentId: 'document',
        chunkCount: 1,
      };
    });
    const service = makeService(
      makeKnowledgeBase(addDocument),
      makeConfig({ MIN_RECORDS_FOR_UPDATE: '1' }),
    );

    await service.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    await service.startAutoSync({
      enabled: true,
      syncInterval: 5,
      autoUpdate: true,
      minRecordsForUpdate: 1,
    });
    expect(jest.getTimerCount()).toBe(1);

    const ingest = service.ingestChatRecords([
      {
        msg_id: 'shutdown-message',
        from: 'user-1',
        content: 'wait for me',
        send_time: 1_700_000_001,
      },
    ]);
    await waitFor(() => addDocument.mock.calls.length === 1);

    let shutdownFinished = false;
    const shutdown = service.onModuleDestroy().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    expect(jest.getTimerCount()).toBe(0);

    flush.resolve(undefined);
    await Promise.all([ingest, shutdown]);
    expect(shutdownFinished).toBe(true);
  });
});
