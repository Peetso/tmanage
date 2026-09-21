import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  ClientProjectionPayload,
  ClientProjectionRow,
  DeliverableVersionRow,
} from '../../common/database/schema.js';
import { ApprovalsService } from './approvals.service.js';
import type { ApprovalsRepository } from './approvals.repository.js';
import { DeliverableVersionNotFoundError } from './deliverable-versions.repository.js';
import type { DeliverableVersionsRepository } from './deliverable-versions.repository.js';
import {
  ClientProjectionAlreadyExistsError,
  ClientProjectionNotFoundError,
} from './client-projections.repository.js';
import type {
  ClientProjectionsRepository,
  PublishClientProjectionInput,
} from './client-projections.repository.js';

/**
 * FR-05's publish/read behaviour, with fakes for the two repositories the paths touch.
 *
 * The things only the service can get wrong, and that the DB round-trip does not need to repeat:
 * publish is internal-only and freezes the governed version's own hash (25 §7), the projection is
 * append-only (one per version), and the read is authorized against the client relation. The fakes
 * stand in for the database only — `authorize()` runs for real, so the object-layer decision is
 * exercised, not mocked.
 *
 * "read by a non-client denied" (the acceptance) is read as acceptance 3's precise wording, "a
 * caller without the relation refused": `client_projection.read` is deliberately held by internal
 * roles too (capabilities.ts — an admin previews what a client will see), so the gate is the
 * relation, and the denied caller here is a client outside it.
 */

const ORG = '00000000-0000-7000-8000-0000000000a1';
const CLIENT_ORG = '00000000-0000-7000-8000-0000000000b9';
const PROJECT = '00000000-0000-7000-8000-0000000000c1';
const OTHER_PROJECT = '00000000-0000-7000-8000-0000000000c9';
const DELIVERABLE = '00000000-0000-7000-8000-0000000000d1';
const VERSION = '00000000-0000-7000-8000-0000000000e1';
const PUBLISHER = '00000000-0000-7000-8000-0000000000f1';
const HASH_A = 'a'.repeat(64);

const context = { organizationId: ORG } as TenantContext;

const payload: ClientProjectionPayload = {
  title: 'Atlas Homepage Concept',
  summary: 'The approved direction for the booking hero.',
  milestoneState: 'in_review',
  forecastDate: '2026-10-15',
  publishedRisk: 'on_track',
  decision: 'approved',
  approvedContacts: ['salma.riad@atlas.example'],
};

/** An internal publisher — workspace_admin holds `deliverable.publish` and the project relation. */
function publisher(): Principal {
  return {
    userId: PUBLISHER,
    organizationId: ORG,
    kind: 'internal',
    role: 'workspace_admin',
    membershipId: '00000000-0000-7000-8000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: true,
  };
}

/** A client principal; `projectIds` is the client relation `authorize` reads for the read gate. */
function client(projectIds: readonly string[]): Principal {
  return {
    userId: '00000000-0000-7000-8000-000000000aa2',
    organizationId: ORG,
    kind: 'client',
    role: 'client_reviewer',
    membershipId: '00000000-0000-7000-8000-000000000002',
    membershipStatus: 'active',
    clientOrganizationId: CLIENT_ORG,
    projectIds,
    hasOrgWideScope: false,
  };
}

