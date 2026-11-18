import 'reflect-metadata';
import * as crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRecordRow } from '../../common/database/schema.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { IS_PUBLIC } from '../../common/http/decorators.js';
import { AnchorSigner } from '../audit/audit-anchor-signer.js';
import { THROTTLE_POLICY } from '../rate-limits/throttle-policies.js';
import { recordGenesisHash, sealRecord } from './approval-records.js';
import type { ApprovalEvidence } from './approval-records.js';
import { ApprovalRecordVerifyController } from './approval-record-verify.controller.js';
import {
  fingerprintMatches,
  NOT_FOUND_VERDICT,
  normalizeFingerprint,
  normalizeRecordId,
} from './approval-record-verify.js';
import type { RecordVerifyLookup } from './approval-record-verify.repository.js';
import { ApprovalRecordVerifyService } from './approval-record-verify.service.js';

// Spy on the one constant-time primitive, keeping its real behaviour.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof crypto>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

/**
 * 52-19 (web half) — the public verify check over fakes: the three verdicts, that a missing ID and
 * a wrong fingerprint are indistinguishable (same body, same single constant-time comparison, no
 * scoped read), and the route's gate (public, throttled per IP, closed on store failure).
 */

const ORG = '0190a000-0000-7000-8000-0000000000a1';
const RECORD_ID = '0190a000-0000-7000-8000-00000000c0de';
const OTHER_ID = '0190a000-0000-7000-8000-00000000beef';
const signer = AnchorSigner.fromEnv({
  AUDIT_ANCHOR_KEY: `1:${Buffer.alloc(32, 7).toString('base64')}`,
});

function sealedRow(): ApprovalRecordRow {
  const sealed = sealRecord(
    {
      schema: 'tmanage.approval.record.v1',
      recordNo: 1,
      previousRecordHash: recordGenesisHash(ORG),
      organizationId: ORG,
      projectId: 'p1',
      approvalId: 'a1',
      deliverableId: 'd1',
      deliverableVersionId: 'v1',
      versionNo: 2,
      fileVersionId: null,
      contentHash: 'cd'.repeat(32),
      approver: {
        userId: 'u1',
        membershipId: 'm1',
        kind: 'client',
        role: 'client_approver',
        clientOrganizationId: null,
      },
      decision: 'approved',
      comment: 'Looks good',
      decidedAt: '2026-11-12T14:05:00.000Z',
      ip: '203.0.113.9',
      userAgent: 'Browser',
    } satisfies ApprovalEvidence,
    signer,
  );
  return {
    id: RECORD_ID,
    organizationId: ORG,
    approvalId: 'a1',
    deliverableVersionId: 'v1',
    recordNo: 1,
    approverUserId: 'u1',
    approverKind: 'client',
    decision: 'approved',
    recordJson: sealed.recordJson,
    recordHash: sealed.recordHash,
    previousRecordHash: sealed.evidence.previousRecordHash,
    signature: sealed.signature,
    createdAt: new Date('2026-11-12T14:05:00.000Z'),
  };
}

