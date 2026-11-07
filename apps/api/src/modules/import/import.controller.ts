import { Body, Controller, Get, HttpCode, Inject, Optional, Param, Post } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { IMPORT_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { parseImportCommitBody, parseImportValidationBody } from './import-input.js';
import type {
  ImportCommitView,
  ImportJobListView,
  ImportService,
  ImportUndoView,
  ImportValidationView,
} from './import.service.js';
import type { SourceRow } from './import-validation.js';
import { parseIssueKey } from './jira-issues.js';
import {
  JIRA_FETCHER,
  JIRA_REST_MAPPING,
  JiraFetchError,
  MAX_JIRA_PAGE_TOKEN,
  fetchJiraIssues,
  jiraBaseUrl,
} from './jira-rest.js';
import type { JiraFetch } from './jira-rest.js';

/**
 * ON-09 / ADM-10 — the onboarding-import validate / dry-run endpoint.
 *
 * One route this slice: `POST …/imports/validations` accepts a source mapping and a batch of
 * source rows, validates them against the target shape, persists the attempt as one
 * `import_jobs` row and returns the report plus that job id. It **commits no target entity**.
 *
 * ## Capability
 *
 * Reused, not new: `org.manage`. `41 §ADM-10` places data import/export under **Admin**, so
 * import is an org-level administrative action (owner / org_admin), and the coarse gate is the
 * same one `ClientsController` uses. A dedicated `import.run` capability is the clean follow-up,
 * but adding it would edit `capabilities.ts` + `role-operation-grid.ts` and serialize with the
 * grid slices — deliberately deferred (NEXT-SCOPES-5 §Item x95).
 *
 * Like every tenant-scoped controller here, it reads `organization_id` from the `TenantContext`
 * the guard built, never from the body or the `:orgSlug` path segment.
 *
 * `200`, not `201`: the addressable result is a validation *report*, and validate-only creates
 * no resource a client navigates to. The `import_jobs` row is an internal anchor, its id
 * returned inside the report rather than as a `Location`.
 */

interface ImportValidationRequestBody {
  readonly sourceKind?: unknown;
  readonly mapping?: unknown;
  readonly rows?: unknown;
}

interface ImportCommitRequestBody extends ImportValidationRequestBody {
  readonly jobId?: unknown;
}

interface JiraSourceRequestBody {
  readonly baseUrl?: unknown;
  readonly email?: unknown;
  readonly token?: unknown;
  readonly jql?: unknown;
  readonly projectKey?: unknown;
  readonly startAt?: unknown;
  readonly nextPageToken?: unknown;
}

/** R22-e: the rows of one Jira REST page window, ready for `POST …/imports/validations`. */
export interface JiraSourceView {
  readonly sourceKind: 'jira_issues';
  readonly mapping: typeof JIRA_REST_MAPPING;
  readonly rows: readonly SourceRow[];
  /** R23-f: the `/search/jql` cursor; at most one of the two cursors is non-null. */
  readonly nextPageToken: string | null;
  readonly nextStartAt: number | null;
  /** `null` on the `/search/jql` path, which reports no count. */
  readonly total: number | null;
  readonly notes: readonly string[];
}

const MAX_JQL = 500;
const MAX_TOKEN = 2048;
const MAX_START_AT = 1_000_000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;

@Controller('v1/organizations/:orgSlug/imports')
export class ImportController {
  constructor(
    @Inject(IMPORT_SERVICE) private readonly imports: ImportService,
    @Optional()
    @Inject(JIRA_FETCHER)
    private readonly jiraFetch: JiraFetch = (url, init) => fetch(url, init),
  ) {}

  /**
   * R31 (A11) — `GET …/imports`: the tenant's recent committed imports, newest first, for the
   * import start page (history, receipt links, undo). The live 404 on this path was a missing
   * route, not a prefix problem: the module only served the validate / commit / receipt / undo
   * sub-paths. `org.manage`, the same coarse gate as every sibling import route.
   */
  @Get()
  @RequireCapability('org.manage')
  async list(@Ctx() context: TenantContext): Promise<ImportJobListView> {
    return this.imports.listRecent(context);
  }

  @Post('validations')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async validate(
    @Ctx() context: TenantContext,
    @Body() body: ImportValidationRequestBody,
  ): Promise<ImportValidationView> {
    const details: { field: string; message: string }[] = [];
    const request = parseImportValidationBody(body, details);
    if (!request || details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.imports.validate(context, request);
  }

  /**
   * `POST …/imports/commits` — the commit half. Takes the id of a validated job plus the batch
   * to commit, re-validates it, creates the target entities from the rows that pass (each through
   * the object-layer `project.create` `authorize()`), records a per-row receipt, and transitions
   * the job to a terminal `committed` / `committed_with_errors` status.
   *
   * ## Capability
   *
   * Reused, not new: `org.manage`, the same coarse gate as the validate half — `41 §ADM-10`
   * places data import under Admin. The per-row `project.create` `authorize()` in the service is
   * what keeps a commit no broader than a manual create; adding a dedicated `import.run`
   * capability would edit `capabilities.ts` + `role-operation-grid.ts` and is the deferred
   * follow-up (recorded in `docs/implementation-status.md`).
   *
   * `200`, not `201`: partial failure means the addressable result is a *receipt* describing what
   * happened to each row, not a single created resource a `Location` would point at. The created
   * entities are addressable at their own routes; their ids are in the receipt.
   */
  @Post('commits')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async commit(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: ImportCommitRequestBody,
  ): Promise<ImportCommitView> {
    const details: { field: string; message: string }[] = [];
    const request = parseImportCommitBody(body, details);
    if (!request || details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.imports.commit(context, principal, request);
  }

  /**
   * `GET …/imports/:jobId/receipt` — the receipt read half (ON-09 "progress" / ADM-10 "receipt",
   * x104). Returns a committed job's terminal status, its committed / failed counts, and the
   * per-row `import_rows` outcomes in source order. Pure read: it commits and re-runs nothing.
   *
   * ## Capability
   *
   * Reused, not new: `org.manage`, the same coarse gate the validate and commit halves use —
   * `41 §ADM-10` places data import under Admin. A caller without it is refused by the guard
   * exactly as the sibling import routes refuse, before this handler runs.
   *
   * ## Tenant-scoped resolve before anything else
   *
   * The job is named by id in the path. `ImportService.getReceipt` loads it tenant-scoped first,
   * so a missing or cross-tenant id is a **404**, never a 500 and never a foreign receipt — the
   * same discipline the commit half's job load follows. The `:orgSlug` segment is the claim the
   * guard resolves against a membership; it is never read here.
   */
  @Get(':jobId/receipt')
  @RequireCapability('org.manage')
  async receipt(
    @Ctx() context: TenantContext,
    @Param('jobId') jobId: string,
  ): Promise<ImportCommitView> {
    return this.imports.getReceipt(context, jobId);
  }

  /**
   * R23-e (54-24) — `POST …/imports/:jobId/undo`: the one-click undo inside 7 days of the commit.
   * Created documents and work items are soft-deleted, created phases removed, in one transaction
   * with the job's undo stamp and an `import.undo` audit row (counts only). `org.manage` at the
   * guard, plus `project.manage` on every touched project in the service. 404 for a missing or
   * foreign job; 409 `import_undo_done` / `import_undo_window` / `import_undo_unsupported`.
   * A bulk delete: on the AI connector's NEVER list.
   */
  @Post(':jobId/undo')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async undo(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('jobId') jobId: string,
  ): Promise<ImportUndoView> {
    return this.imports.undo(context, principal, jobId);
  }

  /**
   * R22-e (54-27) — `POST …/imports/sources/jira`: read one window (≤ 1000 issues) of the
   * caller's own Jira Cloud site and return the rows in the CSV-export shape, with the mapping to
   * post them under to `validations`. Nothing is written; the rows still pass the validations
   * route and the commit's per-row checks.
   *
   * ## Capability
   *
   * `org.manage`, as the sibling import routes — checked by the guard and again here with the
   * real `authorize` before any outbound request, because this route spends egress.
   *
   * ## The credential (deviation from 54-27, stated)
   *
   * 54-27 keeps the API token "in the vault for the job only"; the vault (54-01) and a background
   * job are not built. The token lives for this one request: it builds one basic-auth header and
   * is never stored, logged (`token` is a redacted field name) or echoed — no error carries it.
   * The route is on the AI connector's NEVER list.
   *
   * `baseUrl` must be `https://<site>.atlassian.net` or `https://<site>.jira.com` (422 otherwise —
   * the SSRF rule). `projectKey` becomes `project = KEY ORDER BY created ASC`; a free `jql` (≤ 500
   * characters) is sent verbatim — Jira enforces its own grammar. When Jira has more, exactly one
   * cursor is non-null (R23-f): `nextPageToken` (the `/search/jql` path) or `nextStartAt` (the
   * legacy `/search` fallback) — the client calls again sending that one; both at once is a 400.
   */
  @Post('sources/jira')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async jiraSource(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: JiraSourceRequestBody,
  ): Promise<JiraSourceView> {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }

    const request = parseJiraSourceBody(body ?? {});
    try {
      const result = await fetchJiraIssues({ fetch: this.jiraFetch, ...request });
      return { sourceKind: 'jira_issues', mapping: JIRA_REST_MAPPING, ...result };
    } catch (error) {
      if (error instanceof JiraFetchError) throw jiraApiError(error);
      throw error;
    }
  }
}

interface JiraSourceRequest {
  readonly baseUrl: string;
  readonly email: string;
  readonly token: string;
  readonly jql: string;
  /** The cursor the client sent, if any — at most one of the two. */
  readonly startAt?: number;
  readonly nextPageToken?: string;
}

/** The body, validated. 422 for a disallowed site (the SSRF rule), 400 for anything else. */
export function parseJiraSourceBody(body: JiraSourceRequestBody): JiraSourceRequest {
  const baseUrl = jiraBaseUrl(body.baseUrl);
  if (baseUrl === null) {
    throw new ApiError(422, 'validation_failed', 'That Jira site is not allowed', [
      {
        field: 'baseUrl',
        message: 'must be https://<site>.atlassian.net or https://<site>.jira.com',
      },
    ]);
  }
  const details: { field: string; message: string }[] = [];
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (
    email.length < 3 ||
    email.length > 320 ||
    !email.includes('@') ||
    /[\s:]/u.test(email) ||
    CONTROL.test(email)
  ) {
    details.push({ field: 'email', message: 'must be the Atlassian account email' });
  }
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (token === '' || token.length > MAX_TOKEN || CONTROL.test(token)) {
    details.push({ field: 'token', message: 'must be an Atlassian API token' });
  }
  let jql = '';
  if (body.projectKey !== undefined && body.jql !== undefined) {
    details.push({ field: 'jql', message: 'send jql or projectKey, not both' });
  } else if (body.projectKey !== undefined) {
    const key = typeof body.projectKey === 'string' ? body.projectKey.trim() : '';
    if (parseIssueKey(`${key}-1`) === null) {
      details.push({ field: 'projectKey', message: 'must be a Jira project key like WEB' });
    } else {
      jql = `project = ${key} ORDER BY created ASC`;
    }
  } else if (typeof body.jql === 'string' && body.jql.trim() !== '') {
    jql = body.jql.trim();
    if (jql.length > MAX_JQL || CONTROL.test(jql.replace(/[\n\t]/gu, ' '))) {
      details.push({ field: 'jql', message: `must be ${MAX_JQL} characters or fewer` });
    }
  } else {
    details.push({ field: 'jql', message: 'send jql or projectKey' });
  }
  let startAt: number | undefined;
  if (body.startAt !== undefined && body.startAt !== null) {
    if (
      typeof body.startAt !== 'number' ||
      !Number.isInteger(body.startAt) ||
      body.startAt < 0 ||
      body.startAt > MAX_START_AT
    ) {
      details.push({ field: 'startAt', message: 'must be a whole number, 0 or more' });
    } else {
      startAt = body.startAt;
    }
  }
  let nextPageToken: string | undefined;
  if (body.nextPageToken !== undefined && body.nextPageToken !== null) {
    if (
      typeof body.nextPageToken !== 'string' ||
      body.nextPageToken === '' ||
      body.nextPageToken.length > MAX_JIRA_PAGE_TOKEN ||
      CONTROL.test(body.nextPageToken)
    ) {
      details.push({
        field: 'nextPageToken',
        message: `must be the cursor Jira returned (${MAX_JIRA_PAGE_TOKEN} characters or fewer)`,
      });
    } else if (body.startAt !== undefined && body.startAt !== null) {
      details.push({ field: 'nextPageToken', message: 'send startAt or nextPageToken, not both' });
    } else {
      nextPageToken = body.nextPageToken;
    }
  }
  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }
  return {
    baseUrl,
    email,
    token,
    jql,
    ...(startAt !== undefined ? { startAt } : {}),
    ...(nextPageToken !== undefined ? { nextPageToken } : {}),
  };
}

/** A Jira failure as an API error. The detail names the code the import web translates. */
function jiraApiError(error: JiraFetchError): ApiError {
  if (error.code === 'jira_rate_limited') {
    return new ApiError(
      429,
      'rate_limited',
      'Jira is rate limiting this site. Try again later',
      [
        { field: 'jira', message: error.code },
        { field: 'retryAfterSeconds', message: String(error.retryAfterSeconds ?? 60) },
      ],
      error.code,
    );
  }
  const field = error.code === 'jira_auth_failed' ? 'token' : 'jira';
  return new ApiError(
    422,
    'validation_failed',
    error.message,
    [{ field, message: error.code }],
    error.code,
  );
}
