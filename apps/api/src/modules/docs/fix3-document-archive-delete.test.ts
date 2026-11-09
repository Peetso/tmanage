import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { DocumentsService, DOCUMENT_RESTORE_DAYS } from './documents.service.js';
import type { DocumentsRepository } from './documents.repository.js';
import type { DocumentVersionsRepository } from './document-versions.repository.js';
import type { DocumentTemplatesRepository } from './document-templates.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DocumentRow } from '../../common/database/schema.js';

/**
 * FIX3 item 6 (live check a6f66e47 D4) — archive, bring back and delete a doc, database-free. The
 * same relation check as editing (a non-member is 404 and nothing is written), one audit row per
 * change carrying ids only, and a deleted doc answers 404 from then on.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const OTHER_PROJECT = 'project-0000-0000-0000-0000-000000000002';
const USER = 'user-0000-0000-0000-0000-000000000001';
const DOC = 'document-0000-0000-0000-000000000001';
const SEEN = new Date('2026-11-09T09:00:00.000Z');

function member(projectIds: readonly string[]): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function harness() {
  const row: { current: DocumentRow } = {
    current: {
      id: DOC,
      organizationId: ORG,
      projectId: PROJECT,
      title: 'Brief',
      body: '\n',
      createdByUserId: USER,
      createdAt: SEEN,
      updatedAt: SEEN,
      archivedAt: null,
      deletedAt: null,
    } as DocumentRow,
  };
  const audits: { action: string }[] = [];
  const restoreWindows: number[] = [];
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const documents = {
    findById: async (_r: unknown, _c: unknown, id: string) =>
      id === row.current.id ? row.current : null,
    requireById: async () => row.current,
    setArchived: async (_r: unknown, _c: unknown, _id: string, archived: boolean) => {
      row.current = { ...row.current, archivedAt: archived ? SEEN : null };
    },
    softDelete: async (_r: unknown, _c: unknown, _id: string, days: number) => {
      restoreWindows.push(days);
      row.current = { ...row.current, deletedAt: SEEN };
    },
  } as unknown as DocumentsRepository;
  const audit = {
    record: async (_tx: unknown, _c: unknown, input: { action: string }) => {
      audits.push(input);
    },
  } as unknown as AuditService;
  const service = new DocumentsService(
    database,
    documents,
    {} as ProjectsRepository,
    {} as DocumentVersionsRepository,
    {} as DocumentTemplatesRepository,
    audit,
  );
  return { service, row, audits, restoreWindows };
}

describe('documents: archive and delete (FIX3 item 6)', () => {
  it('archives and brings back, once each, and shows archivedAt only while archived', async () => {
    const { service, audits } = harness();
    const archived = await service.setArchived(context, member([PROJECT]), DOC, true);
    expect(archived.archivedAt).toBe(SEEN.toISOString());
    // Idempotent: archiving again writes nothing.
    await service.setArchived(context, member([PROJECT]), DOC, true);
    const back = await service.setArchived(context, member([PROJECT]), DOC, false);
    expect(back.archivedAt).toBeUndefined();
    expect(audits.map((entry) => entry.action)).toEqual([
      'document.archived',
      'document.unarchived',
    ]);
  });

  it('refuses a non-member with 404 and writes nothing', async () => {
    const { service, audits, row } = harness();
    await expect(
      service.setArchived(context, member([OTHER_PROJECT]), DOC, true),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.softDelete(context, member([OTHER_PROJECT]), DOC)).rejects.toMatchObject({
      status: 404,
    });
    expect(audits).toEqual([]);
    expect(row.current.deletedAt).toBeNull();
  });

  it('a deleted doc keeps a restore window and answers 404 afterwards', async () => {
    const { service, audits, restoreWindows } = harness();
    await service.softDelete(context, member([PROJECT]), DOC);
    expect(restoreWindows).toEqual([DOCUMENT_RESTORE_DAYS]);
    expect(audits.map((entry) => entry.action)).toEqual(['document.deleted']);
    await expect(service.get(context, member([PROJECT]), DOC)).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.softDelete(context, member([PROJECT]), DOC)).rejects.toMatchObject({
      status: 404,
    });
  });
});
