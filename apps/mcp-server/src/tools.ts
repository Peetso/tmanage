import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiError } from './api-client.js';
import type { TManageApiClient } from './api-client.js';

/**
 * The seven capabilities Peter asked for, as MCP tools, plus `list_organizations` so an
 * assistant can discover which workspace a token reaches. Every tool is a thin call into
 * {@link TManageApiClient}: the API enforces the member's permissions, so a tool can only ever
 * do what its token's member may do.
 *
 * Output is a short human line plus the JSON payload, and the same object as
 * `structuredContent`, so a model gets a readable summary and a machine-readable result from
 * one response.
 */

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(summary: string, data: unknown): ToolResult {
  const payload = data as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: payload && typeof payload === 'object' ? payload : { value: data },
  };
}

/** Turn any failure into a readable, non-throwing tool error — the MCP contract for failures. */
function fail(error: unknown): ToolResult {
  const message =
    error instanceof ApiError
      ? `TManage API error ${error.status}${error.code ? ` (${error.code})` : ''}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * There is deliberately no per-call organization argument. A personal access token is bound to
 * exactly one organization (TManage 0202), so the working org is the token's own — resolved once
 * from `list_organizations`, which the API now scopes to that single org. Letting a caller name an
 * organization would only invite 404s (the API refuses the token against any other org) and give
 * the misleading impression a token reaches more than it does. `TMANAGE_ORG_SLUG` can still pin
 * the slug for the operator who runs the server.
 */
export function registerTools(server: McpServer, client: TManageApiClient): void {
  server.registerTool(
    'list_organizations',
    {
      title: 'List my organizations',
      description:
        'List the TManage organizations (workspaces) this token can act in, with the slug to ' +
        'pass to other tools and your role in each.',
      inputSchema: {},
    },
    async () => {
      try {
        const organizations = await client.listOrganizations();
        return ok(`${organizations.length} organization(s).`, { organizations });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'search_workspace',
    {
      title: 'Search the workspace',
      description:
        'Full-text search across work items, documents and meetings in a TManage organization.',
      inputSchema: {
        query: z.string().min(1).max(300).describe('The search text.'),
        project_id: z.string().optional().describe('Restrict to one project.'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20).'),
      },
    },
    async (args) => {
      try {
        const orgSlug = await client.resolveOrgSlug();
        const results = await client.search(orgSlug, args.query, {
          ...(args.project_id !== undefined ? { projectId: args.project_id } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        return ok(`${results.length} result(s) in "${orgSlug}".`, { orgSlug, results });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'list_my_work',
    {
      title: 'List my work for today',
      description:
        'Work items that need the token’s member today — overdue, due soon, or assigned.',
      inputSchema: {},
    },
    async () => {
      try {
        const orgSlug = await client.resolveOrgSlug();
        const items = await client.listMyWork(orgSlug);
        return ok(`${items.length} item(s) for today in "${orgSlug}".`, { orgSlug, items });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'list_inbox',
    {
      title: 'List my inbox',
      description: 'The member’s inbox bundles — what has changed and needs attention.',
      inputSchema: {
        mode: z.string().optional().describe('Inbox mode filter.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max bundles.'),
      },
    },
    async (args) => {
      try {
        const orgSlug = await client.resolveOrgSlug();
        const items = await client.listInbox(orgSlug, {
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        return ok(`${items.length} inbox item(s) in "${orgSlug}".`, { orgSlug, items });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_work_item',
    {
      title: 'Get a work item',
      description: 'Fetch one work item by id.',
      inputSchema: {
        work_item_id: z.string().min(1).describe('The work item id.'),
      },
    },
    async (args) => {
      try {
        const orgSlug = await client.resolveOrgSlug();
        const workItem = await client.getWorkItem(orgSlug, args.work_item_id);
        return ok(`Work item "${workItem.title}" (${workItem.state}).`, { orgSlug, workItem });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_project',
    {
      title: 'Get a project',
      description: 'Fetch one project by id, including its status.',
      inputSchema: {
        project_id: z.string().min(1).describe('The project id.'),
      },
    },
    async (args) => {
      try {
        const orgSlug = await client.resolveOrgSlug();
        const project = await client.getProject(orgSlug, args.project_id);
        return ok(`Project "${project.name}" (${project.status}).`, { orgSlug, project });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'get_document',
    {
      title: 'Get a document',
      description: 'Fetch one document by id, including its body.',
      inputSchema: {
        document_id: z.string().min(1).describe('The document id.'),
      },
    },
    async (args) => {
      try {
        const orgSlug = await client.resolveOrgSlug();
        const document = await client.getDocument(orgSlug, args.document_id);
        return ok(`Document "${document.title}".`, { orgSlug, document });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'List the projects in a TManage organization with their status.',
      inputSchema: {},
    },
    async () => {
      try {
        const orgSlug = await client.resolveOrgSlug();
        const projects = await client.listProjects(orgSlug);
        return ok(`${projects.length} project(s) in "${orgSlug}".`, { orgSlug, projects });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'create_work_item',
    {
      title: 'Create a work item',
      description: 'Create a work item in a project. It starts at the lifecycle’s initial state.',
      inputSchema: {
        project_id: z.string().min(1).describe('The project the item belongs to.'),
        title: z.string().min(1).max(300).describe('The work item title.'),
        type: z.string().max(32).optional().describe('The work item type.'),
        owner_user_id: z.string().optional().describe('Assign to this user.'),
        audience: z
          .enum(['internal', 'client_visible', 'client_action_required'])
          .optional()
          .describe('Who can see the item.'),
        start_at: z.string().nullish().describe('ISO-8601 start instant, or null.'),
        due_at: z.string().nullish().describe('ISO-8601 due instant, or null.'),
      },
    },
    async (args) => {
      try {
        const orgSlug = await client.resolveOrgSlug();
        const workItem = await client.createWorkItem(orgSlug, {
          projectId: args.project_id,
          title: args.title,
          ...(args.type !== undefined ? { type: args.type } : {}),
          ...(args.owner_user_id !== undefined ? { ownerUserId: args.owner_user_id } : {}),
          ...(args.audience !== undefined ? { audience: args.audience } : {}),
          ...(args.start_at !== undefined ? { startAt: args.start_at } : {}),
          ...(args.due_at !== undefined ? { dueAt: args.due_at } : {}),
        });
        return ok(`Created work item "${workItem.title}" (${workItem.id}).`, { orgSlug, workItem });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'add_comment',
    {
      title: 'Add a comment',
      description: 'Add a comment to a work item.',
      inputSchema: {
        work_item_id: z.string().min(1).describe('The work item to comment on.'),
        body: z.string().min(1).max(5000).describe('The comment text.'),
      },
    },
    async (args) => {
      try {
        const orgSlug = await client.resolveOrgSlug();
        const comment = await client.addComment(orgSlug, args.work_item_id, args.body);
        return ok(`Added comment ${comment.id}.`, { orgSlug, comment });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
