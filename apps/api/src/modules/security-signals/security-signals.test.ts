import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { SecuritySignalsService, toSignalView } from './security-signals.service.js';
import { signalRule } from './signal-rules.js';
import type * as Repo from './security-signals.repository.js';

const ORG = '0190a000-0000-7000-8000-000000000001';
const AT = new Date('2026-10-31T12:00:00.000Z');
const row: Repo.SignalRecord = {
  ...{ id: '0190a000-0000-7000-8000-0000000000aa', organizationId: ORG, ruleKey: 'mass_export' },
  ...{ severity: 'high', subjectType: 'user', subjectId: ORG, hasSource: true, count: 4 },
  ...{ windowStart: AT, firstSeen: AT, lastSeen: AT, notifyStatus: 'sent', reviewedAt: null },
};
const rule: Repo.AlertRuleRecord = {
  ...{ ruleKey: 'mass_export', enabled: true, thresholdJson: '{"count":3,"windowMinutes":60}' },
  ...{ cooldownMinutes: 120, lastFiredAt: null, updatedAt: AT },
};
const audits: unknown[] = [];
const filters: Repo.SignalFilter[] = [];
const store: Repo.SecuritySignalsStore = {
  listForOrganization: (context, filter) => {
    filters.push(filter);
    return Promise.resolve(context.organizationId === ORG ? [row] : []);
  },
  markReviewed: (context, id, at) =>
    Promise.resolve(
      context.organizationId === ORG && id === row.id ? { ...row, reviewedAt: at } : null,
    ),
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

  it('lists the four 56-21b platform rules and enables failed step-ups', async () => {
    const keys = ['support_sessions_burst', 'platform_access_off_hours'];
    keys.push('platform_step_up_failures', 'support_session_new_country');
    const listed = (await service.rules(req)).filter((r) => keys.includes(r.key));
    expect(listed.map((r) => r.scope)).toEqual(['platform', 'platform', 'platform', 'platform']);
    expect(listed.every((r) => r.label.ar !== '' && r.label.en !== '')).toBe(true);
    const body = { enabled: true, threshold: { count: 3, windowMinutes: 30 } };
    const saved = await service.updateRule(actor, 'platform_step_up_failures', body, req);
    expect(saved).toMatchObject({ enabled: true });
  });

  it('labels the R22-b e-invoice chain break rule in EN and AR', async () => {
    const chain = signalRule('einvoice_chain_break');
    expect(chain).toMatchObject({ severity: 'high', scope: 'organization', status: 'active' });
    expect(chain?.label.en).not.toBe('');
    expect(chain?.label.ar).toMatch(/^[^A-Za-z]+$/u);
    expect((await service.rules(req)).some((r) => r.key === 'einvoice_chain_break')).toBe(true);
    const view = toSignalView({ ...row, ruleKey: 'einvoice_chain_break' });
    expect(view.label.en).toBe(chain?.label.en);
  });

  it('R44 L2: an owner marks an own signal reviewed; others get 403 / 404', async () => {
    const saved = await service.markReviewed(context, owner, row.id);
    expect(saved.reviewedAt).toBe(AT.toISOString());
    const other = '0190a000-0000-7000-8000-0000000000bb';
    await expect(service.markReviewed(context, owner, other)).rejects.toMatchObject({
      status: 404,
    });
    const admin = { role: 'member', hasOrgWideScope: true } as unknown as Principal;
    await expect(service.markReviewed(context, admin, row.id)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('R44 L2: filters on reviewed=true|false and refuses any other value', async () => {
    await service.organizationEvents(context, owner, { reviewed: 'false' });
    expect(filters.at(-1)).toMatchObject({ reviewed: false });
    await expect(
      service.organizationEvents(context, owner, { reviewed: 'yes' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