function versionRow(): DeliverableVersionRow {
  return {
    id: VERSION,
    organizationId: ORG,
    projectId: PROJECT,
    deliverableId: DELIVERABLE,
    contentHash: HASH_A,
    createdByUserId: PUBLISHER,
    createdAt: new Date('2026-09-20T00:00:00.000Z'),
  };
}

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    transaction: <T>(_c: TenantContext, work: (tx: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

class FakeVersions {
  constructor(private readonly version: DeliverableVersionRow | null) {}
  async requireById(_tx: never, _c: TenantContext, id: string): Promise<DeliverableVersionRow> {
    if (!this.version) throw new DeliverableVersionNotFoundError(id);
    return this.version;
  }
}

/** In-memory projections: append-only, one per version, exactly as `0031` enforces at the engine. */
class FakeClientProjections {
  private stored: ClientProjectionRow | null = null;

  async publish(
    _tx: never,
    ctx: TenantContext,
    input: PublishClientProjectionInput,
  ): Promise<ClientProjectionRow> {
    if (this.stored && this.stored.deliverableVersionId === input.deliverableVersionId) {
      throw new ClientProjectionAlreadyExistsError(input.deliverableVersionId);
    }
    this.stored = {
      id: '00000000-0000-7000-8000-000000000bb1',
      organizationId: ctx.organizationId,
      projectId: input.projectId,
      deliverableId: input.deliverableId,
      deliverableVersionId: input.deliverableVersionId,
      contentHash: input.contentHash,
      projection: input.projection,
      publishedByUserId: input.publishedByUserId,
      publishedAt: new Date('2026-09-20T12:00:00.000Z'),
    };
    return this.stored;
  }

  async requireByVersion(_tx: never, _c: TenantContext, id: string): Promise<ClientProjectionRow> {
    if (!this.stored || this.stored.deliverableVersionId !== id) {
      throw new ClientProjectionNotFoundError(id);
    }
    return this.stored;
  }
}

function service(versions: FakeVersions, projections: FakeClientProjections): ApprovalsService {
  return new ApprovalsService(
    fakeDatabase(),
    {} as unknown as ApprovalsRepository,
    versions as unknown as DeliverableVersionsRepository,
    projections as unknown as ClientProjectionsRepository,
  );
}

describe('ApprovalsService.publish / readProjection', () => {
  it('freezes the governed version and round-trips the hash on read', async () => {
    const projections = new FakeClientProjections();
    const svc = service(new FakeVersions(versionRow()), projections);

    const published = await svc.publish(context, publisher(), {
      deliverableVersionId: VERSION,
      projection: payload,
    });
    expect(published.deliverableVersionId).toBe(VERSION);
    expect(published.contentHash).toBe(HASH_A);
    expect(published.publishedByUserId).toBe(PUBLISHER);
    expect(published.projection).toEqual(payload);

    // The related client reads the frozen projection back — same hash, same allowlisted payload.
    const read = await svc.readProjection(context, client([PROJECT]), VERSION);
    expect(read.contentHash).toBe(HASH_A);
    expect(read.projection).toEqual(payload);
    expect(read.id).toBe(published.id);
  });

  it('refuses a publish from a non-publisher (client) at the object layer', async () => {
    // A client role never holds `deliverable.publish` in its ceiling, so `authorize` denies at the
    // ceiling check — before the internal-only guard is even reached. Either way it is a 404 at the
    // object layer, and the client is a "non-internal caller refused" (acceptance 2).
    const projections = new FakeClientProjections();
    const svc = service(new FakeVersions(versionRow()), projections);

    const error = await svc
      .publish(context, client([PROJECT]), { deliverableVersionId: VERSION, projection: payload })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).auditCode).toBe('capability_not_in_role_ceiling');
    // Nothing was published: a subsequent read finds no projection.
    await expect(svc.readProjection(context, client([PROJECT]), VERSION)).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('refuses a re-publish of an already-projected version (append-only)', async () => {
    const projections = new FakeClientProjections();
    const svc = service(new FakeVersions(versionRow()), projections);

    await svc.publish(context, publisher(), { deliverableVersionId: VERSION, projection: payload });
    const error = await svc
      .publish(context, publisher(), { deliverableVersionId: VERSION, projection: payload })
      .catch((e: unknown) => e);

    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).auditCode).toBe('client_projection_exists');
  });

  it('maps an unknown version id to 404 before the relation check, and writes nothing (publish)', async () => {
    // The known trap (x90/x91/x92): the id is resolved tenant-scoped *before* authorize, so an
    // org-wide caller naming a missing (or cross-tenant) version gets a 404, not a 500 the filter
    // never maps, and no projection is written.
    const projections = new FakeClientProjections();
    const svc = service(new FakeVersions(null), projections);

    const error = await svc
      .publish(context, publisher(), { deliverableVersionId: VERSION, projection: payload })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe('not_found');
    expect((error as ApiError).message).toBe(MESSAGES.notFound);
    // No write happened: the version was never resolved, so nothing was published to read back.
    await expect(svc.readProjection(context, client([PROJECT]), VERSION)).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('refuses a read from a caller outside the client relation', async () => {
    const projections = new FakeClientProjections();
    const svc = service(new FakeVersions(versionRow()), projections);
    await svc.publish(context, publisher(), { deliverableVersionId: VERSION, projection: payload });

    const error = await svc
      .readProjection(context, client([OTHER_PROJECT]), VERSION)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).auditCode).toBe('not_project_member');
  });

  it('maps a missing (or cross-tenant) projection to a 404 ApiError, not a raw 500', async () => {
    // Nothing published; the scoped read reports another tenant's row as absent the same way.
    const svc = service(new FakeVersions(versionRow()), new FakeClientProjections());

    const error = await svc
      .readProjection(context, client([PROJECT]), VERSION)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe('not_found');
    expect((error as ApiError).message).toBe(MESSAGES.notFound);
    expect((error as ApiError).details).toBeUndefined();
  });
});
