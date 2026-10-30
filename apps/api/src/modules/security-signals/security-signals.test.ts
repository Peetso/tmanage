import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { SecuritySignalsService } from './security-signals.service.js';
import type * as Repo from './security-signals.repository.js';

const ORG = '0190a000-0000-7000-8000-000000000001';
const AT = new Date('2026-10-31T12:00:00.000Z');
const row: Repo.SignalRecord = {
  ...{ id: '0190a000-0000-7000-8000-0000000000aa', organizationId: ORG, ruleKey: 'mass_export' },
  ...{ severity: 'high', subjectType: 'user', subjectId: ORG, hasSource: true, count: 4 },
  ...{ windowStart: AT, firstSeen: AT, lastSeen: AT, notifyStatus: 'sent' },
};
const rule: Repo.AlertRuleRecord = {
  ...{ ruleKey: 'mass_export', enabled: true, thresholdJson: '{"count":3,"windowMinutes":60}' },
  ...{ cooldownMinutes: 120, lastFiredAt: null, updatedAt: AT },
};
const audits: unknown[] = [];
const store: Repo.SecuritySignalsStore = {
  listForOrganization: (context) => Promise.resolve(context.organizationId === ORG ? [row] : []),
  listAll: () => Promise.resolve([row]),
  listRules: () => Promise.resolve([rule]),
  updateRuleAudited: (_key, change) => {
    const { next, audit } = change(rule);
    audits.push(audit);
    return Promise.resolve({ ...rule, ...next });
  },
};
const service = new SecuritySignalsService(store, () => AT);
const context = { organizationId: ORG, correlationId: 'c' } as unknown as TenantContext;
const owner = { role: 'owner', hasOrgWideScope: true } as unknown as Principal;
const actor = { account: { userId: ORG, email: 'a@x.test' } } as unknown as PlatformAdminActor;
const req = { correlationId: 'c', ip: null, userAgent: null };

describe('security signals service', () => {
  it('returns own-org events without a source hash, IP or detail JSON', async () => {
    const page = await service.organizationEvents(context, owner, {});
    expect(page.events).toHaveLength(1);
    const wire = JSON.stringify(page);
    expect(wire).not.toMatch(/source_?hash|"ip"|details/iu);
    expect(page.events[0]?.hasSource).toBe(true);
    const member = { role: 'member', hasOrgWideScope: false } as unknown as Principal;
    await expect(service.organizationEvents(context, member, {})).rejects.toMatchObject({
      status: 403,
    });
  });

  it('validates the threshold schema and audits a rule change', async () => {
    const bad = { enabled: true, threshold: { count: 0, windowMinutes: 60 } };
    await expect(service.updateRule(actor, 'mass_export', bad, req)).rejects.toMatchObject({
      status: 400,
    });
    const body = { enabled: false, threshold: { count: 5, windowMinutes: 30 } };
    const ok = await service.updateRule(actor, 'mass_export', body, req);
    expect(ok).toMatchObject({ ...body, cooldownMinutes: 120 });
    expect(audits[0]).toMatchObject({ action: 'platform.alert_rule_updated' });
  });

  it('refuses to enable the deferred impossible-travel rule', async () => {
    const body = { enabled: true, threshold: { count: 1, windowMinutes: 60 } };
    await expect(service.updateRule(actor, 'impossible_travel', body, req)).rejects.toMatchObject({
      status: 409,
    });
    const travel = (await service.rules(req)).find((r) => r.key === 'impossible_travel');
    expect(travel).toMatchObject({ status: 'deferred', enabled: false });
  });
});
