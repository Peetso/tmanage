import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { assertSafeAuditMetadata } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MemberAdminNoteRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AppendAuditEventInput } from '../audit/audit-events.repository.js';
import { MemberNotesController } from './member-notes.controller.js';
import type { MemberNotesRepository } from './member-notes.repository.js';
import { MemberNotesService } from './member-notes.service.js';

/**
 * Wave 9 S8 — audit F56: an `org.manage` holder could read and silently delete the private admin
 * notes written about their own membership. Now a note about the caller's own membership is the
 * module's 404 on list, add and delete (the row survives), and adding / deleting a note about
 * someone else is audited in the same transaction (ids only).
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const ADMIN_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e2';
const OWNER_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
const OTHER_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e3';

const admin: Principal = {
  userId: '00000000-0000-4000-8000-0000000000c2',
  organizationId: ORG,
  kind: 'internal',
  role: 'org_admin',
  membershipId: ADMIN_MEMBERSHIP,
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
};

const adminContext = { organizationId: ORG, membershipId: ADMIN_MEMBERSHIP } as TenantContext;

function harness() {
  const rows: MemberAdminNoteRow[] = [
    {
      id: 'note-about-admin',
      organizationId: ORG,
      subjectMembershipId: ADMIN_MEMBERSHIP,
      body: 'dummy performance note',
      authorMembershipId: OWNER_MEMBERSHIP,
      createdAt: new Date('2026-09-27T00:00:00.000Z'),
    },
  ];
  const members = [ADMIN_MEMBERSHIP, OWNER_MEMBERSHIP, OTHER_MEMBERSHIP];
  const repo = {
    findMembership: async (_r: unknown, _c: unknown, id: string) =>
      members.includes(id) ? { id, organizationId: ORG } : undefined,
    findNote: vi.fn(async (_r: unknown, _c: unknown, subject: string, id: string) =>
      rows.find((n) => n.subjectMembershipId === subject && n.id === id),
    ),
    list: vi.fn(async (_r: unknown, _c: unknown, subject: string) =>
      rows.filter((n) => n.subjectMembershipId === subject),
    ),
    append: async (
      _r: unknown,
      _c: unknown,
      input: { subjectMembershipId: string; body: string; authorMembershipId: string },
    ) => {
      const row = {
        id: `note-${rows.length + 1}`,
        organizationId: ORG,
        createdAt: new Date('2026-09-28T00:00:00.000Z'),
        ...input,
      };
      rows.push(row);
      return row;
    },
    remove: vi.fn(async (_r: unknown, _c: unknown, subject: string, id: string) => {
      const i = rows.findIndex((n) => n.subjectMembershipId === subject && n.id === id);
      if (i >= 0) rows.splice(i, 1);
    }),
  };
  const recorded: AppendAuditEventInput[] = [];
  const audit = {
    record: async (_tx: unknown, _c: unknown, input: AppendAuditEventInput) => {
      assertSafeAuditMetadata(input.metadata);
      recorded.push(input);
      return input;
    },
  };
  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const controller = new MemberNotesController(
    new MemberNotesService(
      database,
      repo as unknown as MemberNotesRepository,
      audit as unknown as Pick<AuditService, 'record'>,
    ),
  );
  return { rows, repo, recorded, controller };
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return (error as ApiError).status;
}

describe('wave9-S8 F56: no admin notes about yourself', () => {
  it('self list is a 404 and reads no note', async () => {
    const h = harness();
    expect(await statusOf(h.controller.list(adminContext, admin, ADMIN_MEMBERSHIP))).toBe(404);
    expect(h.repo.list).not.toHaveBeenCalled();
  });

  it('self delete is a 404 and the row survives, unaudited because nothing happened', async () => {
    const h = harness();
    expect(
      await statusOf(
        h.controller.remove(adminContext, admin, ADMIN_MEMBERSHIP, 'note-about-admin'),
      ),
    ).toBe(404);
    expect(h.repo.remove).not.toHaveBeenCalled();
    expect(h.rows.map((n) => n.id)).toEqual(['note-about-admin']);
    expect(h.recorded).toHaveLength(0);
  });

  it('self add is a 404 with no insert', async () => {
    const h = harness();
    expect(
      await statusOf(h.controller.add(adminContext, admin, ADMIN_MEMBERSHIP, { body: 'x' })),
    ).toBe(404);
    expect(h.rows).toHaveLength(1);
  });

  it('a note about another member works and its add and delete are audited (ids only)', async () => {
    const h = harness();
    const created = await h.controller.add(adminContext, admin, OTHER_MEMBERSHIP, {
      body: 'Spoke to them',
    });
    expect((await h.controller.list(adminContext, admin, OTHER_MEMBERSHIP)).notes).toHaveLength(1);
    await h.controller.remove(adminContext, admin, OTHER_MEMBERSHIP, created.id);
    expect(h.recorded.map((r) => r.action)).toEqual([
      'member_admin_note.created',
      'member_admin_note.deleted',
    ]);
    for (const row of h.recorded) {
      expect(row).toMatchObject({
        objectId: created.id,
        actorUserId: admin.userId,
        metadata: { target_membership_id: OTHER_MEMBERSHIP },
      });
      expect(JSON.stringify(row)).not.toContain('Spoke to them');
    }
  });
});
