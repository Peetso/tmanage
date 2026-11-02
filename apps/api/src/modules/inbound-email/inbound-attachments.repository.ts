import { and, asc, eq, lt, ne, or, isNull } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { inboundEmailAttachments, inboundEmails } from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * R22-d (54-12a part 2) — the attachment scan pass's and the serving routes' storage on
 * `inbound_email_attachments`. No migration: the columns R21-f made (`state`, `scan_status`,
 * `scan_signature`, `sha256`, `detected_type`, `updated_at`) carry everything.
 *
 * ## The claim, without a claim column
 *
 * There is no `scan_claimed_at`. A pass claims a `scanning` row by a compare-and-swap on
 * `updated_at`: `scan_status = 'claimed'`, `updated_at = now`, conditional on the `updated_at`
 * it read. A row is eligible when it is `scanning` and either nobody holds it (`scan_status` is
 * not `claimed`) or the hold is older than the stale bound — so a pass that died, or a scanner
 * that was down (the row is left `scanning`, its claim standing), is retried after the bound and
 * never sooner. Every statement but {@link InboundAttachmentsRepository.organizationsAwaitingScan}
 * carries the caller context's `organization_id`; that one is the pass's bootstrap read
 * (`bootstrapRead(['inbound_email_attachments'])`) of which organizations have work.
 */

export const CLAIMED = 'claimed';

/** One row the pass may claim, with its mail's address id (the object key's middle segment). */
export interface ScanCandidate {
  readonly id: string;
  readonly inboundEmailId: string;
  readonly addressId: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly detectedType: string | null;
  readonly updatedAt: Date;
}

/** One attachment with the facts of its mail the serving routes need. */
export interface ServableAttachment {
  readonly id: string;
  readonly inboundEmailId: string;
  readonly addressId: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly state: string;
  readonly detectedType: string | null;
  readonly authResult: string;
}

export interface ScanFacts {
  /** The driver's token (`stub`, `clamav`); never the engine's detection name. */
  readonly scanner: string;
  readonly detectedType: string | null;
  readonly at: Date;
}

function eligible(staleBefore: Date): SQL {
  return and(
    eq(inboundEmailAttachments.state, 'scanning'),
    or(
      isNull(inboundEmailAttachments.scanStatus),
      ne(inboundEmailAttachments.scanStatus, CLAIMED),
      lt(inboundEmailAttachments.updatedAt, staleBefore),
    ),
  ) as SQL;
}

