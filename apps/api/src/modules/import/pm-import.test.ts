import { describe, expect, it } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PmFetchError, isAllowedPmUrl, pmGetJson } from './pm-egress.js';
import type { PmFetch } from './pm-egress.js';
import { readPmBoards } from './pm-sources.js';
import type { PmBoardData } from './pm-sources.js';
import { buildPmPlan, extractMarkers, suggestPmMapping } from './pm-import-plan.js';
import { PmImportService, pmVaultKey } from './pm-import.service.js';
import type { PmImportDeps } from './pm-import.service.js';

/** R45 L3 (54-25): egress guard, Trello / Asana mapping, idempotency and the token's one use. */

const TB = 'a'.repeat(24);
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function stub(routes: Record<string, unknown>, calls: string[] = []): PmFetch {
  return (url) => {
    calls.push(url);
    const hit = Object.keys(routes).find((k) => url.includes(k));
    return Promise.resolve(hit ? json(routes[hit]) : new Response('', { status: 404 }));
  };
}

const trello = {
  [`/boards/${TB}/lists`]: [{ id: 'l1', name: 'Doing' }],
  [`/boards/${TB}/members`]: [{ id: 'm1', fullName: 'Lina', username: 'Lina' }],
  [`/boards/${TB}/cards`]: [
    {
      id: 'b'.repeat(24),
      name: 'Fix header',
      desc: 'Body',
      due: '2026-12-01T09:00:00.000Z',
      idList: 'l1',
      idMembers: ['m1'],
      shortLink: 'Ab12',
      closed: false,
    },
    {
      id: 'c'.repeat(24),
      name: 'Old',
      idList: 'l1',
      idMembers: [],
      shortLink: 'Zz9',
      closed: true,
    },
  ],
  [`/boards/${TB}/actions`]: [
    {
      data: { card: { id: 'b'.repeat(24) }, text: 'Looks good' },
      date: '2026-11-01T00:00:00Z',
      memberCreator: { fullName: 'Lina' },
    },
  ],
};

describe('pm egress guard', () => {
  it('allows only https on the three provider hosts', () => {
    expect(isAllowedPmUrl('https://api.trello.com/1/members/me')).toBe(true);
    expect(isAllowedPmUrl('https://app.asana.com/api/1.0/users/me')).toBe(true);
    expect(isAllowedPmUrl('https://api.github.com/repos/a/b')).toBe(true);
    for (const bad of [
      'http://api.trello.com/1',
      'https://api.trello.com:8443/1',
      'https://u:p@app.asana.com/',
      'https://169.254.169.254/',
      'https://api.trello.com.evil.test/',
    ]) {
      expect(isAllowedPmUrl(bad)).toBe(false);
    }
  });

  it('never calls a refused host and refuses a redirect without following it', async () => {
    const calls: string[] = [];
    await expect(pmGetJson(stub({}, calls), 'https://example.com/', {})).rejects.toMatchObject({
      code: 'pm_host_refused',
    });
    expect(calls).toEqual([]);
    const redirect: PmFetch = (_u, init) => {
      expect(init.redirect).toBe('manual');
      return Promise.resolve(
        new Response('', { status: 302, headers: { location: 'http://10.0.0.1/' } }),
      );
    };
    await expect(pmGetJson(redirect, 'https://api.trello.com/1/x', {})).rejects.toBeInstanceOf(
      PmFetchError,
    );
  });
});

describe('pm sources', () => {
  it('maps a Trello board: list, due date, members, comments and the provenance address', async () => {
    const data = await readPmBoards(
      stub(trello),
      { source: 'trello', apiKey: 'f'.repeat(32), token: 't'.repeat(64) },
      [TB],
      true,
    );
    expect(data.containers).toEqual(['Doing']);
    expect(data.cards[0]).toMatchObject({
      url: 'https://trello.com/c/Ab12',
      container: 'Doing',
      dueOn: '2026-12-01',
      assigneeKeys: ['trello:lina'],
    });
    expect(data.cards[0]?.comments?.[0]?.text).toBe('Looks good');
    expect(data.cards[1]?.archived).toBe(true);
  });

  it('maps an Asana task: section, assignee by e-mail, completed', async () => {
    const data = await readPmBoards(
      stub({
        '/projects/42/sections': { data: [{ name: 'Backlog' }] },
        '/tasks?project=42': {
          data: [
            {
              gid: '7',
              name: 'Ship',
              due_on: '2026-12-02',
              completed: true,
              assignee: { gid: '9', name: 'Sam', email: 'Sam@X.example' },
              memberships: [{ project: { gid: '42' }, section: { name: 'Backlog' } }],
            },
          ],
        },
      }),
      { source: 'asana', token: '2/123/456:abcdefabcdef' },
      ['42'],
      false,
    );
    expect(data.cards[0]).toMatchObject({
      url: 'https://app.asana.com/0/42/7',
      container: 'Backlog',
      completed: true,
      assigneeKeys: ['sam@x.example'],
      comments: null,
    });
  });
});

const card = (over: Partial<PmBoardData['cards'][number]>) => ({
  externalId: '1',
  url: 'https://trello.com/c/Ab12',
  boardId: TB,
  title: 'T',
  description: null,
  container: 'Doing',
  dueOn: null,
  assigneeKeys: [],
  completed: false,
  archived: false,
  comments: [],
  ...over,
});

