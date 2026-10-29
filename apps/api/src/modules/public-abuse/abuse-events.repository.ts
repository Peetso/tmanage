import { isIP } from 'node:net';
import type { RowDataPacket } from 'mysql2';
import { uuidv7 } from '@tmanage/domain';
import type { IdentityQueryRunner, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * 52-21 — the storage half of the abuse telemetry (`public_abuse_events`) and the issued
 * challenges (`public_challenges`), both GLOBAL (0255) and reached only through
 * `identityTransaction` with the one table each statement needs.
 *
 * Privacy, at write time: no submitted content is stored; `key_hash` is an HMAC of the values;
 * the IP is truncated to /24 (IPv4) or /56 (IPv6) by {@link truncateIp} before it reaches SQL.
 *
 * Retention: events 30 days, challenges one hour past expiry, swept by {@link purge} at most once
 * an hour from the guard's own calls (56-05's lazy bucket sweep, no cron on the one Hostinger app).
 *
 * Dates are bound from the application clock: they are compared with bound instants (24 h repeat
 * window, expiry), and the admin pool clock in the suites is SYSTEM.
 */

export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const CHALLENGE_GRACE_MS = 60 * 60 * 1_000;
const PURGE_BATCH = 5_000;

export type AbuseEventKind =
  'form_submit' | 'otp_send' | 'otp_verify' | 'token_open' | 'signup' | 'contact';
export type AbuseDecision = 'allow' | 'hold' | 'spam' | 'blocked' | 'challenge';
export type ChallengeKind = 'email_code' | 'pow' | 'turnstile';

export interface AbuseEventInput {
  readonly kind: AbuseEventKind;
  readonly surface: string;
  readonly keyHash: string;
  readonly ip?: string | undefined;
  readonly decision: AbuseDecision;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly organizationId?: string | undefined;
  readonly at: Date;
}

export interface ChallengeRecord {
  readonly id: string;
  readonly kind: ChallengeKind;
  readonly targetHash: string;
  readonly codeHash: string | null;
  readonly attempts: number;
  readonly expiresAt: Date;
  readonly solvedAt: Date | null;
  readonly createdAt: Date;
}

export interface AbuseEventStore {
  record(event: AbuseEventInput, correlationId: string): Promise<void>;
  /** Events of this surface with this key hash since `since` (the 24 h repeat signal). */
  countByKey(surface: string, keyHash: string, since: Date, correlationId: string): Promise<number>;
  purge(at: Date, correlationId: string): Promise<{ events: number; challenges: number }>;
}

export interface ChallengeStore {
  insert(challenge: ChallengeRecord, correlationId: string): Promise<void>;
  find(id: string, correlationId: string): Promise<ChallengeRecord | null>;
  /** The newest unexpired, unsolved challenge of this kind for this target. */
  latestOpen(
    kind: ChallengeKind,
    targetHash: string,
    at: Date,
    correlationId: string,
  ): Promise<ChallengeRecord | null>;
  /** Add one attempt; returns the count after it. */
  addAttempt(id: string, correlationId: string): Promise<number>;
  /** Mark solved once; `false` when it was already solved (single use). */
  markSolved(id: string, at: Date, correlationId: string): Promise<boolean>;
}

/** IPv4 → `a.b.c.0/24`; IPv6 → the first 56 bits `/56`; anything else → `null`. */
export function truncateIp(ip: string | undefined): string | null {
  const address = (ip ?? '').trim().split('%')[0] ?? '';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address);
  const v4 = mapped?.[1] ?? (isIP(address) === 4 ? address : undefined);
  if (v4 !== undefined) {
    const parts = v4.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (isIP(address) !== 6) return null;
  const [head = '', tail = ''] = address.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const groups = address.includes('::')
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  const words = groups.map((group) => parseInt(group, 16) || 0);
  const fourth = (words[3] ?? 0) & 0xff00;
  return `${[words[0], words[1], words[2], fourth].map((word) => (word ?? 0).toString(16)).join(':')}::/56`;
}