export class InboundAttachmentsRepository {
  /** Bootstrap read: the organizations holding a claimable `scanning` attachment. */
  async organizationsAwaitingScan(
    runner: BootstrapQueryRunner,
    staleBefore: Date,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ organizationId: inboundEmailAttachments.organizationId })
      .from(inboundEmailAttachments)
      .where(eligible(staleBefore))
      .orderBy(asc(inboundEmailAttachments.organizationId));
    return rows.map((row) => row.organizationId);
  }

  /** Claimable rows of this organization, oldest first. */
  async listAwaitingScan(
    runner: TenantQueryRunner,
    context: TenantContext,
    staleBefore: Date,
    limit: number,
  ): Promise<readonly ScanCandidate[]> {
    return tenantDrizzle(runner)
      .select({
        id: inboundEmailAttachments.id,
        inboundEmailId: inboundEmailAttachments.inboundEmailId,
        addressId: inboundEmails.addressId,
        name: inboundEmailAttachments.name,
        sizeBytes: inboundEmailAttachments.sizeBytes,
        sha256: inboundEmailAttachments.sha256,
        detectedType: inboundEmailAttachments.detectedType,
        updatedAt: inboundEmailAttachments.updatedAt,
      })
      .from(inboundEmailAttachments)
      .innerJoin(
        inboundEmails,
        and(
          eq(inboundEmails.organizationId, inboundEmailAttachments.organizationId),
          eq(inboundEmails.id, inboundEmailAttachments.inboundEmailId),
        ),
      )
      .where(
        and(
          eq(inboundEmailAttachments.organizationId, context.organizationId),
          eligible(staleBefore),
        ),
      )
      .orderBy(asc(inboundEmailAttachments.updatedAt), asc(inboundEmailAttachments.id))
      .limit(limit);
  }

  /** The compare-and-swap claim on `updated_at`. `true` when this call took the row. */
  async claimScanning(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: Pick<ScanCandidate, 'id' | 'updatedAt'>,
    staleBefore: Date,
    now: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(inboundEmailAttachments)
      .set({ scanStatus: CLAIMED, updatedAt: now })
      .where(
        and(
          eq(inboundEmailAttachments.organizationId, context.organizationId),
          eq(inboundEmailAttachments.id, row.id),
          eq(inboundEmailAttachments.updatedAt, row.updatedAt),
          eligible(staleBefore),
        ),
      );
    return result[0].affectedRows === 1;
  }

  /** `scanning -> clean`, conditional on this pass still holding the claim. */
  async recordClean(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    facts: ScanFacts,
  ): Promise<boolean> {
    return this.conclude(runner, context, id, {
      state: 'clean',
      scanStatus: 'clean',
      scanSignature: facts.scanner,
      detectedType: facts.detectedType,
      updatedAt: facts.at,
    });
  }

  /** `scanning -> blocked_threat`; the detection name is never stored (stderr only). */
  async recordThreat(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    facts: ScanFacts,
  ): Promise<boolean> {
    return this.conclude(runner, context, id, {
      state: 'blocked_threat',
      scanStatus: 'infected',
      scanSignature: facts.scanner,
      detectedType: facts.detectedType,
      updatedAt: facts.at,
    });
  }

  /** `scanning -> unavailable`: the bytes are missing or not the ones parked. Ask to re-send. */
  async markUnavailable(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    at: Date,
  ): Promise<boolean> {
    return this.conclude(runner, context, id, {
      state: 'unavailable',
      scanStatus: 'failed',
      updatedAt: at,
    });
  }

  private async conclude(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    values: {
      readonly state: string;
      readonly scanStatus: string;
      readonly scanSignature?: string;
      readonly detectedType?: string | null;
      readonly updatedAt: Date;
    },
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(inboundEmailAttachments)
      .set({
        state: values.state,
        scanStatus: values.scanStatus,
        ...(values.scanSignature !== undefined ? { scanSignature: values.scanSignature } : {}),
        ...(values.detectedType !== undefined && values.detectedType !== null
          ? { detectedType: values.detectedType }
          : {}),
        updatedAt: values.updatedAt,
      })
      .where(
        and(
          eq(inboundEmailAttachments.organizationId, context.organizationId),
          eq(inboundEmailAttachments.id, id),
          eq(inboundEmailAttachments.state, 'scanning'),
          eq(inboundEmailAttachments.scanStatus, CLAIMED),
        ),
      );
    return result[0].affectedRows === 1;
  }

  /** One attachment and its mail, for preview/download. `null` when not this organization's. */
  async findForServe(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<ServableAttachment | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        id: inboundEmailAttachments.id,
        inboundEmailId: inboundEmailAttachments.inboundEmailId,
        addressId: inboundEmails.addressId,
        name: inboundEmailAttachments.name,
        sizeBytes: inboundEmailAttachments.sizeBytes,
        state: inboundEmailAttachments.state,
        detectedType: inboundEmailAttachments.detectedType,
        authResult: inboundEmails.authResult,
      })
      .from(inboundEmailAttachments)
      .innerJoin(
        inboundEmails,
        and(
          eq(inboundEmails.organizationId, inboundEmailAttachments.organizationId),
          eq(inboundEmails.id, inboundEmailAttachments.inboundEmailId),
        ),
      )
      .where(
        and(
          eq(inboundEmailAttachments.organizationId, context.organizationId),
          eq(inboundEmailAttachments.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}
