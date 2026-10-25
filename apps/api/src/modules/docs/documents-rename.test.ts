import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { DocumentsService } from './documents.service.js';
import type { DocumentsRepository } from './documents.repository.js';
import type { DocumentVersionsRepository } from './document-versions.repository.js';
import type { DocumentTemplatesRepository } from './document-templates.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DocumentRow } from '../../common/database/schema.js';

/**
 * B4 — `DocumentsService.rename`, database-free. The subject is the service's own decisions: the
 * same relation check as saving a version (a non-member is 404), the optimistic `expectedUpdatedAt`
 * (stale → 409, nothing written), and that a successful rename writes exactly one audit row and
 * one `document.renamed.v1` event carrying ids only — never the title.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const OTHER_PROJECT = 'project-0000-0000-0000-0000-000000000002';
const USER = 'user-0000-0000-0000-0000-000000000001';
const DOC = 'document-0000-0000-0000-000000000001';
const SEEN = new Date('2026-10-23T09:00:00.000Z');

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
      title: 'Untitled doc',
      body: '\n',
      createdByUserId: USER,
      createdAt: SEEN,
      updatedAt: SEEN,
    } as DocumentRow,
  };
  const audits: unknown[] = [];
  const events: unknown[] = [];
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const documents = {
    findById: async (_r: unknown, _c: unknown, id: string) =>
      id === row.current.id ? row.current : null,
    requireById: async () => row.current,
    rename: async (_r: unknown, c: TenantContext, _id: string, expected: Date, title: string) => {
      if (expected.getTime() !== row.current.updatedAt.getTime()) return false;
      row.current = {
        ...row.current,
        title,
        titleUpdatedByUserId: c.userId,
        updatedAt: new Date(row.current.updatedAt.getTime() + 1000),
      };
      return true;
    },
  } as unknown as DocumentsRepository;
  const audit = {
    record: async (_tx: unknown, _c: unknown, input: unknown) => {
      audits.push(input);
    },
  } as unknown as AuditService;
  const outbox = {
    append: async (_tx: unknown, _c: unknown, input: unknown) => {
      events.push(input);
      return 'event-1';
    },
  } as unknown as OutboxEventsRepository;
  const service = new DocumentsService(
    database,
    documents,
    {} as ProjectsRepository,
    {} as DocumentVersionsRepository,
    {} as DocumentTemplatesRepository,
    audit,
    outbox,
  );
  return { service, row, audits, events };
}

describe('DocumentsService.rename (B4)', () => {
  it('renames on a fresh version, audits and emits ids only; a stale version is 409; a non-member is 404', async () => {
    const { service, row, audits, events } = harness();

    const renamed = await service.rename(context, member([PROJECT]), DOC, {
      title: 'Kickoff notes',
      expectedUpdatedAt: SEEN.toISOString(),
    });
    expect(renamed.title).toBe('Kickoff notes');
    expect(renamed.updatedAt).not.toBe(SEEN.toISOString());
    expect(audits).toEqual([
      {
        action: 'document.renamed',
        objectId: DOC,
        result: 'allowed',
        metadata: { project_id: PROJECT },
      },
    ]);
    expect(events).toEqual([
      {
        type: 'document.renamed.v1',
        aggregateId: DOC,
        payload: { documentId: DOC, projectId: PROJECT },
      },
    ]);
    expect(JSON.stringify([audits, events])).not.toContain('Kickoff');

    // The same, now-stale version again: 409 and nothing more is written.
    const stale = await service
      .rename(context, member([PROJECT]), DOC, {
        title: 'Overwrite',
        expectedUpdatedAt: SEEN.toISOString(),
      })
      .catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(ApiError);
    expect((stale as ApiError).status).toBe(409);
    expect(row.current.title).toBe('Kickoff notes');

    // Not a member of the document's project: the same 404 as an unknown id, and no write.
    const hidden = await service
      .rename(context, member([OTHER_PROJECT]), DOC, {
        title: 'Probe',
        expectedUpdatedAt: row.current.updatedAt.toISOString(),
      })
      .catch((error: unknown) => error);
    expect(hidden).toBeInstanceOf(ApiError);
    expect((hidden as ApiError).status).toBe(404);
    expect(row.current.title).toBe('Kickoff notes');
    expect(audits).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('F2: the view names who last renamed it, and a never-renamed document carries no renamer', async () => {
    const { service } = harness();
    const before = await service.get(context, member([PROJECT]), DOC);
    expect(before).not.toHaveProperty('titleUpdatedByUserId');

    const renamed = await service.rename(context, member([PROJECT]), DOC, {
      title: 'Atlas brief',
      expectedUpdatedAt: SEEN.toISOString(),
    });
    expect(renamed.titleUpdatedByUserId).toBe(USER);
  });
});
