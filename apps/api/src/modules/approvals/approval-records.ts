import type { ReviewerDecision } from '@tmanage/domain';
import type { ApprovalRecordRow } from '../../common/database/schema.js';
import type { AnchorSigner } from '../audit/audit-anchor-signer.js';
import { canonicalJson, sha256Hex } from '../audit/audit-chain.js';

/**
 * 52-19 — the legal-grade approval record, as pure functions. No I/O: the repository stores what
 * {@link sealRecord} returns and the certificate route checks it with {@link verifyRecord}, so
 * what is written and what is checked can never be two different canonical forms.
 *
 * ## Canonical form
 *
 * {@link ApprovalEvidence} serialised by the audit chain's `canonicalJson` (object keys sorted at
 * every depth). Free text (the comment, the user agent) is NFC-normalised before it is sealed, so
 * the same words typed on two keyboards hash the same. `record_hash` = SHA-256 of that text.
 *
 * ## Chain and signature
 *
 * The records of one organization form a chain: record `n` carries the hash of record `n - 1`
 * inside its own sealed JSON, and record 1 points at {@link recordGenesisHash} — bound to the
 * organization so one organization's chain cannot be spliced in front of another's. The signature
 * is the audit anchor key's HMAC over a domain-separated message (`tmanage.approval.record.v1`),
 * so it can never be confused with an audit anchor signed by the same key.
 */

export const RECORD_SCHEMA = 'tmanage.approval.record.v1';

/** The longest user agent kept in a record; longer headers are cut, never refused. */
const USER_AGENT_MAX = 512;

export type ApproverKind = 'internal' | 'client';

/** The request facts the API itself saw — never values from the request body. */
export interface DecisionEvidence {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** Everything a record proves. Dates are ISO-8601 instants to the millisecond. */
export interface ApprovalEvidence {
  readonly schema: typeof RECORD_SCHEMA;
  readonly recordNo: number;
  readonly previousRecordHash: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly approvalId: string;
  readonly deliverableId: string;
  readonly deliverableVersionId: string;
  readonly versionNo: number | null;
  readonly fileVersionId: string | null;
  /** SHA-256 (hex) of the exact version the approver decided on. */
  readonly contentHash: string;
  readonly approver: {
    readonly userId: string;
    readonly membershipId: string;
    readonly kind: ApproverKind;
    readonly role: string;
    readonly clientOrganizationId: string | null;
  };
  readonly decision: ReviewerDecision;
  readonly comment: string | null;
  readonly decidedAt: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/**
 * 52-26. What a simple electronic signature adds to the record: how the signer signed, the
 * consent sentence (and its version) they ticked, when their one-time e-mail code was checked, and
 * the SHA-256 of a drawn mark. Sealed in the same chain as the approval decisions, never a second.
 */
export interface EsignFacts {
  readonly requestId: string;
  readonly signerId: string;
  readonly signerEmail: string;
  readonly signerName: string;
  readonly method: 'typed' | 'drawn';
  readonly typedName: string | null;
  readonly markSha256: string | null;
  readonly consentTextVersion: string;
  readonly consentText: string;
  readonly codeVerifiedAt: string;
}

/**
 * 52-26. A signature record: the decision record's facts with `decision = 'signed'`. Its
 * `approvalId` column carries the signature request id (the chain row's subject), and `contentHash`
 * the SHA-256 the request pinned.
 */
export interface EsignEvidence extends Omit<ApprovalEvidence, 'decision'> {
  readonly decision: 'signed';
  readonly esign: EsignFacts;
}

/** Any record the chain seals. */
export type SealableEvidence = ApprovalEvidence | EsignEvidence;

/** The chain position the repository fills in. */
export interface ChainPosition {
  readonly organizationId: string;
  readonly recordNo: number;
  readonly previousRecordHash: string;
}

export interface SealedRecord<E extends SealableEvidence = ApprovalEvidence> {
  readonly evidence: E;
  readonly recordJson: string;
  readonly recordHash: string;
  readonly signature: string | null;
}

export interface RecordVerification {
  /** The stored JSON still hashes to the stored hash, and the row's columns agree with it. */
  readonly hashValid: boolean;
  /** The record points at the previous record's stored hash (or the genesis for record 1). */
  readonly chainValid: boolean;
  /** `null` = unsigned, or signed with a key id this server no longer holds. */
  readonly signatureValid: boolean | null;
}

export function recordGenesisHash(organizationId: string): string {
  return sha256Hex(`tmanage.approval.record.genesis:${organizationId}`);
}

function signatureMessage(recordHash: string): string {
  return canonicalJson([RECORD_SCHEMA, recordHash]);
}

function normalizedText(value: string | null, max?: number): string | null {
  if (value === null) return null;
  const text = value.normalize('NFC');
  return max === undefined ? text : text.slice(0, max);
}

/** Normalise the free text, serialise, hash and sign one record. */
export function sealRecord<E extends SealableEvidence>(
  evidence: E,
  signer: AnchorSigner,
): SealedRecord<E> {
  const normalized: E = {
    ...evidence,
    comment: normalizedText(evidence.comment),
    userAgent: normalizedText(evidence.userAgent, USER_AGENT_MAX),
  };
  const recordJson = canonicalJson(normalized);
  const recordHash = sha256Hex(recordJson);
  return {
    evidence: normalized,
    recordJson,
    recordHash,
    signature: signer.sign(signatureMessage(recordHash)),
  };
}

/** The stored JSON hashes to the stored hash, is canonical, and agrees with the row's columns. */
function storedEvidenceMatches(row: ApprovalRecordRow): boolean {
  if (sha256Hex(row.recordJson) !== row.recordHash) return false;
  try {
    const evidence = JSON.parse(row.recordJson) as SealableEvidence;
    return (
      canonicalJson(evidence) === row.recordJson &&
      evidence.recordNo === row.recordNo &&
      evidence.organizationId === row.organizationId &&
      evidence.approvalId === row.approvalId &&
      evidence.deliverableVersionId === row.deliverableVersionId &&
      evidence.approver.userId === row.approverUserId &&
      evidence.approver.kind === row.approverKind &&
      evidence.decision === row.decision &&
      evidence.previousRecordHash === row.previousRecordHash
    );
  } catch {
    // Not JSON, or not the record's shape: whatever it is, it is not what was sealed.
    return false;
  }
}

/**
 * Check one stored record. `previousHash` is the stored hash of record `recordNo - 1`, or `null`
 * when that row is missing (a gap breaks the chain); record 1 is checked against the genesis.
 */
export function verifyRecord(
  row: ApprovalRecordRow,
  previousHash: string | null,
  signer: AnchorSigner,
): RecordVerification {
  const expectedPrevious =
    row.recordNo === 1 ? recordGenesisHash(row.organizationId) : previousHash;
  return {
    hashValid: storedEvidenceMatches(row),
    chainValid: expectedPrevious !== null && expectedPrevious === row.previousRecordHash,
    signatureValid: signer.verify(signatureMessage(row.recordHash), row.signature),
  };
}
