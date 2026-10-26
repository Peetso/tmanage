import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { getMeeting } from '../src/lib/api/meetings';

/**
 * The meeting page finds its meeting through the per-project lists (`getMeeting`). The projects
 * list is paged — 50 by default, 200 at most, oldest first — so a lookup that read one page of
 * projects never found a meeting in the tenant's 51st or later project, and the meeting page said
 * "Meeting not found" for a meeting the calendar had just linked to.
 */

const NOW = '2026-10-26T09:00:00.000Z';
const projects = Array.from({ length: 60 }, (_, index) => ({
  id: `project-${String(index + 1).padStart(3, '0')}`,
  workspaceId: 'ws-1',
  name: `Project ${index + 1}`,
  status: 'active',
  ownerUserId: null,
  committedAt: null,
  forecastAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
}));
const LATE_PROJECT = 'project-055';
const meeting = {
  id: 'meeting-late',
  projectId: LATE_PROJECT,
  title: 'Launch review',
  startsAt: NOW,
  endsAt: null,
  agendaNote: null,
  createdByUserId: 'user-1',
  createdAt: NOW,
  updatedAt: NOW,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fake API that pages the way the real one does: `limit` (default 50, max 200) and `after`. */
function pagedApi(): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
      const after = url.searchParams.get('after');
      if (url.pathname.endsWith('/projects')) {
        const rest = after ? projects.filter((p) => p.id > after) : projects;
        return Promise.resolve(json({ projects: rest.slice(0, limit) }));
      }
      if (url.pathname.endsWith('/meetings')) {
        const projectId = url.searchParams.get('projectId');
        return Promise.resolve(json({ meetings: projectId === LATE_PROJECT ? [meeting] : [] }));
      }
      return Promise.resolve(json({}));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

describe('getMeeting', () => {
  it('finds a meeting in a project past the first page of projects', async () => {
    await expect(getMeeting(pagedApi(), 'acme', 'meeting-late')).resolves.toEqual(meeting);
  });

  it('resolves null for a meeting no readable project holds', async () => {
    await expect(getMeeting(pagedApi(), 'acme', 'meeting-missing')).resolves.toBeNull();
  });
});
