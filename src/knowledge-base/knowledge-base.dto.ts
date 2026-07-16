import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const KNOWLEDGE_BASE_QUERY_MAX_LENGTH = 4000;
export const KNOWLEDGE_BASE_TOP_K_MAX = 20;
export const KNOWLEDGE_BASE_CATEGORY_MAX_LENGTH = 128;
export const KNOWLEDGE_BASE_TAG_MAX_LENGTH = 64;
export const KNOWLEDGE_BASE_TAGS_MAX_SIZE = 20;

function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function trimOptionalString(value: unknown): unknown {
  const normalized = trimString(value);
  return normalized === '' || normalized === null ? undefined : normalized;
}

function normalizeTags(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;

  const values = Array.isArray(value) ? value : [value];
  const normalized: unknown[] = [];
  const seen = new Set<string>();

  for (const item of values) {
    if (typeof item !== 'string') {
      normalized.push(item);
      continue;
    }

    for (const candidate of item.split(',')) {
      const tag = candidate.trim();
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(tag);
    }
  }

  return normalized.length > 0 ? normalized : undefined;
}

export class AddDocumentDto {
  @ApiPropertyOptional({
    description: 'Document tags',
    type: [String],
    maxItems: KNOWLEDGE_BASE_TAGS_MAX_SIZE,
  })
  @Transform(({ value }) => normalizeTags(value))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(KNOWLEDGE_BASE_TAGS_MAX_SIZE)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(KNOWLEDGE_BASE_TAG_MAX_LENGTH, { each: true })
  tags?: string[];

  @ApiPropertyOptional({
    description: 'Document category',
    maxLength: KNOWLEDGE_BASE_CATEGORY_MAX_LENGTH,
  })
  @Transform(({ value }) => trimOptionalString(value))
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(KNOWLEDGE_BASE_CATEGORY_MAX_LENGTH)
  category?: string;
}

abstract class RetrievalRequestDto {
  @ApiPropertyOptional({
    description: 'Number of top results to retrieve',
    default: 4,
    minimum: 1,
    maximum: KNOWLEDGE_BASE_TOP_K_MAX,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(KNOWLEDGE_BASE_TOP_K_MAX)
  @IsOptional()
  topK?: number;

  @ApiPropertyOptional({
    description: 'Filter by category',
    maxLength: KNOWLEDGE_BASE_CATEGORY_MAX_LENGTH,
  })
  @Transform(({ value }) => trimOptionalString(value))
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(KNOWLEDGE_BASE_CATEGORY_MAX_LENGTH)
  filterCategory?: string;

  @ApiPropertyOptional({
    description: 'Filter by tags',
    type: [String],
    maxItems: KNOWLEDGE_BASE_TAGS_MAX_SIZE,
  })
  @Transform(({ value }) => normalizeTags(value))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(KNOWLEDGE_BASE_TAGS_MAX_SIZE)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(KNOWLEDGE_BASE_TAG_MAX_LENGTH, { each: true })
  filterTags?: string[];
}

export class SearchKnowledgeBaseDto extends RetrievalRequestDto {
  @ApiProperty({
    description: 'Question to search in knowledge base',
    maxLength: KNOWLEDGE_BASE_QUERY_MAX_LENGTH,
  })
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(1)
  @MaxLength(KNOWLEDGE_BASE_QUERY_MAX_LENGTH)
  question: string;
}

export class RetrieveKnowledgeBaseDto extends RetrievalRequestDto {
  @ApiProperty({
    description: 'Query to retrieve evidence for',
    maxLength: KNOWLEDGE_BASE_QUERY_MAX_LENGTH,
  })
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(1)
  @MaxLength(KNOWLEDGE_BASE_QUERY_MAX_LENGTH)
  query: string;
}

export class ListDocumentsDto {
  @ApiPropertyOptional({
    description: 'Filter by category',
    maxLength: KNOWLEDGE_BASE_CATEGORY_MAX_LENGTH,
  })
  @Transform(({ value }) => trimOptionalString(value))
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(KNOWLEDGE_BASE_CATEGORY_MAX_LENGTH)
  category?: string;

  @ApiPropertyOptional({
    description: 'Filter by tags',
    type: [String],
    maxItems: KNOWLEDGE_BASE_TAGS_MAX_SIZE,
  })
  @Transform(({ value }) => normalizeTags(value))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(KNOWLEDGE_BASE_TAGS_MAX_SIZE)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(KNOWLEDGE_BASE_TAG_MAX_LENGTH, { each: true })
  tags?: string[];
}

export class RemoveDocumentDto {
  @ApiProperty({ description: 'Document ID to remove', maxLength: 512 })
  @Transform(({ value }) => trimString(value))
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  documentId: string;
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
  @ApiProperty({
    description: 'Legacy answer field; retrieval returns an empty string',
  })
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

export class RetrieveResponseDto {
  @ApiProperty({ description: 'Ranked retrieval evidence' })
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
