import { describe, expect, it, vi } from 'vitest';
import { isSafeAuditMetadata } from '@tmanage/domain';
import type { CatalogRuntime, CatalogTool } from '@tmanage/mcp-server';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { findOpById } from '../ai-actions/registry/index.js';
import {
  callSubject,
  kindOfSegment,
  subjectNameReadOp,
  subjectOf,
} from '../ai-actions/registry/subject.js';
import { AiActivityRepository } from '../audit/ai-activity.repository.js';
import type { AiToolCallRow } from '../audit/ai-activity.service.js';
import { tmanageAiStatusOf } from '../copilot/copilot-chat.service.js';
import type { ChatStanding } from '../copilot/copilot-chat.service.js';
import { auditedRuntime, mcpToolCallMetadata } from '../mcp/mcp-call-audit.js';
import type { McpToolCallAudit } from '../mcp/mcp-call-audit.js';
import { knownAiAppOf, openUrlOf } from '../oauth/known-clients.js';
import {
  AI_ACTIVITY_PAGE_SIZE,
  encodeActivityCursor,
  kindOf,
  nameReadFor,
  parseActivityCursor,
  verbOf,
} from './ai-activity.js';
import { AiActivityService } from './ai-activity.service.js';
import type { SubjectNamer } from './ai-activity.service.js';
import { AiPanelService } from './ai-panel.service.js';

/**
 * AI panel with two tabs (Fable 5.2 rulings 2026-11-23), the API side: the subject identifiers on
 * the MCP audit row, the member's own activity named under the member's own access, the panel's
 * one answer, and the app table chosen by verified client id. The step-up refusal of the approve
 * route is proved in `../mcp/pending-actions-step-up.test.ts`.
 */

const context = {
  organizationId: 'org-1',
  userId: 'user-1',
  membershipId: 'mem-1',
  correlationId: 'corr-1',
} as unknown as TenantContext;

const op = (id: string) => {
  const found = findOpById(id);
  if (found === undefined) throw new Error(`no op ${id}`);
  return found;
};

describe('every op declares its subject (registry/subject.ts)', () => {
  it('an item route is about its last parameter, kind from the segment before it', () => {
    expect(subjectOf(op('work_items.delete'))).toEqual({
      kind: 'work_item',
      param: 'workItemId',
      collection: false,
    });
    expect(subjectOf(op('projects.get'))?.kind).toBe('project');
    expect(subjectOf(op('billing.cost_centers.delete'))?.kind).toBe('cost_center');
  });

  it('a collection GET is a bulk read; a collection POST creates one item', () => {
    expect(subjectOf(op('projects.list'))).toEqual({
      kind: 'project',
      param: null,
      collection: true,
    });
    expect(subjectOf(op('projects.create'))?.collection).toBe(true);
  });

  it('names a subject by the item read of its own path, never by the action itself', () => {
    expect(subjectNameReadOp(op('work_items.delete'))?.id).toBe('work_items.get');
    expect(subjectNameReadOp(op('projects.create'))?.id).toBe('projects.get');
    expect(subjectNameReadOp(op('projects.list'))).toBeUndefined();
  });

  it('records identifiers and a count only: the id from args, a create from its answer', () => {
    expect(
      callSubject(op('work_items.delete'), { workItemId: 'wi-1', projectId: 'p-1' }, null),
    ).toEqual({ kind: 'work_item', id: 'wi-1', count: null, projectId: 'p-1' });
    expect(
      callSubject(op('projects.create'), { name: 'Website relaunch' }, { id: 'p-9', name: 'x' }),
    ).toEqual({ kind: 'project', id: 'p-9', count: null, projectId: 'p-9' });
    expect(callSubject(op('projects.list'), {}, { items: [{}, {}, {}, {}] })).toEqual({
      kind: 'project',
      id: null,
      count: 4,
      projectId: null,
    });
  });

  it('words plural segments as one kind', () => {
    expect(kindOfSegment('work-items')).toBe('work_item');
    expect(kindOfSegment('people')).toBe('person');
    expect(kindOfSegment('activities')).toBe('activity');
  });

  it('declares a subject for nearly every op (a route-wide rule, not a hand table)', async () => {
    const { OPS } = await import('../ai-actions/registry/index.js');
    const missing = OPS.filter((candidate) => subjectOf(candidate) === null);
    expect(missing.length / OPS.length).toBeLessThan(0.02);
  });
});

