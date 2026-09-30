import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { PortalFeedbackController } from './feedback.controller.js';
import { PortalFeedbackService } from './feedback.service.js';
import type { PortalFeedbackRepository } from './feedback.repository.js';
import type { ClientProjectionsRepository } from '../approvals/client-projections.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ClientProjectionRow, PortalFeedbackRow } from '../../common/database/schema.js';

/**
 * Portal deliverable feedback (x321) over fakes with **real** `authorize()`.
 *
 * The fakes stand in only for the database and the two repositories. `authorize()` is the real
 * policy, so these cases prove the actual refusals x321 exists for: an unpublished/unknown or
 * off-client deliverable is a 404 with no write, a rating outside 1–5 is a 400 with no write, and
 * the client write returns no internal field. The 403 for a role lacking the capability is
 * `CapabilityGuard`'s, which reads exactly the `@RequireCapability` metadata pinned below; the live
 * guard round-trip and the staff read are the chain's e2e (no DB test / no new e2e in this slice).
 */

const ORG = 'org-under-test';
const CLIENT_ORG = 'client-org-under-test';
const PROJECT = 'project-visible';
const DELIVERABLE = 'deliverable-1';
const VERSION = 'version-1';

function clientPrincipal(readableProjectId: string): Principal {
  return {
    userId: 'client-user-1',
    organizationId: ORG,
    kind: 'client',
    role: 'client_reviewer',
    membershipId: 'membership-1',
    membershipStatus: 'active',
    clientOrganizationId: CLIENT_ORG,
    projectIds: [readableProjectId],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, userId: 'client-user-1' } as unknown as TenantContext;

/** A database whose `read`/`transaction` run the unit of work with an ignored runner. */
function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

/** Projections repo resolving the latest published version for the deliverables it was seeded. */
function fakeProjections(
  byDeliverable: Record<string, { projectId: string; deliverableVersionId: string }>,
): ClientProjectionsRepository {
  return {
    findLatestByDeliverable: (_r: never, _c: TenantContext, deliverableId: string) => {
      const hit = byDeliverable[deliverableId];
      return Promise.resolve(
        hit ? ({ ...hit, deliverableId } as unknown as ClientProjectionRow) : null,
      );
    },
  } as unknown as ClientProjectionsRepository;
}

function controllerWith(
  byDeliverable: Record<string, { projectId: string; deliverableVersionId: string }>,
): { controller: PortalFeedbackController; upsert: ReturnType<typeof vi.fn> } {
  const upsert = vi.fn(
    (_r: never, _c: TenantContext, input: { rating: number; comment: string | null }) =>
      Promise.resolve({
        id: 'feedback-1',
        organizationId: ORG,
        deliverableVersionId: VERSION,
        clientContactUserId: 'client-user-1',
        rating: input.rating,
        comment: input.comment,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      } as PortalFeedbackRow),
  );
  const repo = { upsert } as unknown as PortalFeedbackRepository;
  const service = new PortalFeedbackService(fakeDatabase(), fakeProjections(byDeliverable), repo);
  return { controller: new PortalFeedbackController(service), upsert };
}

describe('PortalFeedbackController route capabilities (x321)', () => {
  const capabilityOf = (key: string): unknown =>
    Reflect.getMetadata(
      REQUIRED_CAPABILITY,
      (PortalFeedbackController.prototype as unknown as Record<string, unknown>)[key] as object,
    );

  it('guards the client write with client_projection.read and the staff read with client_member.manage', () => {
    // The gate CapabilityGuard reads: a role without client_projection.read is 403 on the write
    // before the handler runs, and no client role can exercise client_member.manage at internal.
    expect(capabilityOf('submit')).toBe('client_projection.read');
    expect(capabilityOf('list')).toBe('client_member.manage');
  });
});

describe('PortalFeedbackController.submit (x321)', () => {
  it('answers 404 with no write for an unpublished or unknown deliverable', async () => {
    const { controller, upsert } = controllerWith({});
    await expect(
      controller.submit(context, clientPrincipal(PROJECT), DELIVERABLE, { rating: 5 }),
    ).rejects.toMatchObject({ status: 404 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('answers 404 with no write for a deliverable in a project outside the client scope', async () => {
    const { controller, upsert } = controllerWith({
      [DELIVERABLE]: { projectId: 'project-not-shared', deliverableVersionId: VERSION },
    });
    await expect(
      controller.submit(context, clientPrincipal(PROJECT), DELIVERABLE, { rating: 5 }),
    ).rejects.toMatchObject({ status: 404 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('answers 400 with no write for a rating outside 1–5', async () => {
    const { controller, upsert } = controllerWith({
      [DELIVERABLE]: { projectId: PROJECT, deliverableVersionId: VERSION },
    });
    for (const rating of [0, 6, 2.5]) {
      await expect(
        controller.submit(context, clientPrincipal(PROJECT), DELIVERABLE, { rating }),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(upsert).not.toHaveBeenCalled();
  });

  it('writes the client-authored feedback and returns no internal field', async () => {
    const { controller, upsert } = controllerWith({
      [DELIVERABLE]: { projectId: PROJECT, deliverableVersionId: VERSION },
    });
    const view = await controller.submit(context, clientPrincipal(PROJECT), DELIVERABLE, {
      rating: 4,
      comment: '  looks good  ',
    });
    expect(view).toEqual({
      id: 'feedback-1',
      rating: 4,
      comment: 'looks good',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    // The author is the session's user and the version comes from the resolved projection.
    expect(upsert).toHaveBeenCalledWith(expect.anything(), context, {
      deliverableVersionId: VERSION,
      clientContactUserId: 'client-user-1',
      rating: 4,
      comment: 'looks good',
    });
    expect(view).not.toHaveProperty('clientContactUserId');
    expect(view).not.toHaveProperty('organizationId');
  });
});
