/**
 * 52-19 — the nightly approval record chain walk (0349, `approval_records`).
 *
 * Nightly at 03:30 UTC (after the 03:00 e-invoice chain), and once on boot, every organization's
 * approval record chain — the decision and signature records the API seals — is walked in
 * `record_no` order, in batches, and each record is checked the way the API's `verifyRecord`
 * checks one on read: its stored JSON is canonical and hashes to `record_hash`, its columns agree
 * with the JSON, record 1 points at the organization's genesis hash, every next record is the
 * previous `record_no` + 1 and carries the previous record's hash, and its HMAC (when present
 * and its key id is still in `AUDIT_ANCHOR_KEY`) verifies. A break is reported, never repaired:
 * one `security_signals` row (`approval_chain_break`, high) through the 56-23 signal path, whose
 * dedupe key makes the same break on a later night count up instead of adding a row; the
 * security digest mails it to the workspace. Logs carry counts only — never a hash or a name.
 * This file holds no SQL; `common/database/approval-chain-store.ts` does.
 *
 * The genesis and signature formats are the API's (`approvals/approval-records.ts`), repeated
 * here because one app may not import another's `src/`. Change both together.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { uuidv7 } from '@tmanage/domain';
import { parseFieldCipherKeys } from '@tmanage/domain/field-cipher';
import { canonicalJson, sha256Hex } from './audit-anchor.js';
import { sourceHash } from './security-detector.js';

export const APPROVAL_CHAIN_RUN_HOUR_UTC = 3;
export const APPROVAL_CHAIN_RUN_MINUTE_UTC = 30;
export const APPROVAL_CHAIN_STALE_MS = 26 * 60 * 60 * 1000;
export const APPROVAL_CHAIN_TICK_MS = 15 * 60 * 1000;
export const APPROVAL_CHAIN_BATCH = 500;
export const APPROVAL_CHAIN_RULE_KEY = 'approval_chain_break';
export const APPROVAL_CHAIN_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECORD_SCHEMA = 'tmanage.approval.record.v1';

export type ApprovalChainStatus = 'ok' | 'broken' | 'empty';
export type ApprovalChainBreakReason =
  'gap' | 'genesis_mismatch' | 'link_mismatch' | 'hash_mismatch' | 'signature_invalid';

/** One stored record, as the store reads it. */
export interface ChainRecordRow {
  readonly recordNo: number;
  readonly recordHash: string;
  readonly previousRecordHash: string;
  readonly recordJson: string;
  readonly signature: string | null;
  readonly approvalId: string;
  readonly deliverableVersionId: string;
  readonly approverUserId: string;
  readonly approverKind: string;
  readonly decision: string;
}

export interface ApprovalChainVerdict {
  readonly status: ApprovalChainStatus;
  readonly records: number;
  readonly breakRecordNo: number | null;
  readonly reason: ApprovalChainBreakReason | null;
}

export interface ApprovalChainStore {
  /** Every organization holding at least one record (the one cross-tenant read). */
  organizations(): Promise<readonly string[]>;
  /** One organization's records after `afterRecordNo`, in order, at most `limit`. */
  records(
    organizationId: string,
    afterRecordNo: number,
    limit: number,
  ): Promise<readonly ChainRecordRow[]>;
  recordBreak(signal: {
    readonly id: string;
    readonly organizationId: string;
    readonly ruleKey: typeof APPROVAL_CHAIN_RULE_KEY;
    readonly severity: 'high';
    readonly sourceHash: string;
    readonly count: 1;
    readonly breakRecordNo: number;
    readonly reason: ApprovalChainBreakReason;
    readonly seenAt: Date;
  }): Promise<void>;
  /** 0355: the newest verdict time of any organization (the walk's last run), `null` if none. */
  latestCheckedAt(): Promise<Date | null>;
  /**
   * 0355: one verdict row; a broken one is written with its `approval.chain_broken.v1` outbox
   * event in the same transaction.
   */
  recordVerdict(check: ApprovalChainCheck): Promise<void>;
  /** Delete verdicts older than `before`; returns how many. */
  pruneBefore(before: Date): Promise<number>;
}

/** 0355 — one persisted verdict. */
export interface ApprovalChainCheck {
  readonly id: string;
  readonly organizationId: string;
  readonly checkedAt: Date;
  readonly status: ApprovalChainStatus;
  readonly records: number;
  readonly breakRecordNo: number | null;
  readonly reason: ApprovalChainBreakReason | null;
}

/** `null` = cannot tell (unsigned, or the key id is not in the ring). */
export type RecordSignatureCheck = (message: string, signature: string | null) => boolean | null;

export interface ApprovalChainDeps {
  readonly store: ApprovalChainStore;
  readonly verifySignature: RecordSignatureCheck;
  readonly now?: () => Date;
  readonly batch?: number;
}

export interface ApprovalChainResult {
  readonly organizations: number;
  readonly ok: number;
  readonly broken: number;
  readonly empty: number;
  readonly failed: number;
  readonly pruned: number;
}

export function approvalRecordGenesis(organizationId: string): string {
  return sha256Hex(`tmanage.approval.record.genesis:${organizationId}`);
}

/** The API's `AnchorSigner.verify`, over `AUDIT_ANCHOR_KEY`'s whole ring (old key ids verify). */
export function recordSignatureCheckFromEnv(env: {
  readonly AUDIT_ANCHOR_KEY?: string | undefined;
}): RecordSignatureCheck {
  let ring: ReadonlyMap<string, Buffer> = new Map();
  const raw = env.AUDIT_ANCHOR_KEY;
  if (raw !== undefined && raw.trim() !== '') {
    try {
      ring = parseFieldCipherKeys(raw).byId;
    } catch {
      ring = new Map();
    }
  }
  return (message, signature) => {
    if (signature === null) return null;
    const parts = signature.split(':');
    if (parts.length !== 3 || parts[0] !== 'v1') return false;
    const key = ring.get(parts[1] as string);
    if (key === undefined) return null;
    const expected = createHmac('sha256', key).update(message, 'utf8').digest();
    const presented = Buffer.from(parts[2] as string, 'hex');
    return expected.length === presented.length && timingSafeEqual(expected, presented);
  };
}

