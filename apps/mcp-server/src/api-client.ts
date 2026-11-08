/**
 * The HTTP client the tools call. It is the only thing in this package that knows the TManage
 * API's routes and shapes; the tool handlers depend on the {@link TManageApiClient} interface
 * so they can be tested against a mock without a live server.
 *
 * Every request carries `Authorization: Bearer <token>` — a personal access token. The API's
 * permission checks run against that token's member, so the client never needs to carry a role
 * or a tenant: whatever the member may do, the token may do, and nothing more.
 *
 * Routes are tenant-scoped under `v1/organizations/:orgSlug/...`. The one exception is
 * `GET /v1/organizations`, which under a personal access token returns the single organization the
 * token is bound to (TManage 0202); the client uses it to resolve the working `orgSlug`. A token is
 * bound to one org, so there is no org to choose — the API refuses the token against any other.
 */

export interface OrganizationSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly audience: string;
  readonly role: string;
  readonly clientOrganizationName: string | null;
}

export interface SearchResult {
  readonly kind: string;
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly snippet: string | null;
}

export interface WorkItem {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
  readonly title: string;
  readonly state: string;
  readonly ownerUserId: string | null;
  readonly audience: string;
  readonly startAt: string | null;
  readonly dueAt: string | null;
  readonly completedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface MyDayEntry {
  readonly reason: string;
  readonly workItem: WorkItem;
}

export interface InboxItem {
  readonly bundleId?: string;
  readonly objectType?: string;
  readonly objectId?: string;
  readonly title?: string;
  readonly state?: string;
  readonly projectId?: string;
  readonly count?: number;
  readonly unreadCount?: number;
  readonly latestAt?: string;
}

export interface Project {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly status: string;
  readonly ownerUserId: string | null;
  readonly committedAt: string | null;
  readonly forecastAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TManageDocument {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkComment {
  readonly id: string;
  readonly workItemId: string;
  readonly authorMembershipId: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface CreateWorkItemInput {
  readonly projectId: string;
  readonly title: string;
  readonly type?: string;
  readonly ownerUserId?: string;
  readonly audience?: string;
  readonly startAt?: string | null;
  readonly dueAt?: string | null;
}

/** 53-13. A draft meeting note waiting for a person to review it in TManage. */
export interface MeetingNoteDraft {
  readonly id: string;
  readonly meetingId: string;
  readonly kind: 'note' | 'decision';
  readonly body: string;
  readonly authorUserId: string;
  readonly source: 'mcp';
  readonly assistantName: string;
  readonly submittedAt: string;
}

export interface SubmitMeetingNoteDraftInput {
  readonly body: string;
  readonly kind?: 'note' | 'decision';
  readonly assistantName?: string;
}

/** The capabilities the tool handlers rely on. One method per TManage endpoint they reach. */
export interface TManageApiClient {
  listOrganizations(): Promise<readonly OrganizationSummary[]>;
  /** Resolve the working org slug: the explicit one, else the pinned one, else the first org. */
  resolveOrgSlug(explicit?: string): Promise<string>;
  search(
    orgSlug: string,
    query: string,
    options?: { projectId?: string; limit?: number },
  ): Promise<readonly SearchResult[]>;
  listMyWork(orgSlug: string): Promise<readonly MyDayEntry[]>;
  listInbox(
    orgSlug: string,
    options?: { mode?: string; limit?: number },
  ): Promise<readonly InboxItem[]>;
  getWorkItem(orgSlug: string, workItemId: string): Promise<WorkItem>;
  getProject(orgSlug: string, projectId: string): Promise<Project>;
  getDocument(orgSlug: string, documentId: string): Promise<TManageDocument>;
  listProjects(orgSlug: string): Promise<readonly Project[]>;
  createWorkItem(orgSlug: string, input: CreateWorkItemInput): Promise<WorkItem>;
  addComment(orgSlug: string, workItemId: string, body: string): Promise<WorkComment>;
  /** 53-13. Submit a draft note for a meeting; it stays pending until a person saves it. */
  submitMeetingNoteDraft(
    orgSlug: string,
    meetingId: string,
    input: SubmitMeetingNoteDraftInput,
  ): Promise<MeetingNoteDraft>;
}

/** A non-2xx response from the API, carrying the status and the server's error code if any. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface HttpApiClientOptions {
  readonly baseUrl: string;
  /** The bearer token for every request. */
  readonly token: string;
  /** Pins the working org; when set, `resolveOrgSlug()` returns it without a lookup. */
  readonly orgSlug?: string | undefined;
  /** Injected so tests can supply a fake; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

const PATH_SEGMENT = /[^A-Za-z0-9._~-]/g;

/** Percent-encode a value used as one URL path segment (an org slug, an id). */
function segment(value: string): string {
  return value.replace(PATH_SEGMENT, (c) => encodeURIComponent(c));
}

export function createHttpApiClient(options: HttpApiClientOptions): TManageApiClient {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  let cachedOrgSlug: string | undefined = options.orgSlug;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.token}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const text = await response.text();
    const parsed: unknown = text.length > 0 ? safeJson(text) : undefined;

    if (!response.ok) {
      const envelope = parsed as { code?: string; message?: string } | undefined;
      throw new ApiError(
        response.status,
        envelope?.code,
        envelope?.message ?? `TManage API ${method} ${path} failed with ${response.status}`,
      );
    }
    return parsed as T;
  }

  function orgPath(orgSlug: string, suffix: string): string {
    return `/v1/organizations/${segment(orgSlug)}${suffix}`;
  }

  const client: TManageApiClient = {
    async listOrganizations() {
      const data = await request<{ organizations: readonly OrganizationSummary[] }>(
        'GET',
        '/v1/organizations',
      );
      return data.organizations;
    },

    async resolveOrgSlug(explicit) {
      if (explicit) return explicit;
      if (cachedOrgSlug) return cachedOrgSlug;
      const orgs = await client.listOrganizations();
      const first = orgs[0];
      if (!first) {
        throw new ApiError(
          404,
          'no_organization',
          'This token belongs to no organization. Create or join one in TManage, or set ' +
            'TMANAGE_ORG_SLUG.',
        );
      }
      cachedOrgSlug = first.slug;
      return first.slug;
    },

    async search(orgSlug, query, opts) {
      const params = new URLSearchParams({ q: query });
      if (opts?.projectId) params.set('projectId', opts.projectId);
      if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
      const data = await request<{ results: readonly SearchResult[] }>(
        'GET',
        orgPath(orgSlug, `/search?${params.toString()}`),
      );
      return data.results;
    },

    async listMyWork(orgSlug) {
      const data = await request<{ items: readonly MyDayEntry[] }>(
        'GET',
        orgPath(orgSlug, '/home/my-day'),
      );
      return data.items;
    },

    async listInbox(orgSlug, opts) {
      const params = new URLSearchParams();
      if (opts?.mode) params.set('mode', opts.mode);
      if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
      const query = params.toString();
      const data = await request<{ items: readonly InboxItem[] }>(
        'GET',
        orgPath(orgSlug, `/inbox${query ? `?${query}` : ''}`),
      );
      return data.items;
    },

    async getWorkItem(orgSlug, workItemId) {
      return request<WorkItem>('GET', orgPath(orgSlug, `/work-items/${segment(workItemId)}`));
    },

    async getProject(orgSlug, projectId) {
      return request<Project>('GET', orgPath(orgSlug, `/projects/${segment(projectId)}`));
    },

    async getDocument(orgSlug, documentId) {
      return request<TManageDocument>('GET', orgPath(orgSlug, `/documents/${segment(documentId)}`));
    },

    async listProjects(orgSlug) {
      const data = await request<{ projects: readonly Project[] }>(
        'GET',
        orgPath(orgSlug, '/projects'),
      );
      return data.projects;
    },

    async createWorkItem(orgSlug, input) {
      return request<WorkItem>('POST', orgPath(orgSlug, '/work-items'), input);
    },

    async addComment(orgSlug, workItemId, body) {
      return request<WorkComment>(
        'POST',
        orgPath(orgSlug, `/work-items/${segment(workItemId)}/comments`),
        { body },
      );
    },

    async submitMeetingNoteDraft(orgSlug, meetingId, input) {
      return request<MeetingNoteDraft>(
        'POST',
        orgPath(orgSlug, `/meetings/${segment(meetingId)}/note-drafts`),
        input,
      );
    },
  };

  return client;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
