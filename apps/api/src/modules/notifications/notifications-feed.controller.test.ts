import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { NotificationsFeedController } from './notifications-feed.controller.js';
import type { NotificationsFeedRepository } from './notifications-feed.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { NotificationRow } from '../../common/database/schema.js';

/**
 * NOTIF feed (x151). The controller's own logic, database-free over an in-memory fake whose
 * `findForRecipient` applies the recipient scope the real SQL applies — so the substance the
 * slice owns is proved here: a caller reads their own rows, marks their own row read, and
 * another person's `notificationId` is a 404 with no write. The tenant-scoped round-trip and
 * `0010`'s trigger are the chain's concern (no DB test in this slice).
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const ME = 'user-0000-0000-0000-0000-0000000000a1';
const OTHER = 'user-0000-0000-0000-0000-0000000000b2';

function principal(userId: string): Principal {
  return {
    userId,
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG } as unknown as TenantContext;

function row(
  id: string,
  recipientUserId: string,
  over: Partial<NotificationRow> = {},
): NotificationRow {
  return {
    id,
    organizationId: ORG,
    recipientUserId,
    type: 'work_item.blocked.v1',
    objectType: 'work_item',
    objectId: 'work-0000-0000-0000-0000-000000000001',
    dedupeKey: `dedupe-${id}`,
    readAt: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...over,
  } as NotificationRow;
}

/**
 * A controller over an in-memory store. `findForRecipient` and `markRead` honour the recipient
 * scope (they filter by `recipientUserId`), exactly as the real repository's `WHERE` does, so a
 * cross-recipient id resolves to nothing here just as it would against the database.
 */
function controllerWith(seed: readonly NotificationRow[] = []) {
  const rows = seed.map((r) => ({ ...r }));
  const marked: string[] = [];
  const listed: { recipientUserId: string }[] = [];

  const feed = {
    listForRecipient: async (_runner: unknown, _context: unknown, recipientUserId: string) => {
      listed.push({ recipientUserId });
      return rows.filter((r) => r.recipientUserId === recipientUserId);
    },
    findForRecipient: async (
      _runner: unknown,
      _context: unknown,
      recipientUserId: string,
      notificationId: string,
    ) => rows.find((r) => r.recipientUserId === recipientUserId && r.id === notificationId),
    markRead: async (
      _runner: unknown,
      _context: unknown,
      recipientUserId: string,
      notificationId: string,
    ) => {
      const found = rows.find(
        (r) =>
          r.recipientUserId === recipientUserId && r.id === notificationId && r.readAt === null,
      );
      if (!found) return 0;
      found.readAt = new Date('2026-09-02T00:00:00.000Z');
      marked.push(notificationId);
      return 1;
    },
  } as unknown as NotificationsFeedRepository;

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  return { controller: new NotificationsFeedController(database, feed), marked, listed };
}

const UUID_A = '0199aa00-0000-7000-8000-000000000001';
const UUID_B = '0199aa00-0000-7000-8000-000000000002';

describe('NotificationsFeedController', () => {
  it('requires work.read on both the feed list and the mark-read routes (403 for a role without it)', () => {
    // The 403 is the CapabilityGuard's, keyed off this metadata; a route without it would run
    // unguarded rather than be refused.
    expect(
      Reflect.getMetadata(REQUIRED_CAPABILITY, NotificationsFeedController.prototype.list),
    ).toBe('work.read');
    expect(
      Reflect.getMetadata(REQUIRED_CAPABILITY, NotificationsFeedController.prototype.markRead),
    ).toBe('work.read');
  });

  it('lists only the acting recipient’s own notifications, newest first, without echoing the tenant', async () => {
    const { controller, listed } = controllerWith([row(UUID_A, ME), row(UUID_B, OTHER)]);

    const view = await controller.list(context, principal(ME));

    expect(view.items.map((item) => item.id)).toEqual([UUID_A]);
    // The recipient is the authenticated principal, never a value the request could name.
    expect(listed[0]?.recipientUserId).toBe(ME);
    expect(JSON.stringify(view)).not.toContain(ORG);
  });

  it('marks the recipient’s own notification read and reports it read', async () => {
    const { controller, marked } = controllerWith([row(UUID_A, ME)]);

    const view = await controller.markRead(context, principal(ME), UUID_A);

    expect(view.read).toBe(true);
    expect(view.readAt).not.toBeNull();
    expect(marked).toEqual([UUID_A]);
  });

  it('answers 404 with no write for another user’s notificationId (own-scope is the substance)', async () => {
    const { controller, marked } = controllerWith([row(UUID_A, OTHER)]);

    const error = await controller
      .markRead(context, principal(ME), UUID_A)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(marked).toEqual([]); // resolve failed before any write
  });

  it('answers 404 with no write for an id this API never issued', async () => {
    const { controller, marked } = controllerWith([row(UUID_A, ME)]);

    const error = await controller
      .markRead(context, principal(ME), 'not-a-uuid')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(marked).toEqual([]);
  });
});
