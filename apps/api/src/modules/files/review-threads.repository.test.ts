import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { resetContentPurgeDaysCache } from '../../common/database/content-retention.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { assertTenantScoped } from '../../common/database/tenant-guard.js';
import { ReviewCommentsRepository, parseMentions } from './review-comments.repository.js';
import { ReviewMentionCandidatesRepository } from './review-mention-candidates.repository.js';
import {
  DuplicateThreadNumberError,
  ReviewThreadsRepository,
  isRetryableNumberRace,
} from './review-threads.repository.js';

/**
 * R4 slice 5 — the three review repositories without a server. Every statement the real Drizzle
 * proxy builds goes through the tenant guard in `enforce` mode, so each case also proves the SQL
 * names the active tenant on every tenant table it touches. MariaDB itself is
 * `test/r4-005-review-threads.db.test.ts`.
 */

interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const ORG = uuidv7();
const context: TenantContext = createTenantContext({
  organizationId: ORG,
  userId: uuidv7(),
  principalKind: 'internal',
  membershipId: uuidv7(),
  capabilities: [],
  policyVersion: 'test',
  correlationId: uuidv7(),
});

function fakeRunner(
  answers: readonly unknown[],
  failOn?: (sql: string) => unknown,
): { runner: TenantQueryRunner; statements: Statement[] } {
  const statements: Statement[] = [];
  let next = 0;
  const respond = (async (sql: string, params: readonly unknown[] = []) => {
    statements.push({ sql, params });
    // `platform_settings` (the restore-window read) is a global table the guard admits.
    assertTenantScoped(sql, params, context, { mode: 'enforce' });
    const failure = failOn?.(sql);
    if (failure) throw failure;
    const answer = answers[next] ?? [];
    next += 1;
    return answer;
  }) as unknown as TenantQueryRunner['query'];
  const execute = respond as unknown as TenantQueryRunner['execute'];
  return {
    runner: { query: respond, execute, unscoped: () => ({ query: respond, execute }) },
    statements,
  };
}

const threads = new ReviewThreadsRepository();
const comments = new ReviewCommentsRepository();
const people = new ReviewMentionCandidatesRepository();

