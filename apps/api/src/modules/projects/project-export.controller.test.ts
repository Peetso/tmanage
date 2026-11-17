import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectRow, WorkItemRow } from '../../common/database/schema.js';
import type { ProjectsRepository } from './projects.repository.js';
import type { ProjectExportRepository } from './project-export.repository.js';
import { ProjectExportController } from './project-export.controller.js';
import { ProjectExportService } from './project-export.service.js';

/**
 * 54-29 — the per-project export over fakes, with the **real** `authorize`: format allow-list,
 * the tenant refusal (another workspace's project is a 404 with nothing read or audited), the
 * `work.export` refusal on the project (a member who can read but not export gets 403), the
 * CSV formula guard and the safe download headers.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = '01900000-0000-7000-8000-000000000001';
const USER = '01900000-0000-7000-8000-0000000000aa';

function principal(role: 'owner' | 'member', projectIds: string[] = []): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: role === 'owner',
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function item(title: string): WorkItemRow {
  return {
    id: '01900000-0000-7000-8000-0000000000b1',
    projectId: PROJECT,
    organizationId: ORG,
    title,
    description: '@SUM(A1)',
    state: 'in_progress',
    ownerUserId: USER,
    startAt: null,
    dueAt: new Date('2026-12-01T00:00:00.000Z'),
  } as unknown as WorkItemRow;
}

function build(projectOrg = ORG) {
  const audits: unknown[] = [];
  const reads: string[] = [];
  const database = {
    read: async (_c: unknown, work: (runner: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const projects = {
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      id === PROJECT && ctx.organizationId === projectOrg
        ? ({
            id: PROJECT,
            organizationId: ctx.organizationId,
            name: 'Rebrand "Q4"/x',
            archivedAt: null,
          } as ProjectRow)
        : null,
  } as unknown as ProjectsRepository;
  const rows = {
    listItems: async () => {
      reads.push('items');
      return [item('=HYPERLINK("http://evil")')];
    },
    labelsByItem: async () => new Map([['01900000-0000-7000-8000-0000000000b1', ['Design']]]),
    ownerEmails: async () => new Map([[USER, 'sara@example.com']]),
  } as unknown as ProjectExportRepository;
  const service = new ProjectExportService(
    database,
    { recordStandalone: async (_c: unknown, input: unknown) => void audits.push(input) } as never,
    projects,
    rows,
    () => new Date('2026-11-17T10:00:00.000Z'),
  );
  const headers: Record<string, string> = {};
  const reply = { header: (name: string, value: string) => void (headers[name] = value) };
  return { controller: new ProjectExportController(service), audits, reads, headers, reply };
}

async function textOf(file: { getStream(): AsyncIterable<unknown> }): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of file.getStream()) parts.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(parts).toString('utf-8');
}

async function refusal(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('GET …/projects/:projectId/export', () => {
  it('writes a formula-guarded CSV with ClickUp columns and a slug file name', async () => {
    const { controller, audits, headers, reply } = build();
    const file = await controller.export(context, principal('owner'), PROJECT, reply, 'csv');
    const text = await textOf(file);
    expect(text.startsWith('﻿Task ID,Task Name,Status,Assignees,')).toBe(true);
    expect(text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(text).toContain("'@SUM(A1)");
    expect(text).toContain('In progress,sara@example.com');
    expect(headers['content-disposition']).toBe(
      'attachment; filename="rebrand-q4-x-2026-11-17.csv"',
    );
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(audits).toEqual([
      expect.objectContaining({ action: 'project.exported', objectId: PROJECT }),
    ]);
  });

  it('writes versioned JSON', async () => {
    const { controller, reply } = build();
    const file = await controller.export(context, principal('owner'), PROJECT, reply, 'json');
    const doc = JSON.parse(await textOf(file));
    expect(doc).toMatchObject({ kind: 'tmanage.project-export', version: 1 });
    expect(doc.items[0]).toMatchObject({ state: 'in_progress', labels: ['Design'] });
  });

  it('refuses a format outside the allow-list before any read', async () => {
    const { controller, reads, reply } = build();
    for (const format of [undefined, 'xlsx', 'CSV', 'csv;']) {
      expect(
        await refusal(controller.export(context, principal('owner'), PROJECT, reply, format)),
      ).toBe(400);
    }
    expect(reads).toEqual([]);
  });

  it("answers 404 for another workspace's project, reading and auditing nothing", async () => {
    const { controller, reads, audits, reply } = build(OTHER_ORG);
    expect(
      await refusal(controller.export(context, principal('owner'), PROJECT, reply, 'csv')),
    ).toBe(404);
    expect(reads).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('answers 403 to a project member without work.export', async () => {
    const { controller, reads, reply } = build();
    expect(
      await refusal(
        controller.export(context, principal('member', [PROJECT]), PROJECT, reply, 'csv'),
      ),
    ).toBe(403);
    expect(reads).toEqual([]);
  });

  it('answers 404 to a member of the workspace who is not on the project', async () => {
    const { controller, reply } = build();
    expect(
      await refusal(controller.export(context, principal('member'), PROJECT, reply, 'csv')),
    ).toBe(404);
  });
});
