import { describe, expect, it } from 'vitest';
import { analyzeStatement, tenantTablesMentioned } from '../../../common/database/tenant-guard.js';
import { PLATFORM_METADATA_TABLES } from '../platform-admin.repository.js';
import { ORG_SQL } from './organizations.repository.js';
import { listFilters } from './organizations.service.js';

/** PA-07: cross-org reads stay on metadata; one-org statements bind to that org alone. */

const ORG = '0199aa00-0000-7000-8000-0000000000c1';
const OTHER = '0199aa00-0000-7000-8000-00000000ffff';
const AT = new Date('2026-10-28T10:00:00Z');

const full = ORG_SQL.list(
  listFilters({
    q: 'north',
    status: 'active',
    plan: 'studio',
    createdFrom: AT,
    createdTo: AT,
    activeFrom: AT,
    activeTo: AT,
    cursor: { createdAt: AT, id: ORG },
  }),
);

const CROSS = [
  ORG_SQL.list(listFilters({})).sql,
  full.sql,
  ORG_SQL.statusCounts,
  ORG_SQL.one,
  ORG_SQL.deleted,
  ORG_SQL.search,
  ORG_SQL.slugOwner,
];
const IDENTITY = [
  ORG_SQL.userByEmail,
  ORG_SQL.readSetting,
  ORG_SQL.openSupportSessions,
  ORG_SQL.orgSupportSessions,
  ORG_SQL.platformAuditForOrg,
  ORG_SQL.recentPlatformActions,
];

/** Each one-org statement with the parameters the repository binds, the org first where it leads. */
const TENANT: readonly (readonly [string, string, (org: string) => unknown[]])[] = [
  ['orgAudit', ORG_SQL.orgAudit, (org) => [org, 10]],
  ['invitedCount', ORG_SQL.invitedCount, (org) => [org]],
  ['openApprovalsCount', ORG_SQL.openApprovalsCount, (org) => [org]],
  ['failedRunsCount', ORG_SQL.failedRunsCount, (org) => [org, AT]],
  ['overrideCounts', ORG_SQL.overrideCounts, (org) => [org]],
  ['connections', ORG_SQL.connections, (org) => [org]],
  ['disconnect', ORG_SQL.disconnect, (org) => [org, ORG]],
  ['storageSum', ORG_SQL.storageSum, (org) => [org]],
  ['storageCounterUpdate', ORG_SQL.storageCounterUpdate, (org) => [5, org]],
  ['storageCounterInsert', ORG_SQL.storageCounterInsert, (org) => [ORG, org, 5]],
  ['subscription', ORG_SQL.subscription, (org) => [org]],
  ['updatePlan', ORG_SQL.updatePlan, (org) => ['studio', org]],
  ['insertSubscription', ORG_SQL.insertSubscription, (org) => [ORG, org, 'studio']],
  ['updateBillingOverride', ORG_SQL.updateBillingOverride, (org) => ['paid', org]],
  ['upsertLimits', ORG_SQL.upsertLimits, (org) => [ORG, org, 1, 2, 3, ORG]],
  ['updateProfile', ORG_SQL.updateProfile, (org) => ['N', 'n', 'en', 'UTC', null, org]],
  ['members', ORG_SQL.members, (org) => [org, 500]],
  ['clientMembers', ORG_SQL.clientMembers, (org) => [org, 500]],
  ['invitations', ORG_SQL.invitations, (org) => [org]],
  ['insertMembership', ORG_SQL.insertMembership, (org) => [ORG, org, ORG, 'member', true]],
  ['softDelete', ORG_SQL.softDelete, (org) => [30, ORG, org]],
  ['restore', ORG_SQL.restore, (org) => [org]],
  ['purgeNow', ORG_SQL.purgeNow, (org) => [org]],
  ['archive', ORG_SQL.archive, (org) => [org]],
  ['unarchive', ORG_SQL.unarchive, (org) => [org, org]],
  ['policyRefresh', ORG_SQL.policyRefresh, (org) => [org]],
];

describe('platform organizations statements', () => {
  it('reach across organizations only through the metadata tables', () => {
    const allowed = new Set<string>(PLATFORM_METADATA_TABLES);
    for (const sql of CROSS) {
      for (const table of tenantTablesMentioned(sql)) expect(allowed.has(table), table).toBe(true);
    }
    const all = [...CROSS, ...IDENTITY].join('\n');
    for (const table of ['work_items', 'messages', 'documents', 'file_assets', 'metadata_json']) {
      expect(all).not.toMatch(new RegExp(`\\b${table}\\b`, 'u'));
    }
  });

  it('keep the identity statements on global tables', () => {
    for (const sql of IDENTITY) expect(tenantTablesMentioned(sql)).toEqual([]);
  });

  it.each(TENANT)('%s is bound to the one organization', (_name, sql, params) => {
    expect(analyzeStatement(sql, params(ORG) as never, ORG).violations).toEqual([]);
    expect(analyzeStatement(sql, params(OTHER) as never, ORG).violations).not.toEqual([]);
  });

  it('binds every list filter as a parameter, never into the text', () => {
    expect(full.sql).not.toContain('north');
    expect(full.params).toContain('studio');
    expect(full.params[full.params.length - 1]).toBe(50);
  });
});
