import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectRow } from '../../common/database/schema.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { ClientOrganizationsRepository } from '../clients/client-organizations.repository.js';
import type { ProjectClientsRepository } from '../clients/project-clients.repository.js';
import type {
  ActivityEntryRow,
  ActivityRepository,
  ActivityScope,
  ActivitySourceFacts,
  FactSource,
} from './activity.repository.js';
import { ActivityService, decodeActivityCursor, encodeActivityCursor } from './activity.service.js';
import {
  ClientActivityController,
  ProjectActivityController,
  parseActivityQuery,
} from './activity.controller.js';

/**
 * 62-A2 (B02) — the Activity read over fakes with the real `authorize()`: parent first (a project
 * or client the caller may not read is a 404 and no entry is read), then every entry re-checked
 * against its source row as it is now (deleted = gone, finance = finance.view), paged by keyset.
 */

const ORG = '0199aa00-0000-7000-8000-00000000000a';
const P1 = '0199aa00-0000-7000-8000-0000000000a1';
const P2 = '0199aa00-0000-7000-8000-0000000000a2';
const CLIENT = '0199aa00-0000-7000-8000-0000000000c1';
const context = { organizationId: ORG, userId: 'u' } as unknown as TenantContext;

function principal(
  role: Principal['role'],
  projectIds: readonly string[],
  orgWide = false,
): Principal {
  return {
    userId: '0199aa00-0000-7000-8000-0000000000u1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: '0199aa00-0000-7000-8000-0000000000m1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: orgWide,
  };
}

const owner = principal('owner', [], true);
const memberOnP1 = principal('member', [P1]);
const memberOnP2 = principal('member', [P2]);

let seq = 0;
function row(action: string, objectId: string, projectId: string | null = P1): ActivityEntryRow {
  seq += 1;
  return {
    id: `0199aa00-0000-7000-8000-${String(1000 - seq).padStart(12, '0')}`,
    projectId,
    clientOrganizationId: null,
    objectType: action.split('.')[0]!,
    objectId,
    action,
    kind: 'work',
    actorUserId: 'u1',
    occurredAt: new Date(Date.UTC(2026, 10, 19, 0, 0, 1000 - seq)),
  };
}