/** The stored JSON is canonical, hashes to the stored hash, and agrees with the row's columns. */
function sealedMatches(organizationId: string, row: ChainRecordRow): boolean {
  if (createHash('sha256').update(row.recordJson, 'utf8').digest('hex') !== row.recordHash) {
    return false;
  }
  try {
    const e = JSON.parse(row.recordJson) as {
      recordNo?: unknown;
      organizationId?: unknown;
      approvalId?: unknown;
      deliverableVersionId?: unknown;
      approver?: { userId?: unknown; kind?: unknown };
      decision?: unknown;
      previousRecordHash?: unknown;
    };
    return (
      canonicalJson(e) === row.recordJson &&
      e.recordNo === row.recordNo &&
      e.organizationId === organizationId &&
      e.approvalId === row.approvalId &&
      e.deliverableVersionId === row.deliverableVersionId &&
      e.approver?.userId === row.approverUserId &&
      e.approver?.kind === row.approverKind &&
      e.decision === row.decision &&
      e.previousRecordHash === row.previousRecordHash
    );
  } catch {
    return false;
  }
}

/**
 * Check one record against its expected position. Returns the first reason it fails, or `null`.
 * `previousHash` is the stored hash of the record before it (`null` for record 1).
 */
export function checkChainRecord(
  organizationId: string,
  row: ChainRecordRow,
  expectedRecordNo: number,
  previousHash: string | null,
  verifySignature: RecordSignatureCheck,
): ApprovalChainBreakReason | null {
  if (row.recordNo !== expectedRecordNo) return 'gap';
  if (previousHash === null) {
    if (row.previousRecordHash !== approvalRecordGenesis(organizationId)) return 'genesis_mismatch';
  } else if (row.previousRecordHash !== previousHash) return 'link_mismatch';
  if (!sealedMatches(organizationId, row)) return 'hash_mismatch';
  const message = canonicalJson([RECORD_SCHEMA, row.recordHash]);
  if (verifySignature(message, row.signature) === false) return 'signature_invalid';
  return null;
}

/** Walk one organization's chain in batches; stops at the FIRST break. */
export async function walkApprovalChain(
  deps: ApprovalChainDeps,
  organizationId: string,
): Promise<ApprovalChainVerdict> {
  const batch = deps.batch ?? APPROVAL_CHAIN_BATCH;
  let expected = 1;
  let previousHash: string | null = null;
  for (;;) {
    const rows = await deps.store.records(organizationId, expected - 1, batch);
    for (const row of rows) {
      const reason = checkChainRecord(
        organizationId,
        row,
        expected,
        previousHash,
        deps.verifySignature,
      );
      if (reason !== null) {
        return { status: 'broken', records: expected - 1, breakRecordNo: expected, reason };
      }
      previousHash = row.recordHash;
      expected += 1;
    }
    if (rows.length < batch) break;
  }
  const records = expected - 1;
  return { status: records === 0 ? 'empty' : 'ok', records, breakRecordNo: null, reason: null };
}

/** Due when never run, when the last run is over 26 h old, or once past tonight's 03:30 UTC. */
export function approvalChainWalkDue(last: Date | null, now: Date): boolean {
  if (last === null) return true;
  if (now.getTime() - last.getTime() > APPROVAL_CHAIN_STALE_MS) return true;
  const tonight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    APPROVAL_CHAIN_RUN_HOUR_UTC,
    APPROVAL_CHAIN_RUN_MINUTE_UTC,
  );
  return last.getTime() < tonight && now.getTime() >= tonight;
}

export async function runApprovalChainWalk(
  deps: ApprovalChainDeps,
  onError: (organizationId: string, error: unknown) => void = (organizationId, error) =>
    console.error(`[worker] approval chain walk failed for ${organizationId}`, error),
): Promise<ApprovalChainResult> {
  const now = (deps.now ?? (() => new Date()))();
  const organizations = await deps.store.organizations();
  const tally = { ok: 0, broken: 0, empty: 0, failed: 0 };
  for (const organizationId of organizations) {
    try {
      const verdict = await walkApprovalChain(deps, organizationId);
      await deps.store.recordVerdict({
        id: uuidv7(),
        organizationId,
        checkedAt: now,
        status: verdict.status,
        records: verdict.records,
        breakRecordNo: verdict.breakRecordNo,
        reason: verdict.reason,
      });
      if (verdict.status === 'broken' && verdict.breakRecordNo !== null && verdict.reason) {
        await deps.store.recordBreak({
          id: uuidv7(),
          organizationId,
          ruleKey: APPROVAL_CHAIN_RULE_KEY,
          severity: 'high',
          sourceHash: sourceHash(
            `${APPROVAL_CHAIN_RULE_KEY}|${organizationId}|${String(verdict.breakRecordNo)}|${verdict.reason}`,
          ),
          count: 1,
          breakRecordNo: verdict.breakRecordNo,
          reason: verdict.reason,
          seenAt: now,
        });
      }
      tally[verdict.status] += 1;
    } catch (error) {
      tally.failed += 1;
      onError(organizationId, error);
    }
  }
  const pruned = await deps.store.pruneBefore(
    new Date(now.getTime() - APPROVAL_CHAIN_RETENTION_DAYS * DAY_MS),
  );
  return { organizations: organizations.length, ...tally, pruned };
}
