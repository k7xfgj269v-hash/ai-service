import { IsString, IsOptional, IsArray, IsNumber, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AddDocumentDto {
  @ApiPropertyOptional({ description: 'Custom OpenAI API key' })
  @IsString()
  @IsOptional()
  openai_api_key?: string;

  @ApiPropertyOptional({ description: 'Custom OpenAI API base URL' })
  @IsString()
  @IsOptional()
  openai_api_base_url?: string;

  @ApiPropertyOptional({ description: 'AI model to use' })
  @IsString()
  @IsOptional()
  model?: string;

  @ApiPropertyOptional({ description: 'Temperature for AI model' })
  @IsNumber()
  @IsOptional()
  temperature?: number;

  @ApiPropertyOptional({ description: 'Chunk size for document splitting' })
  @IsNumber()
  @IsOptional()
  chunkSize?: number;

  @ApiPropertyOptional({ description: 'Chunk overlap for document splitting' })
  @IsNumber()
  @IsOptional()
  chunkOverlap?: number;

  @ApiPropertyOptional({ description: 'Tags for categorizing the document', type: [String] })
  @IsArray()
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ description: 'Category for the document' })
  @IsString()
  @IsOptional()
  category?: string;
}

export class SearchKnowledgeBaseDto {
  @ApiProperty({ description: 'Question to search in knowledge base' })
  @IsString()
  question: string;

  @ApiPropertyOptional({ description: 'Number of top results to retrieve', default: 4 })
  @IsNumber()
  @IsOptional()
  topK?: number;

  @ApiPropertyOptional({ description: 'Custom OpenAI API key' })
  @IsString()
  @IsOptional()
  openai_api_key?: string;

  @ApiPropertyOptional({ description: 'Custom OpenAI API base URL' })
  @IsString()
  @IsOptional()
  openai_api_base_url?: string;

  @ApiPropertyOptional({ description: 'AI model to use' })
  @IsString()
  @IsOptional()
  model?: string;

  @ApiPropertyOptional({ description: 'Temperature for AI model' })
  @IsNumber()
  @IsOptional()
  temperature?: number;

  @ApiPropertyOptional({ description: 'Filter by category' })
  @IsString()
  @IsOptional()
  filterCategory?: string;

  @ApiPropertyOptional({ description: 'Filter by tags', type: [String] })
  @IsArray()
  @IsOptional()
  filterTags?: string[];
}

export class ListDocumentsDto {
  @ApiPropertyOptional({ description: 'Filter by category' })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiPropertyOptional({ description: 'Filter by tags', type: [String] })
  @IsArray()
  @IsOptional()
  tags?: string[];
}

export class RemoveDocumentDto {
  @ApiProperty({ description: 'Document ID to remove' })
  @IsString()
  documentId: string;
}

export class RebuildKnowledgeBaseDto {
  @ApiPropertyOptional({ description: 'Custom OpenAI API key' })
  @IsString()
  @IsOptional()
  openai_api_key?: string;

  @ApiPropertyOptional({ description: 'Custom OpenAI API base URL' })
  @IsString()
  @IsOptional()
  openai_api_base_url?: string;

  @ApiPropertyOptional({ description: 'AI model to use' })
  @IsString()
  @IsOptional()
  model?: string;

  @ApiPropertyOptional({ description: 'Temperature for AI model' })
  @IsNumber()
  @IsOptional()
  temperature?: number;

  @ApiPropertyOptional({ description: 'Chunk size for document splitting' })
  @IsNumber()
  @IsOptional()
  chunkSize?: number;

  @ApiPropertyOptional({ description: 'Chunk overlap for document splitting' })
  @IsNumber()
  @IsOptional()
  chunkOverlap?: number;
}

export class AddDocumentResponseDto {
  @ApiProperty({ description: 'Success status' })
  success: boolean;

  @ApiProperty({ description: 'Response message' })
  message: string;

  @ApiProperty({ description: 'Generated document ID' })
  documentId: string;

  @ApiProperty({ description: 'Number of chunks created' })
  chunkCount: number;
}

export class SearchResponseDto {
  @ApiProperty({ description: 'Answer to the question' })
  answer: string;

  @ApiProperty({ description: 'Source documents used for the answer' })
  sources: Array<{
    content: string;
    metadata: any;
    score?: number;
  }>;

  @ApiProperty({ description: 'Confidence score (0-1)' })
  confidence: number;

  @ApiProperty({ description: 'Processing time in milliseconds' })
  processingTime: number;
}

export class KnowledgeBaseStatsDto {
  @ApiProperty({ description: 'Total number of documents' })
  totalDocuments: number;

  @ApiProperty({ description: 'Total number of chunks' })
  totalChunks: number;

  @ApiProperty({ description: 'Available categories', type: [String] })
  categories: string[];

  @ApiProperty({ description: 'Last update timestamp' })
  lastUpdated: string;

  @ApiProperty({ description: 'Vector store path' })
  vectorStorePath: string;
}

export class DocumentMetadataDto {
  @ApiProperty({ description: 'Document ID' })
  id: string;

  @ApiProperty({ description: 'File name' })
  fileName: string;

  @ApiProperty({ description: 'File type' })
  fileType: string;

  @ApiProperty({ description: 'Upload date' })
  uploadDate: string;

  @ApiProperty({ description: 'Number of chunks' })
  chunkCount: number;

  @ApiPropertyOptional({ description: 'Document tags', type: [String] })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Document category' })
  category?: string;
}

export class RemoveDocumentResponseDto {
  @ApiProperty({ description: 'Success status' })
  success: boolean;

  @ApiProperty({ description: 'Response message' })
  message: string;
}

export class RebuildResponseDto {
  @ApiProperty({ description: 'Success status' })
  success: boolean;

  @ApiProperty({ description: 'Response message' })
  message: string;

  @ApiProperty({ description: 'Number of documents processed' })
  documentsProcessed: number;
}