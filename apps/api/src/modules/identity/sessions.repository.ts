import { and, asc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { sessionRefreshTokens, sessions } from '../../common/database/schema.js';
import type { SessionRefreshTokenRow, SessionRow } from '../../common/database/schema.js';
import type { IdentityQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Session storage — ID-001's persistence half.
 *
 * Every method takes an {@link IdentityQueryRunner} and nothing else. There is no
 * `TenantContext` parameter here and there could not be: spec §3 step 1 runs before step 2
 * has decided which organization the request is even about. What replaces the tenant
 * predicate is that this path can reach no tenant table at all — see
 * `TenantDatabase.identityRead()`.
 *
 * ## The database owns the clock
 *
 * Every temporal comparison below is written as `now(3)` and evaluated by the **server**,
 * never by the Node process — including the expiry flag on {@link SessionState}, which exists
 * precisely so that a caller can report "expired" without ever comparing a `Date` from the
 * database against `Date.now()` in the application.
 *
 * The reason is the one the membership resolver gives for client-membership expiry: the row
 * is the record of authority, and two API instances with skewed clocks must not disagree
 * about whether a session is still live. A session that is expired on one instance and live
 * on another is a defect that appears only under load, on one machine, intermittently — and
 * on the side that matters it appears as access outliving its revocation.
 *
 * ## No hard delete
 *
 * Revocation is a state, matching the rest of the schema. Sessions are also what the audit
 * trail refers to when it records who did something, and a deleted session id makes an audit
 * row unreadable.
 */

export interface CreateSessionInput {
  readonly userId: string;
  /** SHA-256 hex of the first refresh token. The token itself never reaches this layer. */
  readonly refreshTokenHash: string;
  readonly userAgent?: string | null;
  /** The session's absolute lifetime. `REFRESH_TTL_SECONDS` in `packages/config`. */
  readonly ttlSeconds: number;
}

export interface RotateSessionInput {
  readonly sessionId: string;
  /** The hash the caller presented. The swap only happens if it is still the live one. */
  readonly currentHash: string;
  readonly nextHash: string;
  /** When the token being superseded was issued — `rotatedAt ?? createdAt` of the session. */
  readonly issuedAt: Date;
}

/** A session row plus the one fact about it the application must not compute for itself. */
export interface SessionState {
  readonly session: SessionRow;
  /** `expires_at <= now(3)`, evaluated by the database. */
  readonly expired: boolean;
}

/** The device/session list projection. Deliberately carries no token hash of any kind. */
export interface SessionSummary {
  readonly id: string;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly rotatedAt: Date | null;
  readonly expiresAt: Date;
}

/** MySQL returns 1/0 rather than a boolean; it has no boolean type. */
const expiredByServerClock = sql<number>`case when ${sessions.expiresAt} <= now(3) then 1 else 0 end`;

export class SessionsRepository {
  async create(runner: IdentityQueryRunner, input: CreateSessionInput): Promise<SessionRow> {
    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(sessions)
      .values({
        id,
        userId: input.userId,
        refreshTokenHash: input.refreshTokenHash,
        userAgent: input.userAgent ?? null,
        // Fixed here and never moved again. Rotation issues a new token inside the same
        // window; it does not extend the window, because a refresh token that slides its own
        // expiry produces a session that never ends — and a stolen one that never ends either.
        expiresAt: sql`date_add(now(3), interval ${input.ttlSeconds} second)`,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findById(runner, id);
    if (!created) throw new Error(`Session ${id} was not found immediately after writing it`);
    return created.session;
  }

  /**
   * One session by id, with the server's verdict on its expiry.
   *
   * Returns the row whatever state it is in. Classifying "revoked" and "expired" separately
   * is the service's job, because the two produce the same answer to the caller and different
   * entries in the audit trail — a distinction that must not be flattened into a boolean here.
   */
  async findById(runner: IdentityQueryRunner, sessionId: string): Promise<SessionState | null> {
    const rows = await tenantDrizzle(runner)
      .select({ session: sessions, expired: expiredByServerClock })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const row = rows[0];
    return row ? { session: row.session, expired: Number(row.expired) === 1 } : null;
  }

  /** The session whose **live** refresh token hashes to this value, if any. */
  async findByLiveTokenHash(
    runner: IdentityQueryRunner,
    tokenHash: string,
  ): Promise<SessionState | null> {
    const rows = await tenantDrizzle(runner)
      .select({ session: sessions, expired: expiredByServerClock })
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, tokenHash))
      .limit(1);
    const row = rows[0];
    return row ? { session: row.session, expired: Number(row.expired) === 1 } : null;
  }

  /**
   * The ledger row for a token that has already been rotated away.
   *
   * A hit here is the reuse signal, and it is the whole reason `session_refresh_tokens`
   * exists: without it a replayed token would hash to a value nothing holds, and a real
   * compromise would be indistinguishable from a stale browser tab.
   */
  async findSupersededToken(
    runner: IdentityQueryRunner,
    tokenHash: string,
  ): Promise<SessionRefreshTokenRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(sessionRefreshTokens)
      .where(eq(sessionRefreshTokens.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Swap the live token, recording the old one — atomically, or not at all.
   *
   * The `UPDATE` is a compare-and-swap: it names the hash the caller presented, so it matches
   * only while that hash is still the live one. Two tabs refreshing at the same instant both
   * read the same hash; then one blocks on the other's row lock and, when it proceeds, finds
   * nothing to update. Exactly one rotation happens, and the loser is told so rather than
   * being handed a second live token.
   *
   * Order matters. The `UPDATE` runs first because it is what takes the lock and proves this
   * caller owns the rotation; the ledger insert follows inside the same transaction.
   * Inserting first would briefly leave one hash present in **both** the live column and the
   * superseded ledger, and a concurrent reader hitting that window would see a live token
   * report itself as replayed — and revoke a healthy session.
   *
   * @returns `false` when the swap did not happen: a lost race, or a session revoked or
   * expired between the read and the write.
   */
  async rotate(runner: IdentityQueryRunner, input: RotateSessionInput): Promise<boolean> {
    const db = tenantDrizzle(runner);

    const swapped = await db
      .update(sessions)
      .set({ refreshTokenHash: input.nextHash, rotatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(sessions.id, input.sessionId),
          eq(sessions.refreshTokenHash, input.currentHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, sql`now(3)`),
        ),
      );

    if (swapped[0].affectedRows === 0) return false;

    await db.insert(sessionRefreshTokens).values({
      id: uuidv7(),
      sessionId: input.sessionId,
      tokenHash: input.currentHash,
      issuedAt: input.issuedAt,
      supersededAt: sql`current_timestamp(3)`,
    });

    return true;
  }

  /**
   * End one session.
   *
   * Idempotent by construction: `revoked_at IS NULL` in the predicate means a second call
   * changes nothing and leaves the **first** reason in place. That matters for the reason
   * this method exists — a session revoked for `refresh_reuse_detected` must not have that
   * finding overwritten by a later routine sign-out.
   */
  async revoke(runner: IdentityQueryRunner, sessionId: string, reason: string): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(sessions)
      .set({ revokedAt: sql`current_timestamp(3)`, revokedReason: reason })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
    return result[0].affectedRows > 0;
  }

  /**
   * End every live session a person holds — the global cutoff.
   *
   * `04-SECURITY-PRIVACY` §3: "immediate server-side revocation on offboarding and sensitive
   * permission changes". Immediate is only true because authentication reads the session row
   * on every request rather than trusting the access token's signature until it expires.
   */
  async revokeAllForUser(
    runner: IdentityQueryRunner,
    userId: string,
    reason: string,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(sessions)
      .set({ revokedAt: sql`current_timestamp(3)`, revokedReason: reason })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    return result[0].affectedRows;
  }

  /**
   * `D06`: the cutoff that spares one session. Every live session this person holds ends
   * except `keepSessionId` — the one that just proved itself for the change that is ending the
   * others. Same statement shape as {@link revokeAllForUser}; the exception is the only
   * difference, and it is applied here rather than by re-issuing the kept session, because a
   * session that is ended and re-opened is a different row with a different history.
   */
  async revokeOthersForUser(
    runner: IdentityQueryRunner,
    userId: string,
    keepSessionId: string,
    reason: string,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(sessions)
      .set({ revokedAt: sql`current_timestamp(3)`, revokedReason: reason })
      .where(
        and(
          eq(sessions.userId, userId),
          ne(sessions.id, keepSessionId),
          isNull(sessions.revokedAt),
        ),
      );
    return result[0].affectedRows;
  }

  /** The device/session list (04 §3). Live sessions only, and no credential material. */
  async listForUser(
    runner: IdentityQueryRunner,
    userId: string,
  ): Promise<readonly SessionSummary[]> {
    return tenantDrizzle(runner)
      .select({
        id: sessions.id,
        userAgent: sessions.userAgent,
        createdAt: sessions.createdAt,
        rotatedAt: sessions.rotatedAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, sql`now(3)`),
        ),
      )
      .orderBy(asc(sessions.id));
  }
}
