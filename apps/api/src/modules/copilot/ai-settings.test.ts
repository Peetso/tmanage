import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { AI_CHAT_SQL, AiChatRepository } from './ai-chat.repository.js';
import { AiSettingsController } from './ai-settings.controller.js';
import type { AiSettingsRepository, AiOwnerSettings } from './ai-settings.repository.js';
import {
  aiProvidersOf,
  applyAiSettingsPatch,
  blockableMember,
  parseAiSettingsPatch,
} from './ai-settings.rules.js';
import {
  AI_SETTINGS_MEMBER_ALLOWED_AUDIT_ACTION,
  AI_SETTINGS_MEMBER_BLOCKED_AUDIT_ACTION,
  AI_SETTINGS_UPDATED_AUDIT_ACTION,
  AiSettingsService,
  type AiSettingsDeps,
} from './ai-settings.service.js';

/**
 * 62-17 — Settings > AI (owner). The rules, the owner gate, the audit in the same transaction, the
 * test-list absence, cross-workspace member ids and the chat honouring the switch, the block list
 * and "let AI read files". No database: the repository is an in-memory stand-in keyed by the
 * context's organization, as every statement is (DA-12). The SQL itself is exercised by
 * `test/t-62-17-ai-settings.db.test.ts`.
 */

const NOW = new Date('2026-11-22T09:00:00.000Z');
const ORG_A = uuidv7();
const ORG_B = uuidv7();
const OWNER_A = uuidv7();
const MAYA_A = uuidv7();
const CLIENT_A = uuidv7();
const AI_A = uuidv7();
const OMAR_B = uuidv7();

function contextFor(
  organizationId: string,
  overrides: Partial<Parameters<typeof createTenantContext>[0]> = {},
): TenantContext {
  return createTenantContext({
    organizationId,
    userId: uuidv7(),
    membershipId: OWNER_A,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: 'v1',
    correlationId: uuidv7(),
    ...overrides,
  });
}

function principal(role: string, kind: 'internal' | 'client' = 'internal'): Principal {
  return {
    userId: 'u1',
    organizationId: ORG_A,
    kind,
    role,
    membershipId: OWNER_A,
    membershipStatus: 'active',
    clientOrganizationId: kind === 'client' ? 'c1' : null,
    projectIds: [],
    hasOrgWideScope: kind === 'internal',
  } as Principal;
}

const DEFAULTS: AiOwnerSettings = {
  aiEnabled: false,
  writeScope: 'read_write',
  runAtOnce: false,
  fileReading: true,
  memberSharePercent: 50,
  conversationRetentionDays: 30,
};

interface AuditRow {
  readonly organizationId: string;
  readonly action: string;
  readonly objectId: string | null;
  readonly changes?: readonly { field: string; before: unknown; after: unknown }[];
  readonly tx: number;
}

/** In-memory tables; a transaction works on a copy and commits only when the callback returns. */
class World {
  settings = new Map<string, AiOwnerSettings & { onTestList: boolean }>([
    [ORG_A, { ...DEFAULTS, onTestList: true }],
    [ORG_B, { ...DEFAULTS, onTestList: true }],
  ]);
  members = new Map<string, { org: string; role: string; kind: string; name: string }>([
    [OWNER_A, { org: ORG_A, role: 'owner', kind: 'human', name: 'Lina' }],
    [MAYA_A, { org: ORG_A, role: 'member', kind: 'human', name: 'Maya' }],
    [CLIENT_A, { org: ORG_A, role: 'client_admin', kind: 'human', name: 'Client' }],
    [AI_A, { org: ORG_A, role: 'member', kind: 'ai', name: 'Agent' }],
    [OMAR_B, { org: ORG_B, role: 'member', kind: 'human', name: 'Omar' }],
  ]);
  blocks = new Map<string, Date>();
  audit: AuditRow[] = [];
  txCount = 0;

  snapshot() {
    return {
      settings: new Map([...this.settings].map(([k, v]) => [k, { ...v }])),
      blocks: new Map(this.blocks),
      audit: [...this.audit],
    };
  }
  restore(s: ReturnType<World['snapshot']>) {
    this.settings = s.settings;
    this.blocks = s.blocks;
    this.audit = s.audit;
  }

