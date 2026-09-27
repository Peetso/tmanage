import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/http/errors.js';
import { GlossaryController } from './glossary.controller.js';
import { GlossaryService } from './glossary.service.js';
import type { GlossaryRepository } from './glossary.repository.js';
import type { GlossaryTermRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Org glossary of terms (x263) controller/service proofs over the module's fakes. The migration and
 * the tenant-scoped SQL round-trip are proven in the DB suite (the chain owns it); here the subject is
 * the logic: add/list/edit/remove, the resolve-before-write 404, and — the required refusal — a
 * duplicate term (same studio, any case) is a 409 that inserts no second row.
 */

const ORG = 'organization-0000-0000-0000-000000000001';

function contextFor(org: string): TenantContext {
  return {
    organizationId: org,
    userId: 'user-1',
    membershipId: 'membership-1',
  } as unknown as TenantContext;
}

/** A controller whose glossary lives in an in-memory store; the unique term key is enforced case-insensitively. */
function controllerWith(): { controller: GlossaryController; store: GlossaryTermRow[] } {
  const store: GlossaryTermRow[] = [];
  let seq = 0;
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repo = {
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      store.find((row) => row.organizationId === ctx.organizationId && row.id === id) ?? null,
    findByTerm: async (_r: unknown, ctx: TenantContext, term: string) =>
      store.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.term.toLowerCase() === term.toLowerCase(),
      ) ?? null,
    insert: async (
      _r: unknown,
      ctx: TenantContext,
      input: { term: string; definition: string },
    ) => {
      const now = new Date();
      const row = {
        id: `glossary-term-${++seq}`,
        organizationId: ctx.organizationId,
        term: input.term,
        definition: input.definition,
        createdAt: now,
        updatedAt: now,
      } as GlossaryTermRow;
      store.push(row);
      return row;
    },
    update: async (
      _r: unknown,
      ctx: TenantContext,
      id: string,
      fields: { term?: string; definition?: string },
    ) => {
      const row = store.find((r) => r.organizationId === ctx.organizationId && r.id === id);
      if (!row) return null;
      if (fields.term !== undefined) row.term = fields.term;
      if (fields.definition !== undefined) row.definition = fields.definition;
      row.updatedAt = new Date();
      return row;
    },
    remove: async (_r: unknown, ctx: TenantContext, id: string) => {
      const index = store.findIndex((r) => r.organizationId === ctx.organizationId && r.id === id);
      if (index >= 0) store.splice(index, 1);
    },
    list: async (_r: unknown, ctx: TenantContext, prefix?: string) =>
      store
        .filter(
          (row) =>
            row.organizationId === ctx.organizationId &&
            (prefix === undefined ||
              prefix === '' ||
              row.term.toLowerCase().startsWith(prefix.toLowerCase())),
        )
        .sort((a, b) => a.term.localeCompare(b.term) || a.id.localeCompare(b.id)),
  } as unknown as GlossaryRepository;

  return { controller: new GlossaryController(new GlossaryService(database, repo)), store };
}

describe('Glossary', () => {
  it('adds a term, never echoes the tenant id, and lists it back with a prefix filter', async () => {
    const { controller } = controllerWith();
    const context = contextFor(ORG);

    const created = await controller.create(context, {
      term: 'API',
      definition: 'Application interface',
    });
    expect(created.term).toBe('API');
    expect(created).not.toHaveProperty('organizationId');

    await controller.create(context, { term: 'Backlog', definition: 'Pending work' });

    const all = await controller.list(context);
    expect(all.terms.map((t) => t.term)).toEqual(['API', 'Backlog']);

    const filtered = await controller.list(context, 'ap');
    expect(filtered.terms.map((t) => t.term)).toEqual(['API']);
  });

  it('refuses a duplicate term (same studio, any case) with 409 and inserts no second row', async () => {
    const { controller, store } = controllerWith();
    const context = contextFor(ORG);
    await controller.create(context, { term: 'API', definition: 'Application interface' });

    const error = await controller
      .create(context, { term: 'api', definition: 'A different definition' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect(store).toHaveLength(1);
  });

  it('edits a term and removes it; a missing id is 404 with no write', async () => {
    const { controller, store } = controllerWith();
    const context = contextFor(ORG);
    const created = await controller.create(context, { term: 'API', definition: 'v1' });

    const edited = await controller.update(context, created.id, { definition: 'v2' });
    expect(edited.definition).toBe('v2');

    await controller.remove(context, created.id);
    expect(store).toHaveLength(0);

    const missing = await controller
      .update(context, 'nope', { definition: 'x' })
      .catch((e: unknown) => e);
    expect((missing as ApiError).status).toBe(404);
  });

  it('rejects an empty term or definition (400) with no write', async () => {
    const { controller, store } = controllerWith();
    const context = contextFor(ORG);
    const error = await controller
      .create(context, { term: '   ', definition: 'x' })
      .catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(400);
    expect(store).toHaveLength(0);
  });
});
