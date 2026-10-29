import { vi } from 'vitest';
import { PLATFORM_PERMISSIONS } from '@tmanage/domain';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../../common/database/tenant-context.js';
import type { CustomRoleRow } from '../../../common/database/schema.js';
import type { AuditService } from '../../audit/audit.service.js';
import type { RoleEditRepository } from '../../admin/role-edit.repository.js';
import type { MembershipsRepository } from '../../tenancy/memberships.repository.js';
import type { MembershipOverridesRepository } from '../../tenancy/membership-overrides.repository.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAuditService } from '../platform-audit.service.js';
import type { MemberIdentity, PlatformPermissionsRepository } from './permissions.repository.js';
import { PlatformPermissionsService } from './permissions.service.js';

/** Unit-test doubles for the PA-04 service (no database; the DB file proves the SQL). */

export const ORG = '0199aa00-0000-7000-8000-00000000000a';
export const ADMIN = '0199aa00-0000-7000-8000-0000000000a1';
export const ROLE = '0199aa00-0000-7000-8000-0000000000c1';
export const OTHER_ROLE = '0199aa00-0000-7000-8000-0000000000c2';
export const MEMBER = '0199aa00-0000-7000-8000-0000000000d1';
export const request = {
  correlationId: '0199aa00-0000-7000-8000-0000000000cc',
  ip: '203.0.113.1',
  userAgent: 'Edge',
};

export const actor: PlatformAdminActor = {
  account: {
    userId: ADMIN,
    email: 'peter@tmanage.test',
    displayName: 'Peter',
    emailVerified: true,
    mfaEnabled: true,
  },
  sessionId: 's',
  stepUp: null,
  source: 'env',
  preset: 'super_admin',
  permissions: [...PLATFORM_PERMISSIONS],
};

export function roleRow(id: string, name: string, capabilities: readonly string[]): CustomRoleRow {
  return {
    id,
    organizationId: ORG,
    name,
    capabilitiesJson: JSON.stringify(capabilities),
    createdBy: ADMIN,
    createdAt: new Date('2026-10-01T00:00:00Z'),
  };
}

export function member(overrides: Partial<MemberIdentity> = {}): MemberIdentity {
  return {
    id: MEMBER,
    userId: '0199aa00-0000-7000-8000-0000000000e1',
    role: 'member',
    status: 'active',
    displayName: 'Mona Samir',
    email: 'mona@nile.test',
    hasOrgWideScope: false,
    workspaceScopeId: null,
    kind: 'internal',
    clientOrganizationId: null,
    ...overrides,
  };
}

export function harness(options: {
  roles?: CustomRoleRow[];
  member?: MemberIdentity;
  holders?: { id: string; userId: string; version: number }[];
}) {
  const runner = {} as TenantQueryRunner;
  const database = {
    read: vi.fn((_context: TenantContext, fn: (r: TenantQueryRunner) => unknown) => fn(runner)),
    transaction: vi.fn((_context: TenantContext, fn: (r: TenantQueryRunner) => unknown) =>
      fn(runner),
    ),
  } as unknown as TenantDatabase;
  const roles = options.roles ?? [];
  const roleRepo = {
    findById: vi.fn(async (_r: unknown, _c: unknown, id: string) => roles.find((r) => r.id === id)),
    findByName: vi.fn(async (_r: unknown, _c: unknown, name: string) =>
      roles.find((r) => r.name === name),
    ),
    insert: vi.fn(
      async (
        _r: unknown,
        _c: unknown,
        input: { name: string; capabilities: readonly string[]; createdBy: string },
      ) => roleRow('0199aa00-0000-7000-8000-0000000000c9', input.name, input.capabilities),
    ),
    update: vi.fn(
      async (
        _r: unknown,
        _c: unknown,
        input: { id: string; name: string; capabilities: string[] },
      ) => roleRow(input.id, input.name, input.capabilities),
    ),
  };
  const repository = {
    organization: vi.fn(async () => ({ id: ORG, name: 'Nile Studio', slug: 'nile' })),
    customRoles: vi.fn(async () => roles),
    internalHolders: vi.fn(async () => new Map([[ROLE, 6]])),
    clientHolders: vi.fn(async () => new Map()),
    holdersOf: vi.fn(async () => options.holders ?? []),
    retireRole: vi.fn(async () => undefined),
    member: vi.fn(async () => options.member),
    userNames: vi.fn(async () => new Map([[ADMIN, 'Peter']])),
    projectOptions: vi.fn(async () => []),
  };
  const overrides = {
    list: vi.fn(async () => []),
    liveOverrides: vi.fn(async () => ({ allow: [], deny: [] })),
    projectIdsOf: vi.fn(async () => []),
    replace: vi.fn(async (_t: unknown, _c: unknown, _m: string, next: readonly unknown[]) => ({
      added: next,
      revoked: [],
    })),
  };
  const memberships = { changeRole: vi.fn(async () => ({})) };
  const audit = { record: vi.fn(async () => ({})) };
  const platformAudit = {
    build: vi.fn((input: { action: string }) => ({ action: input.action })),
    insert: vi.fn(async () => undefined),
  };
  const service = new PlatformPermissionsService(
    database,
    platformAudit as unknown as PlatformAuditService,
    audit as unknown as AuditService,
    repository as unknown as PlatformPermissionsRepository,
    roleRepo as unknown as RoleEditRepository,
    overrides as unknown as MembershipOverridesRepository,
    memberships as unknown as MembershipsRepository,
  );
  return { service, database, roleRepo, repository, overrides, memberships, audit, platformAudit };
}