describe('pm plan', () => {
  const data: PmBoardData = {
    containers: ['Doing', 'Done'],
    people: [{ key: 'a@x.example', name: 'A', email: 'a@x.example' }],
    cards: [
      card({ assigneeKeys: ['a@x.example'] }),
      card({
        url: 'https://trello.com/c/Cd34',
        container: 'Done',
        assigneeKeys: ['trello:nobody'],
      }),
      card({ url: 'https://trello.com/c/Ef56', completed: true }),
    ],
    truncated: false,
  };

  it('maps statuses (owner map, then suggestion; completed is done) and people by e-mail', () => {
    const suggestion = suggestPmMapping(data, new Map([['a@x.example', 'u-1']]));
    expect(suggestion).toEqual({
      statusMap: { Doing: 'in_progress', Done: 'done' },
      userMap: { 'a@x.example': 'u-1' },
    });
    const plan = buildPmPlan(
      'trello',
      data,
      { statusMap: { Doing: 'internal_review' }, userMap: suggestion.userMap },
      { markers: new Set(), activeUserIds: new Set(['u-1']) },
    );
    expect(plan.items.map((i) => i.state)).toEqual(['internal_review', 'done', 'done']);
    expect(plan.items[0]?.ownerUserId).toBe('u-1');
    expect(plan.unmatchedPeople).toEqual(['trello:nobody']);
    expect(plan.items[0]?.description).toContain('Imported from Trello: https://trello.com/c/Ab12');
  });

  it('skips cards whose provenance marker is already in the project (idempotent re-run)', () => {
    const markers = extractMarkers([
      'x\n\n---\nImported from Trello: https://trello.com/c/Ab12',
      null,
    ]);
    const plan = buildPmPlan(
      'trello',
      data,
      { statusMap: {}, userMap: {} },
      { markers, activeUserIds: new Set() },
    );
    expect(plan.counts.alreadyImported).toBe(1);
    expect(plan.items.map((i) => i.card.url)).not.toContain('https://trello.com/c/Ab12');
  });
});

describe('pm import job', () => {
  const context = {
    organizationId: 'org-1',
    userId: 'u-0',
    membershipId: 'ms-0',
  } as unknown as TenantContext;
  const database = {
    read: (_c: unknown, f: (r: unknown) => unknown) => f({}),
    transaction: (_c: unknown, f: (r: unknown) => unknown) => f({}),
  } as unknown as TenantDatabase;

  function harness(fetch: PmFetch, descriptions: string[] = []) {
    const vault = new Map<string, string>([
      [pmVaultKey('trello'), JSON.stringify({ apiKey: 'f'.repeat(32), token: 't'.repeat(64) })],
    ]);
    const writes = { items: [] as string[], comments: 0, rows: [] as string[], stamp: '' };
    const deps = {
      fetch,
      cipher: { encrypt: (s: string) => s, decrypt: (s: string) => s },
      vault: {
        findByKey: (_r: unknown, _c: unknown, k: string) =>
          Promise.resolve(
            vault.has(k) ? { credentialEnc: vault.get(k), installedAt: new Date() } : null,
          ),
        insert: () => Promise.resolve(),
        remove: (_r: unknown, _c: unknown, k: string) => Promise.resolve(void vault.delete(k)),
      },
      pm: {
        importedDescriptions: () => Promise.resolve(descriptions),
        activeUserIds: () => Promise.resolve(new Set()),
        activeUserIdsByEmail: () => Promise.resolve(new Map()),
      },
      workItems: {
        create: (_r: unknown, _c: unknown, i: { description: string }) => (
          writes.items.push(i.description),
          Promise.resolve({ id: `w${writes.items.length}`, version: 1 })
        ),
        transitionState: () => Promise.resolve({ version: 2 }),
      },
      comments: { create: () => (writes.comments++, Promise.resolve({})) },
      rows: {
        create: (_r: unknown, _c: unknown, i: { outcome: string }) => (
          writes.rows.push(i.outcome),
          Promise.resolve({})
        ),
      },
      jobs: {
        markCommitted: (_r: unknown, _c: unknown, _id: string, i: { status: string }) => (
          (writes.stamp = i.status),
          Promise.resolve({})
        ),
      },
      now: () => new Date('2026-11-08T00:00:00Z'),
    } as unknown as PmImportDeps;
    const service = new PmImportService(database, deps);
    const run = () =>
      service.run(context, 'trello', 'job-1', {
        projectId: 'p',
        boardIds: [TB],
        statusMap: {},
        userMap: {},
      });
    return { vault, writes, run };
  }

  it('imports cards with comments, writes receipts, then deletes the token', async () => {
    const h = harness(stub(trello));
    await h.run();
    expect(h.writes.items).toHaveLength(1);
    expect(h.writes.comments).toBe(1);
    expect(h.writes.rows).toEqual(['created']);
    expect(h.writes.stamp).toBe('committed');
    expect(h.vault.size).toBe(0);
  });

  it('deletes the token and fails the job when the source refuses it', async () => {
    const h = harness(() => Promise.resolve(new Response('', { status: 401 })));
    await h.run();
    expect(h.writes.stamp).toBe('failed');
    expect(h.vault.size).toBe(0);
  });

  it('creates nothing on a re-run over an already imported board', async () => {
    const h = harness(stub(trello), ['Imported from Trello: https://trello.com/c/Ab12']);
    await h.run();
    expect(h.writes.items).toEqual([]);
    expect(h.writes.stamp).toBe('committed');
  });
});
