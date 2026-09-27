import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { HomeQuickLinksController } from './quick-links.controller.js';
import { HomeQuickLinksService, MAX_QUICK_LINKS } from './quick-links.service.js';
import type { HomeQuickLinksRepository } from './quick-links.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { HomeQuickLinkRow } from '../../common/database/schema.js';

/**
 * Home quick links (x273) — CRUD + reorder over fakes, always the caller's own.
 *
 * The database is faked and the real {@link HomeQuickLinksService} drives an in-memory repository, so
 * the properties proved are the ones the HTTP surface owns: a valid link is added and read back in
 * position order; **an absolute `http(s)://` path is a 400 with no insert (the open-redirect guard)**,
 * as are a protocol-relative `//host`, a backslash path and an empty label; the count is capped
 * ({@link MAX_QUICK_LINKS} then 409); a reorder must be a permutation of the caller's own ids (an
 * unknown id is a 400 with no write); a delete is own-membership (a foreign id is a 404); the subject
 * is always `context.membershipId`, never a body value; and all four routes sit behind `work.read`.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const MY_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
const OTHER_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e2';

function member(): Principal {
  return {
    userId: '00000000-0000-4000-8000-0000000000c1',
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

/** An in-memory store keyed by membership, so a write is visible to the read-back the service does. */
class FakeHomeQuickLinksRepository {
  readonly rows = new Map<string, HomeQuickLinkRow[]>();
  inserts = 0;
  private seq = 0;

  private own(membershipId: string): HomeQuickLinkRow[] {
    return this.rows.get(membershipId) ?? [];
  }

  listForMembership(
    _r: unknown,
    _c: unknown,
    membershipId: string,
  ): Promise<readonly HomeQuickLinkRow[]> {
    const rows = [...this.own(membershipId)].sort(
      (a, b) => a.position - b.position || a.id.localeCompare(b.id),
    );
    return Promise.resolve(rows);
  }

  countForMembership(_r: unknown, _c: unknown, membershipId: string): Promise<number> {
    return Promise.resolve(this.own(membershipId).length);
  }