  repository(): AiSettingsRepository {
    const key = (org: string, m: string) => `${org}:${m}`;
    return {
      read: async (_r: unknown, c: TenantContext) => {
        const row = this.settings.get(c.organizationId);
        return row === undefined ? null : { ...row, updatedAt: null };
      },
      write: async (_r: unknown, c: TenantContext, s: AiOwnerSettings) => {
        const row = this.settings.get(c.organizationId)!;
        this.settings.set(c.organizationId, { ...row, ...s });
      },
      blockedMembers: async (_r: unknown, c: TenantContext) =>
        [...this.blocks]
          .filter(([k]) => k.startsWith(`${c.organizationId}:`))
          .map(([k, at]) => {
            const id = k.split(':')[1]!;
            return { membershipId: id, displayName: this.members.get(id)!.name, blockedAt: at };
          }),
      member: async (_r: unknown, c: TenantContext, id: string) => {
        const m = this.members.get(id);
        return m === undefined || m.org !== c.organizationId
          ? null
          : { id, role: m.role, kind: m.kind };
      },
      block: async (_r: unknown, c: TenantContext, id: string, at: Date) => {
        if (this.blocks.has(key(c.organizationId, id))) return false;
        this.blocks.set(key(c.organizationId, id), at);
        return true;
      },
      allow: async (_r: unknown, c: TenantContext, id: string) =>
        this.blocks.delete(key(c.organizationId, id)),
    } as unknown as AiSettingsRepository;
  }

  service(readiness?: AiSettingsDeps['readiness']): AiSettingsService {
    const database = {
      read: (c: TenantContext, work: (r: unknown) => Promise<unknown>) => work({}),
      transaction: async (c: TenantContext, work: (r: unknown) => Promise<unknown>) => {
        const saved = this.snapshot();
        this.txCount += 1;
        try {
          return await work({ tx: this.txCount });
        } catch (error) {
          this.restore(saved);
          throw error;
        }
      },
    } as unknown as Pick<TenantDatabase, 'read' | 'transaction'>;
    return new AiSettingsService({
      database,
      repository: this.repository(),
      audit: {
        record: async (r: unknown, c: TenantContext, input: never) => {
          const i = input as { action: string; objectId: string | null; changes?: never };
          this.audit.push({
            organizationId: c.organizationId,
            action: i.action,
            objectId: i.objectId,
            ...(i.changes === undefined ? {} : { changes: i.changes }),
            tx: (r as { tx?: number }).tx ?? 0,
          });
          return {} as never;
        },
      },
      allowance: {
        resolveWith: async () =>
          ({
            allowanceCredits: 2000,
            period: null,
            packBalanceCredits: 0,
          }) as never,
      },
      people: { countInternalPeople: async () => 4 },
      now: () => NOW,
      ...(readiness === undefined ? {} : { readiness }),
    });
  }
}

async function failure(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return 'ok';
  } catch (error) {
    if (error instanceof ApiError) return `${error.status} ${error.auditCode ?? error.code}`;
    throw error;
  }
}

