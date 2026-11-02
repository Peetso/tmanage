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
 * No background job: a call loops pages of 100 until `max` rows, then hands the client a cursor to
 * call again with. R23-f (54-27 part 3) moved the loop to Atlassian's current search API:
 *
 * 1. **New path first** — `GET /rest/api/3/search/jql` with token paging: each page carries an
 *    opaque `nextPageToken` and `isLast`; there is no `total`, and the endpoint returns only `id`
 *    unless `fields` is named, so {@link JIRA_SEARCH_FIELDS} names every field the mapper reads.
 *    The cursor returned is `nextPageToken` (`nextStartAt` is `null`, `total` is `null`).
 * 2. **Legacy fallback** — when the *first* `/search/jql` request of a call answers 404 or 410
 *    (a site that has not got the new API), the rest of the call uses the deprecated
 *    `GET /rest/api/3/search` with `startAt` paging and notes `jira_legacy_search`; the cursor
 *    returned is `nextStartAt`. A client that sends `startAt` is continuing a legacy cursor and
 *    stays legacy. A 404 on a later `/search/jql` page is an error, never a silent switch.
 *
 * The sprint / epic-link custom field ids come from the page's `names` / `schema` expansion. When
 * a `/search/jql` page carries neither, one `GET /rest/api/3/field` call per run supplies the
 * same {@link JiraFieldMeta} (same SSRF, size and timeout rules); if that call fails the run
 * notes `jira_field_meta_unavailable` and the sprint column is absent — never an error.
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

/** Longest `nextPageToken` accepted from a client or from Jira (the token is opaque). */
export const MAX_JIRA_PAGE_TOKEN = 2048;

/**
 * The fields `/rest/api/3/search/jql` is asked for — every field {@link jiraIssueToRow} reads.
 * The sprint / epic-link custom field ids differ per site, so `*navigable` brings the custom
 * fields along (both are navigable) instead of a site-specific id.
 */
export const JIRA_SEARCH_FIELDS = [
  'summary',
  'issuetype',
  'status',
  'priority',
  'assignee',
  'reporter',
  'created',
  'updated',
  'duedate',
  'labels',
  'parent',
  'description',
  '*navigable',
] as const;

function allowedOrigin(baseUrl: string): string {
  const origin = jiraBaseUrl(baseUrl);
  if (origin === null) throw new JiraFetchError('jira_bad_request', 'The Jira site is not allowed');
  return origin;
}

/**
 * The token-paged search URL for one page (R23-f). `nextPageToken` is opaque: it is encoded by
 * `URLSearchParams` and never logged. `baseUrl` must pass {@link jiraBaseUrl}.
 */
export function jiraSearchJqlUrl(
  baseUrl: string,
  jql: string,
  nextPageToken: string | null,
  maxResults = JIRA_PAGE_SIZE,
): string {
  const origin = allowedOrigin(baseUrl);
  const params = new URLSearchParams({
    jql,
    maxResults: String(maxResults),
    fields: JIRA_SEARCH_FIELDS.join(','),
    expand: 'names,schema',
  });
  if (nextPageToken !== null) params.set('nextPageToken', nextPageToken);
  return `${origin}/rest/api/3/search/jql?${params.toString()}`;
}

/** The field catalogue URL the sprint / epic ids come from when a page has no `names`. */
export function jiraFieldUrl(baseUrl: string): string {
  return `${allowedOrigin(baseUrl)}/rest/api/3/field`;
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
  /** A legacy cursor: the call stays on `/rest/api/3/search`. Exclusive with `nextPageToken`. */
  readonly startAt?: number;
  /** A `/search/jql` cursor from an earlier call. */
  readonly nextPageToken?: string;
  readonly max?: number;
  readonly timeoutMs?: number;
}

