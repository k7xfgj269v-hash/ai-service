import { Injectable } from '@nestjs/common';

export interface EvidenceSignal {
  id: string;
  confidence: number;
  documentId?: string;
}

export interface EvidenceGateCalibration {
  minEvidenceCount: number;
  minTopConfidence: number;
  supportingConfidence: number;
  minSupportingEvidence: number;
  minAggregateConfidence: number;
  aggregationWindow: number;
  minDistinctDocuments: number;
}

export interface EvidenceGateMetrics {
  evidenceCount: number;
  discardedEvidenceCount: number;
  topConfidence: number;
  meanConfidence: number;
  aggregateConfidence: number;
  supportingEvidenceCount: number;
  distinctDocumentCount: number;
}

export type EvidenceGateReason =
  | 'no-valid-evidence'
  | 'insufficient-evidence'
  | 'weak-top-evidence'
  | 'insufficient-support'
  | 'weak-aggregate-evidence'
  | 'insufficient-document-diversity';

export interface EvidenceGateDecision {
  answerable: boolean;
  reasons: readonly EvidenceGateReason[];
  metrics: EvidenceGateMetrics;
  evidence: readonly EvidenceSignal[];
}

export const DEFAULT_EVIDENCE_GATE_CALIBRATION: Readonly<EvidenceGateCalibration> =
  Object.freeze({
    minEvidenceCount: 1,
    minTopConfidence: 0.55,
    supportingConfidence: 0.45,
    minSupportingEvidence: 1,
    minAggregateConfidence: 0.5,
    aggregationWindow: 3,
    minDistinctDocuments: 1,
  });

@Injectable()
export class EvidenceGateService {
  evaluate(
    evidence: readonly EvidenceSignal[],
    calibrationOverrides: Partial<EvidenceGateCalibration> = {},
  ): EvidenceGateDecision {
    const calibration = {
      ...DEFAULT_EVIDENCE_GATE_CALIBRATION,
      ...calibrationOverrides,
    };
    validateCalibration(calibration);

    const normalized = normalizeEvidence(evidence);
    const window = normalized.slice(0, calibration.aggregationWindow);
    const topConfidence = window[0]?.confidence ?? 0;
    const meanConfidence =
      window.length === 0
        ? 0
        : window.reduce((total, item) => total + item.confidence, 0) /
          window.length;
    const aggregateConfidence =
      window.length === 0 ? 0 : topConfidence * 0.65 + meanConfidence * 0.35;
    const supportingEvidenceCount = normalized.filter(
      item => item.confidence >= calibration.supportingConfidence,
    ).length;
    const distinctDocumentCount = new Set(
      normalized.map(item => item.documentId || item.id),
    ).size;
    const reasons: EvidenceGateReason[] = [];

    if (normalized.length === 0) reasons.push('no-valid-evidence');
    if (normalized.length < calibration.minEvidenceCount) {
      reasons.push('insufficient-evidence');
    }
    if (topConfidence < calibration.minTopConfidence) {
      reasons.push('weak-top-evidence');
    }
    if (supportingEvidenceCount < calibration.minSupportingEvidence) {
      reasons.push('insufficient-support');
    }
    if (aggregateConfidence < calibration.minAggregateConfidence) {
      reasons.push('weak-aggregate-evidence');
    }
    if (distinctDocumentCount < calibration.minDistinctDocuments) {
      reasons.push('insufficient-document-diversity');
    }

    return {
      answerable: reasons.length === 0,
      reasons,
      metrics: {
        evidenceCount: normalized.length,
        discardedEvidenceCount: evidence.length - normalized.length,
        topConfidence,
        meanConfidence,
        aggregateConfidence,
        supportingEvidenceCount,
        distinctDocumentCount,
      },
      evidence: normalized,
    };
  }
}

function normalizeEvidence(
  evidence: readonly EvidenceSignal[],
): EvidenceSignal[] {
  const byId = new Map<string, EvidenceSignal>();

  for (const item of evidence) {
    const id = item.id.trim();
    if (
      !id ||
      !Number.isFinite(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 1
    ) {
      continue;
    }

    const normalized = {
      id,
      confidence: item.confidence,
      documentId: item.documentId?.trim() || undefined,
    };
    const existing = byId.get(id);
    if (!existing || normalized.confidence > existing.confidence) {
      byId.set(id, normalized);
    }
  }

  return [...byId.values()].sort(
    (left, right) =>
      right.confidence - left.confidence || compareText(left.id, right.id),
  );
}

function validateCalibration(calibration: EvidenceGateCalibration): void {
  validateInteger('minEvidenceCount', calibration.minEvidenceCount, 0);
  validateConfidence('minTopConfidence', calibration.minTopConfidence);
  validateConfidence('supportingConfidence', calibration.supportingConfidence);
  validateInteger(
    'minSupportingEvidence',
    calibration.minSupportingEvidence,
    0,
  );
  validateConfidence(
    'minAggregateConfidence',
    calibration.minAggregateConfidence,
  );
  validateInteger('aggregationWindow', calibration.aggregationWindow, 1);
  validateInteger(
    'minDistinctDocuments',
    calibration.minDistinctDocuments,
    0,
  );
}

function validateConfidence(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
}

function validateInteger(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
