import { describe, expect, it, vi } from 'vitest';
import {
  JiraFetchError,
  fetchJiraIssues,
  jiraBaseUrlAllowed,
  JIRA_SEARCH_FIELDS,
  jiraIssueToRow,
  jiraSearchJqlUrl,
  jiraSearchUrl,
} from './jira-rest.js';
import type { JiraFetch } from './jira-rest.js';
import { validateBatch } from './import-validation.js';
import { JIRA_REST_MAPPING } from './jira-rest.js';

const TOKEN = 'ATATT3xFfGF0-secret-token-value';
const BASE = 'https://acme.atlassian.net';

function issue(n: number): Record<string, unknown> {
  return {
    key: `WEB-${n}`,
    fields: {
      summary: `Issue ${n}`,
      issuetype: { name: 'Task' },
      status: { name: 'In Review', statusCategory: { name: 'In Progress' } },
      created: '2026-01-02T10:00:00.000+0000',
      customfield_10020: [{ name: 'Sprint 1' }, { name: 'Sprint 2' }],
      description: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
      },
    },
  };
}

const META = {
  names: { customfield_10020: 'Sprint' },
  schema: { customfield_10020: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
};

function page(startAt: number, count: number, total: number): Response {
  return new Response(
    JSON.stringify({
      startAt,
      total,
      issues: Array.from({ length: count }, (_, i) => issue(startAt + i + 1)),
      ...META,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const input = (fetch: JiraFetch) => ({
  fetch,
  baseUrl: BASE,
  email: 'ana@acme.test',
  token: TOKEN,
  jql: 'project = WEB ORDER BY created ASC',
});

describe('jiraBaseUrlAllowed (R22-e SSRF rule)', () => {
  it('accepts only https://<site>.atlassian.net style origins', () => {
    for (const bad of [
      'http://acme.atlassian.net',
      'https://acme.atlassian.net:8443',
      'https://10.0.0.1',
      'https://evil.com/?x=.atlassian.net',
      'https://user@acme.atlassian.net',
      'https://acme.atlassian.net/jira',
      'https://atlassian.net.evil.com',
    ]) {
      expect(jiraBaseUrlAllowed(bad), bad).toBe(false);
    }
    expect(jiraBaseUrlAllowed('https://acme.atlassian.net')).toBe(true);
    expect(jiraBaseUrlAllowed('https://acme.jira.com/')).toBe(true);
  });

  it('builds the search URL with the JQL encoded and names + schema expanded', () => {
    const url = new URL(jiraSearchUrl(BASE, 'project = WEB', 100));
    expect(url.origin + url.pathname).toBe(`${BASE}/rest/api/3/search`);
    expect(url.searchParams.get('jql')).toBe('project = WEB');
    expect(url.searchParams.get('startAt')).toBe('100');
    expect(url.searchParams.get('expand')).toBe('names,schema');
  });
});

describe('jiraIssueToRow (R22-e)', () => {
  it('maps the sprint custom field by its names entry and keeps the description as ADF JSON', () => {
    const row = jiraIssueToRow(issue(7), { names: META.names });
    expect(row['Issue key']).toBe('WEB-7');
    expect(row['Status Category']).toBe('In Progress');
    expect(row['Sprint']).toEqual(['Sprint 1', 'Sprint 2']);
    expect(JSON.parse(String(row['Description'])).type).toBe('doc');
    const report = validateBatch('jira_issues', JIRA_REST_MAPPING, [row]);
    expect(report.status).toBe('validated');
  });
});

describe('fetchJiraIssues (R22-e)', () => {
  it('reads two pages of 100 into 200 rows with basic auth and no next page', async () => {
    const fetch = vi.fn<JiraFetch>(async (url) => {
      const startAt = Number(new URL(url).searchParams.get('startAt'));
      return page(startAt, 100, 200);
    });
    const result = await fetchJiraIssues({ ...input(fetch), startAt: 0 });
    expect(result.rows).toHaveLength(200);
    expect(result.nextStartAt).toBeNull();
    expect(result.total).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.redirect).toBe('manual');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe(
      `Basic ${Buffer.from(`ana@acme.test:${TOKEN}`).toString('base64')}`,
    );
  });

  it('returns nextStartAt when Jira has more than max', async () => {
    const fetch = vi.fn<JiraFetch>(async (url) =>
      page(Number(new URL(url).searchParams.get('startAt')), 100, 5000),
    );
    const result = await fetchJiraIssues({ ...input(fetch), startAt: 0, max: 150 });
    expect(result.rows).toHaveLength(150);
    expect(result.nextStartAt).toBe(150);
  });

  it('treats a 3xx as an error and never follows it', async () => {
    const fetch = vi.fn<JiraFetch>(
      async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } }),
    );
    await expect(fetchJiraIssues(input(fetch))).rejects.toMatchObject({
      code: 'jira_redirect_refused',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('maps 401 to jira_auth_failed without the token in the message or stack', async () => {
    const fetch: JiraFetch = async () => new Response('{}', { status: 401 });
    const error = await fetchJiraIssues(input(fetch)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JiraFetchError);
    expect((error as JiraFetchError).code).toBe('jira_auth_failed');
    expect(String((error as Error).message)).not.toContain(TOKEN);
    expect(String((error as Error).stack)).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    const cursor = 'opaque-page-cursor-xyz';
    const again = (await fetchJiraIssues({ ...input(fetch), nextPageToken: cursor }).catch(
      (e: unknown) => e as Error,
    )) as Error;
    for (const text of [again.message, String(again.stack), JSON.stringify(again)]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(cursor);
    }
  });

  it('maps 429 to jira_rate_limited with retryAfterSeconds', async () => {
    const fetch: JiraFetch = async () =>
      new Response('', { status: 429, headers: { 'retry-after': '30' } });
    await expect(fetchJiraIssues(input(fetch))).rejects.toMatchObject({
      code: 'jira_rate_limited',
      retryAfterSeconds: 30,
    });
  });

  it('refuses a response over 5 MiB', async () => {
    const fetch: JiraFetch = async () =>
      new Response('x'.repeat(5 * 1024 * 1024 + 1), { status: 200 });
    await expect(fetchJiraIssues(input(fetch))).rejects.toMatchObject({
      code: 'jira_response_too_large',
    });
  });
});

/** A `/search/jql` page: `count` issues, `next` as the cursor (or `isLast`). */
function jqlPage(from: number, count: number, next: string | null, meta = true): Response {
  return new Response(
    JSON.stringify({
      issues: Array.from({ length: count }, (_, i) => issue(from + i + 1)),
      ...(next === null ? { isLast: true } : { nextPageToken: next, isLast: false }),
      ...(meta ? META : {}),
    }),
    { status: 200 },
  );
}

const FIELDS = [
  { id: 'summary', name: 'Summary', schema: { type: 'string' } },
  {
    id: 'customfield_10020',
    name: 'Sprint',
    schema: { type: 'array', custom: 'com.pyxis.greenhopper.jira:gh-sprint' },
  },
];

const path = (url: unknown) => new URL(String(url)).pathname;

describe('fetchJiraIssues on /rest/api/3/search/jql (R23-f)', () => {
  it('pages by nextPageToken until isLast, naming every mapped field', async () => {
    const fetch = vi.fn<JiraFetch>(async (url) =>
      new URL(url).searchParams.get('nextPageToken') === 'p2'
        ? jqlPage(100, 100, null)
        : jqlPage(0, 100, 'p2'),
    );
    const result = await fetchJiraIssues(input(fetch));
    expect(result.rows).toHaveLength(200);
    expect(result).toMatchObject({ nextPageToken: null, nextStartAt: null, total: null });
    expect(fetch).toHaveBeenCalledTimes(2);
    const second = new URL(String(fetch.mock.calls[1]?.[0]));
    expect(second.pathname).toBe('/rest/api/3/search/jql');
    expect(second.searchParams.get('nextPageToken')).toBe('p2');
    const fields = second.searchParams.get('fields')?.split(',') ?? [];
    for (const f of ['summary', 'issuetype', 'status', 'priority', 'assignee', 'reporter']) {
      expect(fields).toContain(f);
    }
    for (const f of ['created', 'updated', 'duedate', 'labels', 'parent', 'description']) {
      expect(fields).toContain(f);
    }
    expect(fields).toEqual([...JIRA_SEARCH_FIELDS]);
  });

  it('returns the last page token when max is reached', async () => {
    const fetch = vi.fn<JiraFetch>(async () => jqlPage(0, 50, 'p-next'));
    const result = await fetchJiraIssues({ ...input(fetch), max: 50 });
    expect(result).toMatchObject({ nextPageToken: 'p-next', nextStartAt: null });
  });

  it('falls back to the legacy search when the first request answers 404', async () => {
    const fetch = vi.fn<JiraFetch>(async (url) =>
      path(url) === '/rest/api/3/search/jql'
        ? new Response('', { status: 404 })
        : page(Number(new URL(url).searchParams.get('startAt')), 100, 5000),
    );
    const result = await fetchJiraIssues({ ...input(fetch), max: 150 });
    expect(path(fetch.mock.calls[1]?.[0])).toBe('/rest/api/3/search');
    expect(new URL(String(fetch.mock.calls[1]?.[0])).searchParams.get('startAt')).toBe('0');
    expect(result).toMatchObject({ nextStartAt: 150, nextPageToken: null, total: 5000 });
    expect(result.notes).toContain('jira_legacy_search');
  });

  it('treats a 404 on a later page as jira_unavailable, not a switch', async () => {
    const fetch = vi.fn<JiraFetch>(async (url) =>
      new URL(url).searchParams.has('nextPageToken')
        ? new Response('', { status: 404 })
        : jqlPage(0, 100, 'p2'),
    );
    await expect(fetchJiraIssues(input(fetch))).rejects.toMatchObject({
      code: 'jira_unavailable',
    });
    expect(fetch.mock.calls.every(([url]) => path(url) === '/rest/api/3/search/jql')).toBe(true);
  });

  it('reads the sprint ids from one /field call when the page has no names', async () => {
    const fetch = vi.fn<JiraFetch>(async (url) => {
      if (path(url) === '/rest/api/3/field') return new Response(JSON.stringify(FIELDS));
      return new URL(url).searchParams.has('nextPageToken')
        ? jqlPage(100, 1, null, false)
        : jqlPage(0, 100, 'p2', false);
    });
    const result = await fetchJiraIssues(input(fetch));
    expect(fetch.mock.calls.filter(([url]) => path(url) === '/rest/api/3/field')).toHaveLength(1);
    expect(result.rows[0]?.['Sprint']).toEqual(['Sprint 1', 'Sprint 2']);
    expect(result.notes).not.toContain('jira_field_meta_unavailable');
  });

  it('notes a failed /field call and returns the rows without a sprint column', async () => {
    const fetch = vi.fn<JiraFetch>(async (url) =>
      path(url) === '/rest/api/3/field'
        ? new Response('', { status: 500 })
        : jqlPage(0, 3, null, false),
    );
    const result = await fetchJiraIssues(input(fetch));
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]?.['Sprint']).toBeUndefined();
    expect(result.notes).toContain('jira_field_meta_unavailable');
  });

  it('refuses a page that repeats its cursor', async () => {
    const fetch = vi.fn<JiraFetch>(async () => jqlPage(0, 10, 'same'));
    await expect(fetchJiraIssues(input(fetch))).rejects.toMatchObject({
      code: 'jira_bad_response',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refuses a disallowed site exactly as the legacy URL builder', () => {
    for (const bad of ['http://acme.atlassian.net', 'https://evil.com']) {
      expect(() => jiraSearchJqlUrl(bad, 'x', null)).toThrow(JiraFetchError);
      expect(() => jiraSearchUrl(bad, 'x', 0)).toThrow(JiraFetchError);
    }
  });
});
