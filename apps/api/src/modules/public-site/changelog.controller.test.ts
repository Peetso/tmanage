import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { IS_PUBLIC, REQUIRED_CAPABILITY, SKIPS_TENANT } from '../../common/http/decorators.js';
import { ChangelogController } from './changelog.controller.js';
import type { ChangelogRepository } from './changelog.repository.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { ChangelogEntryRow } from '../../common/database/schema.js';

/**
 * Public product changelog (x160). The controller's own logic, database-free over fakes. The
 * subject is what the controller does with the rows the read hands it — the month grouping, the
 * newest-first order, the bounded page — and that the route is genuinely public. The published-only
 * SQL predicate and the migration are the chain's concern (no DB test in this slice); the fake
 * `listPublished` therefore returns whatever it is seeded with, so the controller's month grouping
 * and its NULL-date guard are exercised directly.
 */

const REQUEST = { headers: {} } as const;

function entry(
  id: string,
  publishedAt: string | null,
  over: Partial<ChangelogEntryRow> = {},
): ChangelogEntryRow {
  return {
    id,
    version: '2026.09',
    title: `Entry ${id}`,
    bodyMd: '# Body',
    category: 'feature',
    published: publishedAt !== null,
    publishedAt: publishedAt === null ? null : new Date(publishedAt),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...over,
  } as ChangelogEntryRow;
}

/** A controller over an in-memory store; records the limit the read was bounded to. */
function controllerWith(seed: readonly ChangelogEntryRow[] = []): {
  controller: ChangelogController;
  limits: number[];
} {
  const limits: number[] = [];
  const database = {
    identityRead: async (_options: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const changelog = {
    listPublished: async (_runner: unknown, limit: number) => {
      limits.push(limit);
      return [...seed];
    },
  } as unknown as ChangelogRepository;
  return { controller: new ChangelogController(database, changelog), limits };
}

describe('ChangelogController', () => {
  it('is a public route: no session, no tenant, no capability', () => {
    // The route opts out of the whole guard pipeline with `@Public()` — the CapabilityGuard reads
    // this metadata and would refuse a tenant route that named no capability, so its absence here
    // is only safe *because* the route is public.
    const isPublic = Reflect.getMetadata(IS_PUBLIC, ChangelogController.prototype.list);
    const capability = Reflect.getMetadata(REQUIRED_CAPABILITY, ChangelogController.prototype.list);
    const skipsTenant = Reflect.getMetadata(SKIPS_TENANT, ChangelogController.prototype.list);
    expect(isPublic).toBe(true);
    expect(capability).toBeUndefined();
    expect(skipsTenant).toBeUndefined();
  });

  it('groups published entries by month, newest month first, preserving the within-month order', async () => {
    const { controller } = controllerWith([
      // The read hands them back newest-first (published_at DESC); the controller keeps that order.
      entry('entry-0000-0000-0000-000000000003', '2026-10-05T09:00:00.000Z'),
      entry('entry-0000-0000-0000-000000000002', '2026-10-01T09:00:00.000Z'),
      entry('entry-0000-0000-0000-000000000001', '2026-09-20T09:00:00.000Z'),
    ]);

    const view = await controller.list(REQUEST);

    expect(view.months.map((m) => m.month)).toEqual(['2026-10', '2026-09']);
    expect(view.months[0]?.entries.map((e) => e.id)).toEqual([
      'entry-0000-0000-0000-000000000003',
      'entry-0000-0000-0000-000000000002',
    ]);
    expect(view.months[1]?.entries.map((e) => e.id)).toEqual(['entry-0000-0000-0000-000000000001']);
    // The wire projection narrows the category and echoes the live instant.
    expect(view.months[0]?.entries[0]?.category).toBe('feature');
    expect(view.months[0]?.entries[0]?.publishedAt).toBe('2026-10-05T09:00:00.000Z');
  });

  it('excludes a draft: a row with no live date never reaches a month bucket', async () => {
    // The repository's `WHERE published = 1 AND published_at IS NOT NULL` is the real boundary; this
    // proves the controller adds a defensive guard rather than emitting an `Invalid Date` month for
    // a row without a date.
    const { controller } = controllerWith([
      entry('entry-published-00000000000001', '2026-10-05T09:00:00.000Z'),
      entry('entry-draft-000000000000000002', null),
    ]);

    const view = await controller.list(REQUEST);

    const ids = view.months.flatMap((m) => m.entries.map((e) => e.id));
    expect(ids).toEqual(['entry-published-00000000000001']);
  });

  it('bounds the page: the read is asked for at most 200 entries', async () => {
    const { controller, limits } = controllerWith([]);
    await controller.list(REQUEST);
    expect(limits).toEqual([200]);
  });
});
