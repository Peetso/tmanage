import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { MemberNotesController } from './member-notes.controller.js';
import { MemberNotesService } from './member-notes.service.js';
import type { MemberNotesRepository } from './member-notes.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MemberAdminNoteRow, MembershipRow } from '../../common/database/schema.js';

/**
 * Admin private member notes (x280) over fakes, with the **real** `authorize`.
 *
 * The database is faked, the policy is not: a real `Principal` runs through the real evaluator, so
 * these cases prove the rules that are the whole of this slice's safety — the subject membership is
 * resolved tenant-scoped BEFORE authorize (a cross-tenant/unknown id is a 404 with no insert, the
 * Known trap); `org.manage` gates every route (a caller without it is a 403 with no insert); an empty
 * body is a 400 with no insert; and a note is written under the acting membership, never a body value.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OWNER_USER = '00000000-0000-4000-8000-0000000000c1';
const ACTOR_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
const SUBJECT = '00000000-0000-4000-8000-0000000000f1';

/** An owner — the only internal role whose ceiling holds `org.manage`. */
function owner(): Principal {
  return {
    userId: OWNER_USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: ACTOR_MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

/** An org_admin — holds every capability except `org.manage`, so the real authorize denies. */
function orgAdmin(): Principal {
  return { ...owner(), role: 'org_admin' };
}

const context = {
  organizationId: ORG,
  membershipId: ACTOR_MEMBERSHIP,
} as unknown as TenantContext;

function membership(id: string): MembershipRow {
  return { id, organizationId: ORG } as unknown as MembershipRow;
}

/**
 * An in-memory {@link MemberNotesRepository}. `findMembership` models the tenant-scoped resolve: a
 * membership absent from `members` (e.g. one in another tenant) returns `undefined`, exactly what the
 * real scoped read gives.
 */
class FakeMemberNotesRepository {
  appendCalls = 0;
  removeCalls = 0;
  readonly rows: MemberAdminNoteRow[] = [];

  constructor(readonly members: readonly string[]) {}

  findMembership(_r: unknown, _c: unknown, id: string): Promise<MembershipRow | undefined> {
    return Promise.resolve(this.members.includes(id) ? membership(id) : undefined);
  }

  findNote(
    _r: unknown,
    _c: unknown,
    subject: string,
    noteId: string,
  ): Promise<MemberAdminNoteRow | undefined> {
    return Promise.resolve(
      this.rows.find((n) => n.subjectMembershipId === subject && n.id === noteId),
    );
  }

  list(_r: unknown, _c: unknown, subject: string): Promise<readonly MemberAdminNoteRow[]> {
    return Promise.resolve(this.rows.filter((n) => n.subjectMembershipId === subject));
  }

  append(
    _r: unknown,
    _c: unknown,
    input: { subjectMembershipId: string; body: string; authorMembershipId: string },
  ): Promise<MemberAdminNoteRow> {
    this.appendCalls += 1;
    const row: MemberAdminNoteRow = {
      id: `note-${this.rows.length + 1}`,
      organizationId: ORG,
      subjectMembershipId: input.subjectMembershipId,
      body: input.body,
      authorMembershipId: input.authorMembershipId,
      createdAt: new Date('2026-09-27T00:00:00.000Z'),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  remove(_r: unknown, _c: unknown, subject: string, noteId: string): Promise<void> {
    this.removeCalls += 1;
    const i = this.rows.findIndex((n) => n.subjectMembershipId === subject && n.id === noteId);
    if (i >= 0) this.rows.splice(i, 1);
    return Promise.resolve();
  }
}

function controllerWith(repo: FakeMemberNotesRepository): MemberNotesController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const service = new MemberNotesService(database, repo as unknown as MemberNotesRepository);
  return new MemberNotesController(service);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('MemberNotesController (ADM private member notes, x280)', () => {
  it('adds a note under the acting membership, then lists it newest first', async () => {
    const repo = new FakeMemberNotesRepository([SUBJECT]);
    const controller = controllerWith(repo);

    const created = await controller.add(context, owner(), SUBJECT, { body: '  Spoke to them  ' });
    expect(repo.appendCalls).toBe(1);
    expect(created).toMatchObject({
      subjectMembershipId: SUBJECT,
      body: 'Spoke to them',
      authorMembershipId: ACTOR_MEMBERSHIP,
    });

    const listed = await controller.list(context, owner(), SUBJECT);
    expect(listed.notes).toHaveLength(1);
    expect(listed.notes[0]?.body).toBe('Spoke to them');
  });

  it('404s a note for a membership in another tenant, before authorize and before any insert (the required refusal)', async () => {
    // SUBJECT is not among the tenant's memberships → the scoped resolve returns undefined → 404.
    const repo = new FakeMemberNotesRepository([]);
    const controller = controllerWith(repo);

    await expectStatus(controller.add(context, owner(), SUBJECT, { body: 'note' }), 404);
    expect(repo.appendCalls).toBe(0);
  });

  it('403s a caller without org.manage on add, with the real authorize, no insert', async () => {
    const repo = new FakeMemberNotesRepository([SUBJECT]);
    const controller = controllerWith(repo);

    await expectStatus(controller.add(context, orgAdmin(), SUBJECT, { body: 'note' }), 403);
    expect(repo.appendCalls).toBe(0);
  });

  it('400s an empty note body, with no insert', async () => {
    const repo = new FakeMemberNotesRepository([SUBJECT]);
    const controller = controllerWith(repo);

    await expectStatus(controller.add(context, owner(), SUBJECT, { body: '   ' }), 400);
    expect(repo.appendCalls).toBe(0);
  });

  it('404s deleting an unknown note under the subject, with no delete', async () => {
    const repo = new FakeMemberNotesRepository([SUBJECT]);
    const controller = controllerWith(repo);

    await expectStatus(controller.remove(context, owner(), SUBJECT, 'missing'), 404);
    expect(repo.removeCalls).toBe(0);
  });

  it('guards every route with org.manage, so CapabilityGuard refuses a caller without it', () => {
    for (const method of ['list', 'add', 'remove'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        MemberNotesController.prototype[method],
      );
      expect(capability).toBe('org.manage');
    }
  });
});
