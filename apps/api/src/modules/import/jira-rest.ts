/**
 * R22-e (54-27) — the Jira Cloud REST source: pure mapping plus an injectable fetcher.
 *
 * `POST …/imports/sources/jira` reads one page window (≤ {@link MAX_IMPORT_ROWS} issues) of the
 * caller's own Jira with Atlassian basic auth (email + API token) and returns rows in the
 * CSV-export shape R21-e validates, so the existing `validations` → `commits` routes do the rest.
 * The description column carries the **raw ADF JSON**; `jiraDescription` converts it on commit.
 *
 * ## The credential
 *
 * Used for this request only: it builds one `Authorization` header and is never stored, logged,
 * echoed or placed in an error (54-27's "vault for the job" is 54-01, not built — there is no
 * job-scoped secret store, so there is no job). Every error here is built from fixed text and
 * the HTTP status alone.
 *
 * ## Egress (SSRF)
 *
 * {@link jiraBaseUrl} allows only `https://<site>.atlassian.net` / `https://<site>.jira.com`:
 * no port, no userinfo, no IP literal, no path, query or fragment. Redirects are not followed
 * (`redirect: 'manual'`; a 3xx is an error), each response is capped at 5 MiB, and each request
 * has a timeout.
 *
 * ## Paging
 *
 * No background job: a call loops `/rest/api/3/search` pages of 100 until `max` rows, and returns
 * `nextStartAt` when Jira has more — the client calls again with that `startAt`.
 */

import { MAX_IMPORT_ROWS } from './import-validation.js';
import type { SourceRow } from './import-validation.js';
import { MAX_DESCRIPTION } from './jira-issues.js';
import { adfToMarkdown } from './jira-adf.js';

/** The fetch the module binds (global `fetch`); tests pass a stub. */
export type JiraFetch = (url: string, init: RequestInit) => Promise<Response>;

/** DI token for {@link JiraFetch}; declared here so no shared token file is edited. */
export const JIRA_FETCHER = Symbol.for('tmanage.JiraFetcher');

export const MAX_JIRA_RESPONSE_BYTES = 5 * 1024 * 1024;
export const JIRA_PAGE_SIZE = 100;

export type JiraFetchErrorCode =
  | 'jira_auth_failed'
  | 'jira_rate_limited'
  | 'jira_redirect_refused'
  | 'jira_bad_request'
  | 'jira_response_too_large'
  | 'jira_bad_response'
  | 'jira_unavailable';

/** A Jira call failure. The message is fixed text plus a status — never a credential. */
export class JiraFetchError extends Error {
  constructor(
    readonly code: JiraFetchErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'JiraFetchError';
  }
}

/** The CSV-header names the REST rows use — the mapping the client posts with them. */
export const JIRA_REST_MAPPING = {
  issueKey: 'Issue key',
  summary: 'Summary',
  issueType: 'Issue Type',
  status: 'Status',
  statusCategory: 'Status Category',
  priority: 'Priority',
  assigneeEmail: 'Assignee',
  sprint: 'Sprint',
  parent: 'Parent',
  description: 'Description',
  created: 'Created',
  dueDate: 'Due date',
} as const;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
const SITE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * The site origin when `value` is an allowed Jira Cloud base URL, else `null`. Allowed:
 * `https:` only; host `<label>.atlassian.net` or `<label>.jira.com`; no port, no userinfo, no IP
 * literal; path empty or `/`; no query or fragment.
 */
export function jiraBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  if (/[\s\\]/u.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '' || value.includes('@')) return null;
  if (url.port !== '') return null;
  if (url.search !== '' || url.hash !== '' || value.includes('?') || value.includes('#')) {
    return null;
  }
  if (url.pathname !== '/' && url.pathname !== '') return null;
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || IPV4.test(host)) return null;
  const suffix = ['.atlassian.net', '.jira.com'].find((s) => host.endsWith(s));
  if (suffix === undefined) return null;
  const site = host.slice(0, -suffix.length);
  if (!SITE_LABEL.test(site)) return null;
  return `https://${host}`;
}

export function jiraBaseUrlAllowed(value: unknown): boolean {
  return jiraBaseUrl(value) !== null;
}

/** The search URL for one page. `baseUrl` must already have passed {@link jiraBaseUrl}. */
export function jiraSearchUrl(
  baseUrl: string,
  jql: string,
  startAt: number,
  maxResults = JIRA_PAGE_SIZE,
): string {
  const origin = jiraBaseUrl(baseUrl);
  if (origin === null) throw new JiraFetchError('jira_bad_request', 'The Jira site is not allowed');
  const params = new URLSearchParams({
    jql,
    startAt: String(startAt),
    maxResults: String(maxResults),
    expand: 'names,schema',
  });
  return `${origin}/rest/api/3/search?${params.toString()}`;
}

