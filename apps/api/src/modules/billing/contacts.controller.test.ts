import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { BillingContactsController } from './contacts.controller.js';
import { BillingContactsService } from './contacts.service.js';
import type { BillingContactsStore } from './contacts.service.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingContactRow } from '../../common/database/schema.js';

/**
 * x199 — the fast, database-free proof of billing contacts (Billing module 19). It runs the controller
 * over an in-memory contact store with the **real** `authorize`: the resolve-then-authorize order, the
 * cross-tenant 404 (no write), the bad-email 400 (no write) and the `org.manage` gate are the
 * behaviours a wiring bug would break, and none needs MySQL. The composite key and the immutability
 * trigger are proved against the real engine by the chain's DB suite (Peter's rule: no DB tests here).
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const MEMBERSHIP = '01890000-0000-7000-8000-000000000011';
const context = { organizationId: ORG } as unknown as TenantContext;

/** An owner — the one internal role whose ceiling still holds `org.manage`. */
function owner(): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  } as unknown as Principal;
}

/** An in-memory contact store standing in for the drizzle store, counting its writes. */
class FakeStore implements BillingContactsStore {
  readonly rows: BillingContactRow[] = [];
  inserts = 0;
  deletes = 0;

  async listAll() {
    return [...this.rows];
  }
  async findById(_r: unknown, _c: TenantContext, id: string) {
    return this.rows.find((row) => row.id === id) ?? null;
  }
  async insert(
    _r: unknown,
    _c: TenantContext,
    input: { name: string; email: string; role: string | null },
  ) {
    this.inserts += 1;
    const row = {
      id: `contact-${this.rows.length + 1}`,
      organizationId: ORG,
      name: input.name,
      email: input.email,
      role: input.role,
      createdAt: new Date(),
    } as BillingContactRow;
    this.rows.push(row);
    return row;
  }
  async remove(_r: unknown, _c: TenantContext, id: string) {
    this.deletes += 1;
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

function harness() {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const store = new FakeStore();
  const service = new BillingContactsService(database, store);
  return { controller: new BillingContactsController(service), store };
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

describe('BillingContactsController', () => {
  let harnessed: ReturnType<typeof harness>;

  beforeEach(() => {
    harnessed = harness();
  });

  it('adds, lists and removes a contact for an owner', async () => {
    const { controller } = harnessed;

    const added = await controller.add(context, owner(), {
      name: 'Ada Finance',
      email: 'ada@example.com',
      role: 'Accounts payable',
    });
    expect(added).toMatchObject({
      name: 'Ada Finance',
      email: 'ada@example.com',
      role: 'Accounts payable',
    });

    const listed = await controller.list(context, owner());
    expect(listed.contacts).toHaveLength(1);
    expect(listed.contacts[0]).toMatchObject({ id: added.id });

    const removed = await controller.remove(context, owner(), added.id);
    expect(removed.id).toBe(added.id);

    const after = await controller.list(context, owner());
    expect(after.contacts).toHaveLength(0);
  });

  it('refuses a malformed email with 400 and writes nothing', async () => {
    const { controller, store } = harnessed;
    const status = await statusOf(() =>
      controller.add(context, owner(), { name: 'Ada', email: 'not-an-email' }),
    );
    expect(status).toBe(400);
    expect(store.inserts).toBe(0);
  });

  it('answers 404 and writes nothing when the contact is cross-tenant or absent', async () => {
    const { controller, store } = harnessed;
    const status = await statusOf(() => controller.remove(context, owner(), 'contact-missing'));
    expect(status).toBe(404);
    expect(store.deletes).toBe(0);
  });

  it('refuses a principal without org.manage with 403 and writes nothing', async () => {
    const { controller, store } = harnessed;
    const notManager: Principal = { ...owner(), role: 'org_admin' } as Principal;
    const status = await statusOf(() =>
      controller.add(context, notManager, { name: 'Ada', email: 'ada@example.com' }),
    );
    expect(status).toBe(403);
    expect(store.inserts).toBe(0);
  });
});