export interface FetchJiraIssuesResult {
  readonly rows: readonly SourceRow[];
  /** The `/search/jql` cursor to call again with, or `null`. */
  readonly nextPageToken: string | null;
  /** The legacy cursor to call again with, or `null`. At most one of the two is non-null. */
  readonly nextStartAt: number | null;
  /** Jira's issue count — legacy path only; `/search/jql` has none. */
  readonly total: number | null;
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

/** One GET under the egress rules, mapped to {@link JiraFetchError} codes; the parsed JSON. */
async function getJson(
  input: FetchJiraIssuesInput,
  authorization: string,
  url: string,
): Promise<{ body: unknown; status: number }> {
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
  try {
    return { body: JSON.parse(await boundedText(response)) as unknown, status };
  } catch (error) {
    if (error instanceof JiraFetchError) throw error;
    throw new JiraFetchError('jira_bad_response', 'Jira sent an unreadable response', status);
  }
}

interface SearchPage {
  readonly issues: unknown[];
  readonly meta: JiraFieldMeta;
  /** Legacy shape only. */
  readonly total: number;
  /** `/search/jql` shape only: the next cursor, `null` when absent. */
  readonly nextPageToken: string | null;
  readonly isLast: boolean;
}

/** Reads either response shape: `{ issues, nextPageToken?, isLast? }` or `{ issues, total }`. */
function readSearchPage(body: unknown, status: number): SearchPage {
  const page = record(body);
  if (!page || !Array.isArray(page['issues'])) {
    throw new JiraFetchError('jira_bad_response', 'Jira sent an unreadable response', status);
  }
  const total = Number(page['total']);
  const token = page['nextPageToken'];
  if (
    token !== undefined &&
    token !== null &&
    (typeof token !== 'string' || token.length > MAX_JIRA_PAGE_TOKEN)
  ) {
    throw new JiraFetchError('jira_bad_response', 'Jira sent an unreadable response', status);
  }
  return {
    issues: page['issues'] as unknown[],
    meta: { names: record(page['names']) ?? {}, schema: record(page['schema']) ?? {} },
    total: Number.isFinite(total) && total >= 0 ? Math.floor(total) : 0,
    nextPageToken: typeof token === 'string' && token !== '' ? token : null,
    isLast: page['isLast'] === true,
  };
}

function hasMeta(meta: JiraFieldMeta): boolean {
  return Object.keys(meta.names ?? {}).length > 0 || Object.keys(meta.schema ?? {}).length > 0;
}

/**
 * The site's field catalogue (`GET /rest/api/3/field`) as {@link JiraFieldMeta}, or `null` when
 * it cannot be read — the caller notes `jira_field_meta_unavailable` and maps without it.
 */
export async function customFieldMeta(
  input: FetchJiraIssuesInput,
  authorization: string,
): Promise<JiraFieldMeta | null> {
  try {
    const { body } = await getJson(input, authorization, jiraFieldUrl(input.baseUrl));
    if (!Array.isArray(body)) return null;
    const names: Record<string, unknown> = {};
    const schema: Record<string, unknown> = {};
    for (const field of body) {
      const entry = record(field);
      const id = str(entry?.['id']);
      if (entry === null || id === undefined) continue;
      if (entry['name'] !== undefined) names[id] = entry['name'];
      if (record(entry['schema']) !== null) schema[id] = entry['schema'];
    }
    return { names, schema };
  } catch {
    // Any failure (status, size, timeout, shape) degrades to "no sprint column", never an error.
    return null;
  }
}

/**
 * Read up to `max` issues, page by page — `/search/jql` first, the legacy `/search` when the
 * first `/search/jql` request answers 404/410 or when the client sent a legacy `startAt`. The
 * result carries exactly the cursor of the path used (see the module comment).
 */
export async function fetchJiraIssues(input: FetchJiraIssuesInput): Promise<FetchJiraIssuesResult> {
  const max = Math.min(MAX_IMPORT_ROWS, Math.max(1, Math.floor(input.max ?? MAX_IMPORT_ROWS)));
  const authorization = `Basic ${Buffer.from(`${input.email}:${input.token}`, 'utf8').toString('base64')}`;
  const notes = new Set<string>([
    'comments_not_imported',
    'attachments_not_imported',
    'worklogs_not_imported',
  ]);
  if (input.startAt !== undefined) {
    return fetchLegacy(input, authorization, Math.max(0, Math.floor(input.startAt)), max, notes);
  }

  const rows: SourceRow[] = [];
  const seen = new Set<string>();
  let token: string | null = input.nextPageToken ?? null;
  if (token !== null) seen.add(token);
  let fieldMeta: JiraFieldMeta | null | undefined;
  let first = true;
  while (rows.length < max) {
    const url = jiraSearchJqlUrl(
      input.baseUrl,
      input.jql,
      token,
      Math.min(JIRA_PAGE_SIZE, max - rows.length),
    );
    let response: { body: unknown; status: number };
    try {
      response = await getJson(input, authorization, url);
    } catch (error) {
      // Only the very first request of a fresh run may switch paths; a client continuing a
      // `/search/jql` cursor has no offset to continue from, so its 404 stays an error.
      if (
        first &&
        token === null &&
        error instanceof JiraFetchError &&
        (error.status === 404 || error.status === 410)
      ) {
        notes.add('jira_legacy_search');
        return fetchLegacy(input, authorization, 0, max, notes);
      }
      throw error;
    }
    first = false;
    const page = readSearchPage(response.body, response.status);
    let meta = page.meta;
    if (!hasMeta(meta)) {
      if (fieldMeta === undefined) {
        fieldMeta = await customFieldMeta(input, authorization);
        if (fieldMeta === null) notes.add('jira_field_meta_unavailable');
      }
      meta = fieldMeta ?? {};
    }
    const taken = page.issues.slice(0, max - rows.length);
    for (const issue of taken) rows.push(jiraIssueToRow(issue, meta, notes));
    if (page.issues.length === 0 || page.isLast || page.nextPageToken === null) {
      return { rows, nextPageToken: null, nextStartAt: null, total: null, notes: [...notes] };
    }
    if (seen.has(page.nextPageToken)) {
      throw new JiraFetchError('jira_bad_response', 'Jira repeated a page cursor', response.status);
    }
    seen.add(page.nextPageToken);
    token = page.nextPageToken;
  }
  return { rows, nextPageToken: token, nextStartAt: null, total: null, notes: [...notes] };
}

/** The legacy `/rest/api/3/search` loop (`startAt` paging, `total` known). */
async function fetchLegacy(
  input: FetchJiraIssuesInput,
  authorization: string,
  from: number,
  max: number,
  notes: Set<string>,
): Promise<FetchJiraIssuesResult> {
  const rows: SourceRow[] = [];
  let startAt = from;
  let total = 0;
  while (rows.length < max) {
    const url = jiraSearchUrl(
      input.baseUrl,
      input.jql,
      startAt,
      Math.min(JIRA_PAGE_SIZE, max - rows.length),
    );
    const { body, status } = await getJson(input, authorization, url);
    const page = readSearchPage(body, status);
    total = page.total;
    // A page longer than asked for is cut; `startAt` moves by what was taken.
    const taken = page.issues.slice(0, max - rows.length);
    for (const issue of taken) rows.push(jiraIssueToRow(issue, page.meta, notes));
    startAt += taken.length;
    if (page.issues.length === 0 || startAt >= total) {
      return { rows, nextPageToken: null, nextStartAt: null, total, notes: [...notes] };
    }
  }
  return {
    rows,
    nextPageToken: null,
    nextStartAt: startAt < total ? startAt : null,
    total,
    notes: [...notes],
  };
}
