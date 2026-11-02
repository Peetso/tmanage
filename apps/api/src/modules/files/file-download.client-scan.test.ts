import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ObjectStore } from '@tmanage/storage';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { ClientRequestsRepository } from '../requests/client-requests.repository.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { FileClientRelation } from './file-client-relation.js';
import { FileDownloadService } from './file-download.service.js';

/**
 * 56-06 (R19-e) — `require_scan_for_clients`. With a scanner and the setting on (the default), a
 * client asking for a version that is not scanned-clean gets the one 404; a member still gets the
 * bytes under `allow_labeled`. Without a scanner the rule is off. Fakes with the real `authorize`.
 */
const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const CLIENT_ORG = '00000000-0000-4000-8000-0000000000f1';
const ASSET = '00000000-0000-4000-8000-0000000000d1';
const context = { organizationId: ORG, membershipId: 'm' } as unknown as TenantContext;

const base = {
  userId: '00000000-0000-4000-8000-0000000000c1',
  organizationId: ORG,
  membershipId: '00000000-0000-4000-8000-0000000000e1',
  membershipStatus: 'active',
  projectIds: [PROJECT],
} as const;
const member = {
  ...base,
  kind: 'internal',
  role: 'owner',
  clientOrganizationId: null,
  hasOrgWideScope: true,
} as Principal;
const client = {
  ...base,
  kind: 'client',
  role: 'client_reviewer',
  clientOrganizationId: CLIENT_ORG,
  hasOrgWideScope: false,
} as Principal;

function build(scanVerdict: string | null, scanner: { kind: 'none' | 'engine' }, stored?: string) {
  const denials: string[] = [];
  const database = {
    read: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
    transaction: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
  } as unknown as TenantDatabase;
  const clean = scanVerdict === 'clean';
  const assets = {
    findWithLatestVersion: () =>
      Promise.resolve({
        asset: {
          id: ASSET,
          organizationId: ORG,
          projectId: PROJECT,
          purpose: 'deliverable',
          audience: 'client_visible',
          clientOrganizationId: CLIENT_ORG,
          objectId: null,
          status: clean ? 'ready' : 'scanning',
          name: 'brief.pdf',
        },
        version: {
          id: 'v1',
          scanVerdict,
          trustZone: clean ? 'private' : 'quarantine',
          detectedMimeType: 'application/pdf',
          objectKey: 'k/1',
          sizeBytes: 3,
        },
      }),
  } as unknown as FileAssetsRepository;
  const audit = {
    record: () => Promise.resolve({}),
    recordDenial: (_c: unknown, _a: unknown, input: { auditCode: string }) => {
      denials.push(input.auditCode);
      return Promise.resolve(true);
    },
  } as unknown as AuditService;
  const settings = {
    findByKey: (_r: unknown, _c: unknown, key: string) =>
      Promise.resolve(
        key === 'require_scan_for_clients' && stored !== undefined
          ? { settingValue: stored }
          : undefined,
      ),
  } as unknown as OrgSettingsRepository;
  const service = new FileDownloadService(
    database,
    assets,
    {
      findById: () => Promise.resolve({ id: PROJECT, archivedAt: null }),
    } as unknown as ProjectsRepository,
    {} as ClientRequestsRepository,
    {
      openObject: () =>
        Promise.resolve({ stream: Readable.from([Buffer.from('abc')]), sizeBytes: 3 }),
    } as unknown as ObjectStore,
    audit,
    scanner,
    settings,
    {
      reach: () => Promise.resolve({ audience: 'client_visible' }),
    } as unknown as FileClientRelation,
  );
  return { service, denials };
}

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
}

describe('56-06 require_scan_for_clients', () => {
  it('a client gets 404 for an unscanned version while a member gets the bytes', async () => {
    const t = build(null, { kind: 'engine' });
    expect(await status(t.service.downloadForClient(context, client, ASSET))).toBe(404);
    expect(t.denials).toEqual(['client_scan_required']);
    expect(await status(t.service.download(context, member, ASSET))).toBe(200);
  });

  it('a client gets a scanned-clean version, and the rule is off when stored false or no scanner', async () => {
    expect(
      await status(
        build('clean', { kind: 'engine' }).service.downloadForClient(context, client, ASSET),
      ),
    ).toBe(200);
    expect(
      await status(
        build(null, { kind: 'engine' }, 'false').service.downloadForClient(context, client, ASSET),
      ),
    ).toBe(200);
    expect(
      await status(
        build(null, { kind: 'none' }, 'true').service.downloadForClient(context, client, ASSET),
      ),
    ).toBe(200);
  });
});
