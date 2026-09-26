import { describe, expect, it } from 'vitest';
import type { Principal, Role } from '@tmanage/domain';
import { AuditService } from './audit.service.js';
import type { AuditEventsRepository, ListAuditEventsOptions } from './audit-events.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditEventRow } from '../../common/database/schema.js';

/**
 * ADM audit viewer (x115). `AuditService.listForViewer` — the paginated, tenant-scoped read the
 * Administration audit screen consumes, behind `audit.read`.
 *
 * Database-free proofs over fakes with the **real** authorize: the capability gate and the
 * own-activity narrowing are `AuditService.view`'s real code (`hasCapability`, the scope
 * overwrite), not stubbed. The fake repository reimplements exactly the SQL semantics the real
 * `list` is DB-proven to have — the tenant predicate `AND`ed with the optional equality filters,
 * ordered by id descending, cursored by `before`, capped by `limit` — so a cross-tenant row a
 * fake returns unscoped would still be dropped here only if the service passed the caller's own
 * context, which is the property under test.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const ACTOR = 'user-0000-0000-0000-0000-0000000000aa';
const OTHER_ACTOR = 'user-0000-0000-0000-0000-0000000000bb';

const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

function principal(role: Role, overrides: Partial<Principal> = {}): Principal {
  return {
    userId: ACTOR,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: false,
    ...overrides,
  } as Principal;
}

/** Only the columns the viewer projection reads; the rest are filled so the row typechecks. */
function row(overrides: Partial<AuditEventRow>): AuditEventRow {
  return {
    id: 'audit-0000-0000-0000-0000-000000000000',
    organizationId: ORG,
    actorUserId: ACTOR,
    effectiveActorId: null,
    action: 'project.created',
    objectType: 'project',
    objectId: 'project-0000-0000-0000-0000-000000000001',
    result: 'allowed',
    correlationId: 'correlation-0000-0000-0000-000000000009',
    metadataJson: { secret_token: 'must-never-surface' },
    createdAt: new Date('2026-02-01T09:00:00.000Z'),
    ...overrides,
  } as unknown as AuditEventRow;
}

/**
 * A service whose repository holds exactly `rows`, filtered/ordered/cursored the way the real
 * `list` is. The service supplies the tenant context; a row in another organization is present in
 * the store and must never surface, which proves the scoping is the service's, not the fake's.
 */
function serviceWith(rows: readonly AuditEventRow[]): AuditService {
  const database = {
    read: async (ctx: unknown, work: (runner: unknown) => Promise<unknown>) => work({ ctx }),
  } as unknown as TenantDatabase;

  const events = {
    list: async (
      _runner: unknown,
      ctx: TenantContext,
      options: ListAuditEventsOptions = {},
    ): Promise<readonly AuditEventRow[]> => {
      let out = rows.filter((r) => r.organizationId === ctx.organizationId);
      if (options.actorUserId) out = out.filter((r) => r.actorUserId === options.actorUserId);
      if (options.objectId) out = out.filter((r) => r.objectId === options.objectId);
      if (options.objectType) out = out.filter((r) => r.objectType === options.objectType);
      if (options.action) out = out.filter((r) => r.action === options.action);
      if (options.result) out = out.filter((r) => r.result === options.result);
      out = [...out].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      if (options.before) out = out.filter((r) => r.id < options.before!);
      return out.slice(0, options.limit ?? 50);
    },
  } as unknown as AuditEventsRepository;

  return new AuditService(database, events);
}

/** Distinct, ascending ids so newest-first ordering is unambiguous. `id-<n>` sorts lexically. */
function idAt(n: number): string {
  return `audit-0000-0000-0000-0000-${String(n).padStart(12, '0')}`;
}

