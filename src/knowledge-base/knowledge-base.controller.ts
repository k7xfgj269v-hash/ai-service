import {
  BadRequestException,
  Body,
  CallHandler,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  Injectable,
  NestInterceptor,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import * as fs from 'fs';
import { diskStorage } from 'multer';
import * as path from 'path';
import { Observable, catchError, throwError } from 'rxjs';
import {
  AddDocumentDto,
  AddDocumentResponseDto,
  AnswerKnowledgeBaseDto,
  AnswerResponseDto,
  DocumentMetadataDto,
  KnowledgeBaseStatsDto,
  ListDocumentsDto,
  RemoveDocumentDto,
  RemoveDocumentResponseDto,
  RebuildResponseDto,
  RetrieveKnowledgeBaseDto,
  RetrieveResponseDto,
  SearchKnowledgeBaseDto,
  SearchResponseDto,
} from './knowledge-base.dto';
import { KnowledgeBaseService } from './knowledge-base.service';
import {
  RagAnswerResult,
  RagQueryService,
  RagRetrieveResult,
} from '../rag/rag-query.service';

export const DOCUMENT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

const DOCUMENT_MIME_TYPES: Readonly<Record<string, readonly string[]>> = {
  '.pdf': ['application/pdf', 'application/octet-stream'],
  '.docx': [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
    'application/octet-stream',
  ],
  '.md': [
    'text/markdown',
    'text/x-markdown',
    'text/plain',
    'application/octet-stream',
  ],
  '.txt': ['text/plain', 'application/octet-stream'],
};

function cleanupUploadedFile(filePath?: string): void {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

export const documentUploadOptions: MulterOptions = {
  limits: { fileSize: DOCUMENT_UPLOAD_MAX_BYTES },
  fileFilter: (_request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const allowedMimeTypes = DOCUMENT_MIME_TYPES[extension];
    const mimeType = String(file.mimetype || '').toLowerCase();

    if (!allowedMimeTypes || !allowedMimeTypes.includes(mimeType)) {
      callback(
        new BadRequestException(
          'Only PDF, DOCX, Markdown, and text files are supported',
        ),
        false,
      );
      return;
    }

    callback(null, true);
  },
  storage: diskStorage({
    destination: (_request, _file, callback) => {
      const uploadPath = path.join(process.cwd(), 'uploads', 'documents');
      if (!fs.existsSync(uploadPath)) {
        fs.mkdirSync(uploadPath, { recursive: true });
      }
      callback(null, uploadPath);
    },
    filename: (_request, file, callback) => {
      const uniqueSuffix =
        Date.now() + '-' + Math.round(Math.random() * 1e9);
      const extension = path.extname(file.originalname);
      callback(null, `${file.fieldname}-${uniqueSuffix}${extension}`);
    },
  }),
};

@Injectable()
export class FailedUploadCleanupInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{
      file?: Express.Multer.File;
    }>();

    return next.handle().pipe(
      catchError(error => {
        cleanupUploadedFile(request.file?.path);
        return throwError(() => error);
      }),
    );
  }
}

@ApiTags('knowledge-base')
@Controller('knowledge-base')
export class KnowledgeBaseController {
  constructor(
    private readonly knowledgeBaseService: KnowledgeBaseService,
    private readonly ragQueryService: RagQueryService,
  ) {}

  @Post('add')
  @ApiOperation({ summary: 'Add document to knowledge base' })
  @ApiResponse({
    status: 200,
    description: 'Document added successfully',
    type: AddDocumentResponseDto,
  })
  @UseInterceptors(
    FileInterceptor('file', documentUploadOptions),
    FailedUploadCleanupInterceptor,
  )
  async addDocument(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: AddDocumentDto,
  ): Promise<AddDocumentResponseDto> {
    if (!file) {
      throw new BadRequestException(
        'No file uploaded (field name must be "file")',
      );
    }

    try {
      return await this.knowledgeBaseService.addDocument(
        file.path,
        file.originalname,
        file.mimetype,
        {
          tags: body.tags,
          category: body.category,
        },
      );
    } catch (error) {
      cleanupUploadedFile(file.path);
      throw error;
    }
  }

