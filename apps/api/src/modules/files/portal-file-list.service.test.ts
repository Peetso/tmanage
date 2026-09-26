import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { PortalFileListService } from './portal-file-list.service.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileVersionRow } from '../../common/database/schema.js';
import { ApiError } from '../../common/http/errors.js';

/**
 * FILE-003 · WEB-006 — the client file list's three gates, `authorize()` exercised for real.
 *
 * The fakes stand in only for the database and the join query; the relation rule (rule 10) and the
 * per-row client-organization / servable checks run exactly as they would in production. Each case
 * pins a boundary the download door already enforces, so the list can never disagree with it.
 */

const ORG = 'org-under-test';
const CLIENT_ORG = 'client-org-under-test';
const SIBLING_CLIENT_ORG = 'sibling-client-org';
const READABLE_PROJECT = 'project-readable';

function clientPrincipal(readableProjectId: string): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG,
    kind: 'client',
    role: 'client_viewer',
    membershipId: 'membership-1',
    membershipStatus: 'active',
    clientOrganizationId: CLIENT_ORG,
    projectIds: [readableProjectId],
    hasOrgWideScope: false,
  };
}

function internalPrincipal(): Principal {
  return {
    userId: 'staff-1',
    organizationId: ORG,
    kind: 'internal',
    role: 'admin',
    membershipId: 'm-staff',
    membershipStatus: 'active',
    projectIds: [READABLE_PROJECT],
    hasOrgWideScope: true,
  } as unknown as Principal;
}

const context = {} as TenantContext;

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_context: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
  } as unknown as TenantDatabase;
}

type Candidate = {
  readonly asset: FileAssetRow;
  readonly version: FileVersionRow | null;
  readonly request: {
    readonly id: string;
    readonly projectId: string;
    readonly clientOrganizationId: string;
  };
};

function candidate(options: {
  readonly id: string;
  readonly projectId?: string;
  readonly requestClientOrganizationId: string;
  readonly status?: string;
  readonly scanVerdict?: string | null;
  readonly trustZone?: string;
  readonly withVersion?: boolean;
}): Candidate {
  const projectId = options.projectId ?? READABLE_PROJECT;
  const asset = {
    id: options.id,
    organizationId: ORG,
    projectId,
    name: `File ${options.id}`,
    purpose: 'request_attachment',
    objectId: `req-${options.id}`,
    status: options.status ?? 'ready',
    createdAt: new Date('2026-09-19T00:00:00.000Z'),
  } as unknown as FileAssetRow;
  const version =
    options.withVersion === false
      ? null
      : ({
          sizeBytes: 1234,
          detectedMimeType: 'application/pdf',
          declaredMimeType: 'application/pdf',
          scanVerdict: options.scanVerdict === undefined ? 'clean' : options.scanVerdict,
          trustZone: options.trustZone ?? 'private',
        } as unknown as FileVersionRow);
  return {
    asset,
    version,
    request: {
      id: `req-${options.id}`,
      projectId,
      clientOrganizationId: options.requestClientOrganizationId,
    },
  };
}

function serviceWith(rows: readonly Candidate[]): PortalFileListService {
  const assets = {
    listRequestAttachmentsForProject: () => Promise.resolve(rows),
  } as unknown as FileAssetsRepository;
  return new PortalFileListService(fakeDatabase(), assets);
}

describe('PortalFileListService.listForClient', () => {
  it('lists a client-org servable file and hides a sibling client and an unpublished one', async () => {
    const service = serviceWith([
      candidate({ id: 'own-clean', requestClientOrganizationId: CLIENT_ORG }),
      // The audience guard: another client's attachment in the same shared project.
      candidate({ id: 'sibling', requestClientOrganizationId: SIBLING_CLIENT_ORG }),
      // Not yet published: still scanning, so no servable version.
      candidate({
        id: 'scanning',
        requestClientOrganizationId: CLIENT_ORG,
        status: 'scanning',
        scanVerdict: null,
        trustZone: 'quarantine',
      }),
    ]);

    const files = await service.listForClient(
      context,
      clientPrincipal(READABLE_PROJECT),
      READABLE_PROJECT,
    );

    expect(files.map((f) => f.id)).toEqual(['own-clean']);
    expect(files[0]).toMatchObject({
      name: 'File own-clean',
      contentType: 'application/pdf',
      sizeBytes: 1234,
    });
  });

  it('answers 404 for a project the client cannot read, before any file is read', async () => {
    const service = serviceWith([candidate({ id: 'x', requestClientOrganizationId: CLIENT_ORG })]);

    await expect(
      // The principal's only readable project is READABLE_PROJECT; another id is not theirs.
      service.listForClient(context, clientPrincipal(READABLE_PROJECT), 'project-not-mine'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a non-client principal with 403', async () => {
    const service = serviceWith([candidate({ id: 'x', requestClientOrganizationId: CLIENT_ORG })]);

    await expect(
      service.listForClient(context, internalPrincipal(), READABLE_PROJECT),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.listForClient(context, internalPrincipal(), READABLE_PROJECT),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
