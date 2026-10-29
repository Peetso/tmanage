import { vi } from 'vitest';
import type { TenantContext, TenantQueryRunner } from '../../../common/database/tenant-context.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAdminRepository, PlatformAuditInput } from '../platform-admin.repository.js';
import type { RequestContext } from '../platform-admin.service.js';
import { platformOrgContext } from './organizations.repository.js';
import type { OrgRow, PlatformOrganizationsRepository } from './organizations.repository.js';
import { PlatformOrganizationsService } from './organizations.service.js';

/** PA-07 unit-test fakes: an in-memory organization row, a recording transaction, an actor. */

export const ORG = '0199aa00-0000-7000-8000-0000000000c1';
export const ADMIN = '0199aa00-0000-7000-8000-0000000000a1';
export const NOW = new Date('2026-10-28T10:00:00Z');
export const CONTEXT: RequestContext = {
  correlationId: '0199aa00-0000-7000-8000-0000000000f1',
  ip: '127.0.0.1',
  userAgent: 'test',
} as RequestContext;

export function actor(preset: PlatformAdminActor['preset'] = 'support'): PlatformAdminActor {
  return {
    account: {
      userId: ADMIN,
      email: 'nour.platform@tmanage.example',
      displayName: 'Nour',
      emailVerified: true,
      mfaEnabled: true,
    },
    sessionId: 's1',
    stepUp: null,
    source: 'db',
    preset,
    permissions: [],
  } as unknown as PlatformAdminActor;
}

export function orgRow(over: Partial<OrgRow> = {}): OrgRow {
  return {
    id: ORG,
    slug: 'northstar-studio',
    name: 'Northstar Studio',
    createdAt: new Date('2026-03-12T00:00:00Z'),
    defaultLocale: 'en',
    timezone: 'UTC',
    suspendedAt: null,
    archivedAt: null,
    deletedAt: null,
    purgeAfter: null,
    deletedByUserId: null,
    deletedByEmail: null,
    billingModeOverride: null,
    operatorNotes: null,
    ownerEmail: 'maya@northstar.example',
    people: 4,
    clients: 1,
    projects: 2,
    planId: 'studio',
    storageBytes: 10,
    peopleLimit: null,
    activeProjectsLimit: null,
    storageBytesLimit: null,
    failedRuns: 0,
    lastActiveAt: null,
    ...over,
  };
}

export interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export function fakeOrgs(initial: OrgRow = orgRow()) {
  let row: OrgRow | null = initial;
  const statements: Recorded[] = [];
  const audits: PlatformAuditInput[] = [];
  const settings = new Map<string, string>();
  const tx = {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      statements.push({ sql, params });
      return { affectedRows: 1 };
    }),
    execute: vi.fn(),
  } as unknown as TenantQueryRunner;
  const repo = {
    find: vi.fn(async () => row),
    list: vi.fn(async () => (row ? [row] : [])),
    statusCounts: vi.fn(async () => ({
      total: 1,
      active: 1,
      suspended: 0,
      deleted: 0,
      archived: 0,
      firstPurgeAt: null,
    })),
    openSupportSessions: vi.fn(async () => ({ open: 0, firstExpiry: null })),
    recentPlatformActions: vi.fn(async () => []),
    slugOwner: vi.fn(async (_slug: string) => null as string | null),
    readSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
    findUserByEmail: vi.fn(
      async () => null as { id: string; email: string; displayName: string } | null,
    ),
    subscription: vi.fn(async () => null),
    connections: vi.fn(async () => []),
    members: vi.fn(async () => ({ internal: [], clients: [], invitations: [] })),
    recordAudit: vi.fn(async (audit: PlatformAuditInput) => {
      audits.push(audit);
    }),
    write: vi.fn(
      async <T>(
        id: string,
        audit: PlatformAuditInput,
        work: (runner: TenantQueryRunner, context: TenantContext) => Promise<T>,
      ): Promise<T> => {
        const result = await work(tx, platformOrgContext(id, audit.correlationId));
        audits.push(audit);
        return result;
      },
    ),
  };
  return {
    repo: repo as unknown as PlatformOrganizationsRepository,
    raw: repo,
    tx,
    statements,
    audits,
    settings,
    setRow: (next: OrgRow | null) => {
      row = next;
    },
  };
}

export function serviceWith(fake: ReturnType<typeof fakeOrgs>) {
  const lookup = {
    overview: vi.fn(async () => ({
      companies: 1,
      suspendedCompanies: 0,
      people: 4,
      signups7d: 0,
      signups30d: 1,
      activeToday: 1,
      storageBytesUsed: 10,
      failedAutomationRuns7d: 0,
      outboxErrors: 0,
    })),
    searchPeople: vi.fn(async () => ({ people: [], memberships: [] })),
  } as unknown as PlatformAdminRepository;
  return new PlatformOrganizationsService(lookup, fake.repo, () => NOW);
}
