import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { ssoSamlRequests } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 54-15 — storage for `sso_saml_requests` (0330): the AuthnRequest IDs this server sent and the
 * Assertion IDs it accepted, per organization. Always through a service context bound to the
 * organization of the signed flow cookie. Times are bound `Date`s from the service's clock.
 */

const ER_DUP_ENTRY = 1062;

/** A duplicate-key violation, seen through Drizzle's wrapper (the driver error is on `cause`). */
export function isDuplicateKeyError(error: unknown): boolean {
  const marks = (candidate: unknown): boolean =>
    typeof candidate === 'object' &&
    candidate !== null &&
    ((candidate as { errno?: number }).errno === ER_DUP_ENTRY ||
      (candidate as { code?: string }).code === 'ER_DUP_ENTRY');
  if (marks(error)) return true;
  return typeof error === 'object' && error !== null && marks((error as { cause?: unknown }).cause);
}

export class SsoSamlRequestsRepository {
  /** Remember a sent AuthnRequest; expired rows of the organization go on the way. */
  async rememberRequest(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
    now: Date,
    expiresAt: Date,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(ssoSamlRequests)
      .where(
        and(
          eq(ssoSamlRequests.organizationId, context.organizationId),
          lt(ssoSamlRequests.expiresAt, now),
        ),
      );
    await db.insert(ssoSamlRequests).values({
      id: uuidv7(),
      organizationId: context.organizationId,
      kind: 'request',
      samlId: requestId,
      expiresAt,
      consumedAt: null,
      createdAt: now,
    });
  }

  /** Mark the request answered; false when it is unknown, expired or answered already. */
  async consumeRequest(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(ssoSamlRequests)
      .set({ consumedAt: now })
      .where(
        and(
          eq(ssoSamlRequests.organizationId, context.organizationId),
          eq(ssoSamlRequests.kind, 'request'),
          eq(ssoSamlRequests.samlId, requestId),
          isNull(ssoSamlRequests.consumedAt),
          gt(ssoSamlRequests.expiresAt, now),
        ),
      );
    return result[0].affectedRows === 1;
  }

  /** Record an accepted Assertion ID; false when it was seen before (a replay). */
  async rememberAssertion(
    runner: TenantQueryRunner,
    context: TenantContext,
    assertionId: string,
    now: Date,
    expiresAt: Date,
  ): Promise<boolean> {
    const db = tenantDrizzle(runner);
    const seen = await db
      .select({ id: ssoSamlRequests.id })
      .from(ssoSamlRequests)
      .where(
        and(
          eq(ssoSamlRequests.organizationId, context.organizationId),
          eq(ssoSamlRequests.kind, 'assertion'),
          eq(ssoSamlRequests.samlId, assertionId),
        ),
      )
      .limit(1);
    if (seen.length > 0) return false;
    try {
      await db.insert(ssoSamlRequests).values({
        id: uuidv7(),
        organizationId: context.organizationId,
        kind: 'assertion',
        samlId: assertionId,
        expiresAt,
        consumedAt: now,
        createdAt: now,
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
    return true;
  }
}
