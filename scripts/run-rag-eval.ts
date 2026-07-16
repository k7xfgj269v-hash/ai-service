import * as fs from 'fs';
import * as path from 'path';
import {
  RagEvaluationCase,
  RagEvaluationReport,
  RagEvaluator,
} from '../src/rag/evaluation/rag-evaluator';

export function loadEvaluationCases(filePath: string): RagEvaluationCase[] {
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0);

  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Invalid evaluation JSONL at line ${index + 1}`);
    }
    return validateCase(parsed, index + 1);
  });
}

export function runRagEvaluation(
  filePath = path.resolve(process.cwd(), 'evaluation', 'rag-eval.jsonl'),
): RagEvaluationReport {
  const cases = loadEvaluationCases(filePath);
  return new RagEvaluator().evaluateOffline(cases);
}

if (require.main === module) {
  try {
    const report = runRagEvaluation(process.argv[2]);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch {
    process.stderr.write(
      `${JSON.stringify({ status: 'error', code: 'evaluation_failed' })}\n`,
    );
    process.exitCode = 1;
  }
}

function validateCase(value: unknown, line: number): RagEvaluationCase {
  if (!isRecord(value)) {
    throw new Error(`Evaluation case at line ${line} must be an object`);
  }

  const documents = value.documents;
  if (!Array.isArray(documents)) {
    throw new Error(`Evaluation documents at line ${line} must be an array`);
  }

  return {
    id: requiredString(value.id, 'id', line),
    query: requiredString(value.query, 'query', line),
    documents: documents.map((document, index) => {
      if (!isRecord(document)) {
        throw new Error(
          `Evaluation document ${index + 1} at line ${line} must be an object`,
        );
      }
      return {
        id: requiredString(document.id, 'document id', line),
        text: requiredString(document.text, 'document text', line),
      };
    }),
    relevantDocumentIds: stringArray(
      value.relevantDocumentIds,
      'relevantDocumentIds',
      line,
    ),
    expectedCitationIds: stringArray(
      value.expectedCitationIds,
      'expectedCitationIds',
      line,
    ),
    shouldAbstain: requiredBoolean(
      value.shouldAbstain,
      'shouldAbstain',
      line,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  line: number,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Evaluation ${field} at line ${line} must be a string`);
  }
  return value.trim();
}

function stringArray(
  value: unknown,
  field: string,
  line: number,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Evaluation ${field} at line ${line} must be an array`);
  }
  return value.map(item => requiredString(item, field, line));
}

function requiredBoolean(
  value: unknown,
  field: string,
  line: number,
): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Evaluation ${field} at line ${line} must be a boolean`);
  }
  return value;
}
