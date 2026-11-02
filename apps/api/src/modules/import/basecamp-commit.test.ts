import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { commitBasecampBatch, undoImportedEntities } from './basecamp-commit.js';
import type { ImportCommitDeps, UndoDeps } from './basecamp-commit.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext } from '../../common/database/tenant-context.js';

const CONTEXT = { organizationId: 'org-1', userId: 'user-1' } as TenantContext;
const PROJECT_ID = '00000000-0000-4000-8000-0000000000a1';
const OWNER: Principal = {
  userId: 'user-1',
  organizationId: 'org-1',
  kind: 'internal',
  role: 'owner',
  membershipId: 'm-1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
};
const tx = {} as never;
const projects = {
  findById: async (_r: unknown, _c: unknown, id: string) => ({ id, archivedAt: null }),
} as unknown as Pick<ProjectsRepository, 'findById'>;

describe('commitBasecampBatch', () => {
  it('creates a document and an item, and counts a campfire row as skipped', async () => {
    const calls: string[] = [];
    const deps = {
      documents: {
        create: async (_t: unknown, _c: unknown, input: { body: string }) => {
          calls.push(`doc:${input.body.split('\n')[0]}`);
          return { id: 'doc-1' };
        },
      },
      workItems: {
        create: async () => {
          calls.push('item');
          return { id: 'item-1', version: 1 };
        },
        transitionState: async () => ({ version: 2 }),
      },
      phases: { listDefinitions: async () => [], createDefinition: async () => ({ id: 'ph' }) },
      labels: {},
      memberships: { findByUserId: async () => null, listWithNames: async () => [] },
      now: () => new Date('2026-03-10T00:00:00Z'),
    } as unknown as ImportCommitDeps;
    const rows = [
      { kind: 'message', path: 'm/1.html', title: 'Kickoff', html: '<p>Hi</p>' },
      { kind: 'todo', title: 'Ship it', assignee: 'Nobody', dueAt: '2026-03-20' },
      { kind: 'campfire' },
    ];
    const { results, summary } = await commitBasecampBatch(
      tx,
      CONTEXT,
      OWNER,
      {
        mapping: {},
        rows,
        options: { projectId: PROJECT_ID, statusMap: {}, userMap: {} },
        invalidDetail: () => null,
      },
      projects,
      deps,
    );
    expect(calls).toEqual(['doc:Imported from Basecamp: m/1.html', 'item']);
    expect(results).toHaveLength(2);
    expect(summary.basecampSkipped).toEqual({ campfire: 1 });
    expect(summary.documentsCreated).toBe(1);
    expect(summary.notes).toContain('basecamp_person_unmatched:1');
  });
});

describe('undoImportedEntities', () => {
  it('deletes the batch document and work item', async () => {
    const removed: string[] = [];
    const deps: UndoDeps = {
      documents: { remove: async (_t, _c, id) => void removed.push(id) },
      workItems: { softDelete: async (_t, _c, id) => (removed.push(id), {}) as never },
      phases: { deleteDefinition: async () => undefined },
    };
    const outcome = await undoImportedEntities(
      tx,
      CONTEXT,
      [
        { type: 'document', id: 'doc-1' },
        { type: 'work_item', id: 'item-1' },
      ],
      deps,
    );
    expect(outcome.deleted).toBe(2);
    expect(removed).toEqual(['doc-1', 'item-1']);
  });
});
