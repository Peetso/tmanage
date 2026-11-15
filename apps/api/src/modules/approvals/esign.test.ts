import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ObjectStore } from '@tmanage/storage';
import type {
  ApprovalRecordRow,
  SignatureRequestRow,
  SignatureRequestSignerRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { AnchorSigner } from '../audit/audit-anchor-signer.js';
import { PublicLinkSecrets } from '../public-links/public-link-secrets.js';
import { recordGenesisHash, sealRecord, verifyRecord } from './approval-records.js';
import type { EsignEvidence } from './approval-records.js';
import type { ApprovalRecordsRepository } from './approval-records.repository.js';
import type { DeliverableVersionsRepository } from './deliverable-versions.repository.js';
import { parseMarkPng } from './esign.js';
import type { EsignRepository } from './esign.repository.js';
import { EsignService } from './esign.service.js';

// 52-26 security path: one assertion per key behaviour.
const ORG = 'org-1';
const NOW = new Date('2026-11-15T10:00:00.000Z');
const context = { organizationId: ORG } as TenantContext;
const client = (userId: string) =>
  ({
    userId,
    organizationId: ORG,
    kind: 'client',
    role: 'client_admin',
    membershipId: 'm',
    membershipStatus: 'active',
    clientOrganizationId: 'co-1',
    projectIds: ['p1'],
    hasOrgWideScope: false,
  }) as Principal;
const secrets = new PublicLinkSecrets('pepper');
const request = {
  id: 'r1',
  organizationId: ORG,
  projectId: 'p1',
  deliverableVersionId: 'v1',
  contentHash: 'a'.repeat(64),
  status: 'pending',
  expiresAt: new Date('2026-11-20'),
} as SignatureRequestRow;

function setup(code: { hash: string | null; expiresAt: Date; attempts: number }) {
  const signer = {
    id: 's1',
    userId: 'u1',
    clientOrganizationId: 'co-1',
    status: 'pending',
    codeHash: code.hash,
    codeExpiresAt: code.expiresAt,
    codeAttempts: code.attempts,
  } as SignatureRequestSignerRow;
  const repo = {
    findRequest: async () => request,
    findSigner: async (_r: unknown, _c: unknown, _id: string, userId: string) =>
      userId === 'u1' ? signer : null,
    updateSigner: vi.fn(),
  } as unknown as EsignRepository;
  const database = {
    transaction: <T>(_c: TenantContext, work: (tx: never) => Promise<T>) => work({} as never),
  } as unknown as TenantDatabase;
  const service = new EsignService(
    {
      database,
      secrets,
      store: {} as ObjectStore,
      mailer: null,
      webPublicUrl: null,
      now: () => NOW,
    },
    repo,
    {
      findById: async () => ({ contentHash: 'a'.repeat(64) }),
    } as unknown as DeliverableVersionsRepository,
    undefined,
    { appendEsign: vi.fn() } as unknown as ApprovalRecordsRepository,
  );
  return { service, repo };
}

const body = { method: 'typed', typedName: 'Layla Haddad', consent: true, code: '000000' };
const sign = (service: EsignService, who = 'u1') =>
  service.sign(context, client(who), 'r1', body, { ip: null, userAgent: null });
const live = new Date('2026-11-15T10:05:00.000Z');

describe('52-26 e-sign security', () => {
  it('refuses a wrong code and counts the attempt', async () => {
    const { service, repo } = setup({
      hash: secrets.issueCode('s1').hash,
      expiresAt: live,
      attempts: 0,
    });
    await expect(sign(service)).rejects.toMatchObject({
      status: 400,
      details: [{ field: 'code' }],
    });
    expect(repo.updateSigner).toHaveBeenCalledWith({}, context, 's1', { codeAttempts: 1 });
  });

  it('refuses an expired code and an exhausted one without comparing', async () => {
    const hash = secrets.issueCode('s1').hash;
    const expired = setup({ hash, expiresAt: new Date('2026-11-15T09:59:00.000Z'), attempts: 0 });
    await expect(sign(expired.service)).rejects.toMatchObject({
      details: [{ message: 'code_expired' }],
    });
    const locked = setup({ hash, expiresAt: live, attempts: 5 });
    await expect(sign(locked.service)).rejects.toMatchObject({
      details: [{ message: 'code_locked' }],
    });
    expect(locked.repo.updateSigner).not.toHaveBeenCalled();
  });

  it('refuses a client the request is not addressed to with a 404', async () => {
    const { service } = setup({ hash: null, expiresAt: live, attempts: 0 });
    await expect(sign(service, 'u2')).rejects.toMatchObject({ status: 404 });
  });

  it('detects a tampered signature record', () => {
    const anchor = AnchorSigner.fromEnv({
      AUDIT_ANCHOR_KEY: `1:${Buffer.alloc(32, 7).toString('base64')}`,
    });
    const evidence = {
      organizationId: ORG,
      recordNo: 1,
      previousRecordHash: recordGenesisHash(ORG),
      approvalId: 'r1',
      deliverableVersionId: 'v1',
      approver: { userId: 'u1', kind: 'client' },
      decision: 'signed',
      comment: null,
      userAgent: null,
      esign: { typedName: 'Layla Haddad' },
    };
    const sealed = sealRecord(evidence as unknown as EsignEvidence, anchor);
    const row = {
      organizationId: ORG,
      recordNo: 1,
      approvalId: 'r1',
      deliverableVersionId: 'v1',
      approverUserId: 'u1',
      approverKind: 'client',
      decision: 'signed',
      previousRecordHash: recordGenesisHash(ORG),
      recordHash: sealed.recordHash,
      signature: sealed.signature,
      recordJson: sealed.recordJson,
    } as ApprovalRecordRow;
    expect(verifyRecord(row, null, anchor).hashValid).toBe(true);
    const tampered = { ...row, recordJson: row.recordJson.replace('Layla Haddad', 'Omar Saleh') };
    expect(verifyRecord(tampered, null, anchor).hashValid).toBe(false);
  });

  it('refuses a PNG with bytes after IEND (polyglot)', () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    expect(parseMarkPng(png.toString('base64')).length).toBe(png.length);
    expect(() =>
      parseMarkPng(Buffer.concat([png, Buffer.from('<script>')]).toString('base64')),
    ).toThrow();
  });
});
