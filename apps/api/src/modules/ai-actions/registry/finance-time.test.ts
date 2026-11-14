import { describe, expect, it } from 'vitest';
import { AI_SCOPES, RISK_CLASSES, neverByKey, opsById, routeKey } from './index.js';
import { REDACT_PROFILES } from './detail.js';
import { waveCDetails, waveCDetailsById } from './wave-c.js';
import {
  FINANCE_TIME_WRITE_ALLOWLIST,
  financeTimeDetails,
  financeTimeOps,
  redactFinanceResult,
} from './finance-time.js';

/**
 * R18-b (52-22). The 52 time/finance routes left NEVER for classified ops: each one is a live op
 * with a legal risk/scope pair and a `finance`-redacted detail; non-read ops outside the everyday
 * write allowlist are confirm-class under manage; settings and period locks stay NEVER; and the
 * `finance` redaction drops cost/margin keys for a member without `finance.manage`. The full
 * route census stays in `registry-sync.test.ts` (the contract test).
 */
describe('R18-b finance and time ops', () => {
  it('registers every moved route once, out of NEVER, with a legal risk/scope pair', () => {
    expect(financeTimeOps).toHaveLength(54);
    for (const op of financeTimeOps) {
      expect(opsById.get(op.id), op.id).toBe(op);
      expect(neverByKey.has(routeKey(op.method, op.path)), op.id).toBe(false);
      expect(RISK_CLASSES, op.id).toContain(op.risk);
      expect(AI_SCOPES, op.id).toContain(op.scope);
      if (op.risk === 'read') expect(op.method, op.id).toBe('GET');
      if (op.risk === 'confirm') expect(op.scope, op.id).toBe('manage');
    }
  });

  it('holds every non-read op outside the write allowlist for approval', () => {
    for (const op of financeTimeOps) {
      if (op.method === 'GET' && !op.path.endsWith('.csv')) continue;
      const expected = FINANCE_TIME_WRITE_ALLOWLIST.includes(op.id) ? 'write' : 'confirm';
      expect(op.risk, op.id).toBe(expected);
    }
  });

  it('keeps finance settings and period locks in NEVER', () => {
    for (const [method, path] of [
      ['GET', '/v1/organizations/:orgSlug/finance/profile'],
      ['POST', '/v1/organizations/:orgSlug/finance/tax-rates'],
      ['POST', '/v1/organizations/:orgSlug/finance/exchange-rates'],
      ['POST', '/v1/organizations/:orgSlug/time/locks/'],
    ] as const) {
      expect(neverByKey.has(routeKey(method, path)), `${method} ${path}`).toBe(true);
    }
  });

  it('gives each op one strict, finance-redacted, bilingual detail whose examples parse', () => {
    expect(financeTimeDetails.map((d) => d.id).sort()).toEqual(
      financeTimeOps.map((o) => o.id).sort(),
    );
    expect(waveCDetailsById.size).toBe(waveCDetails.length);
    for (const d of financeTimeDetails) {
      expect(REDACT_PROFILES, d.id).toContain(d.redact);
      expect(d.redact, d.id).toBe('finance');
      expect(d.descriptionAr?.length ?? 0, d.id).toBeGreaterThan(0);
      expect(d.examples.length, d.id).toBe(2);
      for (const e of d.examples) expect(d.input.safeParse(e.args).success, d.id).toBe(true);
      expect(d.input.safeParse({ ...d.examples[0]!.args, orgSlug: 'x' }).success, d.id).toBe(false);
    }
  });

  it('refuses out-of-range minutes and a client-visible AI-created retainer', () => {
    const upsert = waveCDetailsById.get('time.timesheets.entries.upsert')!;
    const line = { spentOn: '2026-11-01', minutes: 1441 };
    expect(upsert.input.safeParse({ timesheetId: 't', version: 1, entries: [line] }).success).toBe(
      false,
    );
    const create = waveCDetailsById.get('finance.retainers.create')!;
    const args = { clientOrganizationId: 'c', name: 'R', startsOn: '2026-12-01' };
    expect(create.input.safeParse({ ...args, clientVisible: true }).success).toBe(false);
    expect(create.input.safeParse({ ...args, clientVisible: false }).success).toBe(true);
  });

  it('strips cost, margin and bank keys without finance.manage and keeps them with it', () => {
    const report = {
      rows: [{ project: 'Acme', revenueMinor: 900, costMinor: 400, marginBp: 5555 }],
      entry: { minutes: 60, costSnapshotMinor: 3000, bank_details_text: 'IBAN' },
    };
    expect(redactFinanceResult(report, false)).toEqual({
      rows: [{ project: 'Acme', revenueMinor: 900 }],
      entry: { minutes: 60 },
    });
    expect(redactFinanceResult(report, true)).toEqual(report);
  });
});
