export interface OfflineEvaluationDocument {
  id: string;
  text: string;
}

export interface RagEvaluationCase {
  id: string;
  query: string;
  documents: readonly OfflineEvaluationDocument[];
  relevantDocumentIds: readonly string[];
  expectedCitationIds: readonly string[];
  shouldAbstain: boolean;
}

export interface RagEvaluationPrediction {
  caseId: string;
  retrievedDocumentIds: readonly string[];
  citationIds: readonly string[];
  abstained: boolean;
}

export interface RagCaseMetrics {
  caseId: string;
  retrievalRecallAtK: number | null;
  reciprocalRankAtK: number | null;
  citationPrecision: number;
  citationRecall: number;
  citationValidity: number;
  abstentionCorrect: boolean;
}

export interface RagEvaluationSummary {
  caseCount: number;
  retrievalCaseCount: number;
  recallAtK: number;
  mrrAtK: number;
  citationPrecision: number;
  citationRecall: number;
  citationValidity: number;
  abstentionAccuracy: number;
}

export interface RagEvaluationReport {
  k: number;
  metrics: RagEvaluationSummary;
  cases: readonly RagCaseMetrics[];
}

export interface OfflineEvaluationOptions {
  k?: number;
  minScore?: number;
  citationLimit?: number;
}

interface ScoredDocument {
  id: string;
  score: number;
}

const DEFAULT_K = 3;
const DEFAULT_MIN_SCORE = 0.25;
const DEFAULT_CITATION_LIMIT = 2;
const ENGLISH_STOP_WORDS = new Set([
  'a',
  'an',
  'are',
  'be',
  'for',
  'how',
  'is',
  'of',
  'the',
  'to',
  'what',
  'when',
]);

export class RagEvaluator {
  evaluateOffline(
    cases: readonly RagEvaluationCase[],
    options: OfflineEvaluationOptions = {},
  ): RagEvaluationReport {
    const k = options.k ?? DEFAULT_K;
    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    const citationLimit = options.citationLimit ?? DEFAULT_CITATION_LIMIT;
    validateOptions(k, minScore, citationLimit);

    const predictions = cases.map(testCase =>
      createOfflinePrediction(testCase, { k, minScore, citationLimit }),
    );
    return this.evaluate(cases, predictions, k);
  }

  evaluate(
    cases: readonly RagEvaluationCase[],
    predictions: readonly RagEvaluationPrediction[],
    k = DEFAULT_K,
  ): RagEvaluationReport {
    validatePositiveInteger('k', k);
    const predictionByCase = indexPredictions(predictions);
    const seenCases = new Set<string>();
    const caseMetrics: RagCaseMetrics[] = [];
    let retrievalRecallTotal = 0;
    let reciprocalRankTotal = 0;
    let retrievalCaseCount = 0;
    let citationTruePositiveCount = 0;
    let expectedCitationCount = 0;
    let predictedCitationCount = 0;
    let validCitationCount = 0;
    let correctAbstentionCount = 0;

    for (const testCase of cases) {
      const caseId = normalizeRequiredId(testCase.id, 'case ID');
      if (seenCases.has(caseId)) {
        throw new Error(`Duplicate evaluation case ID: ${caseId}`);
      }
      seenCases.add(caseId);

      const prediction = predictionByCase.get(caseId);
      if (!prediction) {
        throw new Error(`Missing prediction for evaluation case: ${caseId}`);
      }

      const retrieved = uniqueIds(prediction.retrievedDocumentIds).slice(0, k);
      const relevant = uniqueIds(testCase.relevantDocumentIds);
      const expectedCitations = uniqueIds(testCase.expectedCitationIds);
      const citations = uniqueIds(prediction.citationIds);
      const relevantSet = new Set(relevant);
      const expectedCitationSet = new Set(expectedCitations);
      const retrievedSet = new Set(retrieved);
      const matchedRelevant = retrieved.filter(id => relevantSet.has(id)).length;
      const firstRelevantIndex = retrieved.findIndex(id => relevantSet.has(id));
      const retrievalRecallAtK =
        relevant.length === 0 ? null : matchedRelevant / relevant.length;
      const reciprocalRankAtK =
        relevant.length === 0
          ? null
          : firstRelevantIndex === -1
            ? 0
            : 1 / (firstRelevantIndex + 1);
      const citationTruePositives = citations.filter(id =>
        expectedCitationSet.has(id),
      ).length;
      const validCitations = citations.filter(id => retrievedSet.has(id)).length;
      const citationPrecision = ratio(
        citationTruePositives,
        citations.length,
        expectedCitations.length === 0 ? 1 : 0,
      );
      const citationRecall = ratio(
        citationTruePositives,
        expectedCitations.length,
        1,
      );
      const citationValidity = ratio(validCitations, citations.length, 1);
      const abstentionCorrect =
        prediction.abstained === testCase.shouldAbstain;

      if (retrievalRecallAtK !== null && reciprocalRankAtK !== null) {
        retrievalCaseCount += 1;
        retrievalRecallTotal += retrievalRecallAtK;
        reciprocalRankTotal += reciprocalRankAtK;
      }
      citationTruePositiveCount += citationTruePositives;
      expectedCitationCount += expectedCitations.length;
      predictedCitationCount += citations.length;
      validCitationCount += validCitations;
      if (abstentionCorrect) correctAbstentionCount += 1;

      caseMetrics.push({
        caseId,
        retrievalRecallAtK: nullableRound(retrievalRecallAtK),
        reciprocalRankAtK: nullableRound(reciprocalRankAtK),
        citationPrecision: round(citationPrecision),
        citationRecall: round(citationRecall),
        citationValidity: round(citationValidity),
        abstentionCorrect,
      });
    }

    for (const caseId of predictionByCase.keys()) {
      if (!seenCases.has(caseId)) {
        throw new Error(`Prediction has no evaluation case: ${caseId}`);
      }
    }

    return {
      k,
      metrics: {
        caseCount: cases.length,
        retrievalCaseCount,
        recallAtK: round(
          ratio(retrievalRecallTotal, retrievalCaseCount, 1),
        ),
        mrrAtK: round(ratio(reciprocalRankTotal, retrievalCaseCount, 1)),
        citationPrecision: round(
          ratio(
            citationTruePositiveCount,
            predictedCitationCount,
            expectedCitationCount === 0 ? 1 : 0,
          ),
        ),
        citationRecall: round(
          ratio(citationTruePositiveCount, expectedCitationCount, 1),
        ),
        citationValidity: round(
          ratio(validCitationCount, predictedCitationCount, 1),
        ),
        abstentionAccuracy: round(
          ratio(correctAbstentionCount, cases.length, 1),
        ),
      },
      cases: caseMetrics,
    };
  }
}

