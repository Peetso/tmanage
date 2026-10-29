import { describe, expect, it } from 'vitest';
import {
  analyzeStatement,
  isNonTenantTable,
  tenantTablesMentioned,
} from '../../common/database/tenant-guard.js';
import {
  ADMIN_SECURITY_ACTION_PREFIXES,
  PLATFORM_METADATA_TABLES,
  SQL,
} from './platform-admin.repository.js';

/** Cross-tenant reads are limited to metadata — proved on the statements with the real guard. */

const ORG = '0199aa00-0000-7000-8000-0000000000c1';
const OTHER = '0199aa00-0000-7000-8000-00000000ffff';
const CROSS = [
  SQL.overview,
  SQL.listCompanies,
  SQL.company,
  SQL.people,
  SQL.internalMemberships(2),
  SQL.clientMemberships(2),
];
const IDENTITY = [
  SQL.account,
  SQL.liveStepUp,
  SQL.insertStepUp,
  SQL.insertAudit,
  SQL.listAudit,
  SQL.revokeSessions,
  SQL.writeSetting,
];
const AUDIT = SQL.companyAudit(ADMIN_SECURITY_ACTION_PREFIXES.length);
const AUDIT_PARAMS = ADMIN_SECURITY_ACTION_PREFIXES.map((p) => `${p}%`);

describe('platform admin statements', () => {
  it('reach across companies only through metadata tables, never content', () => {
    const allowed = new Set<string>(PLATFORM_METADATA_TABLES);
    for (const sql of CROSS)
      for (const t of tenantTablesMentioned(sql)) expect(allowed.has(t), t).toBe(true);
    const all = [...CROSS, ...IDENTITY, AUDIT].join('\n');
    for (const t of [
      'work_items',
      'messages',
      'documents',
      'file_assets',
      'client_requests',
      'metadata_json',
    ]) {
      expect(all).not.toMatch(new RegExp(`\\b${t}\\b`, 'u'));
    }
  });

  it('keep identity statements on global tables', () => {
    for (const sql of IDENTITY) expect(tenantTablesMentioned(sql)).toEqual([]);
    for (const t of [
      'platform_admin_step_ups',
      'platform_admin_audit_events',
      'platform_settings',
    ]) {
      expect(isNonTenantTable(t)).toBe(true);
    }
  });

  it('scope one company’s audit read and its suspension to that company alone', () => {
    expect(analyzeStatement(AUDIT, [ORG, ...AUDIT_PARAMS, 25], ORG).violations).toEqual([]);
    expect(analyzeStatement(AUDIT, [OTHER, ...AUDIT_PARAMS, 25], ORG).violations).not.toEqual([]);
    expect(analyzeStatement(SQL.setSuspended(true), [ORG], ORG).violations).toEqual([]);
    expect(analyzeStatement(SQL.setSuspended(true), [OTHER], ORG).violations).not.toEqual([]);
  });
});

// ---- platform-admin v2 · PA-09 ----
describe('PLATFORM_METADATA_TABLES (SPEC P2)', () => {
  it('is exactly the metadata allowlist: no content table, no before/after values', () => {
    expect([...PLATFORM_METADATA_TABLES].sort()).toEqual(
      [
        'organizations',
        'memberships',
        'client_memberships',
        'client_organizations',
        'projects',
        'subscriptions',
        'usage_counters',
        'workflow_runs',
        'outbox_events',
        'organization_limits',
        'audit_events',
        'custom_roles',
        'org_feature_flags',
        'project_memberships',
        'member_profiles',
      ].sort(),
    );
    // The C2 detail opens ONE organization through the tenant path; the change values never
    // join a cross-organization read.
    expect(PLATFORM_METADATA_TABLES).not.toContain('audit_event_changes');
  });
});
