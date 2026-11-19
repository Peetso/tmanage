import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/http/errors.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';
import { isPlatformAuditAction } from '../platform-audit-actions.js';
import type { StoredSetting } from './settings.repository.js';
import { UNIT_COSTS_SETTING, parseStoredUnitCosts } from './unit-costs.js';
import { UnitCostsService, type UnitCostsStore } from './unit-costs.service.js';

/** 62-A3 (B14): the platform's monthly unit costs — unset is "not set", never 0. */

const ctx = { correlationId: 'c', ip: '203.0.113.9', userAgent: 'Firefox' };
const actor: PlatformAdminActor = {
  account: {
    userId: 'u',
    email: 'peter@example.com',
    displayName: 'Peter',
    emailVerified: true,
    mfaEnabled: true,
  },
  sessionId: 's',
  stepUp: null,
};

function harness() {
  const rows = new Map<string, StoredSetting>();
  const audits: PlatformAuditInput[] = [];
  const store: UnitCostsStore = {
    readAll: async () => rows,
    writeMany: async (entries, audit) => {
      for (const [key, value] of entries) {
        rows.set(key, { value, updatedAt: new Date('2026-11-19T10:00:00Z'), updatedBy: 'Peter' });
      }
      audits.push(audit);
    },
  };
  return { rows, audits, service: new UnitCostsService(store) };
}

describe('unit costs', () => {
  it('reads as not set (null, never 0) until a platform admin enters them', async () => {
    const { service } = harness();
    expect(await service.read(ctx)).toEqual({ costs: null, updatedAt: null, updatedBy: null });
  });

  it('stores both monthly lines with one audit row, and 0 only when typed', async () => {
    const { service, audits, rows } = harness();
    const view = await service.set(
      actor,
      { hostingCentsPerMonth: 2999, mailCentsPerMonth: 0 },
      ctx,
    );
    expect(view.costs).toEqual({ hostingCentsPerMonth: 2999, mailCentsPerMonth: 0 });
    expect(rows.get(UNIT_COSTS_SETTING)?.value).toBe(
      '{"hostingCentsPerMonth":2999,"mailCentsPerMonth":0}',
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'platform.unit_costs_updated',
      beforeJson: 'null',
      afterJson: '{"hostingCentsPerMonth":2999,"mailCentsPerMonth":0}',
    });
    expect(isPlatformAuditAction('platform.unit_costs_updated')).toBe(true);
  });

  it('refuses a missing, fractional, negative or huge line', async () => {
    const { service, audits } = harness();
    for (const body of [
      null,
      { hostingCentsPerMonth: 100 },
      { hostingCentsPerMonth: 1.5, mailCentsPerMonth: 0 },
      { hostingCentsPerMonth: -1, mailCentsPerMonth: 0 },
      { hostingCentsPerMonth: 10_000_001, mailCentsPerMonth: 0 },
      { hostingCentsPerMonth: '100', mailCentsPerMonth: 0 },
    ]) {
      await expect(service.set(actor, body, ctx)).rejects.toBeInstanceOf(ApiError);
    }
    expect(audits).toHaveLength(0);
  });

  it('treats an unreadable stored value as not set rather than zero', () => {
    for (const stored of [null, '', 'oops', '{}', '{"hostingCentsPerMonth":1}', '[1,2]']) {
      expect(parseStoredUnitCosts(stored)).toBeNull();
    }
  });
});
