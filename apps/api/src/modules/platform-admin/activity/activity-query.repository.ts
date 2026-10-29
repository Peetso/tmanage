import type { SqlParameter } from '../../../common/database/tenant-context.js';
import { ApiError } from '../../../common/http/errors.js';
import { likeContains, requireId } from '../platform-admin.access.js';

/**
 * Platform admin · Activity — the pure half of the list reads (platform-admin v2 · PA-09): query
 * parsing, the keyset cursor, and the filter → SQL fragments. No I/O, so the unit test holds
 * every filter to its SQL.
 *
 * Every list pages by `(created_at, id)` descending — the 0241 global index
 * `ix_audit_events_time_global (created_at, id)` serves the action log with no organization
 * prefix — so a page never skips or repeats a row however many arrive meanwhile.
 */

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 100;

const MAX_TEXT = 200;
const RESULTS = ['allowed', 'denied', 'error'] as const;

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'Check the filter and try again.', [
    { field, message },
  ]);
}

/** One query-string value: trimmed text, or `null` when absent/empty. 400 when too long. */
export function optionalText(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw invalid(field, 'text');
  const value = raw.trim();
  if (value === '') return null;
  if (value.length > MAX_TEXT) throw invalid(field, `at most ${MAX_TEXT} characters`);
  return value;
}

export function optionalId(raw: unknown, field: string): string | null {
  const value = optionalText(raw, field);
  if (value === null) return null;
  try {
    return requireId(value);
  } catch {
    throw invalid(field, 'an id');
  }
}

export function optionalDate(raw: unknown, field: string): Date | null {
  const value = optionalText(raw, field);
  if (value === null) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw invalid(field, 'an ISO date');
  return at;
}

export function optionalFlag(raw: unknown): boolean {
  return raw === true || raw === 'true' || raw === '1' || raw === 'yes';
}

export function pageSize(raw: unknown): number {
  const value = Number(raw ?? DEFAULT_PAGE);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_PAGE;
  return Math.min(MAX_PAGE, Math.trunc(value));
}

// ── Cursor ───────────────────────────────────────────────────────────────────

export interface Cursor {
  readonly at: Date;
  readonly id: string;
}

/** `base64url("<iso>|<id>")` — opaque to the screen. */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at.toISOString()}|${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): Cursor | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 200) throw invalid('cursor', 'a cursor from a page');
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const bar = text.indexOf('|');
  const at = new Date(bar > 0 ? text.slice(0, bar) : '');
  const id = bar > 0 ? text.slice(bar + 1) : '';
  if (Number.isNaN(at.getTime()) || !/^[0-9a-f-]{36}$/u.test(id)) {
    throw invalid('cursor', 'a cursor from a page');
  }
  return { at, id };
}

/** The keyset predicate for `order by <time> desc, <id> desc`. */
export function keyset(cursor: Cursor | null, time: string, id: string): Fragment {
  if (cursor === null) return { sql: [], params: [] };
  return {
    sql: [`(${time} < ? or (${time} = ? and ${id} < ?))`],
    params: [cursor.at, cursor.at, cursor.id],
  };
}

/** Take one more than the page to know whether another exists. */
export function pageOf<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (row: T) => Cursor,
): { readonly rows: readonly T[]; readonly nextCursor: string | null } {
  if (rows.length <= limit) return { rows, nextCursor: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1] as T;
  return { rows: page, nextCursor: encodeCursor(cursorOf(last)) };
}

export interface Fragment {
  readonly sql: readonly string[];
  readonly params: readonly SqlParameter[];
}

function join(...parts: Fragment[]): { where: string; params: SqlParameter[] } {
  const sql = parts.flatMap((part) => part.sql);
  return {
    where: sql.length === 0 ? '' : `where ${sql.join(' and ')}`,
    params: parts.flatMap((part) => [...part.params]),
  };
}

// ── C1 action log ────────────────────────────────────────────────────────────

export interface ActionFilter {
  readonly organizationId: string | null;
  readonly actorUserId: string | null;
  readonly effectiveActorUserId: string | null;
  readonly supportOnly: boolean;
  readonly supportSessionId: string | null;
  readonly action: string | null;
  readonly actionFamily: string | null;
  readonly objectType: string | null;
  readonly objectId: string | null;
  readonly result: (typeof RESULTS)[number] | null;
  readonly from: Date | null;
  readonly to: Date | null;
  readonly ip: string | null;
  readonly hasChanges: boolean;
  readonly correlationId: string | null;
  readonly q: string | null;
}