describe('the MCP audit row gains the subject, identifiers only', () => {
  const scope = {
    userId: 'user-1',
    organizationId: 'org-1',
    membershipId: 'mem-1',
    clientId: '0193a7a0-0000-7000-8000-000000000001',
    correlationId: 'corr-1',
  };
  const call = (subject: McpToolCallAudit['subject']): McpToolCallAudit => ({
    tool: 'work_items_get',
    opId: 'work_items.get',
    outcome: 'ok',
    argsSha256: 'a'.repeat(64),
    latencyMs: 4,
    subject,
  });

  it('writes target kind, id and project; passes the safe-metadata gate', () => {
    const metadata = mcpToolCallMetadata(
      scope,
      call({ kind: 'work_item', id: 'wi-1', count: null, projectId: 'p-1' }),
    );
    expect(metadata).toMatchObject({
      target_kind: 'work_item',
      target_id: 'wi-1',
      target_count: null,
      project_id: 'p-1',
    });
    expect(isSafeAuditMetadata(metadata)).toBe(true);
  });

  it('a value outside the identifier shape is hashed, never stored as written', () => {
    const metadata = mcpToolCallMetadata(
      scope,
      call({ kind: 'work_item', id: 'Homepage hero copy', count: null, projectId: null }),
    );
    expect(String(metadata['target_id'])).toMatch(/^sha256:[0-9a-f]{32}$/);
  });

  it('a call with no subject writes no subject keys (rows read like the old ones)', () => {
    const metadata = mcpToolCallMetadata(scope, call(null));
    expect(Object.keys(metadata)).not.toContain('target_kind');
  });

  it('tmanage_run_action takes the subject from the inner args; a bulk read its count', async () => {
    const runtime: CatalogRuntime = {
      runTool: vi.fn(async () => ({ data: { items: [{ id: 'x' }, { id: 'y' }] } })),
      readResource: vi.fn(),
    } as unknown as CatalogRuntime;
    const seen: McpToolCallAudit[] = [];
    const audited = auditedRuntime(runtime, (record) => seen.push(record));
    const runAction = { name: 'tmanage_run_action' } as CatalogTool;
    await audited.runTool(runAction, {
      action_id: 'work_items.get',
      args: { workItemId: 'wi-7' },
    });
    await audited.runTool({ name: 'projects_list', opId: 'projects.list' } as CatalogTool, {});
    expect(seen[0]?.subject).toEqual({
      kind: 'work_item',
      id: 'wi-7',
      count: null,
      projectId: null,
    });
    expect(seen[1]?.subject).toMatchObject({ kind: 'project', count: 2 });
  });
});

describe('the activity read names only the caller (audit/ai-activity.repository.ts)', () => {
  it("binds the caller's organization, user and membership, and only mcp.tool_called", async () => {
    const statements: { sql: string; params: unknown[] }[] = [];
    const runner = {
      query: async (sql: string, params: unknown[]) => {
        statements.push({ sql, params });
        return [];
      },
    } as unknown as TenantQueryRunner;
    await new AiActivityRepository().listOwn(runner, context, null, 21);
    const [statement] = statements;
    expect(statement?.sql).toMatch(/`organization_id` = \?/);
    expect(statement?.sql).toMatch(/`actor_user_id` = \?/);
    expect(statement?.params).toEqual(
      expect.arrayContaining([
        'org-1',
        'user-1',
        '$.membership_id',
        'mem-1',
        'mcp.tool_called',
        'tmanage-ai',
      ]),
    );
  });
});

