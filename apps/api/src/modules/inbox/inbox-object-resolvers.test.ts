import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { FileAssetRow, ProjectRow } from '../../common/database/schema.js';
import { createInboxObjectResolvers, isCollaborationObjectType } from './inbox-object-resolvers.js';

/**
 * R4 slice 12 — the inbox's reader for a file under review. It shows the file's name only when the
 * download gate's own rule passes for this person, and drops the bundle otherwise.
 */

const ORG = 'org-1';
const context = { organizationId: ORG } as TenantContext;

const database = {
  async read<T>(_context: TenantContext, work: (runner: TenantQueryRunner) => Promise<T>) {
    return work({} as TenantQueryRunner);
  },
} as unknown as TenantDatabase;

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'maya',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: 'membership-maya',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: ['proj-1'],
    hasOrgWideScope: false,
    ...overrides,
  } as Principal;
}

function asset(overrides: Partial<FileAssetRow> = {}): FileAssetRow {
  return {
    id: 'file-1',
    organizationId: ORG,
    projectId: 'proj-1',
    clientOrganizationId: null,
    ownerUserId: 'lina',
    name: 'Homepage Concept.png',
    purpose: 'message_attachment',
    objectId: null,
    audience: 'internal',
    status: 'ready',
    deletedAt: null,
    ...overrides,
  } as FileAssetRow;
}

function resolversFor(row: FileAssetRow | null, archived = false) {
  return createInboxObjectResolvers({
    database,
    conversations: { get: () => Promise.reject(new Error('unused')) },
    documents: { get: () => Promise.reject(new Error('unused')) },
    meetings: { get: () => Promise.reject(new Error('unused')) },
    projects: { get: () => Promise.reject(new Error('unused')) },
    files: { findById: () => Promise.resolve(row) },
    projectRows: {
      findById: () =>
        Promise.resolve({ id: 'proj-1', archivedAt: archived ? new Date() : null } as ProjectRow),
    },
  });
}

describe('file_asset inbox reader', () => {
  it('is a bundle object type', () => {
    expect(isCollaborationObjectType('file_asset')).toBe(true);
  });

  it('names the file for a team member on its project', async () => {
    const read = resolversFor(asset()).file_asset;
    expect(await read?.(context, principal(), 'file-1')).toEqual({
      title: 'Homepage Concept.png',
      state: 'file',
      projectId: 'proj-1',
    });
  });

  it('drops a file off the person’s projects, a deleted file and a missing one', async () => {
    expect(
      await resolversFor(asset()).file_asset?.(context, principal({ projectIds: [] }), 'file-1'),
    ).toBeNull();
    expect(
      await resolversFor(asset({ deletedAt: new Date() })).file_asset?.(
        context,
        principal(),
        'file-1',
      ),
    ).toBeNull();
    expect(await resolversFor(null).file_asset?.(context, principal(), 'file-1')).toBeNull();
  });

  it('never answers a client principal: the studio inbox is not theirs', async () => {
    const client = principal({
      kind: 'client',
      role: 'client_reviewer',
      clientOrganizationId: 'client-1',
    } as Partial<Principal>);
    expect(await resolversFor(asset()).file_asset?.(context, client, 'file-1')).toBeNull();
  });
});
