import { Injectable } from '@nestjs/common';
import {
  ChildChunk,
  ChunkedDocument,
  deterministicId,
  LoadedDocument,
  ParentChunk,
} from '../domain/rag.types';

export const DEFAULT_PARENT_TARGET_TOKENS = 1400;
export const DEFAULT_PARENT_MAX_TOKENS = 1800;
export const DEFAULT_CHILD_TARGET_TOKENS = 360;
export const DEFAULT_CHILD_MAX_TOKENS = 480;
export const DEFAULT_CHILD_OVERLAP_TOKENS = 60;

export interface ChunkingOptions {
  documentId?: string;
  versionId?: string;
  parentTargetTokens?: number;
  parentMaxTokens?: number;
  childTargetTokens?: number;
  childMaxTokens?: number;
  childOverlapTokens?: number;
}

interface TextSpan {
  text: string;
  startOffset: number;
  endOffset: number;
}

@Injectable()
export class StructureChunkerService {
  chunk(
    document: LoadedDocument,
    options: ChunkingOptions = {},
  ): ChunkedDocument {
    const documentId =
      options.documentId ||
      deterministicId('doc', document.sourceIdentity);
    const versionId =
      options.versionId ||
      deterministicId('ver', documentId, document.contentSha256);
    const parentTarget = this.positiveInteger(
      options.parentTargetTokens,
      DEFAULT_PARENT_TARGET_TOKENS,
    );
    const parentMax = this.positiveInteger(
      options.parentMaxTokens,
      DEFAULT_PARENT_MAX_TOKENS,
    );
    const childTarget = this.positiveInteger(
      options.childTargetTokens,
      DEFAULT_CHILD_TARGET_TOKENS,
    );
    const childMax = this.positiveInteger(
      options.childMaxTokens,
      DEFAULT_CHILD_MAX_TOKENS,
    );
    const childOverlap = Math.max(
      0,
      Math.floor(
        options.childOverlapTokens ?? DEFAULT_CHILD_OVERLAP_TOKENS,
      ),
    );
    if (parentTarget > parentMax || childTarget > childMax) {
      throw new Error('Chunk target tokens must not exceed max tokens');
    }
    if (childOverlap >= childTarget) {
      throw new Error('Child overlap must be smaller than child target');
    }

    const parents: ParentChunk[] = [];
    for (const section of document.sections) {
      const spans = this.splitParentSection(
        section.text,
        section.startOffset,
        parentTarget,
        parentMax,
      );
      for (const span of spans) {
        const ordinal = parents.length;
        const content = span.text.trim();
        const estimatedTokens = this.estimateTokens(content);
        parents.push({
          id: deterministicId(
            'par',
            versionId,
            ordinal,
            section.headingPath,
            content,
          ),
          documentId,
          versionId,
          ordinal,
          content,
          headingPath: [...section.headingPath],
          estimatedTokens,
          startOffset: span.startOffset,
          endOffset: span.endOffset,
        });
      }
    }
    if (!parents.length) {
      throw new Error('Document produced no parent chunks');
    }

    const children: ChildChunk[] = [];
    for (const parent of parents) {
      const spans = this.splitTextWindow(
        parent.content,
        parent.startOffset,
        childTarget,
        childMax,
        childOverlap,
      );
      spans.forEach((span, ordinal) => {
        const content = span.text.trim();
        children.push({
          id: deterministicId(
            'chi',
            parent.id,
            ordinal,
            content,
          ),
          parentId: parent.id,
          documentId,
          versionId,
          ordinal,
          content,
          estimatedTokens: this.estimateTokens(content),
          startOffset: span.startOffset,
          endOffset: span.endOffset,
        });
      });
    }
    return { parents, children };
  }

  chunkDocument(
    document: LoadedDocument,
    options: ChunkingOptions = {},
  ): ChunkedDocument {
    return this.chunk(document, options);
  }

  estimateTokens(text: string): number {
    let tokens = 0;
    let latinRun = 0;
    const flushLatin = () => {
      if (latinRun) {
        tokens += Math.ceil(latinRun / 4);
        latinRun = 0;
      }
    };

    for (const character of text) {
      if (/[A-Za-z0-9_]/.test(character)) {
        latinRun += 1;
        continue;
      }
      flushLatin();
      if (/\s/.test(character)) {
        continue;
      }
      tokens += this.isCjk(character) ? 1 : 0.25;
    }
    flushLatin();
    return Math.max(1, Math.ceil(tokens));
  }