const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

function rowToChallenge(row: RowDataPacket): ChallengeRecord {
  return {
    id: String(row['id']),
    kind: String(row['kind']) as ChallengeKind,
    targetHash: String(row['target_hash']),
    codeHash: row['code_hash'] === null ? null : String(row['code_hash']),
    attempts: Number(row['attempts']),
    expiresAt: toDate(row['expires_at']),
    solvedAt: row['solved_at'] === null ? null : toDate(row['solved_at']),
    createdAt: toDate(row['created_at']),
  };
}

const affected = (result: unknown): number =>
  Number((result as { affectedRows?: unknown }).affectedRows ?? 0);

export class PublicAbuseRepository implements AbuseEventStore, ChallengeStore {
  constructor(private readonly database: TenantDatabase) {}

  private events<T>(
    correlationId: string,
    work: (tx: IdentityQueryRunner) => Promise<T>,
  ): Promise<T> {
    return this.database.identityTransaction(
      { correlationId, tables: ['public_abuse_events'] },
      work,
    );
  }

  private challenges<T>(
    correlationId: string,
    work: (tx: IdentityQueryRunner) => Promise<T>,
  ): Promise<T> {
    return this.database.identityTransaction(
      { correlationId, tables: ['public_challenges'] },
      work,
    );
  }

  async record(event: AbuseEventInput, correlationId: string): Promise<void> {
    await this.events(correlationId, (tx) =>
      tx.query(
        `insert into public_abuse_events
           (id, kind, surface, key_hash, ip_text, decision, score, reasons, organization_id, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv7(),
          event.kind,
          event.surface.slice(0, 64),
          event.keyHash,
          truncateIp(event.ip),
          event.decision,
          Math.max(-32_768, Math.min(32_767, Math.round(event.score))),
          event.reasons.length === 0 ? null : event.reasons.join(',').slice(0, 255),
          event.organizationId ?? null,
          event.at,
        ],
      ),
    );
  }

  async countByKey(
    surface: string,
    keyHash: string,
    since: Date,
    correlationId: string,
  ): Promise<number> {
    return this.events(correlationId, async (tx) => {
      const rows = await tx.query<RowDataPacket[]>(
        `select count(*) as n from public_abuse_events
          where key_hash = ? and surface = ? and created_at >= ?`,
        [keyHash, surface, since],
      );
      return Number(rows[0]?.['n'] ?? 0);
    });
  }

  async purge(at: Date, correlationId: string): Promise<{ events: number; challenges: number }> {
    const events = await this.events<number>(correlationId, async (tx) =>
      affected(
        await tx.query(
          `delete from public_abuse_events where created_at < ? order by created_at limit ?`,
          [new Date(at.getTime() - EVENT_RETENTION_MS), PURGE_BATCH],
        ),
      ),
    );
    const challenges = await this.challenges<number>(correlationId, async (tx) =>
      affected(
        await tx.query(
          `delete from public_challenges where expires_at < ? order by expires_at limit ?`,
          [new Date(at.getTime() - CHALLENGE_GRACE_MS), PURGE_BATCH],
        ),
      ),
    );
    return { events, challenges };
  }

  async insert(challenge: ChallengeRecord, correlationId: string): Promise<void> {
    await this.challenges(correlationId, (tx) =>
      tx.query(
        `insert into public_challenges
           (id, kind, target_hash, code_hash, attempts, expires_at, solved_at, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          challenge.id,
          challenge.kind,
          challenge.targetHash,
          challenge.codeHash,
          challenge.attempts,
          challenge.expiresAt,
          challenge.solvedAt,
          challenge.createdAt,
        ],
      ),
    );
  }

  async find(id: string, correlationId: string): Promise<ChallengeRecord | null> {
    return this.challenges(correlationId, async (tx) => {
      const rows = await tx.query<RowDataPacket[]>(
        `select id, kind, target_hash, code_hash, attempts, expires_at, solved_at, created_at
           from public_challenges where id = ? limit 1`,
        [id],
      );
      return rows[0] === undefined ? null : rowToChallenge(rows[0]);
    });
  }

