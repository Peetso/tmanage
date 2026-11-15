import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ApprovalRecordRow } from '../../common/database/schema.js';
import { AnchorSigner } from '../audit/audit-anchor-signer.js';
import { recordGenesisHash, sealRecord, verifyRecord } from './approval-records.js';
import type { ApprovalEvidence } from './approval-records.js';
import { ApprovalsService } from './approvals.service.js';

const ORG = '00000000-0000-7000-8000-0000000000a1';
const KEY = `1:${Buffer.alloc(32, 7).toString('base64')}`;
const signer = AnchorSigner.fromEnv({ AUDIT_ANCHOR_KEY: KEY });
const ids = { organizationId: ORG, approvalId: 'ap1', deliverableVersionId: 'v1' };

function stored(recordNo: number, previousRecordHash: string, userId: string): ApprovalRecordRow {
  const approver = { userId, kind: 'client' };
  const text = { comment: null, userAgent: null };
  const evidence = {
    ...ids,
    ...text,
    recordNo,
    previousRecordHash,
    approver,
    decision: 'approved',
  };
  const sealed = sealRecord(evidence as unknown as ApprovalEvidence, signer);
  const { recordJson, recordHash, signature } = sealed;
  const row = { ...ids, recordNo, approverUserId: userId, approverKind: 'client' };
  return {
    ...row,
    decision: 'approved',
    recordJson,
    recordHash,
    previousRecordHash,
    signature,
  } as ApprovalRecordRow;
}

describe('52-19 approval records', () => {
  const first = stored(1, recordGenesisHash(ORG), 'u1');
  const second = stored(2, first.recordHash, 'u2');

  it('verifies an untouched chain and detects an edited, re-signed or relinked record', () => {
    const ok = { hashValid: true, chainValid: true, signatureValid: true };
    expect(verifyRecord(second, first.recordHash, signer)).toEqual(ok);
    const edited = { ...first, recordJson: first.recordJson.replace('approved', 'rejected') };
    expect(verifyRecord(edited, null, signer).hashValid).toBe(false);
    const forged = stored(1, recordGenesisHash(ORG), 'u9');
    expect(verifyRecord({ ...forged, signature: first.signature }, null, signer)).toMatchObject({
      signatureValid: false,
    });
    expect(verifyRecord(second, forged.recordHash, signer).chainValid).toBe(false);
  });

  it('refuses another client, and an outside tenant, with 404', async () => {
    const approval = { ...ids, id: 'ap1', projectId: 'p1' };
    const found = { requireByVersion: () => Promise.resolve(approval) };
    const records = { listByApproval: async () => [first], hashesByNumber: async () => new Map() };
    const db = { transaction: (_c: unknown, work: (tx: unknown) => unknown) => work({}) };
    const service = new (ApprovalsService as unknown as new (...a: unknown[]) => ApprovalsService)(
      ...[db, found, {}, found, undefined, undefined, undefined, records, signer],
    );
    const context = { organizationId: ORG } as TenantContext;
    const base = {
      organizationId: ORG,
      kind: 'client',
      role: 'client_reviewer',
      projectIds: ['p1'],
    };
    const client = { ...base, membershipStatus: 'active', userId: 'u2' } as unknown as Principal;
    const read = (p: Partial<Principal>) =>
      service.clientCertificate(context, { ...client, ...p }, 'v1');
    await expect(read({})).rejects.toMatchObject({ status: 404 });
    await expect(read({ userId: 'u1' })).resolves.toMatchObject({ intact: true });
    await expect(read({ userId: 'u1', organizationId: 'x' })).rejects.toMatchObject({
      status: 404,
    });
  });
});