describe('AuditService.listForViewer', () => {
  it('projects own-org events newest-first, drops a cross-tenant row, and omits metadata', async () => {
    const service = serviceWith([
      row({ id: idAt(1), action: 'project.created', result: 'allowed' }),
      row({ id: idAt(3), action: 'membership.revoked', result: 'denied', objectId: null }),
      // Another tenant's row, in the store unscoped: it must never surface.
      row({ id: idAt(9), organizationId: OTHER_ORG, action: 'secret.thing' }),
    ]);

    const events = await service.listForViewer(
      context,
      principal('owner', { hasOrgWideScope: true }),
    );

    // Newest (highest id) first; the foreign row is absent.
    expect(events.map((e) => e.id)).toEqual([idAt(3), idAt(1)]);
    expect(events.some((e) => e.action === 'secret.thing')).toBe(false);
    expect(JSON.stringify(events)).not.toContain(OTHER_ORG);

    // The projection is exactly the seven narrow fields — no metadata, correlationId or effectiveActorId.
    expect(Object.keys(events[0]!).sort()).toEqual(
      ['action', 'actorId', 'entityId', 'entityType', 'id', 'occurredAt', 'summary'].sort(),
    );
    expect(JSON.stringify(events)).not.toContain('must-never-surface');
    expect(JSON.stringify(events)).not.toContain('secret_token');

    // Mapping: occurredAt is the ISO createdAt; a denial names its result in the summary.
    expect(events[1]).toMatchObject({
      id: idAt(1),
      occurredAt: '2026-02-01T09:00:00.000Z',
      actorId: ACTOR,
      entityType: 'project',
      summary: 'project.created',
    });
    expect(events[0]).toMatchObject({
      entityId: null,
      summary: 'membership.revoked (denied)',
    });
  });

  it('defaults the page to 20 and clamps a larger request to 50', async () => {
    const many = Array.from({ length: 60 }, (_v, i) => row({ id: idAt(i + 1) }));
    const service = serviceWith(many);
    const owner = principal('owner', { hasOrgWideScope: true });

    // No limit → the viewer default of 20, not the repository's 50.
    expect((await service.listForViewer(context, owner)).length).toBe(20);
    // An over-ceiling request is clamped to 50 (the service never asks the repository for more).
    expect((await service.listForViewer(context, owner, { limit: 999 })).length).toBe(50);
    // A floor breach is clamped up to 1.
    expect((await service.listForViewer(context, owner, { limit: 0 })).length).toBe(1);
  });

  it('paginates deterministically by the keyset cursor with no overlap', async () => {
    const rows = Array.from({ length: 5 }, (_v, i) => row({ id: idAt(i + 1) }));
    const service = serviceWith(rows);
    const owner = principal('owner', { hasOrgWideScope: true });

    const first = await service.listForViewer(context, owner, { limit: 2 });
    expect(first.map((e) => e.id)).toEqual([idAt(5), idAt(4)]);

    const second = await service.listForViewer(context, owner, {
      limit: 2,
      before: first[first.length - 1]!.id,
    });
    expect(second.map((e) => e.id)).toEqual([idAt(3), idAt(2)]);
    // No row appears on both pages.
    expect(first.map((e) => e.id).some((id) => second.map((e) => e.id).includes(id))).toBe(false);
  });

  it('narrows a non-org-wide caller to their own activity, ignoring a wider actorId filter', async () => {
    const service = serviceWith([
      row({ id: idAt(1), actorUserId: ACTOR }),
      row({ id: idAt(2), actorUserId: OTHER_ACTOR, action: 'someone.else' }),
    ]);

    // A member holds audit.read but is not org-wide; a request for another actor must not widen.
    const events = await service.listForViewer(context, principal('member'), {
      actorId: OTHER_ACTOR,
    });

    expect(events.map((e) => e.id)).toEqual([idAt(1)]);
    expect(events.every((e) => e.actorId === ACTOR)).toBe(true);
    expect(events.some((e) => e.action === 'someone.else')).toBe(false);
  });

  it('returns an empty page for an unknown or cross-tenant filter id — never a row, never a 500 (Known trap)', async () => {
    const service = serviceWith([
      row({ id: idAt(1), actorUserId: ACTOR }),
      row({ id: idAt(9), organizationId: OTHER_ORG, actorUserId: OTHER_ACTOR }),
    ]);
    const owner = principal('owner', { hasOrgWideScope: true });

    // A cross-tenant actorId is a filter, not a lookup: it resolves to nothing in this tenant.
    await expect(service.listForViewer(context, owner, { actorId: OTHER_ACTOR })).resolves.toEqual(
      [],
    );
    // An unknown entityId likewise — no throw, no cross-tenant read.
    await expect(
      service.listForViewer(context, owner, { entityId: 'project-does-not-exist' }),
    ).resolves.toEqual([]);
  });

  it('refuses a caller without audit.read with a 403 rather than an empty list', async () => {
    const service = serviceWith([row({ id: idAt(1) })]);

    // `guest` is one of the three roles the matrix withholds audit.read from.
    await expect(service.listForViewer(context, principal('guest'))).rejects.toBeInstanceOf(
      ApiError,
    );
    await service
      .listForViewer(context, principal('guest'))
      .catch((error: unknown) => expect((error as ApiError).status).toBe(403));
  });
});
