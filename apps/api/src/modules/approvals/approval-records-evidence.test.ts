import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { AnchorSigner } from '../audit/audit-anchor-signer.js';
import { readZipDirectory, readZipPart } from '../files/preview-generators/zip-reader.js';
import { THROTTLE_POLICY } from '../rate-limits/throttle-policies.js';
import { recordGenesisHash, sealRecord } from './approval-records.js';
import type { ApprovalEvidence } from './approval-records.js';
import { ApprovalEvidenceController } from './approval-records-evidence.controller.js';
import type { ApprovalEvidenceRepository } from './approval-records-evidence.repository.js';
import { ApprovalEvidenceService } from './approval-records-evidence.service.js';
import { evidenceFileName } from './approval-records-evidence.js';
import type { ApprovalCertificateView } from './approvals.service.js';

/**
 * 52-19 — the evidence bundle over fakes: what the ZIP holds and that a third party can re-check
 * it, the approved file left out when its bytes no longer match, and the gate (the route's
 * capability and throttle; a refused certificate reads and audits nothing).
 */

const ORG = '0190a000-0000-7000-8000-0000000000a1';
const USER = '0190a000-0000-7000-8000-0000000000aa';
const APPROVAL = '0190a000-0000-7000-8000-000000000001';
const FILE_BYTES = Buffer.from('%PDF-1.7 brand guide');
const FILE_SHA = createHash('sha256').update(FILE_BYTES).digest('hex');
const signer = AnchorSigner.fromEnv({
  AUDIT_ANCHOR_KEY: `1:${Buffer.alloc(32, 7).toString('base64')}`,
});
const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;
const principal = { userId: USER, organizationId: ORG, kind: 'internal' } as unknown as Principal;

function view(): ApprovalCertificateView {
  const sealed = sealRecord(
    {
      schema: 'tmanage.approval.record.v1',
      recordNo: 1,
      previousRecordHash: recordGenesisHash(ORG),
      organizationId: ORG,
      approvalId: APPROVAL,
      decision: 'approved',
      comment: 'Looks good',
      userAgent: null,
    } as unknown as ApprovalEvidence,
    signer,
  );
  return {
    approvalId: APPROVAL,
    organizationId: ORG,
    projectId: 'p1',
    deliverableId: 'd1',
    deliverableVersionId: 'v1',
    contentHash: 'cd'.repeat(32),
    state: 'approved',
    decidedAt: '2026-11-18T09:00:00.000Z',
    intact: true,
    records: [
      {
        recordNo: 1,
        recordHash: sealed.recordHash,
        previousRecordHash: recordGenesisHash(ORG),
        signed: true,
        verification: { hashValid: true, chainValid: true, signatureValid: true },
        evidence: sealed.evidence,
      },
    ],
  };
}

function build(options: { stored?: Buffer; refuse?: boolean } = {}) {
  const audits: unknown[] = [];
  const reads: string[] = [];
  const database = {
    read: async (_c: unknown, work: (runner: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const approvals = {
    certificate: async () => {
      if (options.refuse) throw new ApiError(404, 'not_found', 'Not found');
      return view();
    },
  };
  const pdfs = { forView: async () => ({ bytes: Buffer.from('%PDF-record'), fileName: 'x.pdf' }) };
  const repository = {
    approvedFile: async () => {
      reads.push('file');
      return {
        fileVersionId: 'fv1',
        organizationId: ORG,
        objectKey: 'k',
        sizeBytes: FILE_BYTES.length,
        sha256: FILE_SHA,
        scanVerdict: 'clean',
        trustZone: 'private',
        versionNo: 3,
        storageBackend: 'local',
        providerFileId: null,
        storageConnectionId: null,
        name: '../Brand guide.pdf',
      };
    },
    latestChainCheck: async () => {
      reads.push('chain');
      return {
        checkedAt: new Date('2026-11-18T03:30:00.000Z'),
        status: 'ok',
        records: 12,
        breakRecordNo: null,
        breakReason: null,
      };
    },
  } as unknown as ApprovalEvidenceRepository;
  const versions = {
    open: async () => ({
      sizeBytes: FILE_BYTES.length,
      stream: Readable.from([options.stored ?? FILE_BYTES]),
    }),
  };
  const audit = {
    recordStandalone: async (_c: unknown, input: unknown) => {
      audits.push(input);
      return {} as never;
    },
  };
  const service = new ApprovalEvidenceService(
    database,
    approvals,
    pdfs,
    versions,
    audit,
    repository,
    () => new Date('2026-11-18T10:00:00.000Z'),
  );
  return { service, audits, reads };
}

function part(zip: Buffer, path: string): Buffer | null {
  const bytes = readZipPart(zip, readZipDirectory(zip), path, 1024 * 1024);
  return bytes === null ? null : Buffer.from(bytes);
}

describe('52-19 approval evidence bundle', () => {
  it('holds the record PDF, the approved file and a proof anyone can re-check, and audits it', async () => {
    const { service, audits } = build();
    const zip = await service.bundle(context, principal, APPROVAL);
    expect(zip.fileName).toBe(`approval-evidence-${APPROVAL}.zip`);

    const name = evidenceFileName('../Brand guide.pdf', 3);
    expect(name).toBe('approved-file/v3-Brand guide.pdf');
    expect(part(zip.bytes, 'README.txt')?.toString('utf8')).toContain('sha256');
    expect(part(zip.bytes, 'approval-record.pdf')?.toString('latin1')).toBe('%PDF-record');
    expect(part(zip.bytes, name)?.equals(FILE_BYTES)).toBe(true);

    const proof = JSON.parse(part(zip.bytes, 'chain-proof.json')?.toString('utf8') ?? '{}');
    const record = proof.records[0];
    expect(createHash('sha256').update(record.recordJson, 'utf8').digest('hex')).toBe(
      record.recordHash,
    );
    expect(record.previousRecordHash).toBe(proof.genesis.hash);
    expect(proof.file).toMatchObject({ sha256: FILE_SHA, included: true, path: name });
    expect(proof.nightlyCheck).toMatchObject({ status: 'ok', records: 12 });
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'approval.evidence_exported',
        objectId: APPROVAL,
        metadata: { record_count: 1, file_outcome: 'included' },
      }),
    ]);
  });

  it('leaves out a file whose stored bytes no longer match its hash', async () => {
    const { service } = build({ stored: Buffer.from('%PDF-1.7 changed!!!!') });
    const zip = await service.bundle(context, principal, APPROVAL);
    expect(part(zip.bytes, evidenceFileName('../Brand guide.pdf', 3))).toBeNull();
    const proof = JSON.parse(part(zip.bytes, 'chain-proof.json')?.toString('utf8') ?? '{}');
    expect(proof.file).toMatchObject({ included: false, outcome: 'does_not_match' });
  });

  it('is gated: approval.read and a throttle on the route; a refused record reads nothing', async () => {
    const handler = ApprovalEvidenceController.prototype.download;
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, handler)).toBe('approval.read');
    expect(Reflect.getMetadata(THROTTLE_POLICY, handler)).toMatchObject({
      name: 'approval_evidence',
    });

    const { service, audits, reads } = build({ refuse: true });
    await expect(service.bundle(context, principal, APPROVAL)).rejects.toMatchObject({
      status: 404,
    });
    expect(reads).toEqual([]);
    expect(audits).toEqual([]);
  });
});
