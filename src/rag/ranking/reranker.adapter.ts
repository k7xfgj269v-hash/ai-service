export const DEFAULT_RERANK_INPUT_LIMIT = 20;
export const DEFAULT_RERANK_OUTPUT_LIMIT = 10;

export interface RerankCandidate {
  id: string;
  text: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface RerankRequest {
  query: string;
  candidates: readonly RerankCandidate[];
  topK: number;
  signal?: AbortSignal;
}

export interface RerankScore {
  id: string;
  score: number;
}

export interface RerankerAdapter {
  readonly enabled: boolean;
  rerank(request: RerankRequest): Promise<readonly RerankScore[]>;
}

export class DisabledRerankerAdapter implements RerankerAdapter {
  readonly enabled = false;

  async rerank(request: RerankRequest): Promise<readonly RerankScore[]> {
    if (request.signal?.aborted) {
      throw request.signal.reason ?? new Error('Reranking aborted');
    }
    return [];
  }
}