export function parseActionFilter(query: Record<string, unknown>): ActionFilter {
  const result = optionalText(query['result'], 'result');
  if (result !== null && !(RESULTS as readonly string[]).includes(result)) {
    throw invalid('result', 'allowed, denied or error');
  }
  const filter: ActionFilter = {
    organizationId: optionalId(query['organizationId'], 'organizationId'),
    actorUserId: optionalId(query['actorUserId'], 'actorUserId'),
    effectiveActorUserId: optionalId(query['effectiveActorUserId'], 'effectiveActorUserId'),
    supportOnly: optionalFlag(query['supportOnly']),
    supportSessionId: optionalId(query['supportSessionId'], 'supportSessionId'),
    action: optionalText(query['action'], 'action'),
    actionFamily: optionalText(query['actionFamily'], 'actionFamily'),
    objectType: optionalText(query['objectType'], 'objectType'),
    objectId: optionalText(query['objectId'], 'objectId'),
    result: result as ActionFilter['result'],
    from: optionalDate(query['from'], 'from'),
    to: optionalDate(query['to'], 'to'),
    ip: optionalText(query['ip'], 'ip'),
    hasChanges: optionalFlag(query['hasChanges']),
    correlationId: optionalText(query['correlationId'], 'correlationId'),
    q: optionalText(query['q'], 'q'),
  };
  // The changed values live in `audit_event_changes`, which no cross-organization read may
  // name (SPEC P2): "has changes" filters one organization, read through the tenant path.
  if (filter.hasChanges && filter.organizationId === null) {
    throw invalid('hasChanges', 'pick an organization first');
  }
  return filter;
}

/** The `where` over `audit_events e` (joined `users ua` as the actor) for a filter. */
export function actionsWhere(filter: ActionFilter, cursor: Cursor | null) {
  const sql: string[] = [];
  const params: SqlParameter[] = [];
  const add = (fragment: string, ...values: SqlParameter[]) => {
    sql.push(fragment);
    params.push(...values);
  };
  if (filter.organizationId) add('e.organization_id = ?', filter.organizationId);
  if (filter.actorUserId) add('e.actor_user_id = ?', filter.actorUserId);
  if (filter.effectiveActorUserId) add('e.effective_actor_id = ?', filter.effectiveActorUserId);
  if (filter.supportOnly) add('e.platform_support_session_id is not null');
  if (filter.supportSessionId) add('e.platform_support_session_id = ?', filter.supportSessionId);
  if (filter.action) add('e.action = ?', filter.action);
  if (filter.actionFamily)
    add('e.action like ?', `${filter.actionFamily.replace(/[\\%_]/gu, '')}.%`);
  if (filter.objectType) add('e.object_type = ?', filter.objectType);
  if (filter.objectId) add('e.object_id = ?', filter.objectId);
  if (filter.result) add('e.result = ?', filter.result);
  if (filter.from) add('e.created_at >= ?', filter.from);
  if (filter.to) add('e.created_at < ?', filter.to);
  if (filter.ip) add('e.ip = ?', filter.ip);
  if (filter.correlationId) add('e.correlation_id = ?', filter.correlationId);
  if (filter.q) {
    add(
      '(ua.email like ? or e.object_id = ? or e.ip = ? or e.correlation_id = ?)',
      likeContains(filter.q),
      filter.q,
      filter.q,
      filter.q,
    );
  }
  if (filter.hasChanges) {
    // Only ever with an organization (parseActionFilter), on the tenant path.
    add(
      'exists (select 1 from audit_event_changes c where c.organization_id = ? ' +
        'and c.audit_event_id = e.id)',
      filter.organizationId,
    );
  }
  return join({ sql, params }, keyset(cursor, 'e.created_at', 'e.id'));
}

// ── C3 sign-ins / sessions / step-ups ───────────────────────────────────────

export interface SignInFilter {
  readonly userId: string | null;
  readonly email: string | null;
  readonly outcome: string | null;
  readonly reason: string | null;
  readonly ip: string | null;
  readonly from: Date | null;
  readonly to: Date | null;
  readonly q: string | null;
}

