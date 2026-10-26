import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ObjectStore } from '@tmanage/storage';
import { analyzeStatement } from '../../common/database/tenant-guard.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ArchiveFileContents } from './privacy-archive-files.repository.js';
import {
  FILES_ADDED_PERSONAL_JOINS,
  FILES_ADDED_PROJECT_READABLE,
  PrivacyArchiveBuilder,
} from './privacy-archive.repository.js';
import type { ArchiveDoor, ArchiveHeader } from './privacy-archive.repository.js';

/**
 * Wave 11 Q7 — N03 remainder: the member export's `files_added` section (file_assets rows the
 * subject owns) still listed the names and project ids of files in projects the subject had left,
 * although `file_contents` already withheld them. It now applies the contents rule: only files of
 * projects the subject can read now, and a count of the rest.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2';
const SUBJECT = '00000000-0000-4000-8000-0000000000c1';
const P1 = '00000000-0000-4000-8000-0000000000e1';
const P2 = '00000000-0000-4000-8000-0000000000e2';
const context = { organizationId: ORG, correlationId: 'c' } as unknown as TenantContext;

const header: ArchiveHeader = {
  format: 'tmanage-data-export',
  formatVersion: 1,
  kind: 'member',
  organization: { id: ORG, name: 'Northstar Studio' },
  subjectUserId: SUBJECT,
  generatedAt: new Date(0).toISOString(),
};

/** The subject uploaded to P1 and P2, then left P2: only P1 has a project_memberships row. */
const FILES = [
  { id: 'f-p1-a', project_id: P1, name: 'p1-brief.pdf', status: 'ready', owner_user_id: SUBJECT },
  {
    id: 'f-p2-a',
    project_id: P2,
    name: 'p2-secret-plan.pdf',
    status: 'ready',
    owner_user_id: SUBJECT,
  },
  { id: 'f-p1-b', project_id: P1, name: 'p1-notes.pdf', status: 'ready', owner_user_id: SUBJECT },
  { id: 'f-p2-b', project_id: P2, name: 'p2-budget.xlsx', status: 'ready', owner_user_id: SUBJECT },
].sort((a, b) => a.id.localeCompare(b.id));
const MEMBER_OF = new Set([P1]);

/**
 * A scripted tenant database that answers the statements the way the server would for a member
 * with no org-wide or workspace scope: the project-readable verdict is a live project_memberships
 * row for the file's project. Every statement is recorded.
 */
function scripted() {
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const query = (sql: string, params: readonly unknown[]) => {
    statements.push({ sql, params });
    if (sql.includes('as project_readable')) {
      const after = String(params[1] ?? '');
      return Promise.resolve(
        FILES.filter((file) => file.id > after).map((file) => ({
          id: file.id,
          name: file.name,
          status: file.status,
          project_readable: MEMBER_OF.has(file.project_id) ? 1 : 0,
        })),
      );
    }
    if (sql.includes('from file_assets') && sql.includes(' in (')) {
      const ids = new Set(params.slice(2));
      return Promise.resolve(FILES.filter((file) => ids.has(file.id)).map((file) => ({ ...file })));
    }
    return Promise.resolve([]);
  };
  const database = {
    read: (_c: unknown, work: (runner: unknown) => unknown) => work({ query }),
    identityRead: () => Promise.resolve({ account: [], signIns: [] }),
  } as unknown as TenantDatabase;
  return { database, statements };
}

const done = () => Promise.resolve();