function row(overrides: Partial<AiToolCallRow> = {}): AiToolCallRow {
  return {
    id: 'ev-1',
    createdAt: new Date('2026-11-23T10:00:00.000Z'),
    clientId: 'client-claude',
    opId: 'work_items.get',
    tool: 'tmanage_run_action',
    outcome: 'ok',
    targetKind: 'work_item',
    targetId: 'wi-1',
    targetCount: null,
    projectId: 'p-1',
    ...overrides,
  };
}

function activityWith(rows: AiToolCallRow[], namer: SubjectNamer) {
  const listOwn = vi.fn(async () => rows);
  const service = new AiActivityService({
    reader: { listOwn },
    clients: async () => new Map([['client-claude', { clientName: 'Claude', app: 'claude' }]]),
    namer,
  });
  return { service, listOwn };
}

describe('GET …/ai/activity', () => {
  it('names an item and its project only through the read run as the member', async () => {
    const namer = vi.fn<SubjectNamer>(async (_c, _o, read) =>
      read.op.id === 'projects.get' ? 'Website relaunch' : 'Homepage hero copy',
    );
    const { service } = activityWith([row()], namer);
    const { items } = await service.page(context, 'northstar', null);
    expect(items[0]).toMatchObject({
      verb: 'read',
      clientName: 'Claude',
      app: 'claude',
      kind: 'work_item',
      itemId: 'wi-1',
      itemName: 'Homepage hero copy',
      projectId: 'p-1',
      projectName: 'Website relaunch',
    });
    expect(namer).toHaveBeenCalledWith(
      context,
      'northstar',
      expect.objectContaining({ args: { workItemId: 'wi-1' } }),
    );
  });

  it('never returns a name or id the member cannot open now', async () => {
    const { service } = activityWith([row()], async () => null);
    const { items } = await service.page(context, 'northstar', null);
    expect(items[0]).toMatchObject({
      kind: 'work_item',
      itemId: null,
      itemName: null,
      projectId: null,
      projectName: null,
    });
  });

  it('an old row (no subject keys) falls back to its kind and asks for no name', async () => {
    const namer = vi.fn<SubjectNamer>(async () => 'never');
    const old = row({ targetKind: null, targetId: null, projectId: null });
    const { service } = activityWith([old], namer);
    const { items } = await service.page(context, 'northstar', null);
    expect(items[0]).toMatchObject({ verb: 'read', kind: 'work_item', itemName: null });
    expect(namer).not.toHaveBeenCalled();
  });

  it('pages by 20 with a cursor, newest first, and reads one name once per page', async () => {
    const rows = Array.from({ length: AI_ACTIVITY_PAGE_SIZE + 1 }, (_, index) =>
      row({ id: `ev-${index}`, createdAt: new Date(Date.UTC(2026, 10, 23, 10, 0, 60 - index)) }),
    );
    const namer = vi.fn<SubjectNamer>(async () => 'Homepage hero copy');
    const { service, listOwn } = activityWith(rows, namer);
    const page = await service.page(context, 'northstar', null);
    expect(listOwn).toHaveBeenCalledWith(context, null, AI_ACTIVITY_PAGE_SIZE + 1);
    expect(page.items).toHaveLength(AI_ACTIVITY_PAGE_SIZE);
    expect(page.nextCursor).not.toBeNull();
    expect(parseActivityCursor(page.nextCursor)).toEqual({
      createdAt: rows[AI_ACTIVITY_PAGE_SIZE - 1]?.createdAt,
      id: `ev-${AI_ACTIVITY_PAGE_SIZE - 1}`,
    });
    expect(namer).toHaveBeenCalledTimes(2);
  });

  it('refuses a cursor it did not issue', () => {
    expect(() => parseActivityCursor('not-a-cursor')).toThrow(/page link/);
    const cursor = { createdAt: new Date('2026-11-23T10:00:00.000Z'), id: 'ev-3' };
    expect(parseActivityCursor(encodeActivityCursor(cursor))).toEqual(cursor);
  });

  it('words calls from the registry: read, changed, waiting', () => {
    expect(verbOf('work_items.get')).toBe('read');
    expect(verbOf('work_items.delete')).toBe('waiting');
    expect(verbOf(null)).toBe('read');
    expect(verbOf('no.such.op')).toBe('changed');
    expect(kindOf(null, 'projects.get')).toBe('project');
  });

  it('cannot build a name read that needs an identifier it did not store', () => {
    expect(nameReadFor('people.time_off.delete', 'entry-1', null)).toBeNull();
  });
});