export function parseSignInFilter(query: Record<string, unknown>): SignInFilter {
  return {
    userId: optionalId(query['userId'], 'userId'),
    email: optionalText(query['email'], 'email'),
    outcome: optionalText(query['outcome'], 'outcome'),
    reason: optionalText(query['reason'], 'reason'),
    ip: optionalText(query['ip'], 'ip'),
    from: optionalDate(query['from'], 'from'),
    to: optionalDate(query['to'], 'to'),
    q: optionalText(query['q'], 'q'),
  };
}

export function signInsWhere(filter: SignInFilter, cursor: Cursor | null) {
  const sql: string[] = [];
  const params: SqlParameter[] = [];
  const add = (fragment: string, ...values: SqlParameter[]) => {
    sql.push(fragment);
    params.push(...values);
  };
  if (filter.userId) add('e.user_id = ?', filter.userId);
  if (filter.email) add('u.email like ?', likeContains(filter.email));
  if (filter.outcome) add('e.outcome = ?', filter.outcome);
  if (filter.reason) add('e.reason = ?', filter.reason);
  if (filter.ip) add('e.ip = ?', filter.ip);
  if (filter.from) add('e.occurred_at >= ?', filter.from);
  if (filter.to) add('e.occurred_at < ?', filter.to);
  if (filter.q) {
    add('(u.email like ? or e.ip = ?)', likeContains(filter.q), filter.q);
  }
  return join({ sql, params }, keyset(cursor, 'e.occurred_at', 'e.id'));
}

export interface SessionFilter {
  readonly userId: string | null;
  /** Default: live sessions only. */
  readonly active: boolean;
  readonly ip: string | null;
  readonly q: string | null;
}

export function parseSessionFilter(query: Record<string, unknown>): SessionFilter {
  const active = query['active'];
  return {
    userId: optionalId(query['userId'], 'userId'),
    active: active === undefined || active === '' ? true : optionalFlag(active),
    ip: optionalText(query['ip'], 'ip'),
    q: optionalText(query['q'], 'q'),
  };
}

export function sessionsWhere(filter: SessionFilter, cursor: Cursor | null) {
  const sql: string[] = [];
  const params: SqlParameter[] = [];
  const add = (fragment: string, ...values: SqlParameter[]) => {
    sql.push(fragment);
    params.push(...values);
  };
  if (filter.userId) add('s.user_id = ?', filter.userId);
  if (filter.active) add('s.revoked_at is null and s.expires_at > now(3)');
  if (filter.ip) add('(s.ip_first = ? or s.ip_last = ?)', filter.ip, filter.ip);
  if (filter.q) {
    add(
      '(u.email like ? or s.ip_last = ? or s.ip_first = ?)',
      likeContains(filter.q),
      filter.q,
      filter.q,
    );
  }
  return join({ sql, params }, keyset(cursor, 's.created_at', 's.id'));
}

// ── C4 platform admin actions ────────────────────────────────────────────────

export interface PlatformActionFilter {
  readonly adminId: string | null;
  readonly action: string | null;
  readonly organizationId: string | null;
  readonly from: Date | null;
  readonly to: Date | null;
  readonly q: string | null;
}

export function parsePlatformActionFilter(query: Record<string, unknown>): PlatformActionFilter {
  return {
    adminId: optionalId(query['adminId'], 'adminId'),
    action: optionalText(query['action'], 'action'),
    organizationId: optionalId(query['organizationId'], 'organizationId'),
    from: optionalDate(query['from'], 'from'),
    to: optionalDate(query['to'], 'to'),
    q: optionalText(query['q'], 'q'),
  };
}

export function platformActionsWhere(filter: PlatformActionFilter, cursor: Cursor | null) {
  const sql: string[] = [];
  const params: SqlParameter[] = [];
  const add = (fragment: string, ...values: SqlParameter[]) => {
    sql.push(fragment);
    params.push(...values);
  };
  if (filter.adminId) add('p.actor_user_id = ?', filter.adminId);
  if (filter.action) add('p.action = ?', filter.action);
  if (filter.organizationId) add('p.organization_id = ?', filter.organizationId);
  if (filter.from) add('p.created_at >= ?', filter.from);
  if (filter.to) add('p.created_at < ?', filter.to);
  if (filter.q) {
    const like = likeContains(filter.q);
    add('(p.action like ? or p.target_label like ? ' + 'or p.reason like ?)', like, like, like);
  }
  return join({ sql, params }, keyset(cursor, 'p.created_at', 'p.id'));
}
