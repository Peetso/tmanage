import { describe, expect, it } from 'vitest';
import { analyzeStatement, tenantTablesMentioned } from '../../../common/database/tenant-guard.js';
import { PLATFORM_METADATA_TABLES } from '../platform-admin.repository.js';
import {
  actionsWhere,
  decodeCursor,
  encodeCursor,
  pageOf,
  pageSize,
  parseActionFilter,
  parseSessionFilter,
  platformActionsWhere,
  sessionsWhere,
  signInsWhere,
} from './activity-query.repository.js';
import { ACTIVITY_SQL } from './activity.repository.js';

/** platform-admin v2 · PA-09 — the action log's filters, paging and paths, held to their SQL. */

const ORG = '0199aa00-0000-7000-8000-0000000000c1';
const OTHER = '0199aa00-0000-7000-8000-00000000ffff';
const USER = '0199aa00-0000-7000-8000-0000000000a1';
const EVENT = '0199aa00-0000-7000-8000-0000000000e1';

describe('action log filters → SQL (metadata path)', () => {
  it('maps every filter of §5.5 to one predicate with its parameter', () => {
    const filter = parseActionFilter({
      organizationId: ORG,
      actorUserId: USER,
      effectiveActorUserId: USER,
      supportOnly: 'true',
      action: 'role.updated',
      actionFamily: 'role',
      objectType: 'role',
      objectId: 'abc',
      result: 'denied',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-29T00:00:00.000Z',
      ip: '197.45.1.8',
      correlationId: 'corr-1',
      q: 'peter',
    });
    const { where, params } = actionsWhere(filter, null);
    for (const fragment of [
      'e.organization_id = ?',
      'e.actor_user_id = ?',
      'e.effective_actor_id = ?',
      'e.platform_support_session_id is not null',
      'e.action = ?',
      'e.action like ?',
      'e.object_type = ?',
      'e.object_id = ?',
      'e.result = ?',
      'e.created_at >= ?',
      'e.created_at < ?',
      'e.ip = ?',
      'e.correlation_id = ?',
      'ua.email like ?',
    ]) {
      expect(where).toContain(fragment);
    }
    expect(params).toContain('role.%');
    expect(params).toContain('denied');
    expect(params).toContain('%peter%');
  });

  it('refuses an unknown result and "has changes" without an organization', () => {
    expect(() => parseActionFilter({ result: 'maybe' })).toThrow();
    expect(() => parseActionFilter({ hasChanges: 'true' })).toThrow();
    expect(parseActionFilter({ hasChanges: 'true', organizationId: ORG }).hasChanges).toBe(true);
  });

  it('keeps the denied and support rows in an unfiltered list (no hidden predicate)', () => {
    const { where } = actionsWhere(parseActionFilter({}), null);
    expect(where).toBe('');
  });

  it('reads only metadata tables across organizations — never audit_event_changes', () => {
    const allowed = new Set<string>(PLATFORM_METADATA_TABLES);
    const { where } = actionsWhere(parseActionFilter({ supportOnly: '1', result: 'error' }), null);
    for (const sql of [ACTIVITY_SQL.actions(where), ACTIVITY_SQL.actionTotals(where)]) {
      for (const table of tenantTablesMentioned(sql)) expect(allowed.has(table), table).toBe(true);
      expect(sql).not.toMatch(/audit_event_changes|metadata_json/u);
    }
    expect(PLATFORM_METADATA_TABLES).not.toContain('audit_event_changes');
  });

  it('switches "has changes" to one organization, scoped by its own parameter', () => {
    const filter = parseActionFilter({ hasChanges: 'true', organizationId: ORG });
    const { where, params } = actionsWhere(filter, null);
    const sql = ACTIVITY_SQL.tenantActions(where);
    expect(sql).toContain('audit_event_changes');
    expect(sql).not.toMatch(/\borganizations\b/u);
    const full = ['Northstar', 'northstar', ...params, 51];
    expect(analyzeStatement(sql, full, ORG).violations).toEqual([]);
    expect(analyzeStatement(sql, ['N', 'n', OTHER, OTHER, 51], ORG).violations).not.toEqual([]);
  });

  it('opens one event only inside its organization (tenant path)', () => {
    const params = ['Northstar', 'northstar', ORG, EVENT];
    expect(analyzeStatement(ACTIVITY_SQL.action, params, ORG).violations).toEqual([]);
    expect(
      analyzeStatement(ACTIVITY_SQL.action, ['N', 'n', OTHER, EVENT], ORG).violations,
    ).not.toEqual([]);
    expect(analyzeStatement(ACTIVITY_SQL.changes, [ORG, EVENT], ORG).violations).toEqual([]);
    expect(analyzeStatement(ACTIVITY_SQL.changes, [OTHER, EVENT], ORG).violations).not.toEqual([]);
    expect(
      analyzeStatement(ACTIVITY_SQL.sameCorrelation, [ORG, 'corr', EVENT], ORG).violations,
    ).toEqual([]);
  });
});

describe('keyset paging by (created_at, id)', () => {
  it('round-trips the cursor and pages strictly after it', () => {
    const at = new Date('2026-10-28T14:01:47.123Z');
    const cursor = decodeCursor(encodeCursor({ at, id: EVENT }));
    expect(cursor).toEqual({ at, id: EVENT });
    const { where, params } = actionsWhere(parseActionFilter({}), cursor);
    expect(where).toContain('(e.created_at < ? or (e.created_at = ? and e.id < ?))');
    expect(params).toEqual([at, at, EVENT]);
    expect(ACTIVITY_SQL.actions(where)).toContain('order by e.created_at desc, e.id desc');
  });

  it('refuses a forged cursor', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow();
    expect(decodeCursor(undefined)).toBeNull();
  });

  it('takes one extra row to know a next page exists', () => {
    const rows = [1, 2, 3].map((n) => ({ at: new Date(n * 1000), id: `${n}`.padStart(36, '0') }));
    const first = pageOf(rows, 2, (row) => row);
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(pageOf(rows, 3, (row) => row).nextCursor).toBeNull();
    expect(pageSize('500')).toBe(100);
    expect(pageSize(undefined)).toBe(50);
  });

  it('pages the other lists on their own time columns', () => {
    const cursor = { at: new Date(0), id: EVENT };
    expect(
      signInsWhere(
        {
          userId: null,
          email: null,
          outcome: 'failed',
          reason: null,
          ip: null,
          from: null,
          to: null,
          q: null,
        },
        cursor,
      ).where,
    ).toContain('e.occurred_at < ?');
    expect(sessionsWhere(parseSessionFilter({}), cursor).where).toContain(
      's.revoked_at is null and s.expires_at > now(3)',
    );
    expect(
      platformActionsWhere(
        { adminId: USER, action: null, organizationId: null, from: null, to: null, q: null },
        cursor,
      ).where,
    ).toContain('p.actor_user_id = ?');
  });
});