  async latestOpen(
    kind: ChallengeKind,
    targetHash: string,
    at: Date,
    correlationId: string,
  ): Promise<ChallengeRecord | null> {
    return this.challenges(correlationId, async (tx) => {
      const rows = await tx.query<RowDataPacket[]>(
        `select id, kind, target_hash, code_hash, attempts, expires_at, solved_at, created_at
           from public_challenges
          where expires_at > ? and kind = ? and target_hash = ? and solved_at is null
          order by created_at desc limit 1`,
        [at, kind, targetHash],
      );
      return rows[0] === undefined ? null : rowToChallenge(rows[0]);
    });
  }

  async addAttempt(id: string, correlationId: string): Promise<number> {
    return this.challenges(correlationId, async (tx) => {
      await tx.query(
        `update public_challenges set attempts = least(attempts + 1, 100) where id = ?`,
        [id],
      );
      const rows = await tx.query<RowDataPacket[]>(
        `select attempts from public_challenges where id = ?`,
        [id],
      );
      return Number(rows[0]?.['attempts'] ?? 0);
    });
  }

  async markSolved(id: string, at: Date, correlationId: string): Promise<boolean> {
    return this.challenges(
      correlationId,
      async (tx) =>
        affected(
          await tx.query(
            `update public_challenges set solved_at = ? where id = ? and solved_at is null`,
            [at, id],
          ),
        ) === 1,
    );
  }
}

/** The in-process store: keyless compositions and the unit tests' double. */
export function createMemoryAbuseStore(): AbuseEventStore &
  ChallengeStore & { readonly events: AbuseEventInput[] } {
  const events: AbuseEventInput[] = [];
  const challenges = new Map<string, ChallengeRecord>();
  return {
    events,
    record: (event) => {
      events.push({ ...event, ip: truncateIp(event.ip) ?? undefined });
      return Promise.resolve();
    },
    countByKey: (surface, keyHash, since) =>
      Promise.resolve(
        events.filter(
          (event) =>
            event.surface === surface &&
            event.keyHash === keyHash &&
            event.at.getTime() >= since.getTime(),
        ).length,
      ),
    purge: (at) => {
      const cutoff = at.getTime() - EVENT_RETENTION_MS;
      const before = events.length;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if ((events[index]?.at.getTime() ?? 0) < cutoff) events.splice(index, 1);
      }
      let removed = 0;
      for (const [id, challenge] of challenges) {
        if (challenge.expiresAt.getTime() < at.getTime() - CHALLENGE_GRACE_MS) {
          challenges.delete(id);
          removed += 1;
        }
      }
      return Promise.resolve({ events: before - events.length, challenges: removed });
    },
    insert: (challenge) => {
      challenges.set(challenge.id, challenge);
      return Promise.resolve();
    },
    find: (id) => Promise.resolve(challenges.get(id) ?? null),
    latestOpen: (kind, targetHash, at) => {
      const open = [...challenges.values()]
        .filter(
          (challenge) =>
            challenge.kind === kind &&
            challenge.targetHash === targetHash &&
            challenge.solvedAt === null &&
            challenge.expiresAt.getTime() > at.getTime(),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return Promise.resolve(open[0] ?? null);
    },
    addAttempt: (id) => {
      const challenge = challenges.get(id);
      if (challenge === undefined) return Promise.resolve(0);
      const next = { ...challenge, attempts: challenge.attempts + 1 };
      challenges.set(id, next);
      return Promise.resolve(next.attempts);
    },
    markSolved: (id, at) => {
      const challenge = challenges.get(id);
      if (challenge === undefined || challenge.solvedAt !== null) return Promise.resolve(false);
      challenges.set(id, { ...challenge, solvedAt: at });
      return Promise.resolve(true);
    },
  };
}
