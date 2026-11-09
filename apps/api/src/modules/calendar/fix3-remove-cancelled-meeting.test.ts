import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { MeetingsService } from './meetings.service.js';
import type { MeetingsRepository, UpdateMeetingInput } from './meetings.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MeetingRow } from '../../common/database/schema.js';

/**
 * Live check a6f66e47: a cancelled meeting could not be removed. Remove is a soft delete of a
 * cancelled meeting only; afterwards the meeting is a 404 for every read.
 */
const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;
const principal: Principal = {
  userId: USER,
  organizationId: ORG,
  kind: 'internal',
  role: 'member',
  membershipId: 'membership-0000-0000-000000000001',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [PROJECT],
  hasOrgWideScope: false,
};

function serviceWith(row: MeetingRow) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    findById: async (_r: unknown, _c: unknown, id: string) => (id === row.id ? row : null),
    update: async (_r: unknown, _c: unknown, _id: string, input: UpdateMeetingInput) => {
      if (input.deleted) {
        row.deletedAt = input.deleted.at;
        row.deletedByUserId = input.deleted.byUserId;
      }
      if (input.cancelledAt !== undefined) row.cancelledAt = input.cancelledAt;
      return row;
    },
  } as unknown as MeetingsRepository;
  const projects = {} as unknown as ProjectsRepository;
  return new MeetingsService(database, repository, projects);
}

function meeting(cancelled: boolean): MeetingRow {
  return {
    id: 'meeting-0000-0000-0000-000000000001',
    organizationId: ORG,
    projectId: PROJECT,
    title: 'LIVECHECK',
    startsAt: new Date('2026-11-09T15:30:00Z'),
    cancelledAt: cancelled ? new Date('2026-11-09T15:00:00Z') : null,
    deletedAt: null,
    deletedByUserId: null,
    createdByUserId: USER,
  } as unknown as MeetingRow;
}

describe('removing a meeting', () => {
  it('soft-deletes a cancelled meeting, after which it is not found', async () => {
    const row = meeting(true);
    const service = serviceWith(row);
    await service.remove(context, principal, row.id);
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row.deletedByUserId).toBe(USER);
    await expect(service.remove(context, principal, row.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses a meeting that is not cancelled (409) and writes nothing', async () => {
    const row = meeting(false);
    const service = serviceWith(row);
    const error = await service.remove(context, principal, row.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect(row.deletedAt).toBeNull();
  });
});
