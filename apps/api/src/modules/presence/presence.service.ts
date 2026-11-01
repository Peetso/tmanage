import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PresenceRepository, PresenceRow } from './presence.repository.js';

/** What `GET presence` answers for one person. */
export interface PresenceView {
  readonly userId: string;
  readonly online: boolean;
  /** ISO-8601, or null when the person never beat here or hides it. */
  readonly lastSeenAt: string | null;
}

/** The most people one read may ask about. */
export const MAX_PRESENCE_IDS = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pure: one person's view. A person who turned "show last seen / online" off reads as offline
 * with no last-seen time — the toggle hides both, so "online" cannot leak what "last seen" hides.
 */
export function presenceView(userId: string, row: PresenceRow | undefined): PresenceView {
  if (row === undefined || row.showLastSeen === 'false') {
    return { userId, online: false, lastSeenAt: null };
  }
  return { userId, online: row.online, lastSeenAt: row.lastSeenAt.toISOString() };
}

/** Parse `?userIds=a,b,c`: uuids only, deduplicated, at most {@link MAX_PRESENCE_IDS}. */
export function parseUserIds(raw: unknown): readonly string[] {
  const text = typeof raw === 'string' ? raw : '';
  const ids = [
    ...new Set(
      text
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
  if (ids.length > MAX_PRESENCE_IDS || ids.some((id) => !UUID.test(id))) {
    throw new ApiError(400, 'validation_failed', 'The request is invalid', [
      { field: 'userIds', message: `must be at most ${MAX_PRESENCE_IDS} user ids` },
    ]);
  }
  return ids;
}

/**
 * R7 presence (F4). The heartbeat stamps only the caller's own row; the read answers for the
 * people asked about inside this studio only (the tenant column leads every predicate).
 */
export class PresenceService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly presence: PresenceRepository,
  ) {}

  async heartbeat(context: TenantContext, userId: string): Promise<void> {
    await this.database.transaction(context, (tx) => this.presence.heartbeat(tx, context, userId));
  }

  async list(context: TenantContext, userIds: readonly string[]): Promise<readonly PresenceView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.presence.list(runner, context, userIds),
    );
    const byUser = new Map(rows.map((row) => [row.userId, row]));
    return userIds.map((id) => presenceView(id, byUser.get(id)));
  }
}