describe('Q7 — files_added leaves out files of projects the subject left', () => {
  it('(i) has P1 rows, no P2 project id or file name, and a withheld count', async () => {
    const { database } = scripted();
    const document = await new PrivacyArchiveBuilder(database).build(context, header, done);
    const rows = document.sections['files_added'] ?? [];

    expect(rows.map((row) => row['id'])).toEqual(['f-p1-a', 'f-p1-b']);
    expect(rows.every((row) => row['project_id'] === P1)).toBe(true);
    const text = JSON.stringify(document);
    expect(text).not.toContain(P2);
    expect(text).not.toContain('p2-secret-plan');
    expect(text).not.toContain('p2-budget');
    expect(text).not.toContain('f-p2-');
    expect(document.withheldSections?.['files_added']).toBe(2);
    expect(document.withheldSections?.['files_added']).toBeGreaterThanOrEqual(1);
  });

  it('applies the same rule through both doors (self and owner)', async () => {
    for (const door of ['self', 'owner'] as ArchiveDoor[]) {
      const { database } = scripted();
      const document = await new PrivacyArchiveBuilder(database).build(context, header, done, door);
      expect((document.sections['files_added'] ?? []).map((row) => row['id'])).toEqual([
        'f-p1-a',
        'f-p1-b',
      ]);
      expect(document.withheldSections?.['files_added']).toBe(2);
    }
  });

  it('(ii) the owner reading matches the file_contents section: same SQL rule, same files kept', async () => {
    const { database, statements } = scripted();
    const contents = new ArchiveFileContents(
      database,
      {
        openObject: () =>
          Promise.resolve({ sizeBytes: 1, stream: Readable.from([Buffer.from('x')]) }),
      } as unknown as Pick<ObjectStore, 'openObject'>,
      undefined,
      () => Promise.resolve('allow_labeled'),
    );
    (contents as unknown as { latestVersions: unknown }).latestVersions = () =>
      Promise.resolve(new Map());
    const builder = new PrivacyArchiveBuilder(database, contents);
    const document = await builder.build(context, header, done, 'owner');

    const contentsKept = (document.sections['file_contents'] ?? [])
      .filter((row) => row['left_out'] !== 'no_project_access')
      .map((row) => row['file_id']);
    const contentsWithheld = (document.sections['file_contents'] ?? []).filter(
      (row) => row['left_out'] === 'no_project_access',
    ).length;
    const filesAdded = (document.sections['files_added'] ?? []).map((row) => row['id']);
    expect(filesAdded).toEqual(contentsKept);
    expect(document.withheldSections?.['files_added']).toBe(contentsWithheld);

    // The very predicate text: the mirror is byte-identical to the contents read's.
    const verdictReads = statements.filter((s) => s.sql.includes('as project_readable'));
    const addedSql = verdictReads.find((s) => !s.sql.includes('fa.name'))?.sql ?? '';
    const contentsSql = verdictReads.find((s) => s.sql.includes('fa.name'))?.sql ?? '';
    expect(contentsSql).toContain(FILES_ADDED_PROJECT_READABLE);
    expect(contentsSql).toContain(FILES_ADDED_PERSONAL_JOINS);
    expect(addedSql).toContain(FILES_ADDED_PROJECT_READABLE);
    expect(addedSql).toContain(FILES_ADDED_PERSONAL_JOINS);
  });

  it('(iii) every statement is parameterised: no literal id in the SQL text, tenant-bound', async () => {
    const { database, statements } = scripted();
    await new PrivacyArchiveBuilder(database).build(context, header, done);
    const fileStatements = statements.filter((s) => s.sql.includes('file_assets'));
    expect(fileStatements.length).toBe(2);
    for (const { sql, params } of fileStatements) {
      for (const literal of [ORG, SUBJECT, P1, P2, ...FILES.map((file) => file.id)]) {
        expect(sql).not.toContain(literal);
      }
      expect(params[0]).toBe(ORG);
      expect(params).toContain(SUBJECT);
      expect(sql).not.toMatch(/\bwith\b/iu);
      expect(analyzeStatement(sql, params, ORG).violations).toEqual([]);
      expect(analyzeStatement(sql, params, OTHER_ORG).violations.length).toBeGreaterThan(0);
    }
    expect(fileStatements[1]?.params).toEqual([ORG, SUBJECT, 'f-p1-a', 'f-p1-b']);
  });

  it('fails closed: an unexpected verdict withholds the row', async () => {
    const statements: string[] = [];
    const database = {
      read: (_c: unknown, work: (runner: unknown) => unknown) =>
        work({
          query: (sql: string) => {
            statements.push(sql);
            if (sql.includes('as project_readable')) {
              return Promise.resolve([
                { id: 'f1', project_readable: null },
                { id: 'f2', project_readable: '0' },
                { id: 'f3', project_readable: 'yes' },
              ]);
            }
            return Promise.resolve([]);
          },
        }),
      identityRead: () => Promise.resolve({ account: [], signIns: [] }),
    } as unknown as TenantDatabase;
    const document = await new PrivacyArchiveBuilder(database).build(context, header, done);
    expect(document.sections['files_added']).toEqual([]);
    expect(document.withheldSections?.['files_added']).toBe(3);
    expect(statements.some((sql) => sql.includes(' in ('))).toBe(false);
  });

  it('leaves the company export unchanged: every file, no withheld note', async () => {
    const { database, statements } = scripted();
    const document = await new PrivacyArchiveBuilder(database).build(
      context,
      { ...header, kind: 'company', subjectUserId: null },
      done,
    );
    expect(document.withheldSections).toBeUndefined();
    expect(statements.some((s) => s.sql.includes('as project_readable'))).toBe(false);
  });
});