describe('ReviewThreadsRepository', () => {
  it('takes the next number under a lock, scoped to the tenant and the subject', async () => {
    const subjectId = uuidv7();
    const { runner, statements } = fakeRunner([[{ max_number: 4 }]]);
    expect(await threads.lockNextNumber(runner, context, 'file_asset', subjectId)).toBe(5);
    const sql = statements[0]?.sql ?? '';
    expect(sql).toMatch(/for update/i);
    expect(sql).toContain('organization_id = ?');
    expect(statements[0]?.params).toEqual([ORG, 'file_asset', subjectId]);
    const empty = fakeRunner([[{ max_number: null }]]);
    expect(await threads.lockNextNumber(empty.runner, context, 'file_asset', subjectId)).toBe(1);
  });

  it('turns a duplicate key on a new row into DuplicateThreadNumberError', async () => {
    const duplicate = Object.assign(new Error('dup'), { cause: { errno: 1062 } });
    const { runner, statements } = fakeRunner([], (sql) =>
      sql.startsWith('insert') ? duplicate : undefined,
    );
    await expect(
      threads.insert(runner, context, {
        projectId: uuidv7(),
        subjectType: 'file_asset',
        subjectId: uuidv7(),
        fileVersionId: uuidv7(),
        anchorKind: 'pin',
        anchor: { x: 0.5, y: 0.5 },
        pageNo: null,
        timeMs: null,
        number: 1,
        audience: 'internal',
        createdByMembershipId: context.membershipId,
      }),
    ).rejects.toBeInstanceOf(DuplicateThreadNumberError);
    expect(statements[0]?.sql).toContain('`review_threads`');
    expect(statements[0]?.params).toContain(ORG);
  });

  it('treats a lost duplicate key, a deadlock and a stale snapshot as a race to retry', () => {
    expect(isRetryableNumberRace(new DuplicateThreadNumberError())).toBe(true);
    expect(isRetryableNumberRace(Object.assign(new Error('x'), { cause: { errno: 1213 } }))).toBe(
      true,
    );
    expect(isRetryableNumberRace(Object.assign(new Error('x'), { errno: 1020 }))).toBe(true);
    expect(isRetryableNumberRace(Object.assign(new Error('x'), { errno: 1452 }))).toBe(false);
    expect(isRetryableNumberRace(new Error('boom'))).toBe(false);
  });

  it('lists one subject filtered by audience, version and status, live rows only', async () => {
    const { runner, statements } = fakeRunner([[]]);
    await threads.listForSubject(runner, context, {
      subjectType: 'file_asset',
      subjectId: uuidv7(),
      fileVersionId: uuidv7(),
      status: 'open',
      audiences: ['client_visible'],
    });
    const sql = statements[0]?.sql ?? '';
    expect(sql).toContain('`review_threads`.`audience` in (?)');
    expect(sql).toContain('`review_threads`.`file_version_id` = ?');
    expect(sql).toContain('`review_threads`.`deleted_at` is null');
    expect(sql).toMatch(/order by `review_threads`.`number`/);
    expect(statements[0]?.params).toContain('client_visible');
    const none = fakeRunner([]);
    expect(
      await threads.listForSubject(none.runner, context, {
        subjectType: 'file_asset',
        subjectId: uuidv7(),
        audiences: [],
      }),
    ).toEqual([]);
    expect(none.statements).toHaveLength(0);
  });

  it('counts open client-visible threads per file, tenant-scoped, one statement', async () => {
    const a = uuidv7();
    const b = uuidv7();
    const { runner, statements } = fakeRunner([
      [
        [a, '3'],
        [b, 0],
      ],
    ]);
    const counts = await threads.countOpenClientVisible(runner, context, [a, b, a]);
    expect(counts.get(a)).toBe(3);
    expect(counts.has(b)).toBe(false);
    const sql = statements[0]?.sql ?? '';
    expect(sql).toContain('`review_threads`.`organization_id` = ?');
    expect(sql).toContain('`review_threads`.`audience` = ?');
    expect(sql).toContain('`review_threads`.`status` = ?');
    expect(sql).toContain('`review_threads`.`deleted_at` is null');
    expect(sql).toMatch(/group by `review_threads`.`subject_id`/);
    expect(statements[0]?.params).toEqual(
      expect.arrayContaining([ORG, 'file_asset', 'client_visible', 'open']),
    );
    const none = fakeRunner([]);
    expect((await threads.countOpenClientVisible(none.runner, context, [])).size).toBe(0);
    expect(none.statements).toHaveLength(0);
  });

  it('parses an anchor answered as text (MariaDB JSON)', async () => {
    const id = uuidv7();
    const now = new Date();
    const row = [
      id,
      ORG,
      uuidv7(),
      'file_asset',
      uuidv7(),
      uuidv7(),
      'pin',
      '{"x":0.25,"y":0.75}',
      null,
      null,
      3,
      'internal',
      'open',
      null,
      null,
      null,
      context.membershipId,
      now,
      now,
      null,
      null,
      null,
      null,
    ];
    const { runner } = fakeRunner([[row]]);
    const found = await threads.findById(runner, context, id);
    expect(found?.anchor).toEqual({ x: 0.25, y: 0.75 });
    expect(found?.number).toBe(3);
  });

  it('resolves conditionally and never writes the audience', async () => {
    const { runner, statements } = fakeRunner([[{ affectedRows: 1 }]]);
    expect(await threads.setResolved(runner, context, uuidv7(), context.membershipId)).toBe(true);
    const sql = statements[0]?.sql ?? '';
    expect(sql).toContain('`status` <> ?');
    expect(sql).not.toContain('`audience`');
    const moved = fakeRunner([[{ affectedRows: 1 }]]);
    await threads.moveAnchor(moved.runner, context, uuidv7(), {
      anchor: { x: 0.1, y: 0.1 },
      pageNo: 1,
      timeMs: null,
    });
    expect(moved.statements[0]?.sql).not.toContain('`audience`');
    expect(moved.statements[0]?.sql).not.toContain('`file_version_id`');
  });

  it('soft-deletes with the restore window and finds a version’s asset', async () => {
    resetContentPurgeDaysCache();
    const { runner, statements } = fakeRunner([[], [{ affectedRows: 1 }]]);
    expect(await threads.softDelete(runner, context, uuidv7())).toBe(true);
    expect(statements.some((s) => s.sql.includes('`purge_after`'))).toBe(true);
    const assetId = uuidv7();
    const lookup = fakeRunner([[[assetId]]]);
    expect(await threads.assetOfVersion(lookup.runner, context, uuidv7())).toBe(assetId);
    expect(lookup.statements[0]?.sql).toContain('`file_versions`');
  });
});

