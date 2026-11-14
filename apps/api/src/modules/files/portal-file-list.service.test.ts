import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { PortalFileListService } from './portal-file-list.service.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileVersionRow } from '../../common/database/schema.js';
import type { ReviewThreadsRepository } from './review-threads.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import type { ScannerPresence } from '../tenancy/download-scan-policy.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';

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
  readonly audience?: string;
}): Candidate {
  const projectId = options.projectId ?? READABLE_PROJECT;
  const asset = {
    id: options.id,
    organizationId: ORG,
    projectId,
    name: `File ${options.id}`,
    purpose: 'request_attachment',
    objectId: `req-${options.id}`,
    audience: options.audience ?? 'client_visible',
    clientOrganizationId: null,
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

function serviceWith(
  rows: readonly Candidate[],
  policy: {
    readonly scanner?: ScannerPresence;
    readonly stored?: string;
    /** FIX6. The stored "Files clients can receive" (`require_scan_for_clients`). */
    readonly clientFiles?: string;
    readonly archivedAt?: Date;
    readonly openComments?: ReadonlyMap<string, number>;
  } = {},
): PortalFileListService {
  const assets = {
    listRequestAttachmentsForProject: () => Promise.resolve(rows),
  } as unknown as FileAssetsRepository;
  const settings = {
    findByKey: (_r: unknown, _c: unknown, key: string) => {
      const value = key === 'require_scan_for_clients' ? policy.clientFiles : policy.stored;
      return Promise.resolve(value === undefined ? undefined : { settingValue: value });
    },
  } as unknown as OrgSettingsRepository;
  const projects = {
    findById: () =>
      Promise.resolve({ id: READABLE_PROJECT, archivedAt: policy.archivedAt ?? null }),
  } as unknown as ProjectsRepository;
  const threads = {
    countOpenClientVisible: () => Promise.resolve(policy.openComments ?? new Map()),
  } as unknown as ReviewThreadsRepository;
  return new PortalFileListService(
    fakeDatabase(),
    assets,
    policy.scanner,
    settings,
    projects,
    threads,
  );
}

/** C4. A verified file the scan has not judged yet, still in quarantine. */
function awaiting(id: string): Candidate {
  return candidate({
    id,
    requestClientOrganizationId: CLIENT_ORG,
    status: 'scanning',
    scanVerdict: null,
    trustZone: 'quarantine',
  });
}

describe('PortalFileListService.listForClient', () => {
  it('R4 slice 8: says which files the viewer can open and how many comments wait on each', async () => {
    const service = serviceWith(
      [
        candidate({ id: 'proof', requestClientOrganizationId: CLIENT_ORG }),
        candidate({ id: 'quiet', requestClientOrganizationId: CLIENT_ORG }),
      ],
      { openComments: new Map([['proof', 2]]) },
    );
    const files = await service.listForClient(
      context,
      clientPrincipal(READABLE_PROJECT),
      READABLE_PROJECT,
    );
    expect(files.map((f) => [f.id, f.reviewable, f.openComments])).toEqual([
      ['proof', true, 2],
      ['quiet', true, 0],
    ]);
  });

  it('lists a client-org servable file and hides a sibling client and an unpublished one', async () => {
    const service = serviceWith([
      candidate({ id: 'own-clean', requestClientOrganizationId: CLIENT_ORG }),
      // The audience guard: another client's attachment in the same shared project.
      candidate({ id: 'sibling', requestClientOrganizationId: SIBLING_CLIENT_ORG }),
      // Never published: the scan rejected it.
      candidate({
        id: 'rejected',
        requestClientOrganizationId: CLIENT_ORG,
        status: 'rejected',
        scanVerdict: 'infected',
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
      scanStatus: 'clean',
    });
  });

  it('C4: lists an unscanned file as not_scanned when the owner allows labelled downloads and checked files for clients', async () => {
    const service = serviceWith([awaiting('waiting')], {
      scanner: { kind: 'engine' },
      stored: 'allow_labeled',
      clientFiles: 'false',
    });

    const files = await service.listForClient(
      context,
      clientPrincipal(READABLE_PROJECT),
      READABLE_PROJECT,
    );

    expect(files.map((f) => [f.id, f.scanStatus])).toEqual([['waiting', 'not_scanned']]);
  });

  it('FIX6: with a scanner and nothing chosen, clients wait for the scan (being_checked)', async () => {
    const service = serviceWith([awaiting('waiting')], {
      scanner: { kind: 'engine' },
      stored: 'allow_labeled',
    });

    const files = await service.listForClient(
      context,
      clientPrincipal(READABLE_PROJECT),
      READABLE_PROJECT,
    );

    expect(files.map((f) => [f.id, f.scanStatus])).toEqual([['waiting', 'being_checked']]);
  });

  it('FIX6: no scanner and the owner keeps clients to virus-scanned files: not listed', async () => {
    const service = serviceWith([awaiting('waiting')], {
      scanner: { kind: 'none' },
      clientFiles: 'true',
    });

    const files = await service.listForClient(
      context,
      clientPrincipal(READABLE_PROJECT),
      READABLE_PROJECT,
    );

    expect(files).toEqual([]);
  });

  it('C4: lists an unscanned file as being_checked when the owner blocks until scanned', async () => {
    const service = serviceWith([awaiting('waiting')], {
      scanner: { kind: 'engine' },
      stored: 'block',
    });

    const files = await service.listForClient(
      context,
      clientPrincipal(READABLE_PROJECT),
      READABLE_PROJECT,
    );

    expect(files.map((f) => [f.id, f.scanStatus])).toEqual([['waiting', 'being_checked']]);
  });

  it('C4: without a scanner a stored block still lists the file as not_scanned', async () => {
    const service = serviceWith([awaiting('waiting')], {
      scanner: { kind: 'none' },
      stored: 'block',
    });

    const files = await service.listForClient(
      context,
      clientPrincipal(READABLE_PROJECT),
      READABLE_PROJECT,
    );

    expect(files[0]?.scanStatus).toBe('not_scanned');
  });

  it('C4: never lists an infected or unverified file, and never a sibling client unscanned one', async () => {
    const service = serviceWith(
      [
        candidate({
          id: 'infected-ready',
          requestClientOrganizationId: CLIENT_ORG,
          status: 'ready',
          scanVerdict: 'infected',
          trustZone: 'quarantine',
        }),
        candidate({
          id: 'not-verified',
          requestClientOrganizationId: CLIENT_ORG,
          status: 'verifying',
          scanVerdict: null,
          trustZone: 'quarantine',
        }),
        {
          ...awaiting('sibling-waiting'),
          request: {
            id: 'req-sibling-waiting',
            projectId: READABLE_PROJECT,
            clientOrganizationId: SIBLING_CLIENT_ORG,
          },
        },
      ],
      { scanner: { kind: 'engine' }, stored: 'allow_labeled' },
    );

    const files = await service.listForClient(
      context,
      clientPrincipal(READABLE_PROJECT),
      READABLE_PROJECT,
    );

    expect(files).toEqual([]);
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

  it('F48: never lists an internal-audience staff attachment on the client own request', async () => {
    const service = serviceWith([
      candidate({
        id: 'internal-notes',
        requestClientOrganizationId: CLIENT_ORG,
        audience: 'internal',
      }),
      candidate({ id: 'shared', requestClientOrganizationId: CLIENT_ORG }),
      candidate({
        id: 'action',
        requestClientOrganizationId: CLIENT_ORG,
        audience: 'client_action_required',
      }),
    ]);
    const files = await service.listForClient(
      context,
      clientPrincipal(READABLE_PROJECT),
      READABLE_PROJECT,
    );
    expect(files.map((file) => file.id)).toEqual(['shared', 'action']);
  });

  it('F48: lists nothing in an archived project, as the download door serves nothing there', async () => {
    const service = serviceWith(
      [candidate({ id: 'shared', requestClientOrganizationId: CLIENT_ORG })],
      { archivedAt: new Date('2026-10-01T00:00:00.000Z') },
    );
    const files = await service.listForClient(
      context,
      clientPrincipal(READABLE_PROJECT),
      READABLE_PROJECT,
    );
    expect(files).toEqual([]);
  });
});
