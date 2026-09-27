import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { InboxRulesController } from './rules.controller.js';
import { InboxRulesService } from './rules.service.js';
import type { NewInboxRule } from './rules.repository.js';
import type { NotificationsRepository } from './notifications.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InboxRuleRow, NotificationRow } from '../../common/database/schema.js';

/**
 * Inbox routing rules (x301) — controller over faked stores, always the caller's own membership.
 *
 * The properties proved are the ones the HTTP surface and its service own: a rule off the allowlist is
 * a 400 with no insert (the required refusal), the subject of every write is `principal.membershipId`
 * and never a body value, another member's rules are never listed, applied by the resolve helper, or
 * deletable (a 404, never a delete), a missing rule deletes idempotently (204), and every route sits
 * behind `work.read`.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const ME = '00000000-0000-4000-8000-0000000000e1';
const OTHER = '00000000-0000-4000-8000-0000000000e2';
const RULE_ID = '018f0000-0000-7000-8000-0000000000f1';

function member(): Principal {
  return {
    userId: '00000000-0000-4000-8000-0000000000c1',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: ME,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, membershipId: ME } as unknown as TenantContext;

let nextId = 1;

/** In-memory rules store keyed by (org,id), scoped in its query methods the way the real one is. */
class FakeRules {
  readonly rows: InboxRuleRow[] = [];
  insertCalls = 0;
  deleteCalls: { membershipId: string; id: string }[] = [];

  listForMembership(
    _r: unknown,
    _c: unknown,
    membershipId: string,
  ): Promise<readonly InboxRuleRow[]> {
    return Promise.resolve(
      this.rows
        .filter((row) => row.membershipId === membershipId)
        .sort((a, b) => a.position - b.position),
    );
  }

  insert(
    _r: unknown,
    _c: unknown,
    membershipId: string,
    rule: NewInboxRule,
  ): Promise<InboxRuleRow> {
    this.insertCalls += 1;
    const row = {
      id: `018f0000-0000-7000-8000-00000000${String(nextId++).padStart(4, '0')}`,
      organizationId: ORG,
      membershipId,
      matchType: rule.matchType,
      matchValue: rule.matchValue,
      category: rule.category,
      position: rule.position,
      createdAt: new Date(),
    } as InboxRuleRow;
    this.rows.push(row);
    return Promise.resolve(row);
  }

  findById(_r: unknown, _c: unknown, id: string): Promise<InboxRuleRow | null> {
    return Promise.resolve(this.rows.find((row) => row.id === id) ?? null);
  }

  deleteForMembership(_r: unknown, _c: unknown, membershipId: string, id: string): Promise<number> {
    this.deleteCalls.push({ membershipId, id });
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (this.rows[i]!.id === id && this.rows[i]!.membershipId === membershipId)
        this.rows.splice(i, 1);
    }
    return Promise.resolve(before - this.rows.length);
  }
}

class FakeNotifications {
  constructor(private readonly rows: NotificationRow[]) {}
  listForRecipient(): Promise<readonly NotificationRow[]> {
    return Promise.resolve(this.rows);
  }
}

function controllerWith(
  rules: FakeRules,
  notifications: NotificationRow[] = [],
): InboxRulesController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const service = new InboxRulesService(
    database,
    rules as unknown as never,
    new FakeNotifications(notifications) as unknown as NotificationsRepository,
  );
  return new InboxRulesController(service);
}