  insert(
    _r: unknown,
    _c: unknown,
    input: { membershipId: string; label: string; path: string; position: number },
  ): Promise<void> {
    this.inserts += 1;
    const rows = this.own(input.membershipId);
    this.seq += 1;
    rows.push({
      id: `link-${String(this.seq).padStart(4, '0')}`,
      organizationId: ORG,
      membershipId: input.membershipId,
      label: input.label,
      path: input.path,
      position: input.position,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as HomeQuickLinkRow);
    this.rows.set(input.membershipId, rows);
    return Promise.resolve();
  }

  updatePosition(
    _r: unknown,
    _c: unknown,
    membershipId: string,
    id: string,
    position: number,
  ): Promise<void> {
    const row = this.own(membershipId).find((r) => r.id === id);
    if (row) (row as { position: number }).position = position;
    return Promise.resolve();
  }

  deleteOwn(_r: unknown, _c: unknown, membershipId: string, id: string): Promise<boolean> {
    const rows = this.own(membershipId);
    const index = rows.findIndex((r) => r.id === id);
    if (index < 0) return Promise.resolve(false);
    rows.splice(index, 1);
    return Promise.resolve(true);
  }

  seed(membershipId: string, links: readonly { id: string; position: number }[]): void {
    this.rows.set(
      membershipId,
      links.map(
        (l) =>
          ({
            id: l.id,
            organizationId: ORG,
            membershipId,
            label: l.id,
            path: `/x/${l.id}`,
            position: l.position,
            createdAt: new Date(),
            updatedAt: new Date(),
          }) as HomeQuickLinkRow,
      ),
    );
  }
}

function controllerWith(repo: FakeHomeQuickLinksRepository): HomeQuickLinksController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const service = new HomeQuickLinksService(database, repo as unknown as HomeQuickLinksRepository);
  return new HomeQuickLinksController(service);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('HomeQuickLinksController (x273)', () => {
  it('adds a valid link and reads it back in position order', async () => {
    const repo = new FakeHomeQuickLinksRepository();
    const controller = controllerWith(repo);

    await controller.create(context, member(), { label: 'Docs', path: '/docs' });
    const view = await controller.create(context, member(), { label: 'Work', path: '/work/inbox' });

    expect(view.links.map((l) => l.label)).toEqual(['Docs', 'Work']);
    expect(view.links.map((l) => l.position)).toEqual([0, 1]);
    // Always the caller's own membership — the store only ever saw MY_MEMBERSHIP.
    expect([...repo.rows.keys()]).toEqual([MY_MEMBERSHIP]);
  });

  it('400s an absolute http(s):// path and writes nothing (open-redirect guard)', async () => {
    const repo = new FakeHomeQuickLinksRepository();
    await expectStatus(
      controllerWith(repo).create(context, member(), {
        label: 'Evil',
        path: 'https://evil.example.com/steal',
      }),
      400,
    );
    expect(repo.inserts).toBe(0);
  });

  it('400s protocol-relative, backslash and empty-label bodies and writes nothing', async () => {
    const repo = new FakeHomeQuickLinksRepository();
    const controller = controllerWith(repo);
    await expectStatus(
      controller.create(context, member(), { label: 'A', path: '//evil.com' }),
      400,
    );
    await expectStatus(controller.create(context, member(), { label: 'B', path: '/a\\b' }), 400);
    await expectStatus(controller.create(context, member(), { label: '  ', path: '/ok' }), 400);
    expect(repo.inserts).toBe(0);
  });

  it('409s a further add once the member is at the cap', async () => {
    const repo = new FakeHomeQuickLinksRepository();
    repo.seed(
      MY_MEMBERSHIP,
      Array.from({ length: MAX_QUICK_LINKS }, (_v, i) => ({ id: `s${i}`, position: i })),
    );
    await expectStatus(
      controllerWith(repo).create(context, member(), { label: 'One more', path: '/more' }),
      409,
    );
  });

  it('reorders to a permutation of the caller’s own ids', async () => {
    const repo = new FakeHomeQuickLinksRepository();
    repo.seed(MY_MEMBERSHIP, [
      { id: 'a', position: 0 },
      { id: 'b', position: 1 },
      { id: 'c', position: 2 },
    ]);
    const view = await controllerWith(repo).reorder(context, member(), { ids: ['c', 'a', 'b'] });
    expect(view.links.map((l) => l.id)).toEqual(['c', 'a', 'b']);
    expect(view.links.map((l) => l.position)).toEqual([0, 1, 2]);
  });

  it('400s a reorder naming an unknown id and writes nothing', async () => {
    const repo = new FakeHomeQuickLinksRepository();
    repo.seed(MY_MEMBERSHIP, [
      { id: 'a', position: 0 },
      { id: 'b', position: 1 },
    ]);
    await expectStatus(
      controllerWith(repo).reorder(context, member(), { ids: ['a', 'not-mine'] }),
      400,
    );
    // Positions untouched.
    const view = await controllerWith(repo).list(context, member());
    expect(view.links.map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('removes the caller’s own link and 404s an id that is not theirs', async () => {
    const repo = new FakeHomeQuickLinksRepository();
    repo.seed(MY_MEMBERSHIP, [{ id: 'a', position: 0 }]);
    repo.seed(OTHER_MEMBERSHIP, [{ id: 'z', position: 0 }]);
    const controller = controllerWith(repo);

    const after = await controller.remove(context, member(), 'a');
    expect(after.links).toHaveLength(0);

    // Another member's link id is a 404 — its existence is never disclosed.
    await expectStatus(controller.remove(context, member(), 'z'), 404);
  });

  it('never reads another membership’s links — the subject is always the principal', async () => {
    const repo = new FakeHomeQuickLinksRepository();
    repo.seed(OTHER_MEMBERSHIP, [{ id: 'z', position: 0 }]);
    const view = await controllerWith(repo).list(context, member());
    expect(view.links).toHaveLength(0);
  });

  it('guards all four routes with work.read, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['list', 'create', 'reorder', 'remove'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        HomeQuickLinksController.prototype[method],
      );
      expect(capability).toBe('work.read');
    }
  });
});
