import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Type,
  ValidationPipe,
} from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { firstValueFrom, throwError } from 'rxjs';
import {
  AddDocumentDto,
  AnswerKnowledgeBaseDto,
  KNOWLEDGE_BASE_CATEGORY_MAX_LENGTH,
  KNOWLEDGE_BASE_QUERY_MAX_LENGTH,
  KNOWLEDGE_BASE_TAG_MAX_LENGTH,
  KNOWLEDGE_BASE_TAGS_MAX_SIZE,
  KNOWLEDGE_BASE_TOP_K_MAX,
  ListDocumentsDto,
  RetrieveKnowledgeBaseDto,
  SearchKnowledgeBaseDto,
} from './knowledge-base.dto';
import {
  DOCUMENT_UPLOAD_MAX_BYTES,
  FailedUploadCleanupInterceptor,
  KnowledgeBaseController,
  documentUploadOptions,
} from './knowledge-base.controller';
import { KnowledgeBaseService } from './knowledge-base.service';
import { RagQueryService } from '../rag/rag-query.service';

const validationPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
});

async function transform<T>(
  metatype: Type<T>,
  value: unknown,
  type: 'body' | 'query' = 'body',
): Promise<T> {
  return validationPipe.transform(value, {
    type,
    metatype,
    data: '',
  }) as Promise<T>;
}

function uploadFile(
  filePath: string,
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'policy.pdf',
    encoding: '7bit',
    mimetype: 'application/pdf',
    size: 10,
    destination: path.dirname(filePath),
    filename: path.basename(filePath),
    path: filePath,
    buffer: Buffer.alloc(0),
    stream: undefined,
    ...overrides,
  } as Express.Multer.File;
}

