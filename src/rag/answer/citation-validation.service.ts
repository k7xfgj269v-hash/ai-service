import { Injectable } from '@nestjs/common';

export interface CitationValidationOptions {
  requireAtLeastOne?: boolean;
  maxCitations?: number;
}

export interface CitationValidationResult {
  valid: boolean;
  citationIds: readonly string[];
  invalidIds: readonly string[];
  duplicateIds: readonly string[];
  missing: boolean;
  exceedsLimit: boolean;
}

export class CitationValidationError extends Error {
  constructor(readonly result: CitationValidationResult) {
    super(formatValidationError(result));
    this.name = 'CitationValidationError';
  }
}

@Injectable()
export class CitationValidationService {
  validate(
    citationIds: readonly string[],
    allowedCitationIds: Iterable<string>,
    options: CitationValidationOptions = {},
  ): CitationValidationResult {
    const requireAtLeastOne = options.requireAtLeastOne ?? true;
    const maxCitations = options.maxCitations ?? 32;
    if (!Number.isInteger(maxCitations) || maxCitations < 0) {
      throw new Error('maxCitations must be a non-negative integer');
    }

    const allowed = normalizeAllowedIds(allowedCitationIds);
    const validIds: string[] = [];
    const invalidIds: string[] = [];
    const duplicateIds: string[] = [];
    const seen = new Set<string>();

    for (const rawId of citationIds) {
      const id = typeof rawId === 'string' ? rawId.trim() : '';
      if (!id || !allowed.has(id)) {
        pushUnique(invalidIds, id || String(rawId));
        continue;
      }
      if (seen.has(id)) {
        pushUnique(duplicateIds, id);
        continue;
      }
      seen.add(id);
      validIds.push(id);
    }

    const missing = requireAtLeastOne && validIds.length === 0;
    const exceedsLimit = validIds.length > maxCitations;
    const valid = invalidIds.length === 0 && !missing && !exceedsLimit;

    return {
      valid,
      citationIds: exceedsLimit
        ? validIds.slice(0, maxCitations)
        : validIds,
      invalidIds,
      duplicateIds,
      missing,
      exceedsLimit,
    };
  }

  assertValid(
    citationIds: readonly string[],
    allowedCitationIds: Iterable<string>,
    options: CitationValidationOptions = {},
  ): readonly string[] {
    const result = this.validate(citationIds, allowedCitationIds, options);
    if (!result.valid) {
      throw new CitationValidationError(result);
    }
    return result.citationIds;
  }
}

function normalizeAllowedIds(ids: Iterable<string>): Set<string> {
  const normalized = new Set<string>();
  for (const rawId of ids) {
    if (typeof rawId !== 'string') continue;
    const id = rawId.trim();
    if (id) normalized.add(id);
  }
  return normalized;
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function formatValidationError(result: CitationValidationResult): string {
  const reasons: string[] = [];
  if (result.missing) reasons.push('at least one valid citation is required');
  if (result.invalidIds.length > 0) {
    reasons.push(`unknown citation IDs: ${result.invalidIds.join(', ')}`);
  }
  if (result.exceedsLimit) reasons.push('citation limit exceeded');
  return `Citation validation failed: ${reasons.join('; ')}`;
}
