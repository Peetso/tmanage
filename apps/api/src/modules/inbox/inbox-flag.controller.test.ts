import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { InboxFlagController } from './inbox-flag.controller.js';
import { InboxFlagService } from './inbox-flag.service.js';
import type { InboxFlagRepository } from './inbox-flag.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Inbox flags (x260) — flag/unflag/list over fakes, always the caller's own bundle.
 *
 * The database and object rows are faked; the property that matters here is the ownership gate: a
 * bundle the caller has no notification for is a 404 and **nothing is inserted** (the refusal the brief
 * names), while a bundle they do have is flagged idempotently, the subject is always
 * `principal.membershipId`, and all three routes sit behind `work.read`.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const MY_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
const MY_USER = '00000000-0000-4000-8000-0000000000c1';
const MINE = 'work_item:00000000-0000-4000-8000-000000000101';
const NOT_MINE = 'work_item:00000000-0000-4000-8000-000000000909';

function member(): Principal {
  return {
    userId: MY_USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: MY_MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, membershipId: MY_MEMBERSHIP } as unknown as TenantContext;

/** In-memory flags keyed by `membership|bundle`, plus the set of bundles the caller has a notice for. */
class FakeInboxFlagRepository {
  readonly rows = new Set<string>();
  /** Bundles (`objectType:objectId`) the caller is a recipient for. */
  readonly ownedObjects = new Set<string>();
  addCalls: string[] = [];

  hasNotificationForRecipient(
    _r: unknown,
    _c: unknown,
    _userId: string,
    objectType: string,
    objectId: string,
  ): Promise<boolean> {
    return Promise.resolve(this.ownedObjects.has(`${objectType}:${objectId}`));
  }

  add(_r: unknown, _c: unknown, membershipId: string, bundleId: string): Promise<unknown> {
    this.addCalls.push(bundleId);
    this.rows.add(`${membershipId}|${bundleId}`);
    return Promise.resolve({ bundleId });
  }

  remove(_r: unknown, _c: unknown, membershipId: string, bundleId: string): Promise<void> {
    this.rows.delete(`${membershipId}|${bundleId}`);
    return Promise.resolve();
  }

  listForMembership(_r: unknown, _c: unknown, membershipId: string): Promise<readonly string[]> {
    return Promise.resolve(
      [...this.rows]
        .filter((key) => key.startsWith(`${membershipId}|`))
        .map((key) => key.slice(membershipId.length + 1)),
    );
  }
}

function controllerWith(repo: FakeInboxFlagRepository): InboxFlagController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const service = new InboxFlagService(database, repo as unknown as InboxFlagRepository);
  return new InboxFlagController(service);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('InboxFlagController (x260)', () => {
  it('refuses to flag a bundle the caller has no notification for — 404, no insert', async () => {
    const repo = new FakeInboxFlagRepository();
    repo.ownedObjects.add(MINE); // the caller owns MINE, but not NOT_MINE
    await expectStatus(controllerWith(repo).flag(context, member(), NOT_MINE), 404);
    expect(repo.addCalls).toHaveLength(0);
  });

  it('404s a malformed / non-flaggable bundle id and writes nothing', async () => {
    const repo = new FakeInboxFlagRepository();
    for (const bad of ['', 'nope', 'organization_usage:' + ORG, 'work_item:']) {
      await expectStatus(controllerWith(repo).flag(context, member(), bad), 404);
    }
    expect(repo.addCalls).toHaveLength(0);
  });

  it('flags a bundle the caller owns, idempotently, and lists it', async () => {
    const repo = new FakeInboxFlagRepository();
    repo.ownedObjects.add(MINE);
    const controller = controllerWith(repo);

    expect(await controller.flag(context, member(), MINE)).toEqual({
      bundleId: MINE,
      flagged: true,
    });
    await controller.flag(context, member(), MINE); // repeated PUT
    expect(repo.rows.size).toBe(1);

    expect(await controller.listFlagged(context, member())).toEqual({ bundleIds: [MINE] });
  });

  it('unflag is idempotent — removing an unflagged bundle is a no-op (204)', async () => {
    const repo = new FakeInboxFlagRepository();
    await expect(controllerWith(repo).unflag(context, member(), MINE)).resolves.toBeUndefined();
  });

  it('guards all three routes with work.read', () => {
    for (const method of ['listFlagged', 'flag', 'unflag'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        InboxFlagController.prototype[method],
      );
      expect(capability).toBe('work.read');
    }
  });
});
