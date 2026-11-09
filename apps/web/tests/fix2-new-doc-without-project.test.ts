import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../src/lib/api/client';
import { ApiRequestError } from '../src/lib/api/errors';
import { runPaletteAction } from '../src/components/shell/palette-actions';

/**
 * FIX2 item 1 (Peter, live 2026-11-09): "+ New → New doc" answered "That did not work. Try again."
 * Root cause: his workspace had no project yet (the live MCP `projects_list` answered `[]`), and
 * "New doc" took the first project or failed. A document lives in a project, so the action now
 * makes a "General" project in the first workspace and files the doc there; a member who may not
 * create projects gets `no-project` (a message that says why), never the generic failure.
 */

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

function fakeApi(options: { projects: unknown[]; refuseProjectCreate?: boolean }): {
  api: ApiClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const api = {
    request: async (input: { method?: string; path: string; body?: unknown }) => {
      const call = { method: input.method ?? 'GET', path: input.path, body: input.body };
      calls.push(call);
      if (call.method === 'GET' && call.path.endsWith('/projects'))
        return { data: { projects: options.projects } };
      if (call.method === 'GET' && call.path.endsWith('/workspaces'))
        return { data: { workspaces: [{ id: 'ws-1', name: 'Studio', createdAt: '' }] } };
      if (call.method === 'POST' && call.path.endsWith('/projects')) {
        if (options.refuseProjectCreate)
          throw new ApiRequestError(403, 'forbidden', 'needs project.create', 'c1');
        return { data: { id: 'p-new', name: 'General', archivedAt: null } };
      }
      if (call.method === 'POST' && call.path.endsWith('/documents'))
        return { data: { id: 'doc-1' } };
      throw new Error(`unexpected ${call.method} ${call.path}`);
    },
  } as unknown as ApiClient;
  return { api, calls };
}

function context(api: ApiClient, navigated: string[]) {
  return {
    api,
    organizationSlug: 'studio',
    queryClient: undefined,
    navigate: (path: string) => navigated.push(path),
    locale: 'en-US',
    untitledDoc: 'Untitled doc',
    firstProjectName: 'General',
  };
}

describe('FIX2: New doc in a workspace with no project yet', () => {
  it('makes a "General" project, files the doc there and opens the editor', async () => {
    const { api, calls } = fakeApi({ projects: [] });
    const navigated: string[] = [];
    const outcome = await runPaletteAction('create-doc', context(api, navigated));
    expect(outcome).toBe('done');
    const projectPost = calls.find((c) => c.method === 'POST' && c.path.endsWith('/projects'));
    expect(projectPost?.body).toEqual({ workspaceId: 'ws-1', name: 'General' });
    const docPost = calls.find((c) => c.method === 'POST' && c.path.endsWith('/documents'));
    expect((docPost?.body as { projectId: string }).projectId).toBe('p-new');
    expect(navigated).toEqual(['/studio/docs/doc-1/edit']);
  });

  it('skips archived projects and uses the first active one, creating nothing', async () => {
    const { api, calls } = fakeApi({
      projects: [
        { id: 'p-old', archivedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'p-live', archivedAt: null },
      ],
    });
    const outcome = await runPaletteAction('create-doc', context(api, []));
    expect(outcome).toBe('done');
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/projects'))).toBe(false);
    const docPost = calls.find((c) => c.method === 'POST' && c.path.endsWith('/documents'));
    expect((docPost?.body as { projectId: string }).projectId).toBe('p-live');
  });

  it('a member who may not create projects is told why (no-project), not "try again"', async () => {
    const { api } = fakeApi({ projects: [], refuseProjectCreate: true });
    expect(await runPaletteAction('create-doc', context(api, []))).toBe('no-project');
  });
});