  private splitParentSection(
    text: string,
    baseOffset: number,
    targetTokens: number,
    maxTokens: number,
  ): TextSpan[] {
    const paragraphs = this.paragraphSpans(text, baseOffset).flatMap(span =>
      this.estimateTokens(span.text) > maxTokens
        ? this.splitTextWindow(
            span.text,
            span.startOffset,
            targetTokens,
            maxTokens,
            0,
          )
        : [span],
    );
    const chunks: TextSpan[] = [];
    let current: TextSpan | null = null;

    for (const paragraph of paragraphs) {
      if (!current) {
        current = paragraph;
        continue;
      }
      const candidateText = text.slice(
        current.startOffset - baseOffset,
        paragraph.endOffset - baseOffset,
      );
      const currentTokens = this.estimateTokens(current.text);
      const candidateTokens = this.estimateTokens(candidateText);
      if (currentTokens < targetTokens && candidateTokens <= maxTokens) {
        current = {
          text: candidateText,
          startOffset: current.startOffset,
          endOffset: paragraph.endOffset,
        };
      } else {
        chunks.push(current);
        current = paragraph;
      }
    }
    if (current) {
      chunks.push(current);
    }
    return chunks;
  }

  private paragraphSpans(text: string, baseOffset: number): TextSpan[] {
    const spans: TextSpan[] = [];
    const pattern = /\S[\s\S]*?(?=\n{2,}|\s*$)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const raw = match[0];
      const leading = raw.length - raw.trimStart().length;
      const trailing = raw.length - raw.trimEnd().length;
      const start = match.index + leading;
      const end = match.index + raw.length - trailing;
      if (end > start) {
        spans.push({
          text: text.slice(start, end),
          startOffset: baseOffset + start,
          endOffset: baseOffset + end,
        });
      }
    }
    return spans;
  }

  private splitTextWindow(
    text: string,
    baseOffset: number,
    targetTokens: number,
    maxTokens: number,
    overlapTokens: number,
  ): TextSpan[] {
    const spans: TextSpan[] = [];
    let start = 0;

    while (start < text.length) {
      while (start < text.length && /\s/.test(text[start])) {
        start += 1;
      }
      if (start >= text.length) {
        break;
      }
      const remaining = text.slice(start);
      let end: number;
      if (this.estimateTokens(remaining) <= maxTokens) {
        end = text.length;
      } else {
        const targetEnd = this.offsetForTokenBudget(
          text,
          start,
          targetTokens,
        );
        const maxEnd = this.offsetForTokenBudget(text, start, maxTokens);
        end = this.preferredBoundary(text, start, targetEnd, maxEnd);
      }
      if (end <= start) {
        end = Math.min(text.length, start + 1);
      }
      let trimmedEnd = end;
      while (trimmedEnd > start && /\s/.test(text[trimmedEnd - 1])) {
        trimmedEnd -= 1;
      }
      spans.push({
        text: text.slice(start, trimmedEnd),
        startOffset: baseOffset + start,
        endOffset: baseOffset + trimmedEnd,
      });
      if (end >= text.length) {
        break;
      }
      const nextStart =
        overlapTokens > 0
          ? this.offsetForTrailingBudget(text, start, end, overlapTokens)
          : end;
      start = nextStart > start ? nextStart : end;
    }
    return spans;
  }

  private offsetForTokenBudget(
    text: string,
    start: number,
    budget: number,
  ): number {
    let low = start + 1;
    let high = text.length;
    let best = low;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (this.estimateTokens(text.slice(start, middle)) <= budget) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return best;
  }

  private offsetForTrailingBudget(
    text: string,
    minimum: number,
    end: number,
    budget: number,
  ): number {
    let low = minimum;
    let high = end;
    let best = end;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (this.estimateTokens(text.slice(middle, end)) <= budget) {
        best = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    return best;
  }

  private preferredBoundary(
    text: string,
    start: number,
    targetEnd: number,
    maxEnd: number,
  ): number {
    const minimum = Math.max(
      start + 1,
      start + Math.floor((targetEnd - start) * 0.7),
    );
    for (let index = targetEnd; index >= minimum; index -= 1) {
      if (this.isBoundary(text[index - 1])) {
        return index;
      }
    }
    for (let index = targetEnd + 1; index <= maxEnd; index += 1) {
      if (this.isBoundary(text[index - 1])) {
        return index;
      }
    }
    return Math.max(start + 1, maxEnd);
  }

  private isBoundary(character: string): boolean {
    return /[\s。！？!?；;.!]/.test(character);
  }

  private isCjk(character: string): boolean {
    const point = character.codePointAt(0)!;
    return (
      (point >= 0x3400 && point <= 0x9fff) ||
      (point >= 0x3040 && point <= 0x30ff) ||
      (point >= 0xac00 && point <= 0xd7af)
    );
  }

  private positiveInteger(
    value: number | undefined,
    fallback: number,
  ): number {
    const resolved = Math.floor(value ?? fallback);
    if (!Number.isFinite(resolved) || resolved <= 0) {
      throw new Error('Chunk token limits must be positive integers');
    }
    return resolved;
  }
}
