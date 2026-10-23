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
import { FileDownloadService } from './file-download.service.js';

/**
 * B3 — the download gate routed through the owner's "downloads before a virus scan" policy, over
 * fakes with the real `authorize`. A verified-but-unscanned file is served labelled `not_scanned`
 * under `allow_labeled` (from quarantine), refused 409 `scan_required_by_policy` under `block` with a
 * scanner, and always allowed without a scanner. An infected/rejected file is never served.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const ASSET = '00000000-0000-4000-8000-0000000000d1';
const context = { organizationId: ORG, membershipId: 'm' } as unknown as TenantContext;

const principal: Principal = {
  userId: '00000000-0000-4000-8000-0000000000c1',
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: '00000000-0000-4000-8000-0000000000e1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [PROJECT],
  hasOrgWideScope: true,
};

interface Fixture {
  readonly status: string;
  readonly scanVerdict: string | null;
  readonly trustZone: 'private' | 'quarantine';
  readonly stored?: string;
  readonly scanner?: { readonly kind: 'none' | 'engine' } | undefined;
}

function build(fixture: Fixture) {
  const opened: string[] = [];
  const denials: string[] = [];
  const allowed: Record<string, unknown>[] = [];
  const database = {
    read: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
    transaction: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
  } as unknown as TenantDatabase;
  const assets = {
    findWithLatestVersion: () =>
      Promise.resolve({
        asset: {
          id: ASSET,
          organizationId: ORG,
          projectId: PROJECT,
          purpose: 'deliverable',
          audience: 'internal',
          clientOrganizationId: null,
          objectId: null,
          status: fixture.status,
          name: 'brief.pdf',
        },
        version: {
          id: 'v1',
          scanVerdict: fixture.scanVerdict,
          trustZone: fixture.trustZone,
          detectedMimeType: 'application/pdf',
          objectKey: 'k/1',
          sizeBytes: 3,
        },
      }),
  } as unknown as FileAssetsRepository;
  const projects = {
    findById: () => Promise.resolve({ id: PROJECT, archivedAt: null }),
  } as unknown as ProjectsRepository;
  const store = {
    openObject: (input: { zone: string }) => {
      opened.push(input.zone);
      return Promise.resolve({ stream: Readable.from([Buffer.from('abc')]), sizeBytes: 3 });
    },
  } as unknown as ObjectStore;
  const audit = {
    record: (_r: unknown, _c: unknown, input: { metadata: Record<string, unknown> }) => {
      allowed.push(input.metadata);
      return Promise.resolve({});
    },
    recordDenial: (_c: unknown, _a: unknown, input: { auditCode: string }) => {
      denials.push(input.auditCode);
      return Promise.resolve(true);
    },
  } as unknown as AuditService;
  const settings = {
    findByKey: () =>
      Promise.resolve(fixture.stored === undefined ? undefined : { settingValue: fixture.stored }),
  } as unknown as OrgSettingsRepository;
  const service = new FileDownloadService(
    database,
    assets,
    projects,
    {} as ClientRequestsRepository,
    store,
    audit,
    fixture.scanner,
    settings,
  );
  return { service, opened, denials, allowed };
}

const ENGINE = { kind: 'engine' } as const;
const NONE = { kind: 'none' } as const;

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('B3 downloads before a virus scan — the gate', () => {
  it('serves a clean file from private, labelled clean', async () => {
    const t = build({
      status: 'ready',
      scanVerdict: 'clean',
      trustZone: 'private',
      scanner: ENGINE,
    });
    const download = await t.service.download(context, principal, ASSET);
    expect(download.scanStatus).toBe('clean');
    expect(t.opened).toEqual(['private']);
  });

  it('allow_labeled (the default): an unscanned file is served from quarantine as not_scanned', async () => {
    const t = build({
      status: 'scanning',
      scanVerdict: null,
      trustZone: 'quarantine',
      scanner: ENGINE,
    });
    const download = await t.service.download(context, principal, ASSET);
    expect(download.scanStatus).toBe('not_scanned');
    expect(t.opened).toEqual(['quarantine']);
    expect(t.allowed[0]).toMatchObject({ scan_status: 'not_scanned' });
  });

  it('block with a scanner: 409 scan_required_by_policy, nothing opened', async () => {
    const t = build({
      status: 'scanning',
      scanVerdict: null,
      trustZone: 'quarantine',
      stored: 'block',
      scanner: ENGINE,
    });
    const error = await refusal(t.service.download(context, principal, ASSET));
    expect(error.status).toBe(409);
    expect(error.details).toEqual([{ field: 'status', message: 'scan_required_by_policy' }]);
    expect(t.opened).toEqual([]);
    expect(t.denials).toEqual(['not_scanned_blocked_by_policy']);
  });

  it('no scanner configured: a stored block is ignored — allowed, labelled not_scanned', async () => {
    for (const scanner of [NONE, undefined]) {
      const t = build({
        status: 'scanning',
        scanVerdict: 'unscanned',
        trustZone: 'quarantine',
        stored: 'block',
        scanner,
      });
      const download = await t.service.download(context, principal, ASSET);
      expect(download.scanStatus).toBe('not_scanned');
    }
  });

  it('an infected or rejected file is never served, whatever the policy', async () => {
    for (const fixture of [
      { status: 'scanning', scanVerdict: 'infected', trustZone: 'quarantine' as const },
      { status: 'rejected', scanVerdict: 'infected', trustZone: 'quarantine' as const },
    ]) {
      const t = build({ ...fixture, stored: 'allow_labeled', scanner: NONE });
      const error = await refusal(t.service.download(context, principal, ASSET));
      expect(error.status).toBe(409);
      expect(t.opened).toEqual([]);
    }
  });

  it('a file not yet verified stays a 409 pending_scan under allow_labeled', async () => {
    const t = build({
      status: 'verifying',
      scanVerdict: null,
      trustZone: 'quarantine',
      scanner: NONE,
    });
    const error = await refusal(t.service.download(context, principal, ASSET));
    expect(error.status).toBe(409);
    expect(error.details).toEqual([{ field: 'status', message: 'pending_scan' }]);
  });
});
