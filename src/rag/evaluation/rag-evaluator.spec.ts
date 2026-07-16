import {
  RagEvaluationCase,
  RagEvaluationPrediction,
  RagEvaluator,
} from './rag-evaluator';

function evaluationCase(
  overrides: Partial<RagEvaluationCase> = {},
): RagEvaluationCase {
  return {
    id: 'case-1',
    query: 'annual leave submission',
    documents: [
      { id: 'leave-policy', text: 'annual leave submission policy' },
      { id: 'expense-policy', text: 'expense reimbursement policy' },
    ],
    relevantDocumentIds: ['leave-policy'],
    expectedCitationIds: ['leave-policy'],
    shouldAbstain: false,
    ...overrides,
  };
}

describe('RagEvaluator', () => {
  const evaluator = new RagEvaluator();

  it('computes deterministic retrieval, citation, and abstention metrics', () => {
    const cases = [
      evaluationCase(),
      evaluationCase({
        id: 'case-2',
        relevantDocumentIds: ['expense-policy'],
        expectedCitationIds: ['expense-policy'],
        shouldAbstain: true,
      }),
    ];
    const predictions: RagEvaluationPrediction[] = [
      {
        caseId: 'case-1',
        retrievedDocumentIds: ['leave-policy', 'expense-policy'],
        citationIds: ['leave-policy'],
        abstained: false,
      },
      {
        caseId: 'case-2',
        retrievedDocumentIds: ['leave-policy', 'expense-policy'],
        citationIds: ['leave-policy', 'unknown-source'],
        abstained: false,
      },
    ];

    expect(evaluator.evaluate(cases, predictions, 2)).toEqual({
      k: 2,
      metrics: {
        caseCount: 2,
        retrievalCaseCount: 2,
        recallAtK: 1,
        mrrAtK: 0.75,
        citationPrecision: 0.333333,
        citationRecall: 0.5,
        citationValidity: 0.666667,
        abstentionAccuracy: 0.5,
      },
      cases: [
        {
          caseId: 'case-1',
          retrievalRecallAtK: 1,
          reciprocalRankAtK: 1,
          citationPrecision: 1,
          citationRecall: 1,
          citationValidity: 1,
          abstentionCorrect: true,
        },
        {
          caseId: 'case-2',
          retrievalRecallAtK: 1,
          reciprocalRankAtK: 0.5,
          citationPrecision: 0,
          citationRecall: 0,
          citationValidity: 0.5,
          abstentionCorrect: false,
        },
      ],
    });
  });

  it('runs offline lexical retrieval without calling a provider', () => {
    const cases = [
      evaluationCase({
        query: 'How many days for annual leave submission?',
      }),
      evaluationCase({
        id: 'case-2',
        query: 'quantum processor qubits',
        relevantDocumentIds: [],
        expectedCitationIds: [],
        shouldAbstain: true,
      }),
    ];

    const first = evaluator.evaluateOffline(cases, {
      k: 2,
      minScore: 0.25,
      citationLimit: 1,
    });
    const second = evaluator.evaluateOffline(cases, {
      k: 2,
      minScore: 0.25,
      citationLimit: 1,
    });

    expect(first).toEqual(second);
    expect(first.metrics).toEqual({
      caseCount: 2,
      retrievalCaseCount: 1,
      recallAtK: 1,
      mrrAtK: 1,
      citationPrecision: 1,
      citationRecall: 1,
      citationValidity: 1,
      abstentionAccuracy: 1,
    });
  });

  it('rejects incomplete or ambiguous evaluation inputs', () => {
    expect(() =>
      evaluator.evaluate([evaluationCase()], [], 3),
    ).toThrow('Missing prediction');

    expect(() =>
      evaluator.evaluate(
        [evaluationCase(), evaluationCase()],
        [
          {
            caseId: 'case-1',
            retrievedDocumentIds: [],
            citationIds: [],
            abstained: true,
          },
        ],
        3,
      ),
    ).toThrow('Duplicate evaluation case ID');
  });
});