describe('the PATCH body (62-17)', () => {
  it('takes every setting, each optional, and the two member lists', () => {
    expect(
      parseAiSettingsPatch({
        aiEnabled: true,
        writeScope: 'read',
        runAtOnce: false,
        fileReading: false,
        memberSharePercent: 75,
        conversationRetentionDays: 365,
        blockMembershipIds: [MAYA_A, MAYA_A],
        allowMembershipIds: [],
      }),
    ).toEqual({
      aiEnabled: true,
      writeScope: 'read',
      runAtOnce: false,
      fileReading: false,
      memberSharePercent: 75,
      conversationRetentionDays: 365,
      blockMembershipIds: [MAYA_A],
      allowMembershipIds: [],
    });
  });

  it.each([
    [{}, 'body'],
    [null, 'body'],
    [{ unknown: 1 }, 'unknown'],
    [{ aiEnabled: 'yes' }, 'aiEnabled'],
    [{ writeScope: 'manage' }, 'writeScope'],
    [{ memberSharePercent: 0 }, 'memberSharePercent'],
    [{ memberSharePercent: 50.5 }, 'memberSharePercent'],
    [{ conversationRetentionDays: 0 }, 'conversationRetentionDays'],
    [{ conversationRetentionDays: 366 }, 'conversationRetentionDays'],
    [{ blockMembershipIds: ['not-an-id'] }, 'blockMembershipIds'],
    [{ blockMembershipIds: Array.from({ length: 51 }, () => uuidv7()) }, 'blockMembershipIds'],
    [{ blockMembershipIds: [MAYA_A], allowMembershipIds: [MAYA_A] }, 'allowMembershipIds'],
  ])('refuses %j with a 400 on field %s', (body, field) => {
    let caught: unknown;
    try {
      parseAiSettingsPatch(body as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect(JSON.stringify((caught as ApiError).details)).toContain(field);
  });

  it('answers-only turns quick changes off with it, and refuses quick changes while answers-only', () => {
    const on = { ...DEFAULTS, runAtOnce: true };
    expect(applyAiSettingsPatch(on, { writeScope: 'read' })).toMatchObject({
      writeScope: 'read',
      runAtOnce: false,
    });
    expect(() =>
      applyAiSettingsPatch({ ...DEFAULTS, writeScope: 'read' }, { runAtOnce: true }),
    ).toThrow(ApiError);
    expect(applyAiSettingsPatch(DEFAULTS, { runAtOnce: true }).runAtOnce).toBe(true);
  });

  it('only an internal person other than the owner may be blocked', () => {
    expect(blockableMember({ role: 'member', kind: 'human' })).toBe('ok');
    expect(blockableMember({ role: 'org_admin', kind: 'human' })).toBe('ok');
    expect(blockableMember({ role: 'owner', kind: 'human' })).toBe('owner');
    expect(blockableMember({ role: 'client_admin', kind: 'human' })).toBe('absent');
    expect(blockableMember({ role: 'platform_support', kind: 'human' })).toBe('absent');
    expect(blockableMember({ role: 'member', kind: 'ai' })).toBe('absent');
    expect(blockableMember(null)).toBe('absent');
  });

  it('names Voyage on the provider line only while search by meaning is on', () => {
    expect(aiProvidersOf(false)).toEqual(['anthropic']);
    expect(aiProvidersOf(true)).toEqual(['anthropic', 'voyage']);
  });
});

describe('the owner gate (62-17)', () => {
  const world = new World();
  const controller = new AiSettingsController(world.service());

  it('answers the workspace owner', async () => {
    const view = await controller.read(contextFor(ORG_A), principal('owner'));
    expect(view).toMatchObject({ aiEnabled: false, writeScope: 'read_write', fileReading: true });
  });

  it.each([
    ['org_admin', 'internal'],
    ['workspace_admin', 'internal'],
    ['member', 'internal'],
    ['platform_support', 'internal'],
    ['client_admin', 'client'],
  ] as const)('refuses %s (403 copilot.settings:owner) on GET and PATCH', async (role, kind) => {
    expect(await failure(() => controller.read(contextFor(ORG_A), principal(role, kind)))).toBe(
      '403 copilot.settings:owner',
    );
    expect(
      await failure(() =>
        controller.update(contextFor(ORG_A), principal(role, kind), { aiEnabled: true }),
      ),
    ).toBe('403 copilot.settings:owner');
    expect(world.audit).toEqual([]);
  });

  it('refuses the AI channel (token or agent) and a service even as the owner (403)', async () => {
    for (const context of [
      contextFor(ORG_A, { actorChannel: 'ai_assistant' }),
      contextFor(ORG_A, { principalKind: 'service' }),
    ]) {
      expect(await failure(() => controller.read(context, principal('owner')))).toBe(
        '403 copilot.settings:caller',
      );
    }
  });
});

describe('reading and changing the settings (62-17)', () => {
  it('is absent (404) off the test list, for GET and PATCH, with nothing written', async () => {
    const world = new World();
    world.settings.set(ORG_A, { ...DEFAULTS, onTestList: false });
    const service = world.service();
    expect(await failure(() => service.view(contextFor(ORG_A)))).toBe(
      '404 copilot.settings:not_on_test_list',
    );
    expect(await failure(() => service.update(contextFor(ORG_A), { aiEnabled: true }))).toBe(
      '404 copilot.settings:not_on_test_list',
    );
    world.settings.delete(ORG_A);
    expect(await failure(() => service.view(contextFor(ORG_A)))).toBe(
      '404 copilot.settings:not_on_test_list',
    );
    expect(world.audit).toEqual([]);
  });

  it('tells the owner whether TManage AI can answer once on (AI-TWO-WAYS), after every write too', async () => {
    const world = new World();
    expect((await world.service(async () => 'no_key').view(contextFor(ORG_A))).readiness).toBe(
      'no_key',
    );
    const after = await world
      .service(async () => 'flag_off')
      .update(contextFor(ORG_A), { aiEnabled: true });
    expect([after.aiEnabled, after.readiness]).toEqual([true, 'flag_off']);
  });

  it('shows the credits the share stands for, and each choice', async () => {
    const view = await new World().service().view(contextFor(ORG_A));
    expect(view.credits).toEqual({
      workspaceCredits: 2000,
      memberCredits: 1000,
      shareChoices: [
        { percent: 25, memberCredits: 500 },
        { percent: 50, memberCredits: 1000 },
        { percent: 75, memberCredits: 1500 },
        { percent: 100, memberCredits: 2000 },
      ],
    });
    expect(view.providers).toEqual(['anthropic']);
    expect(view.blockedMembers).toEqual([]);
  });

  it('writes the change and one audit row with each before and after, in the same transaction', async () => {
    const world = new World();
    const view = await world.service().update(contextFor(ORG_A), {
      aiEnabled: true,
      memberSharePercent: 75,
      conversationRetentionDays: 30,
    });
    expect(view).toMatchObject({ aiEnabled: true, memberSharePercent: 75 });
    expect(world.settings.get(ORG_B)).toMatchObject({ aiEnabled: false, memberSharePercent: 50 });
    expect(world.audit).toEqual([
      {
        organizationId: ORG_A,
        action: AI_SETTINGS_UPDATED_AUDIT_ACTION,
        objectId: ORG_A,
        changes: [
          { field: 'aiEnabled', before: false, after: true },
          { field: 'memberSharePercent', before: 50, after: 75 },
        ],
        tx: 1,
      },
    ]);
  });

  it('writes nothing and audits nothing when the patch changes nothing', async () => {
    const world = new World();
    await world.service().update(contextFor(ORG_A), { fileReading: true });
    expect(world.audit).toEqual([]);
  });

  it('blocks and allows again: one audit row per member, twice is one row', async () => {
    const world = new World();
    const service = world.service();
    let view = await service.update(contextFor(ORG_A), { blockMembershipIds: [MAYA_A] });
    expect(view.blockedMembers).toEqual([
      { membershipId: MAYA_A, displayName: 'Maya', blockedAt: NOW.toISOString() },
    ]);
    await service.update(contextFor(ORG_A), { blockMembershipIds: [MAYA_A] });
    view = await service.update(contextFor(ORG_A), { allowMembershipIds: [MAYA_A] });
    expect(view.blockedMembers).toEqual([]);
    expect(world.audit.map((row) => [row.action, row.objectId])).toEqual([
      [AI_SETTINGS_MEMBER_BLOCKED_AUDIT_ACTION, MAYA_A],
      [AI_SETTINGS_MEMBER_ALLOWED_AUDIT_ACTION, MAYA_A],
    ]);
  });

  it("another workspace's member id is 404 on block and on allow, and the whole patch rolls back", async () => {
    const world = new World();
    const service = world.service();
    for (const patch of [
      { aiEnabled: true, blockMembershipIds: [OMAR_B] },
      { aiEnabled: true, allowMembershipIds: [OMAR_B] },
    ]) {
      expect(await failure(() => service.update(contextFor(ORG_A), patch))).toBe(
        '404 copilot.settings:member_not_found',
      );
    }
    expect(world.settings.get(ORG_A)?.aiEnabled).toBe(false);
    expect(world.blocks.size).toBe(0);
    expect(world.audit).toEqual([]);
  });

  it('a client, an AI employee or an unknown id is 404; the owner is a 400', async () => {
    const service = new World().service();
    for (const id of [CLIENT_A, AI_A, uuidv7()]) {
      expect(
        await failure(() => service.update(contextFor(ORG_A), { blockMembershipIds: [id] })),
      ).toBe('404 copilot.settings:member_not_found');
    }
    expect(
      await failure(() => service.update(contextFor(ORG_A), { blockMembershipIds: [OWNER_A] })),
    ).toBe('400 validation_failed');
  });
});

describe('the chat honours the owner settings (62-17)', () => {
  function runnerWith(row: Record<string, unknown> | null, blocked: boolean) {
    return {
      execute: async (sql: string) => {
        if (sql === AI_CHAT_SQL.blocked) return blocked ? [{ blocked: 1 }] : [];
        return row === null ? [] : [row];
      },
    } as never;
  }

  it('reads the switch, file reading and the caller on the block list', async () => {
    const repo = new AiChatRepository();
    const row = {
      test_list_at: NOW,
      pool_class: 'customers',
      write_scope: 'read_write',
      run_at_once: 0,
      ai_enabled: 1,
      file_reading: 0,
    };
    expect(await repo.settings(runnerWith(row, true), contextFor(ORG_A))).toMatchObject({
      aiEnabled: true,
      fileReading: false,
      memberBlocked: true,
    });
    expect(await repo.settings(runnerWith(null, false), contextFor(ORG_A))).toMatchObject({
      aiEnabled: false,
      fileReading: true,
      memberBlocked: false,
    });
  });
});
