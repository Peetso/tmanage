import { describe, expect, it, vi } from 'vitest';
import {
  JiraFetchError,
  fetchJiraIssues,
  jiraBaseUrlAllowed,
  jiraIssueToRow,
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
    const result = await fetchJiraIssues(input(fetch));
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
    const result = await fetchJiraIssues({ ...input(fetch), max: 150 });
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
