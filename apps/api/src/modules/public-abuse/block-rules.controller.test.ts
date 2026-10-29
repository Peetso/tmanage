import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { OrgBlockRuleRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { BlockRulesController, BlockRulesService } from './block-rules.controller.js';
import type { BlockRuleStore } from './block-rules.controller.js';
import type { BlockRuleInput, BlockRuleKind } from './block-rules.repository.js';

/**
 * The block-rules routes over an in-memory store with the real `authorize`: the
 * `org.security.manage` gate (403, no write), validation (400), the duplicate 409 and the
 * cross-tenant DELETE that resolves to 404 and removes nothing.
 */

const ORG_A = '01890000-0000-7000-8000-00000000000a';
const ORG_B = '01890000-0000-7000-8000-00000000000b';
const contextFor = (organizationId: string) =>
  ({ organizationId, userId: 'u-1' }) as unknown as TenantContext;

function principal(role: 'owner' | 'member', organizationId = ORG_A): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000001',
    organizationId,
    kind: 'internal',
    role,
    membershipId: '01890000-0000-7000-8000-000000000011',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: role === 'owner',
  } as unknown as Principal;
}

class FakeStore implements BlockRuleStore {
  readonly rows: OrgBlockRuleRow[] = [];
  writes = 0;
  async listAll(_r: unknown, context: TenantContext) {
    return this.rows.filter((row) => row.organizationId === context.organizationId);
  }
  async findById(_r: unknown, context: TenantContext, id: string) {
    return (
      this.rows.find((row) => row.id === id && row.organizationId === context.organizationId) ??
      null
    );
  }
  async findByValue(_r: unknown, context: TenantContext, kind: BlockRuleKind, value: string) {
    return (
      this.rows.find(
        (row) =>
          row.organizationId === context.organizationId && row.kind === kind && row.value === value,
      ) ?? null
    );
  }
  async insert(_r: unknown, context: TenantContext, input: BlockRuleInput) {
    this.writes += 1;
    const row = {
      id: `rule-${this.rows.length + 1}`,
      organizationId: context.organizationId,
      kind: input.kind,
      value: input.value,
      reason: input.reason,
      createdByUserId: null,
      createdAt: new Date('2026-10-29T10:00:00.000Z'),
    } satisfies OrgBlockRuleRow;
    this.rows.push(row);
    return row;
  }
  async remove(_r: unknown, context: TenantContext, id: string) {
    this.writes += 1;
    const index = this.rows.findIndex(
      (row) => row.id === id && row.organizationId === context.organizationId,
    );
    if (index >= 0) this.rows.splice(index, 1);
  }
}

function harness() {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const store = new FakeStore();
  return { controller: new BlockRulesController(new BlockRulesService(database, store)), store };
}

async function statusOf(work: () => Promise<unknown>): Promise<number> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('BlockRulesController', () => {
  it('adds a canonical rule, lists it and refuses a duplicate', async () => {
    const { controller, store } = harness();
    const added = await controller.add(contextFor(ORG_A), principal('owner'), {
      kind: 'domain',
      value: ' @Spam.Example ',
      reason: 'spam wave',
    });
    expect(added).toMatchObject({ kind: 'domain', value: 'spam.example', reason: 'spam wave' });
    expect((await controller.list(contextFor(ORG_A), principal('owner'))).rules).toHaveLength(1);
    expect(
      await statusOf(() =>
        controller.add(contextFor(ORG_A), principal('owner'), {
          kind: 'domain',
          value: 'spam.example',
        }),
      ),
    ).toBe(409);
    expect(store.writes).toBe(1);
  });

  it('is 403 without org.security.manage and writes nothing', async () => {
    const { controller, store } = harness();
    expect(await statusOf(() => controller.list(contextFor(ORG_A), principal('member')))).toBe(403);
    expect(
      await statusOf(() =>
        controller.add(contextFor(ORG_A), principal('member'), {
          kind: 'ip',
          value: '198.51.100.9',
        }),
      ),
    ).toBe(403);
    expect(store.writes).toBe(0);
  });

  it('refuses a malformed value with 400', async () => {
    const { controller } = harness();
    expect(
      await statusOf(() =>
        controller.add(contextFor(ORG_A), principal('owner'), { kind: 'ip', value: '999.1.1.1' }),
      ),
    ).toBe(400);
    expect(
      await statusOf(() =>
        controller.add(contextFor(ORG_A), principal('owner'), { kind: 'phone', value: 'x' }),
      ),
    ).toBe(400);
  });

  it('refuses a cross-tenant read and delete: another organization sees nothing, removes nothing', async () => {
    const { controller, store } = harness();
    const added = await controller.add(contextFor(ORG_A), principal('owner'), {
      kind: 'email',
      value: 'bot@spam.example',
    });
    const otherOwner = principal('owner', ORG_B);
    expect((await controller.list(contextFor(ORG_B), otherOwner)).rules).toEqual([]);
    expect(await statusOf(() => controller.remove(contextFor(ORG_B), otherOwner, added.id))).toBe(
      404,
    );
    expect(store.rows).toHaveLength(1);
  });
});
