# Offline RAG Evaluation

`rag-eval.jsonl` is a small deterministic fixture set for checking retrieval,
citations, and abstention without model, embedding, reranker, Redis, SQLite, or
network calls.

Each JSONL record contains:

- `id`: stable evaluation case ID
- `query`: query used by the offline lexical retriever
- `documents`: local candidate documents with stable IDs and text
- `relevantDocumentIds`: documents that retrieval should return
- `expectedCitationIds`: source IDs that a grounded answer may cite
- `shouldAbstain`: expected evidence-gate decision

`scripts/run-rag-eval.ts` reads the file and emits a JSON report containing
`Recall@K`, `MRR@K`, citation precision, citation recall, citation validity, and
abstention accuracy. The report includes IDs and aggregate metrics only; it
does not echo document text, file paths, configuration, or secrets.

The final T09 integration should add the package script or build entry used to
execute `scripts/run-rag-eval.ts`. The source entry accepts an optional JSONL
path as its first argument and defaults to `evaluation/rag-eval.jsonl`.