// ─── Mapping ─────────────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** `fields.x.name` (issue type, status, priority). */
function named(value: unknown): string | undefined {
  return str(record(value)?.['name']);
}

/** The response's `names` / `schema` blocks, used to find the sprint and epic-link fields. */
export interface JiraFieldMeta {
  readonly names?: Readonly<Record<string, unknown>>;
  readonly schema?: Readonly<Record<string, unknown>>;
}

function customFieldId(meta: JiraFieldMeta, custom: string, name: string): string[] {
  const ids = new Set<string>();
  for (const [id, schema] of Object.entries(meta.schema ?? {})) {
    const type = str(record(schema)?.['custom']);
    if (type !== undefined && type.endsWith(`:${custom}`)) ids.add(id);
  }
  for (const [id, label] of Object.entries(meta.names ?? {})) {
    if (id.startsWith('customfield_') && label === name) ids.add(id);
  }
  return [...ids];
}

/** The sprint names of one sprint field value (an array of `{ name }`), in Jira's order. */
function sprintNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((sprint) => {
    const name = typeof sprint === 'string' ? sprint : str(record(sprint)?.['name']);
    return name === undefined ? [] : [name];
  });
}

/**
 * The raw ADF JSON for the row. A document whose JSON exceeds the description bound is
 * converted here instead and re-wrapped as a one-paragraph ADF doc, so the row still validates
 * and the commit path still reads ADF (`jira_description_preconverted` in the notes).
 */
function descriptionCell(value: unknown, notes: Set<string>): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value === '' ? undefined : value;
  const json = JSON.stringify(value);
  if (json.length <= MAX_DESCRIPTION) return json;
  notes.add('jira_description_preconverted');
  let markdown = adfToMarkdown(value).markdown;
  for (let pass = 0; pass < 8; pass += 1) {
    const wrapped = JSON.stringify({
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: markdown }] }],
    });
    if (wrapped.length <= MAX_DESCRIPTION) return wrapped;
    markdown = `${Array.from(markdown)
      .slice(0, Math.max(0, Array.from(markdown).length - (wrapped.length - MAX_DESCRIPTION) - 8))
      .join('')} …`;
  }
  return undefined;
}

/** One Jira REST issue → the CSV-shaped row R21-e validates. */
export function jiraIssueToRow(
  issue: unknown,
  meta: JiraFieldMeta = {},
  notes: Set<string> = new Set(),
): SourceRow {
  const raw = record(issue) ?? {};
  const fields = record(raw['fields']) ?? {};
  const row: Record<string, unknown> = {};
  const put = (column: string, value: unknown) => {
    if (value !== undefined) row[column] = value;
  };
  put('Issue key', str(raw['key']));
  put('Summary', str(fields['summary']));
  put('Issue Type', named(fields['issuetype']));
  const status = record(fields['status']);
  put('Status', named(status));
  put('Status Category', named(status?.['statusCategory']));
  put('Priority', named(fields['priority']));
  put('Assignee', str(record(fields['assignee'])?.['emailAddress']));
  put('Reporter', str(record(fields['reporter'])?.['emailAddress']));
  put('Created', str(fields['created']));
  put('Updated', str(fields['updated']));
  put('Due date', str(fields['duedate']));
  if (Array.isArray(fields['labels'])) {
    const labels = (fields['labels'] as unknown[]).filter(
      (l): l is string => typeof l === 'string',
    );
    if (labels.length > 0) put('Labels', labels.join(' '));
  }
  const sprints = customFieldId(meta, 'gh-sprint', 'Sprint').flatMap((id) =>
    sprintNames(fields[id]),
  );
  if (sprints.length > 0) put('Sprint', sprints);
  const parent = str(record(fields['parent'])?.['key']);
  const epicLink = customFieldId(meta, 'gh-epic-link', 'Epic Link')
    .map((id) => str(fields[id]))
    .find((key) => key !== undefined);
  put('Parent', parent ?? epicLink);
  put('Epic Link', epicLink);
  put('Description', descriptionCell(fields['description'], notes));
  return row;
}

// ─── Fetching ────────────────────────────────────────────────────────────