describe('KnowledgeBaseController', () => {
  let controller: KnowledgeBaseController;
  let service: {
    addDocument: jest.Mock;
    search: jest.Mock;
    getStats: jest.Mock;
    listDocuments: jest.Mock;
    removeDocument: jest.Mock;
    clear: jest.Mock;
    rebuild: jest.Mock;
  };
  let ragQuery: {
    retrieve: jest.Mock;
    answer: jest.Mock;
  };

  beforeEach(() => {
    service = {
      addDocument: jest.fn(),
      search: jest.fn(),
      getStats: jest.fn(),
      listDocuments: jest.fn(),
      removeDocument: jest.fn(),
      clear: jest.fn(),
      rebuild: jest.fn(),
    };
    ragQuery = {
      retrieve: jest.fn(),
      answer: jest.fn(),
    };
    controller = new KnowledgeBaseController(
      service as unknown as KnowledgeBaseService,
      ragQuery as unknown as RagQueryService,
    );
  });

  describe('strict DTOs', () => {
    it('normalizes category and repeated or comma-separated tags', async () => {
      const addDto = await transform(AddDocumentDto, {
        category: '  HR Policy  ',
        tags: [' Benefits, Leave ', 'benefits', '  '],
      });
      const listDto = await transform(
        ListDocumentsDto,
        { category: ' HR Policy ', tags: ' Benefits,Leave,benefits ' },
        'query',
      );

      expect(addDto).toEqual({
        category: 'HR Policy',
        tags: ['Benefits', 'Leave'],
      });
      expect(listDto).toEqual({
        category: 'HR Policy',
        tags: ['Benefits', 'Leave'],
      });
    });

    it.each([
      [AddDocumentDto, { openai_api_key: 'secret' }],
      [AddDocumentDto, { chunkSize: 1000 }],
      [SearchKnowledgeBaseDto, { question: 'policy', model: 'custom' }],
      [
        RetrieveKnowledgeBaseDto,
        { query: 'policy', openai_api_base_url: 'https://provider.invalid' },
      ],
    ])('rejects provider and chunk controls from %p', async (dto, payload) => {
      await expect(transform(dto as Type<unknown>, payload)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('trims valid search inputs and converts topK', async () => {
      const dto = await transform(SearchKnowledgeBaseDto, {
        question: '  annual leave policy  ',
        topK: '4',
        filterCategory: ' HR ',
        filterTags: ' Leave, Benefits ',
      });

      expect(dto).toEqual({
        question: 'annual leave policy',
        topK: 4,
        filterCategory: 'HR',
        filterTags: ['Leave', 'Benefits'],
      });
    });

    it.each([
      { question: '   ' },
      { question: 'x'.repeat(KNOWLEDGE_BASE_QUERY_MAX_LENGTH + 1) },
      { question: 'policy', topK: 0 },
      { question: 'policy', topK: KNOWLEDGE_BASE_TOP_K_MAX + 1 },
      { question: 'policy', topK: 1.5 },
      {
        question: 'policy',
        filterCategory: 'x'.repeat(
          KNOWLEDGE_BASE_CATEGORY_MAX_LENGTH + 1,
        ),
      },
      {
        question: 'policy',
        filterTags: Array.from(
          { length: KNOWLEDGE_BASE_TAGS_MAX_SIZE + 1 },
          (_, index) => `tag-${index}`,
        ),
      },
      {
        question: 'policy',
        filterTags: ['x'.repeat(KNOWLEDGE_BASE_TAG_MAX_LENGTH + 1)],
      },
    ])('rejects out-of-bounds search input %#', async payload => {
      await expect(
        transform(SearchKnowledgeBaseDto, payload),
      ).rejects.toThrow(BadRequestException);
    });

    it('requires query on the retrieval-only endpoint DTO', async () => {
      await expect(
        transform(RetrieveKnowledgeBaseDto, { query: '   ' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('upload handling', () => {
    it('limits uploads to 25 MiB', () => {
      expect(documentUploadOptions.limits?.fileSize).toBe(
        DOCUMENT_UPLOAD_MAX_BYTES,
      );
      expect(DOCUMENT_UPLOAD_MAX_BYTES).toBe(25 * 1024 * 1024);
    });

    it.each([
      ['report.pdf', 'application/pdf'],
      [
        'report.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      ['notes.md', 'text/markdown'],
      ['notes.txt', 'text/plain'],
    ])('accepts %s with %s', (originalname, mimetype) => {
      const callback = jest.fn();

      documentUploadOptions.fileFilter!(
        {} as Express.Request,
        uploadFile('/tmp/upload', { originalname, mimetype }),
        callback,
      );

      expect(callback).toHaveBeenCalledWith(null, true);
    });

    it.each([
      ['payload.exe', 'application/x-msdownload'],
      ['renamed.pdf', 'application/x-msdownload'],
      ['report.docx', 'application/pdf'],
    ])('rejects unsupported upload %s with %s', (originalname, mimetype) => {
      const callback = jest.fn();

      documentUploadOptions.fileFilter!(
        {} as Express.Request,
        uploadFile('/tmp/upload', { originalname, mimetype }),
        callback,
      );

      expect(callback.mock.calls[0][0]).toBeInstanceOf(BadRequestException);
      expect(callback.mock.calls[0][1]).toBe(false);
    });

    it('passes normalized metadata without provider or chunk controls', async () => {
      const file = uploadFile('/tmp/policy.pdf');
      const body = await transform(AddDocumentDto, {
        category: ' HR ',
        tags: [' Leave ', 'leave', 'Benefits'],
      });
      const response = {
        success: true,
        message: 'added',
        documentId: 'doc-1',
        chunkCount: 3,
      };
      service.addDocument.mockResolvedValue(response);

      await expect(controller.addDocument(file, body)).resolves.toBe(response);
      expect(service.addDocument).toHaveBeenCalledWith(
        file.path,
        file.originalname,
        file.mimetype,
        {
          category: 'HR',
          tags: ['Leave', 'Benefits'],
        },
      );
    });

    it('removes the persisted upload when ingestion fails', async () => {
      const filePath = path.join(
        os.tmpdir(),
        `knowledge-base-upload-${process.pid}-${Date.now()}.pdf`,
      );
      fs.writeFileSync(filePath, 'test');
      service.addDocument.mockRejectedValue(new Error('ingestion failed'));

      await expect(
        controller.addDocument(uploadFile(filePath), new AddDocumentDto()),
      ).rejects.toThrow('ingestion failed');
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('removes a persisted upload when a downstream pipe or handler fails', async () => {
      const filePath = path.join(
        os.tmpdir(),
        `knowledge-base-pipe-${process.pid}-${Date.now()}.pdf`,
      );
      fs.writeFileSync(filePath, 'test');
      const interceptor = new FailedUploadCleanupInterceptor();
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({ file: uploadFile(filePath) }),
        }),
      } as ExecutionContext;
      const next = {
        handle: () =>
          throwError(() => new BadRequestException('invalid metadata')),
      } as CallHandler;

      await expect(
        firstValueFrom(interceptor.intercept(context, next)),
      ).rejects.toThrow(BadRequestException);
      expect(fs.existsSync(filePath)).toBe(false);
    });
  });

  describe('route compatibility', () => {
    const retrievalResult = {
      answer: '',
      sources: [
        {
          content: 'policy evidence',
          metadata: { documentId: 'doc-1' },
          score: 0.2,
        },
      ],
      confidence: 0.8,
      processingTime: 12,
    };

    it('preserves the legacy search response shape', async () => {
      service.search.mockResolvedValue(retrievalResult);
      const body = await transform(SearchKnowledgeBaseDto, {
        question: ' policy ',
        topK: 3,
        filterCategory: ' HR ',
        filterTags: ' Benefits,Leave ',
      });

      await expect(controller.search(body)).resolves.toBe(retrievalResult);
      expect(service.search).toHaveBeenCalledWith('policy', {
        topK: 3,
        filter: {
          category: 'HR',
          tags: ['Benefits', 'Leave'],
        },
      });
    });

    it('returns retrieval evidence without the legacy answer field', async () => {
      const result = {
        query: 'policy',
        evidence: retrievalResult.sources,
      };
      ragQuery.retrieve.mockResolvedValue(result);
      const body = await transform(RetrieveKnowledgeBaseDto, {
        query: ' policy ',
        topK: 2,
      });

      await expect(controller.retrieve(body)).resolves.toBe(result);
      expect(ragQuery.retrieve).toHaveBeenCalledWith({
        query: 'policy',
        limit: 2,
        filter: {
          category: undefined,
          tags: undefined,
        },
      });
    });

    it('returns a validated RAG answer from the answer endpoint', async () => {
      const result = {
        query: 'policy',
        answer: 'Use the current leave policy.',
        citations: [{ id: 'source-1' }],
        abstained: false,
      };
      ragQuery.answer.mockResolvedValue(result);
      const body = await transform(AnswerKnowledgeBaseDto, {
        query: ' policy ',
        topK: 2,
        filterCategory: ' HR ',
      });

      await expect(controller.answer(body)).resolves.toBe(result);
      expect(ragQuery.answer).toHaveBeenCalledWith({
        query: 'policy',
        limit: 2,
        filter: {
          category: 'HR',
          tags: undefined,
        },
      });
    });

    it('keeps stats, documents, delete, and clear responses unchanged', async () => {
      const stats = {
        totalDocuments: 1,
        totalChunks: 3,
        categories: ['HR'],
        lastUpdated: '2026-07-16T00:00:00.000Z',
        vectorStorePath: '/data/vectorstore',
      };
      const documents = [
        {
          id: 'doc-1',
          fileName: 'policy.pdf',
          fileType: 'application/pdf',
          uploadDate: '2026-07-16T00:00:00.000Z',
          chunkCount: 3,
          tags: ['Leave'],
          category: 'HR',
        },
      ];
      const removed = { success: true, message: 'removed' };
      const cleared = { success: true, message: 'cleared' };
      service.getStats.mockResolvedValue(stats);
      service.listDocuments.mockResolvedValue(documents);
      service.removeDocument.mockResolvedValue(removed);
      service.clear.mockResolvedValue(cleared);

      await expect(controller.getStats()).resolves.toBe(stats);
      await expect(
        controller.listDocuments({ category: 'HR', tags: ['Leave'] }),
      ).resolves.toBe(documents);
      await expect(
        controller.removeDocument({ documentId: 'doc-1' }),
      ).resolves.toBe(removed);
      await expect(controller.clear()).resolves.toBe(cleared);
      expect(service.listDocuments).toHaveBeenCalledWith({
        category: 'HR',
        tags: ['Leave'],
      });
      expect(service.removeDocument).toHaveBeenCalledWith('doc-1');
    });

    it('keeps rebuild bodyless and rejects former configuration controls', async () => {
      const rebuilt = {
        success: true,
        message: 'rebuilt',
        documentsProcessed: 2,
      };
      service.rebuild.mockResolvedValue(rebuilt);

      await expect(controller.rebuild()).resolves.toBe(rebuilt);
      await expect(controller.rebuild({})).resolves.toBe(rebuilt);
      await expect(
        controller.rebuild({ model: 'custom' }),
      ).rejects.toThrow(BadRequestException);
      expect(service.rebuild).toHaveBeenNthCalledWith(1);
      expect(service.rebuild).toHaveBeenNthCalledWith(2);
    });
  });
});
