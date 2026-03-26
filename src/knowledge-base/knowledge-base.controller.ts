import {
  Body,
  Controller,
  Get,
  Post,
  Delete,
  UploadedFile,
  UseInterceptors,
  Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { KnowledgeBaseService } from './knowledge-base.service';
import {
  AddDocumentDto,
  SearchKnowledgeBaseDto,
  ListDocumentsDto,
  RemoveDocumentDto,
  RebuildKnowledgeBaseDto,
  AddDocumentResponseDto,
  SearchResponseDto,
  KnowledgeBaseStatsDto,
  DocumentMetadataDto,
  RemoveDocumentResponseDto,
  RebuildResponseDto,
} from './knowledge-base.dto';
import { diskStorage } from 'multer';
import * as path from 'path';
import * as fs from 'fs';

@ApiTags('knowledge-base')
@Controller('knowledge-base')
export class KnowledgeBaseController {
  constructor(
    private readonly knowledgeBaseService: KnowledgeBaseService,
  ) {}

  @Post('add')
  @ApiOperation({ summary: 'Add document to knowledge base' })
  @ApiResponse({
    status: 200,
    description: 'Document added successfully',
    type: AddDocumentResponseDto,
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (req, file, cb) => {
          const uploadPath = path.join(process.cwd(), 'uploads', 'documents');
          if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
          }
          cb(null, uploadPath);
        },
        filename: (req, file, cb) => {
          const uniqueSuffix =
            Date.now() + '-' + Math.round(Math.random() * 1e9);
          const ext = path.extname(file.originalname);
          cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
        },
      }),
    }),
  )
  async addDocument(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: AddDocumentDto,
  ): Promise<AddDocumentResponseDto> {
    return await this.knowledgeBaseService.addDocument(
      file.path,
      file.originalname,
      file.mimetype,
      {
        openai_api_key: body.openai_api_key,
        openai_api_base_url: body.openai_api_base_url,
        model: body.model,
        temperature: body.temperature,
        chunkSize: body.chunkSize,
        chunkOverlap: body.chunkOverlap,
        tags: body.tags,
        category: body.category,
      },
    );
  }

  @Post('search')
  @ApiOperation({ summary: 'Search knowledge base with RAG' })
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
      openai_api_key: body.openai_api_key,
      openai_api_base_url: body.openai_api_base_url,
      model: body.model,
      temperature: body.temperature,
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
    @Query('category') category?: string,
    @Query('tags') tags?: string,
  ): Promise<DocumentMetadataDto[]> {
    const filter: ListDocumentsDto = {};
    if (category) filter.category = category;
    if (tags) filter.tags = tags.split(',');

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
  async rebuild(
    @Body() body: RebuildKnowledgeBaseDto,
  ): Promise<RebuildResponseDto> {
    return await this.knowledgeBaseService.rebuild({
      openai_api_key: body.openai_api_key,
      openai_api_base_url: body.openai_api_base_url,
      model: body.model,
      temperature: body.temperature,
      chunkSize: body.chunkSize,
      chunkOverlap: body.chunkOverlap,
    });
  }
}