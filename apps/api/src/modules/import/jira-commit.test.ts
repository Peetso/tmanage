import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ImportService } from './import.service.js';
import type { ImportJobsRepository } from './import-jobs.repository.js';
import type { ImportRowsRepository } from './import-rows.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { WorkspacesRepository } from '../tenancy/workspaces.repository.js';
import type { JiraCommitDeps } from './jira-commit.js';
import { parseImportCommitBody } from './import-input.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';

const CONTEXT = { organizationId: 'org-1', userId: 'user-1' } as TenantContext;
const JOB_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_PROJECT_ID = '00000000-0000-4000-8000-0000000000a2';
const MAPPING = { issueKey: 'Key', summary: 'Summary', issueType: 'Type' };

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

function makeService(prefixHolder: string | null): { service: ImportService; inserts: string[] } {
  const inserts: string[] = [];
  const runner = {} as never;
  const database = {
    read: <T>(_c: TenantContext, work: (r: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (r: never) => Promise<T>): Promise<T> => work(runner),
  } as unknown as TenantDatabase;
  const jobs = {
    findById: async () => ({ id: JOB_ID, sourceKind: 'jira_issues', status: 'validated' }),
    markCommitted: async () => ({}),
  } as unknown as ImportJobsRepository;
  const rows = { create: async () => ({}) } as unknown as ImportRowsRepository;
  const projects = {
    findById: async (_r: unknown, _c: unknown, id: string) => ({
      id,
      name: id === OTHER_PROJECT_ID ? 'Website' : 'Target',
      archivedAt: null,
    }),
  } as unknown as ProjectsRepository;
  const deps = {
    workKeys: {
      findProject: async () => ({
        id: PROJECT_ID,
        archivedAt: null,
        workKeyPrefix: null,
        workKeyNext: 1,
      }),
      projectWithPrefix: async () => prefixHolder,
      setPrefix: async () => {
        inserts.push('prefix');
      },
      reserve: async () => 1,
      setWorkKey: async () => undefined,
      resolveKeys: async () => new Map(),
    },
    workItems: {
      create: async () => {
        inserts.push('item');
        return { id: 'wi-1', version: 1 };
      },
      transitionState: async () => ({ version: 2 }),
    },
    iterations: {
      listForProject: async () => [],
      insert: async () => 'it-1',
      assignItems: async () => 1,
    },
    labels: {
      findDefinitionByName: async () => null,
      createDefinition: async () => ({ id: 'label-1' }),
      createAssignment: async () => ({}),
    },
    memberships: { findByUserId: async () => null },
    now: () => new Date('2026-11-02T00:00:00.000Z'),
  } as unknown as JiraCommitDeps;
  const service = new ImportService(
    database,
    jobs,
    rows,
    projects,
    {} as WorkspacesRepository,
    deps,
  );
  return { service, inserts };
}

function request(rows: readonly Record<string, unknown>[]) {
  return {
    jobId: JOB_ID,
    sourceKind: 'jira_issues' as const,
    mapping: MAPPING,
    rows,
    jira: { projectId: PROJECT_ID, keepKeys: true, statusMap: {}, userMap: {} },
  };
}

describe('ImportService.commit — jira_issues (R21-e)', () => {
  it('refuses keepKeys with a 409 when another project holds the prefix, before any insert', async () => {
    const { service, inserts } = makeService(OTHER_PROJECT_ID);
    const error = await service
      .commit(CONTEXT, OWNER, request([{ Key: 'WEB-1', Summary: 'a', Type: 'Task' }]))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).message).toContain('Website');
    expect(inserts).toEqual([]);
  });

  it('creates no item for an Epic row and keeps the key of the rest', async () => {
    const { service, inserts } = makeService(null);
    const view = await service.commit(
      CONTEXT,
      OWNER,
      request([
        { Key: 'WEB-1', Summary: 'Checkout', Type: 'Epic' },
        { Key: 'WEB-2', Summary: 'Cart', Type: 'Story' },
      ]),
    );
    expect(inserts).toEqual(['prefix', 'item']);
    expect(view.jira?.epicsSkipped).toBe(1);
    expect(view.jira?.itemsKeyed).toBe(1);
  });

  it('refuses 1 001 rows with a 400 at the body boundary, as today', () => {
    const details: { field: string; message: string }[] = [];
    const rows = Array.from({ length: 1001 }, (_, i) => ({ Key: `WEB-${i + 1}`, Summary: 'x' }));
    const parsed = parseImportCommitBody(
      {
        jobId: JOB_ID,
        sourceKind: 'jira_issues',
        mapping: MAPPING,
        rows,
        options: { projectId: PROJECT_ID },
      },
      details,
    );
    expect(parsed).toBeUndefined();
    expect(details.map((d) => d.field)).toContain('rows');
  });
});
