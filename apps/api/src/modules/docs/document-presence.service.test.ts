import { expect, it } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DocumentPresenceService } from './document-presence.service.js';

// R5 slice 2: PUT then GET lists me; another document does not; 30 s later I am gone.
it('lists, separates and expires editors', async () => {
  const ctx = { organizationId: 'o', userId: 'u', membershipId: 'm' } as TenantContext;
  const db = { read: (_c: unknown, w: (r: unknown) => unknown) => w({}) } as TenantDatabase;
  let clock = 0;
  const people = { people: async () => [{ membershipId: 'm', userId: 'u', displayName: 'Sara' }] };
  const docs = { get: async () => ({}) as never };
  const p = new DocumentPresenceService(db, docs, people, () => clock);
  await p.touch(ctx, {} as never, 'd1');
  expect(await p.list(ctx, {} as never, 'd1')).toMatchObject([{ userId: 'u', name: 'Sara' }]);
  expect(await p.list(ctx, {} as never, 'd2')).toEqual([]);
  clock = 30_001;
  expect(await p.list(ctx, {} as never, 'd1')).toEqual([]);
});
