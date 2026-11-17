import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { FileAssetRow } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { DEFAULT_PRESETS } from './file-safety.js';
import { FileClientRelation } from './file-client-relation.js';
import { FilesService } from './files.service.js';
import { mayDownloadFor, mayUploadFor } from './purpose-policy.js';

/**
 * 55-14a — a client sends a file to their own project from the portal's Files page (purpose
 * `client_upload`). The upload door holds it to the client's own projects and the blocked-type
 * rule; the download relation holds it to the uploader's client organization.
 */
const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000b2';
const context = { organizationId: ORG } as unknown as TenantContext;
const client = (clientOrganizationId: string, projectIds = [PROJECT]): Principal => ({
  userId: '00000000-0000-4000-8000-0000000000c1',
  organizationId: ORG,
  kind: 'client',
  role: 'client_member',
  membershipId: '00000000-0000-4000-8000-0000000000e1',
  membershipStatus: 'active',
  clientOrganizationId,
  projectIds,
  hasOrgWideScope: false,
});

function service() {
  const run = (_c: unknown, work: (r: unknown) => unknown) => work({});
  const projects = { findById: vi.fn(async () => ({ id: PROJECT, archivedAt: null })) };
  const safety = {
    read: async () => ({
      presets: DEFAULT_PRESETS,
      maxFileBytes: 100_000,
      requireScanForClients: false,
      scannerPresent: false,
    }),
  };
  return new FilesService(
    { read: run, transaction: run } as never,
    {} as never,
    {} as never,
    {} as never,
    null,
    projects as never,
    {} as never,
    {} as never,
    { uploadMaxBytes: 100_000 } as never,
    { record: vi.fn(async () => undefined) } as never,
    null,
    null,
    null,
    safety,
  );
}

const upload = (projectId: string, fileName: string, mimeType = 'application/pdf') => ({
  projectId,
  purpose: 'client_upload' as const,
  objectId: null,
  fileName,
  mimeType,
  sizeBytes: 1_000,
  contentHash: null,
  audience: 'client_visible' as const,
  idempotencyKey: 'key-0123456789abcdef',
});

describe('55-14a client portal upload', () => {
  it('is a client purpose the team reads, never a studio upload', () => {
    expect(mayUploadFor('client', 'client_upload')).toBe(true);
    expect(mayUploadFor('internal', 'client_upload')).toBe(false);
    expect(mayDownloadFor('internal', 'client_upload')).toBe(true);
  });

  it("refuses a project outside the client's own with the 404 of an unknown id", async () => {
    await expect(
      service().createForClient(context, client('acme'), upload(OTHER_PROJECT, 'brief.pdf')),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a blocked type before anything is reserved', async () => {
    await expect(
      service().createForClient(context, client('acme'), upload(PROJECT, 'setup.exe')),
    ).rejects.toMatchObject({ status: 422, code: 'file_not_allowed' });
  });

  it("lets only the uploader's client organization reach the file", async () => {
    const asset = {
      purpose: 'client_upload',
      projectId: PROJECT,
      clientOrganizationId: 'acme',
      audience: 'client_visible',
      objectId: null,
    } as unknown as FileAssetRow;
    const relation = new FileClientRelation({} as never, {} as never);
    expect(await relation.reach({} as never, context, client('acme'), asset)).toMatchObject({
      via: 'client_upload',
    });
    expect(await relation.reach({} as never, context, client('globex'), asset)).toBeNull();
    expect(await relation.reach({} as never, context, client('acme', []), asset)).toBeNull();
  });
});