function build(row: ApprovalRecordRow) {
  const scopedReads: string[] = [];
  const lookups: string[] = [];
  const database = {
    read: async (_c: unknown, work: (runner: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const lookup = async (id: string): Promise<RecordVerifyLookup | null> => {
    lookups.push(id);
    return id === row.id
      ? { organizationId: row.organizationId, recordHash: row.recordHash }
      : null;
  };
  const store = {
    findById: async (_r: unknown, _c: unknown, id: string) => {
      scopedReads.push(`row:${id}`);
      return id === row.id ? row : null;
    },
    organizationName: async () => {
      scopedReads.push('organization');
      return 'Nile Studio';
    },
  };
  const hashes = {
    hashesByNumber: async () => {
      scopedReads.push('previous');
      return new Map<number, string>();
    },
  };
  const service = new ApprovalRecordVerifyService(database, lookup, store, hashes, signer);
  return { service, scopedReads, lookups };
}

const timingSafeEqual = vi.mocked(crypto.timingSafeEqual);

describe('public approval-record verify (52-19)', () => {
  beforeEach(() => {
    timingSafeEqual.mockClear();
  });

  it('says genuine for the printed ID and fingerprint, with only the date and workspace', async () => {
    const row = sealedRow();
    const { service } = build(row);
    // Pasted the way the certificate prints it: grouped, upper-case.
    const grouped = (row.recordHash.toUpperCase().match(/.{1,16}/g) ?? []).join(' ');
    const view = await service.verify({
      recordId: ` ${RECORD_ID.toUpperCase()} `,
      fingerprint: grouped,
    });
    expect(view).toEqual({
      verdict: 'genuine',
      decidedAt: '2026-11-12T14:05:00.000Z',
      decision: 'approved',
      workspaceName: 'Nile Studio',
    });
  });

  it('says altered when the stored record no longer hashes to its fingerprint', async () => {
    const row = sealedRow();
    const tampered = { ...row, recordJson: row.recordJson.replace('Looks good', 'Looks great') };
    const { service } = build(tampered);
    const view = await service.verify({ recordId: RECORD_ID, fingerprint: row.recordHash });
    expect(view).toEqual({
      verdict: 'altered',
      decidedAt: null,
      decision: null,
      workspaceName: 'Nile Studio',
    });
  });

  it('says altered when the seal no longer holds', async () => {
    const row = sealedRow();
    const { service } = build({ ...row, signature: `v1:1:${'0'.repeat(64)}` });
    const view = await service.verify({ recordId: RECORD_ID, fingerprint: row.recordHash });
    expect(view.verdict).toBe('altered');
  });

  it('answers a missing ID and a wrong fingerprint identically, without enumeration', async () => {
    const row = sealedRow();
    const { service, scopedReads, lookups } = build(row);

    const missing = await service.verify({ recordId: OTHER_ID, fingerprint: row.recordHash });
    const missingCompares = timingSafeEqual.mock.calls.length;
    timingSafeEqual.mockClear();
    const wrong = await service.verify({ recordId: RECORD_ID, fingerprint: 'ab'.repeat(32) });
    const wrongCompares = timingSafeEqual.mock.calls.length;

    expect(missing).toEqual(NOT_FOUND_VERDICT);
    expect(wrong).toEqual(missing);
    expect(JSON.stringify(wrong)).not.toContain('Nile');
    // Same path: one lookup each, exactly one constant-time comparison each, nothing scoped read.
    expect(lookups).toEqual([OTHER_ID, RECORD_ID]);
    expect(missingCompares).toBe(1);
    expect(wrongCompares).toBe(1);
    expect(scopedReads).toEqual([]);
  });

  it('compares fingerprints only through timingSafeEqual', () => {
    const hash = 'ab'.repeat(32);
    expect(fingerprintMatches(hash, hash)).toBe(true);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    expect(fingerprintMatches(null, hash)).toBe(false);
    expect(fingerprintMatches(hash, null)).toBe(false);
    expect(fingerprintMatches(null, null)).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(4);
  });

  it('reads malformed input as not found', async () => {
    const { service, lookups } = build(sealedRow());
    expect(await service.verify(null)).toEqual(NOT_FOUND_VERDICT);
    expect(await service.verify({ recordId: "1' or '1'='1", fingerprint: 'x' })).toEqual(
      NOT_FOUND_VERDICT,
    );
    expect(lookups).toEqual([]);
    expect(normalizeRecordId('x'.repeat(500))).toBeNull();
    expect(normalizeFingerprint(`sha256:${'AB'.repeat(32)}`)).toBe('ab'.repeat(32));
  });

  it('is public and throttled per IP, closed when the bucket store is down', () => {
    const handler = ApprovalRecordVerifyController.prototype.verify;
    expect(Reflect.getMetadata(IS_PUBLIC, handler)).toBe(true);
    const policy = Reflect.getMetadata(THROTTLE_POLICY, handler) as Record<string, unknown>;
    expect(policy).toMatchObject({
      name: 'approval_record_verify',
      key: 'ip',
      onStoreError: 'closed',
    });
    expect(policy['perMinute']).toBeLessThanOrEqual(10);
    expect(policy['perHour']).toBeLessThanOrEqual(60);
  });
});
