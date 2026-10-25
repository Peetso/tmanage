import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ObjectStore } from '@tmanage/storage';
import { ApiError } from '../../common/http/errors.js';
import { UPLOAD_PURPOSES } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { ClientRequestsRepository } from '../requests/client-requests.repository.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import { FileDownloadService } from './file-download.service.js';
import {
  REQUEST_MESSAGE_FILE_PURPOSES,
  mayDownloadFor,
  mayUploadFor,
  objectTableFor,
} from './purpose-policy.js';

/**
 * Audit gap 13 (0232): a file sent with a reply on a client request has its own purpose,
 * `request_message`, instead of reusing `request_attachment`. It is bound to the request the same
 * way, a client may upload and download it only on their own request, and old reply files that
 * still carry `request_attachment` keep attaching and listing.
 */

describe('request_message — the reply-file purpose', () => {
  it('is a stored purpose, appended after every older value', () => {
    expect(UPLOAD_PURPOSES).toContain('request_message');
    expect(UPLOAD_PURPOSES.indexOf('request_message')).toBe(UPLOAD_PURPOSES.length - 1);
  });

  it('may be uploaded and downloaded by the studio and by a client, never by a service', () => {
    expect(mayUploadFor('internal', 'request_message')).toBe(true);
    expect(mayUploadFor('client', 'request_message')).toBe(true);
    expect(mayUploadFor('service', 'request_message')).toBe(false);
    expect(mayDownloadFor('internal', 'request_message')).toBe(true);
    expect(mayDownloadFor('client', 'request_message')).toBe(true);
    expect(mayDownloadFor('service', 'request_message')).toBe(false);
  });

  it('names a client request, exactly as a request-form file does', () => {
    expect(objectTableFor('request_message')).toBe('client_requests');
    expect(objectTableFor('request_attachment')).toBe('client_requests');
    expect(objectTableFor('message_attachment')).toBeNull();
    expect(objectTableFor('org_logo')).toBeNull();
  });

  it('attaches to a reply under the new purpose and, for old rows, the old one only', () => {
    expect([...REQUEST_MESSAGE_FILE_PURPOSES].sort()).toEqual([
      'request_attachment',
      'request_message',
    ]);
  });

  it('keeps every other purpose out of a client upload', () => {
    expect(mayUploadFor('client', 'message_attachment')).toBe(false);
    expect(mayUploadFor('client', 'deliverable')).toBe(false);
    expect(mayUploadFor('client', 'org_logo')).toBe(false);
  });
});

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const ASSET = '00000000-0000-4000-8000-0000000000d1';
const REQUEST = '00000000-0000-4000-8000-0000000000f1';
const CLIENT_ORG = '00000000-0000-4000-8000-0000000000c9';
const OTHER_CLIENT_ORG = '00000000-0000-4000-8000-0000000000c8';
const context = { organizationId: ORG, membershipId: 'm' } as unknown as TenantContext;

const client: Principal = {
  userId: '00000000-0000-4000-8000-0000000000c1',
  organizationId: ORG,
  kind: 'client',
  role: 'client_member',
  membershipId: '00000000-0000-4000-8000-0000000000e1',
  membershipStatus: 'active',
  clientOrganizationId: CLIENT_ORG,
  projectIds: [PROJECT],
  hasOrgWideScope: false,
};

function build(requestClientOrganizationId: string) {
  const denials: string[] = [];
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
          purpose: 'request_message',
          audience: 'client_visible',
          clientOrganizationId: CLIENT_ORG,
          objectId: REQUEST,
          status: 'ready',
          name: 'reply.pdf',
        },
        version: {
          id: 'v1',
          scanVerdict: 'clean',
          trustZone: 'private',
          detectedMimeType: 'application/pdf',
          objectKey: 'k/1',
          sizeBytes: 3,
        },
      }),
  } as unknown as FileAssetsRepository;
  const requests = {
    findById: () =>
      Promise.resolve({
        id: REQUEST,
        projectId: PROJECT,
        clientOrganizationId: requestClientOrganizationId,
      }),
  } as unknown as ClientRequestsRepository;
  const projects = {
    findById: () => Promise.resolve({ id: PROJECT, archivedAt: null }),
  } as unknown as ProjectsRepository;
  const store = {
    openObject: () =>
      Promise.resolve({ stream: Readable.from([Buffer.from('abc')]), sizeBytes: 3 }),
  } as unknown as ObjectStore;
  const audit = {
    record: () => Promise.resolve({}),
    recordDenial: (_c: unknown, _a: unknown, input: { auditCode: string }) => {
      denials.push(input.auditCode);
      return Promise.resolve(true);
    },
  } as unknown as AuditService;
  const settings = {
    findByKey: () => Promise.resolve(undefined),
  } as unknown as OrgSettingsRepository;
  const service = new FileDownloadService(
    database,
    assets,
    projects,
    requests,
    store,
    audit,
    { kind: 'engine' },
    settings,
  );
  return { service, denials };
}

describe('request_message — the client download gate', () => {
  it("serves a reply file on the client's own request", async () => {
    const t = build(CLIENT_ORG);
    const download = await t.service.downloadForClient(context, client, ASSET);
    expect(download.scanStatus).toBe('clean');
    expect(t.denials).toEqual([]);
  });

  it("refuses a reply file on another client's request", async () => {
    const t = build(OTHER_CLIENT_ORG);
    let refused: unknown;
    try {
      await t.service.downloadForClient(context, client, ASSET);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ApiError);
    expect(t.denials).toContain('client_relation_mismatch');
  });
});
