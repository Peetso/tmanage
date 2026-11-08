import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../../common/database/drizzle.js';
import {
  credentialChangeNotices,
  sessions,
  userMfaFactors,
  userPasskeys,
  userPasswords,
  userRecoveryCodes,
  users,
} from '../../../common/database/schema.js';
import type { IdentityQueryRunner } from '../../../common/database/tenant-context.js';
import { orderedUuidv7 } from '../ordered-id.js';

/**
 * 56-22. Every read and write the passkey surface makes. Identity path only (no tenant): the
 * tables are global, and the sign-in read runs before any tenant exists.
 */

/** The tables every passkey unit of work declares (`identityRead` / `identityTransaction`). */
export const PASSKEY_TABLES = [
  'users',
  'sessions',
  'user_passkeys',
  'user_passwords',
  'user_mfa_factors',
  'user_recovery_codes',
  'authentication_events',
  'credential_change_notices',
] as const;

export interface PasskeyRecord {
  readonly id: string;
  readonly userId: string;
  readonly publicKey: string;
  readonly alg: number;
  readonly signCount: number;
  readonly lastChallengeAt: number;
}

export interface PasskeyListItem {
  readonly id: string;
  readonly name: string;
  readonly backedUp: boolean;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

export async function insertPasskey(
  runner: IdentityQueryRunner,
  row: {
    userId: string;
    credentialId: string;
    credentialIdHash: string;
    publicKey: string;
    alg: number;
    signCount: number;
    name: string;
    transports: string | null;
    backedUp: boolean;
  },
): Promise<string> {
  const id = orderedUuidv7();
  await tenantDrizzle(runner)
    .insert(userPasskeys)
    .values({ id, ...row, createdAt: sql`current_timestamp(3)` });
  return id;
}

/** The name and address a new passkey is labelled with on the person's device. */
export async function findPasskeyOwner(
  runner: IdentityQueryRunner,
  userId: string,
): Promise<{ email: string; displayName: string } | null> {
  const rows = await tenantDrizzle(runner)
    .select({ email: users.email, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function credentialHashTaken(
  runner: IdentityQueryRunner,
  hash: string,
): Promise<boolean> {
  const rows = await tenantDrizzle(runner)
    .select({ id: userPasskeys.id })
    .from(userPasskeys)
    .where(eq(userPasskeys.credentialIdHash, hash))
    .limit(1);
  return rows.length > 0;
}

/** A live passkey by its credential-id hash, with its owner's standing. */
export async function findLivePasskey(
  runner: IdentityQueryRunner,
  hash: string,
): Promise<(PasskeyRecord & { readonly disabled: boolean }) | null> {
  const rows = await tenantDrizzle(runner)
    .select({
      id: userPasskeys.id,
      userId: userPasskeys.userId,
      publicKey: userPasskeys.publicKey,
      alg: userPasskeys.alg,
      signCount: userPasskeys.signCount,
      lastChallengeAt: userPasskeys.lastChallengeAt,
      disabledAt: users.disabledAt,
    })
    .from(userPasskeys)
    .innerJoin(users, eq(users.id, userPasskeys.userId))
    .where(and(eq(userPasskeys.credentialIdHash, hash), isNull(userPasskeys.removedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const { disabledAt, ...record } = row;
  return { ...record, disabled: disabledAt !== null };
}

/**
 * Spend a challenge on a credential: compare-and-swap on the stored counter and challenge time,
 * so two concurrent assertions with one challenge cannot both succeed.
 */
export async function recordPasskeyUse(
  runner: IdentityQueryRunner,
  input: {
    id: string;
    expectedSignCount: number;
    expectedChallengeAt: number;
    signCount: number;
    challengeAt: number;
  },
): Promise<boolean> {
  const result = await tenantDrizzle(runner)
    .update(userPasskeys)
    .set({
      signCount: input.signCount,
      lastChallengeAt: input.challengeAt,
      lastUsedAt: sql`current_timestamp(3)`,
    })
    .where(
      and(
        eq(userPasskeys.id, input.id),
        eq(userPasskeys.signCount, input.expectedSignCount),
        eq(userPasskeys.lastChallengeAt, input.expectedChallengeAt),
        isNull(userPasskeys.removedAt),
      ),
    );
  return result[0].affectedRows === 1;
}

export async function listPasskeys(
  runner: IdentityQueryRunner,
  userId: string,
): Promise<readonly PasskeyListItem[]> {
  return tenantDrizzle(runner)
    .select({
      id: userPasskeys.id,
      name: userPasskeys.name,
      backedUp: userPasskeys.backedUp,
      createdAt: userPasskeys.createdAt,
      lastUsedAt: userPasskeys.lastUsedAt,
    })
    .from(userPasskeys)
    .where(and(eq(userPasskeys.userId, userId), isNull(userPasskeys.removedAt)))
    .orderBy(desc(userPasskeys.createdAt));
}

/** Soft-remove one of this person's passkeys. `false` when it is not theirs or already gone. */
export async function removePasskey(
  runner: IdentityQueryRunner,
  userId: string,
  passkeyId: string,
): Promise<boolean> {
  const result = await tenantDrizzle(runner)
    .update(userPasskeys)
    .set({ removedAt: sql`current_timestamp(3)` })
    .where(
      and(
        eq(userPasskeys.id, passkeyId),
        eq(userPasskeys.userId, userId),
        isNull(userPasskeys.removedAt),
      ),
    );
  return result[0].affectedRows === 1;
}

/** The facts the security score is computed from. */
export async function readSecurityFacts(
  runner: IdentityQueryRunner,
  userId: string,
): Promise<{
  mfaFactors: number;
  passkeys: number;
  recoveryCodes: number;
  passwordSetAt: Date | null;
}> {
  const db = tenantDrizzle(runner);
  const [factors, keys, codes, password] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)` })
      .from(userMfaFactors)
      .where(
        and(
          eq(userMfaFactors.userId, userId),
          isNull(userMfaFactors.disabledAt),
          sql`${userMfaFactors.confirmedAt} is not null`,
        ),
      ),
    db
      .select({ n: sql<number>`count(*)` })
      .from(userPasskeys)
      .where(and(eq(userPasskeys.userId, userId), isNull(userPasskeys.removedAt))),
    db
      .select({ n: sql<number>`count(*)` })
      .from(userRecoveryCodes)
      .where(
        and(
          eq(userRecoveryCodes.userId, userId),
          isNull(userRecoveryCodes.usedAt),
          isNull(userRecoveryCodes.revokedAt),
        ),
      ),
    db
      .select({ setAt: userPasswords.setAt })
      .from(userPasswords)
      .where(eq(userPasswords.userId, userId))
      .limit(1),
  ]);
  return {
    mfaFactors: Number(factors[0]?.n ?? 0),
    passkeys: Number(keys[0]?.n ?? 0),
    recoveryCodes: Number(codes[0]?.n ?? 0),
    passwordSetAt: password[0]?.setAt ?? null,
  };
}

/** The user agents of this person's earlier sessions (newest first), for the new-device check. */
export async function listEarlierUserAgents(
  runner: IdentityQueryRunner,
  userId: string,
  exceptSessionId: string,
): Promise<readonly (string | null)[]> {
  const rows = await tenantDrizzle(runner)
    .select({ userAgent: sessions.userAgent })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId)))
    .orderBy(desc(sessions.createdAt))
    .limit(200);
  return rows.map((row) => row.userAgent);
}

/** Queue a security notice on the existing credential-notice outbox (drained by the worker). */
export async function queueSecurityNotice(
  runner: IdentityQueryRunner,
  input: { userId: string; action: string; correlationId: string },
): Promise<void> {
  await tenantDrizzle(runner)
    .insert(credentialChangeNotices)
    .values({
      id: orderedUuidv7(),
      userId: input.userId,
      action: input.action,
      correlationId: input.correlationId,
      occurredAt: sql`current_timestamp(3)`,
      availableAt: sql`current_timestamp(3)`,
    });
}