  @Post('search')
  @ApiOperation({ summary: 'Search knowledge base with legacy response shape' })
  @ApiResponse({
    status: 200,
    description: 'Search completed successfully',
    type: SearchResponseDto,
  })
  async search(
    @Body() body: SearchKnowledgeBaseDto,
  ): Promise<SearchResponseDto> {
    return await this.knowledgeBaseService.search(body.question, {
      topK: body.topK,
      filter: {
        category: body.filterCategory,
        tags: body.filterTags,
      },
    });
  }

  @Post('retrieve')
  @ApiOperation({ summary: 'Retrieve ranked knowledge base evidence' })
  @ApiResponse({
    status: 200,
    description: 'Evidence retrieved successfully',
    type: RetrieveResponseDto,
  })
  async retrieve(
    @Body() body: RetrieveKnowledgeBaseDto,
  ): Promise<RagRetrieveResult> {
    return this.ragQueryService.retrieve({
      query: body.query,
      limit: body.topK,
      filter: {
        category: body.filterCategory,
        tags: body.filterTags,
      },
    });
  }

  @Post('answer')
  @ApiOperation({ summary: 'Answer from validated knowledge base evidence' })
  @ApiResponse({
    status: 200,
    description: 'Answer completed or abstained',
    type: AnswerResponseDto,
  })
  async answer(
    @Body() body: AnswerKnowledgeBaseDto,
  ): Promise<RagAnswerResult> {
    return this.ragQueryService.answer({
      query: body.query,
      limit: body.topK,
      filter: {
        category: body.filterCategory,
        tags: body.filterTags,
      },
    });
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get knowledge base statistics' })
  @ApiResponse({
    status: 200,
    description: 'Statistics retrieved successfully',
    type: KnowledgeBaseStatsDto,
  })
  async getStats(): Promise<KnowledgeBaseStatsDto> {
    return await this.knowledgeBaseService.getStats();
  }

  @Get('documents')
  @ApiOperation({ summary: 'List all documents in knowledge base' })
  @ApiResponse({
    status: 200,
    description: 'Documents listed successfully',
    type: [DocumentMetadataDto],
  })
  async listDocuments(
    @Query() filter: ListDocumentsDto,
  ): Promise<DocumentMetadataDto[]> {
    return await this.knowledgeBaseService.listDocuments(filter);
  }

  @Delete('document')
  @ApiOperation({ summary: 'Remove document from knowledge base' })
  @ApiResponse({
    status: 200,
    description: 'Document removed successfully',
    type: RemoveDocumentResponseDto,
  })
  async removeDocument(
    @Body() body: RemoveDocumentDto,
  ): Promise<RemoveDocumentResponseDto> {
    return await this.knowledgeBaseService.removeDocument(body.documentId);
  }

  @Delete('clear')
  @ApiOperation({ summary: 'Clear entire knowledge base' })
  @ApiResponse({
    status: 200,
    description: 'Knowledge base cleared successfully',
  })
  async clear(): Promise<{ success: boolean; message: string }> {
    return await this.knowledgeBaseService.clear();
  }

  @Post('rebuild')
  @ApiOperation({ summary: 'Rebuild knowledge base from existing documents' })
  @ApiResponse({
    status: 200,
    description: 'Knowledge base rebuilt successfully',
    type: RebuildResponseDto,
  })
  async rebuild(@Body() body?: unknown): Promise<RebuildResponseDto> {
    if (
      body !== undefined &&
      (body === null ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length > 0)
    ) {
      throw new BadRequestException('Rebuild request body must be empty');
    }

    return await this.knowledgeBaseService.rebuild();
  }
}