function build(
  entries: readonly ActivityEntryRow[],
  facts: Partial<Record<FactSource, Record<string, ActivitySourceFacts>>>,
) {
  const reads = { entries: 0, scopes: [] as ActivityScope[] };
  const database = {
    read: async (_c: unknown, work: (runner: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const activity = {
    listEntries: async (
      _r: unknown,
      _c: unknown,
      scope: ActivityScope,
      _f: unknown,
      before: { occurredAt: Date; id: string } | null,
      limit: number,
    ) => {
      reads.entries += 1;
      reads.scopes.push(scope);
      const sorted = [...entries].sort((a, b) =>
        a.occurredAt.getTime() !== b.occurredAt.getTime()
          ? b.occurredAt.getTime() - a.occurredAt.getTime()
          : a.id < b.id
            ? 1
            : -1,
      );
      const after =
        before === null
          ? sorted
          : sorted.filter(
              (e) =>
                e.occurredAt < before.occurredAt ||
                (e.occurredAt.getTime() === before.occurredAt.getTime() && e.id < before.id),
            );
      return after.slice(0, limit);
    },
    sourceFacts: async (_r: unknown, _c: unknown, source: FactSource, ids: readonly string[]) =>
      new Map(
        ids.flatMap((id) => {
          const found = facts[source]?.[id];
          return found === undefined ? [] : [[id, found] as const];
        }),
      ),
  } as unknown as ActivityRepository;
  const project = (id: string) =>
    ({ id, organizationId: ORG, archivedAt: null }) as unknown as ProjectRow;
  const projects = {
    findById: async (_r: unknown, _c: unknown, id: string) =>
      [P1, P2].includes(id) ? project(id) : null,
  } as unknown as ProjectsRepository;
  const clients = {
    findById: async (_r: unknown, _c: unknown, id: string) => (id === CLIENT ? { id } : null),
  } as unknown as ClientOrganizationsRepository;
  const shares = {
    list: async () => [{ id: 's1', projectId: P1 }],
  } as unknown as ProjectClientsRepository;
  return { service: new ActivityService(database, activity, projects, clients, shares), reads };
}

const fact = (
  id: string,
  projectId: string | null,
  audience: ActivitySourceFacts['audience'] = 'internal',
): ActivitySourceFacts => ({
  id,
  projectId,
  clientOrganizationId: null,
  audience,
});

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    return (error as ApiError).status;
  }
}

describe('activity service (62-A2)', () => {
  it('a project the caller may not read is a 404, and no entry is read', async () => {
    const { service, reads } = build([row('work_item.created', 'w1')], {});
    expect(await status(service.projectActivity(context, memberOnP2, P1))).toBe(404);
    expect(await status(service.projectActivity(context, owner, 'missing-project'))).toBe(404);
    expect(reads.entries).toBe(0);
  });

  it('drops an entry whose source row is gone (deleted) and keeps the rest', async () => {
    const kept = row('work_item.created', 'w1');
    const gone = row('work_item.updated', 'w-deleted');
    const { service } = build([kept, gone], { work_item: { w1: fact('w1', P1) } });
    const page = await service.projectActivity(context, owner, P1);
    expect(page.entries.map((e) => e.id)).toEqual([kept.id]);
    expect(page.entries[0]).toMatchObject({
      kind: 'work',
      action: 'work_item.created',
      phraseKey: 'activity.phrase.work_item.created',
      summary: 'Created a task',
      objectType: 'work_item',
      objectId: 'w1',
      projectId: P1,
    });
    expect(page.nextCursor).toBeNull();
  });

  it('hides a finance entry from a member without finance.view, shows it to the owner', async () => {
    const invoice = row('client_invoice.sent', 'inv1');
    const task = row('work_item.created', 'w1');
    const facts = { client_invoice: { inv1: fact('inv1', P1) }, work_item: { w1: fact('w1', P1) } };
    const asMember = await build([invoice, task], facts).service.projectActivity(
      context,
      memberOnP1,
      P1,
    );
    expect(asMember.entries.map((e) => e.action)).toEqual(['work_item.created']);
    const asOwner = await build([invoice, task], facts).service.projectActivity(context, owner, P1);
    expect(asOwner.entries.map((e) => e.action)).toEqual([
      'client_invoice.sent',
      'work_item.created',
    ]);
  });

  it('drops an entry no longer catalogued, and one about a task on a project the member is not on', async () => {
    const stray = row('file_asset.downloaded', 'f1');
    const moved = row('work_item.created', 'w2');
    const { service } = build([stray, moved], { work_item: { w2: fact('w2', P2) } });
    expect((await service.projectActivity(context, memberOnP1, P1)).entries).toEqual([]);
  });

  it('refills a page from older rows when entries are dropped, and pages by cursor', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row('work_item.created', `w${i}`));
    const visible = Object.fromEntries(
      rows.filter((_, i) => i % 2 === 0).map((r) => [r.objectId, fact(r.objectId, P1)]),
    );
    const { service } = build(rows, { work_item: visible });
    const first = await service.projectActivity(context, owner, P1, { limit: 2 });
    expect(first.entries.map((e) => e.objectId)).toEqual(['w0', 'w2']);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.projectActivity(context, owner, P1, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.entries.map((e) => e.objectId)).toEqual(['w4']);
    expect(second.nextCursor).toBeNull();
  });

  it('a client feed needs org.manage (404 otherwise) and spans the shared projects', async () => {
    const { service, reads } = build([], {});
    expect(await status(service.clientActivity(context, memberOnP1, CLIENT))).toBe(404);
    expect(await status(service.clientActivity(context, owner, 'missing-client'))).toBe(404);
    expect(reads.entries).toBe(0);
    await service.clientActivity(context, owner, CLIENT);
    expect(reads.scopes).toEqual([
      { kind: 'client', clientOrganizationId: CLIENT, projectIds: [P1] },
    ]);
  });

  it('a cursor round-trips, and a forged one is a 400', () => {
    const key = { occurredAt: new Date('2026-11-19T10:00:00.000Z'), id: P1 };
    expect(decodeActivityCursor(encodeActivityCursor(key))).toEqual(key);
    for (const forged of ['x', Buffer.from('2026-11-19|1 or 1=1').toString('base64url')]) {
      expect(() => decodeActivityCursor(forged)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
});

describe('activity controllers (62-A2)', () => {
  it('gate the project feed on work.read and the client feed on org.manage', () => {
    const capability = (target: object) =>
      Reflect.getMetadata(REQUIRED_CAPABILITY, target) as unknown;
    expect(capability(ProjectActivityController.prototype.list as object)).toBe('work.read');
    expect(capability(ClientActivityController.prototype.list as object)).toBe('org.manage');
  });

  it('parses the filters, a day as "to" covering the whole day', () => {
    expect(
      parseActivityQuery({
        kind: 'files',
        person: P1,
        from: '2026-11-01',
        to: '2026-11-19',
        limit: '20',
      }),
    ).toEqual({
      kind: 'files',
      actorUserId: P1,
      from: new Date('2026-11-01T00:00:00.000Z'),
      to: new Date('2026-11-20T00:00:00.000Z'),
      limit: 20,
    });
  });

  it.each([
    [{ kind: 'secrets' }],
    [{ person: 'not-a-user' }],
    [{ from: 'yesterday' }],
    [{ from: '2026-11-19', to: '2026-11-01' }],
    [{ limit: '0' }],
    [{ limit: '101' }],
    [{ kind: ['files', 'work'] }],
  ])('refuses %o with a 400', (query) => {
    expect(() => parseActivityQuery(query)).toThrow(expect.objectContaining({ status: 400 }));
  });
});