export interface FetchJiraIssuesInput {
  readonly fetch: JiraFetch;
  readonly baseUrl: string;
  readonly email: string;
  readonly token: string;
  readonly jql: string;
  readonly startAt?: number;
  readonly max?: number;
  readonly timeoutMs?: number;
}

export interface FetchJiraIssuesResult {
  readonly rows: readonly SourceRow[];
  readonly nextStartAt: number | null;
  readonly total: number;
  readonly notes: readonly string[];
}

function retryAfter(header: string | null): number {
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(3600, Math.ceil(seconds));
  return 60;
}

/** The body as text, refusing more than {@link MAX_JIRA_RESPONSE_BYTES}. */
async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JIRA_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new JiraFetchError('jira_response_too_large', 'The Jira response is too large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JIRA_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new JiraFetchError('jira_response_too_large', 'The Jira response is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchPage(
  input: FetchJiraIssuesInput,
  authorization: string,
  startAt: number,
  maxResults: number,
): Promise<{ issues: unknown[]; total: number; meta: JiraFieldMeta }> {
  const url = jiraSearchUrl(input.baseUrl, input.jql, startAt, maxResults);
  let response: Response;
  try {
    response = await input.fetch(url, {
      method: 'GET',
      headers: { Authorization: authorization, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(input.timeoutMs ?? 20_000),
    });
  } catch {
    // The underlying error is dropped on purpose: nothing from the request travels onward.
    throw new JiraFetchError('jira_unavailable', 'Jira could not be reached');
  }
  const { status } = response;
  if (status >= 300 && status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new JiraFetchError('jira_redirect_refused', 'Jira answered with a redirect', status);
  }
  if (status === 401 || status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new JiraFetchError('jira_auth_failed', 'Jira refused the email or API token', status);
  }
  if (status === 429) {
    const seconds = retryAfter(response.headers.get('retry-after'));
    await response.body?.cancel().catch(() => undefined);
    throw new JiraFetchError('jira_rate_limited', 'Jira is rate limiting', status, seconds);
  }
  if (status === 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new JiraFetchError('jira_bad_request', 'Jira refused the query (check the JQL)', status);
  }
  if (status < 200 || status >= 300) {
    await response.body?.cancel().catch(() => undefined);
    throw new JiraFetchError('jira_unavailable', `Jira answered ${status}`, status);
  }
  let body: Record<string, unknown> | null;
  try {
    body = record(JSON.parse(await boundedText(response)));
  } catch (error) {
    if (error instanceof JiraFetchError) throw error;
    throw new JiraFetchError('jira_bad_response', 'Jira sent an unreadable response', status);
  }
  if (!body || !Array.isArray(body['issues'])) {
    throw new JiraFetchError('jira_bad_response', 'Jira sent an unreadable response', status);
  }
  const total = Number(body['total']);
  return {
    issues: body['issues'] as unknown[],
    total: Number.isFinite(total) && total >= 0 ? Math.floor(total) : 0,
    meta: {
      names: record(body['names']) ?? {},
      schema: record(body['schema']) ?? {},
    },
  };
}

/**
 * Read up to `max` issues starting at `startAt`, page by page. `nextStartAt` is the offset to
 * call again with, or `null` when Jira has no more.
 */
export async function fetchJiraIssues(input: FetchJiraIssuesInput): Promise<FetchJiraIssuesResult> {
  const max = Math.min(MAX_IMPORT_ROWS, Math.max(1, Math.floor(input.max ?? MAX_IMPORT_ROWS)));
  const authorization = `Basic ${Buffer.from(`${input.email}:${input.token}`, 'utf8').toString('base64')}`;
  const rows: SourceRow[] = [];
  const notes = new Set<string>([
    'comments_not_imported',
    'attachments_not_imported',
    'worklogs_not_imported',
  ]);
  let startAt = Math.max(0, Math.floor(input.startAt ?? 0));
  let total = 0;
  while (rows.length < max) {
    const page = await fetchPage(
      input,
      authorization,
      startAt,
      Math.min(JIRA_PAGE_SIZE, max - rows.length),
    );
    total = page.total;
    // A page longer than asked for is cut; `startAt` moves by what was taken.
    const taken = page.issues.slice(0, max - rows.length);
    for (const issue of taken) rows.push(jiraIssueToRow(issue, page.meta, notes));
    startAt += taken.length;
    if (page.issues.length === 0 || startAt >= total) {
      return { rows, nextStartAt: null, total, notes: [...notes] };
    }
  }
  return { rows, nextStartAt: startAt < total ? startAt : null, total, notes: [...notes] };
}
