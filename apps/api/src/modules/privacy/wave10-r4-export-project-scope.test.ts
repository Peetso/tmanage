import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ObjectStore } from '@tmanage/storage';
import { analyzeStatement } from '../../common/database/tenant-guard.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ArchiveFileContents, projectReadable } from './privacy-archive-files.repository.js';

/**
 * Wave 10 R4 — N03: a member's own data export carried the bytes of files from projects they had
 * been removed from. The personal export now asks, in the same tenant read, whether the subject can
 * still read each file's project; a file they cannot is listed as `no_project_access` with nothing
 * of the file in it. The company export is unchanged.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2';
const MEMBER = '00000000-0000-4000-8000-0000000000c1';
const context = { organizationId: ORG, correlationId: 'c' } as unknown as TenantContext;

function versionRow(fileAssetId: string, objectKey: string) {
  return {
    id: `v-${fileAssetId}`,
    organizationId: ORG,
    fileAssetId,
    versionNo: 1,
    objectKey,
    sizeBytes: 5,
    declaredMimeType: 'application/pdf',
    detectedMimeType: 'application/pdf',
    contentHash: null,
    scanVerdict: 'clean',
    scannedAt: null,
    scanner: null,
    trustZone: 'private',
    etag: null,
    createdAt: new Date(0),
  };
}

/** A scripted tenant database: the asset page from `assets`, the versions from `versions`. */
function scripted(assets: readonly Record<string, unknown>[]) {
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const versionReads: string[][] = [];
  const database = {
    read: (_c: unknown, work: (runner: unknown) => unknown) =>
      work({
        query: (sql: string, params: readonly unknown[]) => {
          statements.push({ sql, params });
          return Promise.resolve(params[1] === '' ? assets : []);
        },
      }),
  } as unknown as TenantDatabase;
  const reader = new ArchiveFileContents(
    database,
    {
      openObject: ({ objectKey }: { objectKey: string }) =>
        Promise.resolve({ sizeBytes: 5, stream: Readable.from([Buffer.from(objectKey)]) }),
    } as unknown as Pick<ObjectStore, 'openObject'>,
    undefined,
    () => Promise.resolve('allow_labeled'),
  );
  // The drizzle version read is replaced by the fixture, recording which ids were asked for.
  (reader as unknown as { latestVersions: unknown }).latestVersions = (
    _c: unknown,
    ids: readonly string[],
  ) => {
    versionReads.push([...ids]);
    return Promise.resolve(new Map(ids.map((id) => [id, versionRow(id, 'hello')])));
  };
  return { reader, statements, versionReads };
}

describe('N03 — a personal export leaves out files of projects the subject left', () => {
  it('withholds f1 (removed from its project) with no name, size or bytes, and keeps f2', async () => {
    const { reader, statements, versionReads } = scripted([
      { id: 'f1', name: 'secret-plan.pdf', status: 'ready', project_readable: 0 },
      { id: 'f2', name: 'still-on.pdf', status: 'ready', project_readable: 1 },
    ]);
    const rows = await reader.read(context, MEMBER);

    expect(rows[0]).toEqual({ file_id: 'f1', included: false, left_out: 'no_project_access' });
    expect(JSON.stringify(rows[0])).not.toContain('secret-plan');
    expect(rows[0]).not.toHaveProperty('content_base64');
    expect(rows[0]).not.toHaveProperty('size_bytes');
    expect(rows[1]).toMatchObject({
      file_id: 'f2',
      name: 'still-on.pdf',
      included: true,
      content_base64: Buffer.from('hello').toString('base64'),
    });
    // The withheld file's versions are never even read, so its object is never opened.
    expect(versionReads).toEqual([['f2']]);

    // The decision is made in SQL, in the same tenant read, organization predicate first.
    const sql = statements[0]?.sql ?? '';
    expect(sql).toMatch(
      /where fa\.organization_id = \? and fa\.id > \? and fa\.owner_user_id = \?/u,
    );
    expect(sql).toContain('project_memberships pm');
    expect(sql).toContain('pm.user_id = fa.owner_user_id');
    expect(sql).toContain('m.has_org_wide_scope = 1');
    expect(sql).toContain("m.status = 'active'");
    expect(statements[0]?.params).toEqual([ORG, '', MEMBER]);
  });

  it("includes every file of an org-wide owner's own export (their scope reads every project)", async () => {
    const { reader } = scripted([
      { id: 'f1', name: 'a.pdf', status: 'ready', project_readable: 1 },
      { id: 'f2', name: 'b.pdf', status: 'ready', project_readable: '1' },
    ]);
    const rows = await reader.read(context, MEMBER);
    expect(rows.map((row) => row.included)).toEqual([true, true]);
  });

  it('fails closed: a missing or unexpected verdict on a personal export withholds the file', () => {
    expect(projectReadable({ project_readable: null })).toBe(false);
    expect(projectReadable({ project_readable: 0 })).toBe(false);
    expect(projectReadable({ project_readable: '0' })).toBe(false);
    expect(projectReadable({ project_readable: 1 })).toBe(true);
  });

  it('leaves the company export unchanged: every file, no project-access column', async () => {
    const { reader, statements } = scripted([{ id: 'f1', name: 'a.pdf', status: 'ready' }]);
    const rows = await reader.read(context, null);
    expect(rows[0]).toMatchObject({ file_id: 'f1', name: 'a.pdf', included: true });
    expect(statements[0]?.sql).not.toContain('project_readable');
    expect(statements[0]?.params).toEqual([ORG, '']);
  });

  it('passes the tenant guard for its own organization and is refused for another', async () => {
    const { reader, statements } = scripted([]);
    await reader.read(context, MEMBER);
    const { sql, params } = statements[0] ?? { sql: '', params: [] };
    expect(analyzeStatement(sql, params, ORG).violations).toEqual([]);
    expect(analyzeStatement(sql, params, OTHER_ORG).violations.length).toBeGreaterThan(0);
  });
});
