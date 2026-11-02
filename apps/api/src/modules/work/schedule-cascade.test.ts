import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ScheduleCascadeService } from './schedule-cascade.service.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

// 53-04: preview = apply, a stale preview is refused, and a cascade spans at most 3 projects.
const ORG = 'org-1';
const ctx = { organizationId: ORG, userId: 'u-1', correlationId: 'c' } as TenantContext;
const owner = {
  userId: 'u-1',
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: 'm',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
} as Principal;
const at = (d: string) => new Date(`${d}T09:00:00.000Z`);
const row = (id: string, projectId: string, start: string, due: string) => ({
  id,
  organizationId: ORG,
  projectId,
  title: id,
  audience: 'internal',
  state: 'todo',
  version: 1,
  deletedAt: null,
  startAt: at(start),
  dueAt: at(due),
});

function harness(projects: string[]) {
  const rows = [
    row('R', projects[0]!, '2026-11-02', '2026-11-03'),
    ...projects.map((p, i) => row(`S${i}`, p, '2026-11-01', '2026-11-01')),
  ];
  const edges = projects.map((_, i) => ({
    id: `e${i}`,
    workItemId: `S${i}`,
    dependsOnWorkItemId: i === 0 ? 'R' : `S${i - 1}`,
    kind: 'FS',
    lag: 0,
  }));
  const writes: string[] = [];
  const db = {
    read: (_c: unknown, w: (r: unknown) => unknown) => w({}),
    transaction: (_c: unknown, w: (r: unknown) => unknown) => w({}),
  } as unknown as TenantDatabase;
  const items = {
    findById: async (_r: unknown, _c: unknown, id: string) => rows.find((r) => r.id === id) ?? null,
    findManyByIds: async () => rows,
    update: async (_r: unknown, _c: unknown, id: string) => writes.push(id),
  };
  const graph = { listActiveEdgesFrom: async () => edges };
  const calendars = { findCalendar: async () => null, organizationTimeZone: async () => 'UTC' };
  const service = new ScheduleCascadeService(
    db,
    items as never,
    undefined,
    graph as never,
    calendars as never,
  );
  return { service, writes };
}
const dates = { startAt: at('2026-11-04'), dueAt: at('2026-11-05') };

describe('53-04 schedule cascade', () => {
  it('applies exactly the moves the preview showed', async () => {
    const { service, writes } = harness(['P1', 'P1']);
    const preview = await service.preview(ctx, owner, 'R', dates);
    expect(preview.moves.map((m) => [m.id, m.startAt])).toEqual([
      ['S0', '2026-11-05T09:00:00.000Z'],
      ['S1', '2026-11-05T09:00:00.000Z'],
    ]);
    await service.apply(
      ctx,
      owner,
      'R',
      dates,
      preview.moves.map((m) => m.id),
    );
    expect(writes).toEqual(['R', 'S0', 'S1']);
  });

  it('refuses a stale preview with 409 and writes nothing', async () => {
    const { service, writes } = harness(['P1', 'P1']);
    await expect(service.apply(ctx, owner, 'R', dates, ['S0'])).rejects.toMatchObject({
      status: 409,
    });
    expect(writes).toEqual([]);
  });

  it('caps a cross-project cascade at three projects', async () => {
    const { service } = harness(['P1', 'P2', 'P3', 'P4']);
    const ids = (await service.preview(ctx, owner, 'R', dates)).moves.map((m) => m.id);
    await expect(service.apply(ctx, owner, 'R', dates, ids)).rejects.toMatchObject({ status: 422 });
  });
});
