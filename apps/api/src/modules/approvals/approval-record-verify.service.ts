import { randomUUID } from 'node:crypto';
import type { ApprovalRecordRow } from '../../common/database/schema.js';
import {
  createServiceContext,
  type TenantContext,
  type TenantDatabase,
  type TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { AnchorSigner } from '../audit/audit-anchor-signer.js';
import { verifyRecord, type ApprovalEvidence } from './approval-records.js';
import {
  fingerprintMatches,
  isVerifiedDecision,
  NOT_FOUND_VERDICT,
  verifyInput,
  type PublicRecordVerdictView,
} from './approval-record-verify.js';
import type { FindRecordForVerify } from './approval-record-verify.repository.js';

/** The scoped reads the check needs once the fingerprint has matched. */
export interface RecordVerifyStore {
  findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    recordId: string,
  ): Promise<ApprovalRecordRow | null>;
  organizationName(runner: TenantQueryRunner, context: TenantContext): Promise<string>;
}

export interface RecordHashReader {
  hashesByNumber(
    runner: TenantQueryRunner,
    context: TenantContext,
    recordNos: readonly number[],
  ): Promise<ReadonlyMap<number, string>>;
}

/**
 * 52-19 (web half) — `POST /v1/public/approval-records/verify`: is this printed record genuine?
 *
 * Step 1 is the same for every caller: one lookup by ID, one constant-time comparison. Only when
 * the presented fingerprint is the stored hash does step 2 run, inside the record's organization:
 * re-read the row, check it the way the certificate does (`verifyRecord`: the JSON still hashes to
 * the hash, the row agrees with it, it points at the previous record, the seal holds) and name the
 * workspace. A missing ID, a malformed value and a wrong fingerprint all return
 * {@link NOT_FOUND_VERDICT} and never reach step 2.
 */
export class ApprovalRecordVerifyService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly lookup: FindRecordForVerify,
    private readonly store: RecordVerifyStore,
    private readonly hashes: RecordHashReader,
    private readonly signer: AnchorSigner = AnchorSigner.fromEnv(process.env),
  ) {}

  async verify(body: unknown): Promise<PublicRecordVerdictView> {
    const { recordId, fingerprint } = verifyInput(body);
    const correlationId = randomUUID();
    const found = recordId === null ? null : await this.lookup(recordId, correlationId);
    // Always exactly one constant-time comparison, found or not.
    const matched = fingerprintMatches(fingerprint, found?.recordHash ?? null);
    if (!matched || found === null || recordId === null) return NOT_FOUND_VERDICT;

    const context = createServiceContext({
      organizationId: found.organizationId,
      correlationId,
      policyVersion: 'public-record-verify',
    });
    return this.database.read(context, async (runner) => {
      const row = await this.store.findById(runner, context, recordId);
      // Gone between the two reads: nothing to vouch for.
      if (row === null) return NOT_FOUND_VERDICT;
      const previous =
        row.recordNo > 1
          ? ((await this.hashes.hashesByNumber(runner, context, [row.recordNo - 1])).get(
              row.recordNo - 1,
            ) ?? null)
          : null;
      const check = verifyRecord(row, previous, this.signer);
      const workspaceName = await this.store.organizationName(runner, context);
      const genuine =
        check.hashValid &&
        check.chainValid &&
        check.signatureValid !== false &&
        fingerprintMatches(fingerprint, row.recordHash);
      if (!genuine) {
        return { verdict: 'altered', decidedAt: null, decision: null, workspaceName };
      }
      const evidence = JSON.parse(row.recordJson) as Pick<ApprovalEvidence, 'decidedAt'>;
      return {
        verdict: 'genuine',
        decidedAt: typeof evidence.decidedAt === 'string' ? evidence.decidedAt : null,
        decision: isVerifiedDecision(row.decision) ? row.decision : null,
        workspaceName,
      };
    });
  }
}
