import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.js';
import { ApiError } from './api-client.js';
import type { TManageApiClient } from './api-client.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

/** A fake McpServer that just records each tool's handler so the tests can call it. */
function collectTools(client: TManageApiClient): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fake = {
    registerTool(name: string, _def: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerTools(fake, client);
  return handlers;
}

function stubClient(overrides: Partial<TManageApiClient> = {}): TManageApiClient {
  const base: TManageApiClient = {
    listOrganizations: async () => [
      {
        id: 'o1',
        slug: 'acme',
        name: 'Acme',
        audience: 'internal',
        role: 'manager',
        clientOrganizationName: null,
      },
    ],
    resolveOrgSlug: async (explicit) => explicit ?? 'acme',
    search: async () => [
      { kind: 'work_item', id: 'w1', title: 'Fix', projectId: 'p1', snippet: null },
    ],
    listMyWork: async () => [],
    listInbox: async () => [],
    getWorkItem: async (_o, id) => ({
      id,
      projectId: 'p1',
      type: 'task',
      title: 'Fix',
      state: 'open',
      ownerUserId: null,
      audience: 'internal',
      startAt: null,
      dueAt: null,
      completedAt: null,
      version: 1,
      createdAt: 'now',
      updatedAt: 'now',
      deletedAt: null,
    }),
    getProject: async (_o, id) => ({
      id,
      workspaceId: 'ws1',
      name: 'Launch',
      status: 'on_track',
      ownerUserId: null,
      committedAt: null,
      forecastAt: null,
      createdAt: 'now',
      updatedAt: 'now',
    }),
    getDocument: async (_o, id) => ({
      id,
      projectId: 'p1',
      title: 'Brief',
      body: 'text',
      createdByUserId: 'u1',
      createdAt: 'now',
      updatedAt: 'now',
    }),
    listProjects: async () => [],
    createWorkItem: async (_o, input) => ({
      id: 'w9',
      projectId: input.projectId,
      type: input.type ?? 'task',
      title: input.title,
      state: 'open',
      ownerUserId: null,
      audience: 'internal',
      startAt: null,
      dueAt: null,
      completedAt: null,
      version: 1,
      createdAt: 'now',
      updatedAt: 'now',
      deletedAt: null,
    }),
    addComment: async (_o, workItemId, body) => ({
      id: 'c1',
      workItemId,
      authorMembershipId: 'm1',
      body,
      createdAt: 'now',
    }),
    submitMeetingNoteDraft: async (_o, meetingId, input) => ({
      id: 'd1',
      meetingId,
      kind: input.kind ?? 'note',
      body: input.body,
      authorUserId: 'u1',
      source: 'mcp',
      assistantName: input.assistantName ?? 'AI assistant',
      submittedAt: 'now',
    }),
  };
  return { ...base, ...overrides };
}

describe('TManage MCP tools', () => {
  it('registers the nine expected tools', () => {
    const names = [...collectTools(stubClient()).keys()].sort();
    expect(names).toEqual(
      [
        'add_comment',
        'create_work_item',
        'draft_meeting_notes',
        'get_document',
        'get_project',
        'get_work_item',
        'list_inbox',
        'list_my_work',
        'list_organizations',
        'list_projects',
        'search_workspace',
      ].sort(),
    );
  });

  it('exposes no org argument — the token’s own organization is always used', () => {
    const defs = new Map<string, { inputSchema?: Record<string, unknown> }>();
    const fake = {
      registerTool(name: string, def: { inputSchema?: Record<string, unknown> }) {
        defs.set(name, def);
      },
    } as unknown as McpServer;
    registerTools(fake, stubClient());
    for (const [, def] of defs) {
      expect(Object.keys(def.inputSchema ?? {})).not.toContain('org');
    }
  });

  it('search returns results and threads the resolved org through', async () => {
    const tools = collectTools(stubClient());
    const result = await tools.get('search_workspace')!({ query: 'fix' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('"orgSlug": "acme"');
    expect(result.content[0]!.text).toContain('"id": "w1"');
  });

  it('create_work_item forwards the body and reports the new id', async () => {
    const tools = collectTools(stubClient());
    const result = await tools.get('create_work_item')!({ project_id: 'p1', title: 'New' });
    expect(result.content[0]!.text).toContain('w9');
    expect(result.content[0]!.text).toContain('"title": "New"');
  });

  it('draft_meeting_notes submits a pending draft with provenance and says it is not saved', async () => {
    let seen: { meetingId: string; input: unknown } | undefined;
    const tools = collectTools(
      stubClient({
        submitMeetingNoteDraft: async (_o, meetingId, input) => {
          seen = { meetingId, input };
          return {
            id: 'd1',
            meetingId,
            kind: 'decision',
            body: input.body,
            authorUserId: 'u1',
            source: 'mcp',
            assistantName: 'Claude',
            submittedAt: 'now',
          };
        },
      }),
    );
    const result = await tools.get('draft_meeting_notes')!({
      meeting_id: 'm1',
      body: 'Launch moves',
      kind: 'decision',
      assistant_name: 'Claude',
    });
    expect(seen).toEqual({
      meetingId: 'm1',
      input: { body: 'Launch moves', kind: 'decision', assistantName: 'Claude' },
    });
    expect(result.content[0]!.text).toContain('not saved until a person saves it');
  });

  it('surfaces an API error as a non-throwing tool error', async () => {
    const tools = collectTools(
      stubClient({
        getProject: async () => {
          throw new ApiError(403, 'forbidden', 'nope');
        },
      }),
    );
    const result = await tools.get('get_project')!({ project_id: 'p1' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('403');
    expect(result.content[0]!.text).toContain('forbidden');
  });
});