function notification(id: string, type: string, objectType: string): NotificationRow {
  return { id, type, objectType } as unknown as NotificationRow;
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('InboxRulesController (x301)', () => {
  it('creates a valid rule against the caller’s own membership', async () => {
    const rules = new FakeRules();
    const view = await controllerWith(rules).create(context, member(), {
      matchType: 'object_type',
      matchValue: 'work_item',
      category: 'urgent',
      position: 0,
    });
    expect(view.category).toBe('urgent');
    expect(rules.insertCalls).toBe(1);
    expect(rules.rows[0]!.membershipId).toBe(ME);
  });

  it('400s a matchType off the allowlist and writes nothing (refusal)', async () => {
    const rules = new FakeRules();
    await expectStatus(
      controllerWith(rules).create(context, member(), {
        matchType: 'sender',
        matchValue: 'x',
        category: 'urgent',
      } as unknown as NewInboxRule),
      400,
    );
    expect(rules.insertCalls).toBe(0);
  });

  it('400s a category off the allowlist and writes nothing', async () => {
    const rules = new FakeRules();
    await expectStatus(
      controllerWith(rules).create(context, member(), {
        matchType: 'type',
        matchValue: 'x',
        category: 'spam',
      } as unknown as NewInboxRule),
      400,
    );
    expect(rules.insertCalls).toBe(0);
  });

  it('lists only the caller’s rules, position-ordered', async () => {
    const rules = new FakeRules();
    await controllerWith(rules).create(context, member(), {
      matchType: 'type',
      matchValue: 'a',
      category: 'fyi',
      position: 2,
    });
    await controllerWith(rules).create(context, member(), {
      matchType: 'type',
      matchValue: 'b',
      category: 'urgent',
      position: 1,
    });
    // Another member's rule must never surface.
    rules.rows.push({
      id: 'other-rule',
      organizationId: ORG,
      membershipId: OTHER,
      matchType: 'type',
      matchValue: 'c',
      category: 'archive',
      position: 0,
      createdAt: new Date(),
    } as InboxRuleRow);

    const { rules: listed } = await controllerWith(rules).list(context, member());
    expect(listed.map((r) => r.matchValue)).toEqual(['b', 'a']);
  });

  it('resolves candidates against the caller’s rules, first match wins; another member’s rules never apply', async () => {
    const rules = new FakeRules();
    await controllerWith(rules).create(context, member(), {
      matchType: 'object_type',
      matchValue: 'work_item',
      category: 'urgent',
      position: 0,
    });
    // Another member has a rule that would match — it must not be applied to this caller.
    rules.rows.push({
      id: 'other-rule',
      organizationId: ORG,
      membershipId: OTHER,
      matchType: 'object_type',
      matchValue: 'client_request',
      category: 'archive',
      position: 0,
      createdAt: new Date(),
    } as InboxRuleRow);

    const controller = controllerWith(rules, [
      notification('n1', 'work.assigned.v1', 'work_item'),
      notification('n2', 'client_request.transitioned.v1', 'client_request'),
    ]);
    const { resolved } = await controller.resolve(context, member());
    expect(resolved).toEqual([
      { notificationId: 'n1', category: 'urgent' },
      { notificationId: 'n2', category: null },
    ]);
  });

  it('deletes the caller’s own rule (204) and is idempotent for a missing rule', async () => {
    const rules = new FakeRules();
    rules.rows.push({
      id: RULE_ID,
      organizationId: ORG,
      membershipId: ME,
      matchType: 'type',
      matchValue: 'a',
      category: 'fyi',
      position: 0,
      createdAt: new Date(),
    } as InboxRuleRow);

    await expect(controllerWith(rules).remove(context, member(), RULE_ID)).resolves.toBeUndefined();
    expect(rules.rows).toHaveLength(0);
    // Second delete of the now-absent rule is still 204.
    await expect(controllerWith(rules).remove(context, member(), RULE_ID)).resolves.toBeUndefined();
  });

  it('404s a delete of another member’s rule and never removes it', async () => {
    const rules = new FakeRules();
    rules.rows.push({
      id: RULE_ID,
      organizationId: ORG,
      membershipId: OTHER,
      matchType: 'type',
      matchValue: 'a',
      category: 'fyi',
      position: 0,
      createdAt: new Date(),
    } as InboxRuleRow);

    await expectStatus(controllerWith(rules).remove(context, member(), RULE_ID), 404);
    expect(rules.rows).toHaveLength(1);
    expect(rules.deleteCalls.every((c) => c.membershipId === ME)).toBe(true);
  });

  it('400s a delete with a non-uuid id', async () => {
    const rules = new FakeRules();
    await expectStatus(controllerWith(rules).remove(context, member(), 'not-a-uuid'), 400);
  });

  it('guards every route with work.read', () => {
    for (const method of ['list', 'resolve', 'create', 'remove'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        InboxRulesController.prototype[method],
      );
      expect(capability).toBe('work.read');
    }
  });
});
