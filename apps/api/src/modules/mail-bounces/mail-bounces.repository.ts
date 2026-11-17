import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { emailAddressHash } from '@tmanage/mail';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { mailRecipientBounces } from '../../common/database/schema.js';
import type { MailBounceKind, MailRecipientBounceRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 56-26 (0366) — storage for `mail_recipient_bounces`. Every statement carries the caller
 * context's `organization_id`: the intake's context is the company the signed Message-ID named,
 * an admin's is their own company. No DELETE: clearing a suppression is an UPDATE.
 */

/** The counts and suppression one bounce leaves behind. */
export interface BounceState {
  readonly hardCount: number;
  readonly softCount: number;
  readonly lastKind: MailBounceKind;
  readonly lastStatus: string;
  readonly lastMessageRef: string;
  readonly lastBouncedAt: Date;
  readonly suppressedAt: Date | null;
}

export class MailBouncesRepository {
  /** The company's row for one address hash, locked for the bounce being recorded. */
  async findForUpdate(
    runner: TenantQueryRunner,
    context: TenantContext,
    addressHash: string,
  ): Promise<MailRecipientBounceRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(mailRecipientBounces)
      .where(
        and(
          eq(mailRecipientBounces.organizationId, context.organizationId),
          eq(mailRecipientBounces.addressHash, addressHash),
        ),
      )
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    addressHash: string,
  ): Promise<MailRecipientBounceRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(mailRecipientBounces)
      .where(
        and(
          eq(mailRecipientBounces.organizationId, context.organizationId),
          eq(mailRecipientBounces.addressHash, addressHash),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Whether the company holds mail to this address hash. */
  async isSuppressed(
    runner: TenantQueryRunner,
    context: TenantContext,
    addressHash: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ addressHash: mailRecipientBounces.addressHash })
      .from(mailRecipientBounces)
      .where(
        and(
          eq(mailRecipientBounces.organizationId, context.organizationId),
          eq(mailRecipientBounces.addressHash, addressHash),
          isNotNull(mailRecipientBounces.suppressedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * 56-26 (B1): which of these addresses the company has stopped mailing — one query for a whole
   * invitation list. Answers the addresses as given; the hash never leaves this method.
   */
  async suppressedAddresses(
    runner: TenantQueryRunner,
    context: TenantContext,
    addresses: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (addresses.length === 0) return new Set();
    const hashes = [...new Set(addresses.map(emailAddressHash))];
    const rows = await tenantDrizzle(runner)
      .select({ addressHash: mailRecipientBounces.addressHash })
      .from(mailRecipientBounces)
      .where(
        and(
          eq(mailRecipientBounces.organizationId, context.organizationId),
          inArray(mailRecipientBounces.addressHash, hashes),
          isNotNull(mailRecipientBounces.suppressedAt),
        ),
      );
    const stopped = new Set(rows.map((row) => row.addressHash));
    return new Set(addresses.filter((address) => stopped.has(emailAddressHash(address))));
  }

  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    addressHash: string,
    state: BounceState,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(mailRecipientBounces)
      .values({
        organizationId: context.organizationId,
        addressHash,
        ...state,
        createdAt: at,
        updatedAt: at,
      });
  }

  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    addressHash: string,
    state: BounceState,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(mailRecipientBounces)
      .set({ ...state, updatedAt: at })
      .where(
        and(
          eq(mailRecipientBounces.organizationId, context.organizationId),
          eq(mailRecipientBounces.addressHash, addressHash),
        ),
      );
  }

  /** An admin lifts the suppression; the counts start again. */
  async clear(
    runner: TenantQueryRunner,
    context: TenantContext,
    addressHash: string,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(mailRecipientBounces)
      .set({
        hardCount: 0,
        softCount: 0,
        suppressedAt: null,
        clearedAt: at,
        clearedByUserId: context.userId,
        updatedAt: at,
      })
      .where(
        and(
          eq(mailRecipientBounces.organizationId, context.organizationId),
          eq(mailRecipientBounces.addressHash, addressHash),
        ),
      );
  }
}