function createOfflinePrediction(
  testCase: RagEvaluationCase,
  options: Required<OfflineEvaluationOptions>,
): RagEvaluationPrediction {
  const ranked = rankDocuments(testCase.query, testCase.documents);
  const retrieved = ranked.slice(0, options.k);
  const topScore = retrieved[0]?.score ?? 0;
  const abstained = topScore < options.minScore;
  const citationThreshold = Math.max(
    options.minScore,
    topScore * 0.75,
  );
  const citationIds = abstained
    ? []
    : retrieved
        .filter(document => document.score >= citationThreshold)
        .slice(0, options.citationLimit)
        .map(document => document.id);

  return {
    caseId: normalizeRequiredId(testCase.id, 'case ID'),
    retrievedDocumentIds: retrieved.map(document => document.id),
    citationIds,
    abstained,
  };
}

function rankDocuments(
  query: string,
  documents: readonly OfflineEvaluationDocument[],
): ScoredDocument[] {
  const queryTokens = tokenize(query);
  const seenIds = new Set<string>();

  return documents
    .map(document => {
      const id = normalizeRequiredId(document.id, 'document ID');
      if (seenIds.has(id)) {
        throw new Error(`Duplicate document ID in evaluation case: ${id}`);
      }
      seenIds.add(id);

      return {
        id,
        score: lexicalCoverage(queryTokens, tokenize(document.text)),
      };
    })
    .filter(document => document.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || compareText(left.id, right.id),
    );
}

function tokenize(value: string): Set<string> {
  const normalized = String(value ?? '').normalize('NFKC').toLowerCase();
  const segments = normalized.match(
    /[\p{Script=Han}]+|[\p{Letter}\p{Number}]+/gu,
  ) ?? [];
  const tokens = new Set<string>();

  for (const segment of segments) {
    if (/^\p{Script=Han}+$/u.test(segment)) {
      if (segment.length === 1) {
        tokens.add(segment);
        continue;
      }
      for (let index = 0; index < segment.length - 1; index += 1) {
        tokens.add(segment.slice(index, index + 2));
      }
      continue;
    }

    if (!ENGLISH_STOP_WORDS.has(segment)) {
      tokens.add(segment);
    }
  }

  return tokens;
}

function lexicalCoverage(
  queryTokens: ReadonlySet<string>,
  documentTokens: ReadonlySet<string>,
): number {
  if (queryTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of queryTokens) {
    if (documentTokens.has(token)) intersection += 1;
  }
  return intersection / queryTokens.size;
}

function indexPredictions(
  predictions: readonly RagEvaluationPrediction[],
): Map<string, RagEvaluationPrediction> {
  const indexed = new Map<string, RagEvaluationPrediction>();

  for (const prediction of predictions) {
    const caseId = normalizeRequiredId(prediction.caseId, 'prediction case ID');
    if (indexed.has(caseId)) {
      throw new Error(`Duplicate prediction case ID: ${caseId}`);
    }
    indexed.set(caseId, prediction);
  }

  return indexed;
}

function uniqueIds(values: readonly string[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const id = normalizeRequiredId(value, 'identifier');
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  return ids;
}

function normalizeRequiredId(value: string, label: string): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) throw new Error(`${label} must not be empty`);
  return id;
}

function validateOptions(
  k: number,
  minScore: number,
  citationLimit: number,
): void {
  validatePositiveInteger('k', k);
  validatePositiveInteger('citationLimit', citationLimit);
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    throw new Error('minScore must be between 0 and 1');
  }
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function ratio(
  numerator: number,
  denominator: number,
  emptyValue: number,
): number {
  return denominator === 0 ? emptyValue : numerator / denominator;
}

function nullableRound(value: number | null): number | null {
  return value === null ? null : round(value);
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
