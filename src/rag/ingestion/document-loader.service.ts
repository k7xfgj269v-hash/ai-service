import { Injectable } from '@nestjs/common';
import { readFile } from 'fs/promises';
import * as path from 'path';
import mammoth = require('mammoth');
import { PDFParse } from 'pdf-parse';
import {
  DocumentLoadInput,
  DocumentSourceType,
  LoadedDocument,
  LoadedSection,
  normalizeSourceIdentity,
  sha256Hex,
} from '../domain/rag.types';

interface SectionDraft {
  text: string;
  headingPath: string[];
  pageNumber?: number;
}

const MIME_BY_TYPE: Record<DocumentSourceType, string> = {
  pdf: 'application/pdf',
  docx:
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  markdown: 'text/markdown',
  text: 'text/plain',
};

@Injectable()
export class DocumentLoaderService {
  async load(input: DocumentLoadInput): Promise<LoadedDocument> {
    if (input.content === undefined && !input.filePath) {
      throw new Error('Either content or filePath is required');
    }
    const sourceIdentity = normalizeSourceIdentity(input.sourceIdentity);
    const fileName = this.resolveFileName(input);
    const sourceType = this.resolveSourceType(fileName, input.mimeType);
    const bytes =
      input.content === undefined
        ? await readFile(input.filePath!)
        : Buffer.isBuffer(input.content)
          ? input.content
          : Buffer.from(input.content, 'utf8');
    if (!bytes.length) {
      throw new Error(`Document ${fileName} is empty`);
    }

    let drafts: SectionDraft[];
    let extractedMetadata: Record<string, unknown> = {};
    switch (sourceType) {
      case 'pdf': {
        const result = await this.loadPdf(bytes);
        drafts = result.sections;
        extractedMetadata = { pageCount: result.pageCount };
        break;
      }
      case 'docx':
        drafts = await this.loadDocx(bytes);
        break;
      case 'markdown':
        drafts = this.loadMarkdown(this.decodeText(bytes, fileName));
        break;
      case 'text':
        drafts = this.loadText(this.decodeText(bytes, fileName));
        break;
    }

    const finalized = this.finalizeSections(drafts);
    if (!finalized.text.trim()) {
      throw new Error(`Document ${fileName} contains no extractable text`);
    }

    return {
      sourceIdentity,
      fileName,
      sourceType,
      mimeType: input.mimeType || MIME_BY_TYPE[sourceType],
      contentSha256: sha256Hex(bytes),
      text: finalized.text,
      sections: finalized.sections,
      category: input.category?.trim() || 'general',
      tags: this.normalizeTags(input.tags),
      metadata: {
        ...(input.metadata || {}),
        ...extractedMetadata,
      },
    };
  }

  private async loadPdf(bytes: Buffer): Promise<{
    sections: SectionDraft[];
    pageCount: number;
  }> {
    const parser = new PDFParse({ data: bytes });
    try {
      const result = await parser.getText();
      return {
        pageCount: result.total,
        sections: result.pages
          .map(page => ({
            text: this.normalizeText(page.text),
            headingPath: [`Page ${page.num}`],
            pageNumber: page.num,
          }))
          .filter(section => section.text.length > 0),
      };
    } finally {
      await parser.destroy();
    }
  }

  private async loadDocx(bytes: Buffer): Promise<SectionDraft[]> {
    const result = await mammoth.convertToHtml(
      { buffer: bytes },
      { includeDefaultStyleMap: true },
    );
    const blocks: Array<{ tag: string; text: string }> = [];
    const blockPattern = /<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let match: RegExpExecArray | null;
    while ((match = blockPattern.exec(result.value))) {
      const text = this.normalizeText(this.htmlToText(match[2]));
      if (text) {
        blocks.push({ tag: match[1].toLowerCase(), text });
      }
    }
    if (!blocks.length) {
      const raw = await mammoth.extractRawText({ buffer: bytes });
      return this.loadText(raw.value);
    }

    const headingPath: string[] = [];
    const sections: SectionDraft[] = [];
    let paragraphs: string[] = [];
    const flush = () => {
      if (paragraphs.length) {
        sections.push({
          headingPath: [...headingPath],
          text: paragraphs.join('\n\n'),
        });
        paragraphs = [];
      }
    };

    for (const block of blocks) {
      if (/^h[1-6]$/.test(block.tag)) {
        flush();
        const level = Number(block.tag.slice(1));
        headingPath.splice(level - 1);
        headingPath[level - 1] = block.text;
      } else {
        paragraphs.push(block.text);
      }
    }
    flush();
    return sections;
  }