describe('ReviewCommentsRepository', () => {
  it('lists live comments of a page of threads oldest first; none for no threads', async () => {
    const { runner, statements } = fakeRunner([[]]);
    await comments.listForThreads(runner, context, [uuidv7(), uuidv7()]);
    const sql = statements[0]?.sql ?? '';
    expect(sql).toContain('`review_comments`.`thread_id` in (?, ?)');
    expect(sql).toContain('`review_comments`.`deleted_at` is null');
    expect(sql).toMatch(/order by `review_comments`.`created_at` asc, `review_comments`.`id` asc/);
    const none = fakeRunner([]);
    expect(await comments.listForThreads(none.runner, context, [])).toEqual([]);
    expect(none.statements).toHaveLength(0);
  });

  it('edits and counts within the tenant', async () => {
    const edit = fakeRunner([[{ affectedRows: 1 }]]);
    expect(await comments.editBody(edit.runner, context, uuidv7(), 'new', [])).toBe(true);
    expect(edit.statements[0]?.sql).toContain('`edited_at`');
    const count = fakeRunner([[[2]]]);
    expect(await comments.countLive(count.runner, context, uuidv7())).toBe(2);
  });

  it('parses mentions answered as text, an array, or junk', () => {
    expect(parseMentions('["a","b"]')).toEqual(['a', 'b']);
    expect(parseMentions(['a', 1])).toEqual(['a']);
    expect(parseMentions('{')).toEqual([]);
    expect(parseMentions(null)).toEqual([]);
  });
});

describe('ReviewMentionCandidatesRepository', () => {
  it('searches staff on the project, org-wide staff and the project’s client contacts', async () => {
    const { runner, statements } = fakeRunner([[], [], []]);
    await people.search(runner, context, {
      projectId: uuidv7(),
      prefix: 'mo_',
      includeStaff: true,
      includeClients: true,
      limit: 10,
    });
    expect(statements).toHaveLength(3);
    expect(statements[0]?.sql).toContain('`project_memberships`');
    expect(statements[1]?.sql).toContain('`has_org_wide_scope`');
    expect(statements[2]?.sql).toContain('`project_clients`');
    // A LIKE wildcard typed by the user is escaped.
    expect(statements[0]?.params).toContain('mo\\_%');
  });

  it('limits a client to its own organization and answers nothing for an empty id list', async () => {
    const clientOrg = uuidv7();
    const { runner, statements } = fakeRunner([[]]);
    await people.search(runner, context, {
      projectId: uuidv7(),
      prefix: '',
      includeStaff: false,
      includeClients: true,
      clientOrganizationId: clientOrg,
      limit: 10,
    });
    expect(statements[0]?.params).toContain(clientOrg);
    const none = fakeRunner([]);
    expect(
      await people.search(none.runner, context, {
        projectId: uuidv7(),
        prefix: '',
        userIds: [],
        includeStaff: true,
        includeClients: true,
        limit: 10,
      }),
    ).toEqual([]);
    expect(none.statements).toHaveLength(0);
  });

  it('names people by membership from both membership tables', async () => {
    const m = uuidv7();
    const u = uuidv7();
    const { runner, statements } = fakeRunner([[[m, u, 'Mona']], []]);
    expect(await people.peopleByMembership(runner, context, [m, m])).toEqual([
      { membershipId: m, userId: u, displayName: 'Mona', kind: 'internal' },
    ]);
    expect(statements[0]?.sql).toContain('`memberships`');
    expect(statements[1]?.sql).toContain('`client_memberships`');
    expect(await people.peopleByMembership(runner, context, [])).toEqual([]);
  });
});