const standing = (overrides: Partial<ChatStanding> = {}): ChatStanding => ({
  onTestList: true,
  copilotFlag: true,
  writeScope: 'read',
  runAtOnce: false,
  poolClass: 'customers',
  aiEnabled: true,
  fileReading: true,
  memberBlocked: false,
  ...overrides,
});

describe('GET …/ai/panel', () => {
  it("TManage AI's reason follows the chat's own gate order", () => {
    expect(tmanageAiStatusOf(standing({ onTestList: false }), true).reason).toBe(
      'not_on_test_list',
    );
    expect(tmanageAiStatusOf(standing({ aiEnabled: false }), false)).toEqual({
      inPlan: true,
      enabled: false,
      available: false,
      reason: 'ai_off',
    });
    expect(tmanageAiStatusOf(standing(), false).reason).toBe('no_key');
    expect(tmanageAiStatusOf(standing({ memberBlocked: true }), true).reason).toBe(
      'member_blocked',
    );
    expect(tmanageAiStatusOf(standing(), true)).toMatchObject({ available: true, reason: null });
  });

  function panel(platformOn: boolean, organizationOn: boolean) {
    return new AiPanelService({
      tmanageAi: async () => tmanageAiStatusOf(standing({ aiEnabled: false }), true),
      switches: { platformOn: async () => platformOn, organizationOn: async () => organizationOn },
      apps: async () => [],
      pendingCount: async () => 2,
    });
  }

  it('keeps the two management rights apart (AI settings owner vs AI-apps owner)', async () => {
    const view = await panel(true, true).view(context, {
      mayManageTmanageAi: false,
      mayManageOwnAi: true,
    });
    expect(view.tmanageAi).toMatchObject({ enabled: false, reason: 'ai_off', canManage: false });
    expect(view.ownAi).toEqual({ enabled: true, reason: null, canManage: true });
    expect(view.pendingApprovals).toBe(2);
  });

  it("says why the member's own AI is off: the platform first, then the workspace", async () => {
    const caller = { mayManageTmanageAi: true, mayManageOwnAi: true };
    expect((await panel(false, false).view(context, caller)).ownAi.reason).toBe('platform_off');
    expect((await panel(true, false).view(context, caller)).ownAi.reason).toBe('workspace_off');
  });
});

describe('the app mark and "Open" are chosen by verified client id only', () => {
  const cimd = (clientId: string, verified = true) => ({ kind: 'cimd', clientId, verified });

  it('recognises the verified first-party clients', () => {
    expect(knownAiAppOf(cimd('https://claude.ai/oauth/mcp-oauth-client-metadata'))).toBe('claude');
    expect(knownAiAppOf(cimd('https://chatgpt.com/connector/metadata.json'))).toBe('chatgpt');
    expect(openUrlOf('claude')).toBe('https://claude.ai/');
    expect(openUrlOf('chatgpt')).toBe('https://chatgpt.com/');
  });

  it('Cursor is recognised but has no web link', () => {
    expect(knownAiAppOf(cimd('https://cursor.com/mcp/client.json'))).toBe('cursor');
    expect(openUrlOf('cursor')).toBeNull();
  });

  it('an app that only calls itself "Claude" gets no mark and no link', () => {
    expect(knownAiAppOf({ kind: 'dcr', clientId: 'Claude', verified: false })).toBeNull();
    expect(knownAiAppOf(cimd('https://claude.ai.evil.example/meta.json', true))).toBeNull();
    expect(knownAiAppOf(cimd('https://claude.ai/oauth/meta.json', false))).toBeNull();
    expect(openUrlOf(null)).toBeNull();
  });
});
