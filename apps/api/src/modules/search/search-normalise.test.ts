import { describe, expect, it } from 'vitest';
import { analyzeStatement } from '../../common/database/tenant-guard.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type { TenantQueryRunner } from '../../common/database/tenant-context.js';
import { ARABIC_FOLDS, hasArabic, normaliseArabic } from './search-normalise.js';
import { SearchIndexRepository } from './search-index.repository.js';

/** 53-17 — the Arabic fold runs on the query and, as nested REPLACE, on the stored text. */
describe('Arabic search normalisation', () => {
  it('folds alef/hamza, taa marbuta, ya forms, diacritics and tatweel onto one spelling', () => {
    expect(normaliseArabic('أحمد')).toBe(normaliseArabic('احمد'));
    expect(normaliseArabic('إسلام')).toBe('اسلام');
    expect(normaliseArabic('آمال')).toBe('امال');
    expect(normaliseArabic('فاتورة')).toBe('فاتوره');
    expect(normaliseArabic('مستشفى')).toBe('مستشفي');
    expect(normaliseArabic('مسؤول')).toBe('مسوول');
    expect(normaliseArabic('مُحَمَّد')).toBe('محمد');
    expect(normaliseArabic('مـــشـروع')).toBe('مشروع');
    expect(normaliseArabic('Invoice 2026_01')).toBe('Invoice 2026_01');
    expect(hasArabic('Invoice')).toBe(false);
  });

  it('folds the stored column with the same table only for an Arabic query, and passes the guard', async () => {
    const org = '01900000-0000-7000-8000-000000000001';
    const context = createTenantContext({
      organizationId: org,
      userId: '01900000-0000-7000-8000-000000000002',
      principalKind: 'internal',
      membershipId: '01900000-0000-7000-8000-000000000003',
      capabilities: [],
      policyVersion: 'test',
      correlationId: '01900000-0000-7000-8000-000000000004',
    });
    const captured: { sql: string; params: readonly unknown[] }[] = [];
    const respond = ((statement: string, params: readonly unknown[]) => {
      captured.push({ sql: statement, params });
      return Promise.resolve([]);
    }) as unknown as TenantQueryRunner['query'];
    const runner = { query: respond, execute: respond } as unknown as TenantQueryRunner;
    const repository = new SearchIndexRepository();

    await repository.searchRanked(runner, context, {
      query: 'فاتورة',
      limit: 5,
      kinds: ['document'],
    });
    await repository.searchRanked(runner, context, {
      query: 'brief',
      limit: 5,
      kinds: ['document'],
    });
    const [arabic, latin] = captured;
    // Two folded columns (title, body), each with the whole fold table.
    expect(arabic?.sql.match(/REPLACE\(/gi)).toHaveLength(2 * ARABIC_FOLDS.length);
    expect(arabic?.params).toContain('%فاتوره%');
    expect(analyzeStatement(arabic?.sql ?? '', arabic?.params ?? [], org).violations).toEqual([]);
    expect(latin?.sql).not.toMatch(/REPLACE\(/i);
    expect(latin?.params).toContain('%brief%');
  });
});