  private loadMarkdown(text: string): SectionDraft[] {
    const sections: SectionDraft[] = [];
    const headingPath: string[] = [];
    let lines: string[] = [];
    let inFence = false;
    const flush = () => {
      const content = this.normalizeText(lines.join('\n'));
      if (content) {
        sections.push({ text: content, headingPath: [...headingPath] });
      }
      lines = [];
    };

    for (const line of text.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        lines.push(line);
        continue;
      }
      const heading = !inFence
        ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
        : null;
      if (!heading) {
        lines.push(line);
        continue;
      }
      flush();
      const level = heading[1].length;
      headingPath.splice(level - 1);
      headingPath[level - 1] = heading[2].trim();
    }
    flush();
    return sections;
  }

  private loadText(text: string): SectionDraft[] {
    const normalized = this.normalizeText(text);
    if (!normalized) {
      return [];
    }
    return normalized
      .split(/\n{3,}/)
      .map(section => this.normalizeText(section))
      .filter(Boolean)
      .map(section => ({ text: section, headingPath: [] }));
  }

  private finalizeSections(drafts: SectionDraft[]): {
    text: string;
    sections: LoadedSection[];
  } {
    const sections: LoadedSection[] = [];
    let text = '';
    for (const draft of drafts) {
      const content = this.normalizeText(draft.text);
      if (!content) {
        continue;
      }
      if (text) {
        text += '\n\n';
      }
      const startOffset = text.length;
      text += content;
      sections.push({
        ordinal: sections.length,
        text: content,
        headingPath: draft.headingPath.filter(Boolean),
        ...(draft.pageNumber ? { pageNumber: draft.pageNumber } : {}),
        startOffset,
        endOffset: text.length,
      });
    }
    return { text, sections };
  }

  private resolveFileName(input: DocumentLoadInput): string {
    const candidate =
      input.fileName ||
      (input.filePath ? path.basename(input.filePath) : undefined) ||
      'document.txt';
    const fileName = path.basename(candidate).trim();
    if (!fileName) {
      throw new Error('fileName must not be empty');
    }
    return fileName;
  }

  private resolveSourceType(
    fileName: string,
    mimeType?: string,
  ): DocumentSourceType {
    const extension = path.extname(fileName).toLowerCase();
    if (extension === '.pdf' || mimeType === MIME_BY_TYPE.pdf) {
      return 'pdf';
    }
    if (extension === '.docx' || mimeType === MIME_BY_TYPE.docx) {
      return 'docx';
    }
    if (
      extension === '.md' ||
      extension === '.markdown' ||
      mimeType === MIME_BY_TYPE.markdown
    ) {
      return 'markdown';
    }
    if (
      extension === '.txt' ||
      extension === '' ||
      mimeType?.startsWith('text/')
    ) {
      return 'text';
    }
    throw new Error(`Unsupported document type: ${extension || mimeType}`);
  }

  private decodeText(bytes: Buffer, fileName: string): string {
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    if (text.includes('\u0000')) {
      throw new Error(`Document ${fileName} is not valid UTF-8 text`);
    }
    return text;
  }

  private normalizeText(value: string): string {
    return value
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  private normalizeTags(tags: string[] = []): string[] {
    const values = new Map<string, string>();
    for (const raw of tags) {
      const tag = String(raw).normalize('NFKC').trim();
      if (tag) {
        values.set(tag.toLowerCase(), tag);
      }
    }
    return [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, tag]) => tag);
  }

  private htmlToText(value: string): string {
    return this.decodeHtmlEntities(
      value
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ''),
    );
  }

  private decodeHtmlEntities(value: string): string {
    const named: Record<string, string> = {
      amp: '&',
      apos: "'",
      gt: '>',
      lt: '<',
      nbsp: ' ',
      quot: '"',
    };
    return value.replace(
      /&(#x[\da-f]+|#\d+|[a-z]+);/gi,
      (entity, body: string) => {
        if (body.startsWith('#x')) {
          return String.fromCodePoint(parseInt(body.slice(2), 16));
        }
        if (body.startsWith('#')) {
          return String.fromCodePoint(parseInt(body.slice(1), 10));
        }
        return named[body.toLowerCase()] || entity;
      },
    );
  }
}
