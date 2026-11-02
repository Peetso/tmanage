import {
  bigint,
  boolean,
  char,
  customType,
  date,
  decimal,
  datetime,
  index,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  smallint,
  int,
  text,
  time,
  tinyint,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

/**
 * The Drizzle schema — the type-level mirror of `migrations/*.sql`.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 fixes the access layer as "Drizzle ORM
 * with the `mysql2` driver, schema-owned repositories, and explicit SQL migrations". The
 * last three words are the important ones: **this file does not create anything.** The
 * migrations are the source of truth for what exists in the database; this is a typed
 * description of it, used to build queries.
 *
 * That split is deliberate and is the opposite of the usual Drizzle workflow, where the
 * schema is authoritative and migrations are generated from it. Two reasons:
 *
 * 1. The schema carries constructs Drizzle cannot express — composite foreign keys
 *    including `organization_id` (ADR-0001 layer 1), the `organization_id` immutability
 *    triggers, and the append-only triggers on `audit_events`. A generated migration would
 *    silently omit exactly the parts tenant isolation depends on.
 * 2. `28-SPRINT-TICKETS` DATA-001 and the migrator's ledger both assume hand-written,
 *    reviewed, checksummed SQL files. A generated migration is not a reviewed one.
 *
 * The cost of two descriptions of one schema is drift. `schema.db.test.ts` pays it: it
 * reads `information_schema` from a migrated database and fails if any table, column,
 * nullability, or type here disagrees with what the migrations actually produced. Drift is
 * therefore a failing test rather than a runtime surprise.
 *
 * ## Indexes and constraints are described, not enforced, here
 *
 * The `index()` / `uniqueIndex()` declarations exist so query planning is legible next to
 * the columns and so Drizzle can name them. They are not what creates the indexes — the
 * migrations are. Composite foreign keys are not declared at all: Drizzle's `foreignKey()`
 * would express the columns but not the tenant semantics, and a half-description invites
 * the belief that the real constraint is here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Identity — global, deliberately NOT tenant-owned
// ─────────────────────────────────────────────────────────────────────────────
// A person is one user account that may hold memberships in several organizations. These
// two tables carry no `organization_id` and are absent from the guard's TENANT_TABLES
// registry, which is why an unscoped read of them is legitimate.

export const users = mysqlTable(
  'users',
  {
    id: char('id', { length: 36 }).primaryKey(),
    email: varchar('email', { length: 254 }).notNull(),
    displayName: varchar('display_name', { length: 190 }).notNull(),
    locale: varchar('locale', { length: 35 }).notNull().default('en'),
    timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
    emailVerifiedAt: datetime('email_verified_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-06 ---- 0247: disabled by a platform admin; two-step required.
    disabledAt: datetime('disabled_at', { mode: 'date', fsp: 3 }),
    disabledReason: varchar('disabled_reason', { length: 500 }),
    twoStepRequiredAt: datetime('two_step_required_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [uniqueIndex('uq_users_email').on(table.email)],
);

export const sessions = mysqlTable(
  'sessions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    userId: char('user_id', { length: 36 }).notNull(),
    /** SHA-256 hex of the **one live** refresh token. Superseded hashes move to the ledger. */
    refreshTokenHash: char('refresh_token_hash', { length: 64 }).notNull(),
    userAgent: varchar('user_agent', { length: 255 }),
    /** Absolute deadline, fixed at sign-in. Rotation issues a new token; it does not extend. */
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    rotatedAt: datetime('rotated_at', { mode: 'date', fsp: 3 }),
    revokedAt: datetime('revoked_at', { mode: 'date', fsp: 3 }),
    /** Why the session ended. Carries `refresh_reuse_detected`, which is a security finding. */
    revokedReason: varchar('revoked_reason', { length: 64 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-06 ---- 0247: first and latest address the session was used from.
    ipFirst: varchar('ip_first', { length: 45 }),
    ipLast: varchar('ip_last', { length: 45 }),
    /**
     * R3 (0271). The strictest company "Sign out after inactivity" limit this session has acted
     * under, in minutes; NULL until a company with the policy on has been used. The refresh path
     * refuses a session idle (since `coalesce(rotated_at, created_at)`) longer than this.
     */
    idleLimitMinutes: smallint('idle_limit_minutes', { unsigned: true }),
    /** R12 (0280). The `authentication_events` row of the sign-in that began this session. */
    signInEventId: char('sign_in_event_id', { length: 36 }),
  },
  (table) => [
    uniqueIndex('uq_sessions_refresh_token_hash').on(table.refreshTokenHash),
    index('ix_sessions_user_expiry').on(table.userId, table.expiresAt),
  ],
);

/**
 * Refresh-token hashes that used to be live — ID-001's reuse detector.
 *
 * Append-only in the database (triggers) and by privilege (`users.sql` grants INSERT and
 * SELECT, nothing else). A row here means "this token was rotated away"; presenting it again
 * is a replay, and the service revokes the whole session on sight.
 */
export const sessionRefreshTokens = mysqlTable(
  'session_refresh_tokens',
  {
    id: char('id', { length: 36 }).primaryKey(),
    sessionId: char('session_id', { length: 36 }).notNull(),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    issuedAt: datetime('issued_at', { mode: 'date', fsp: 3 }).notNull(),
    supersededAt: datetime('superseded_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_session_refresh_tokens_hash').on(table.tokenHash),
    index('ix_session_refresh_tokens_session').on(table.sessionId, table.supersededAt),
  ],
);

/**
 * Personal access tokens — per-member API credentials for the MCP server (0202).
 *
 * Tenant-owned (`organization_id`) and bound to one membership, but looked up tenant-free on the
 * unique `token_hash` by the Bearer authentication path — the member is what that read establishes.
 * Only the hash is stored; the plaintext is shown once at creation and never again, the posture
 * `session_refresh_tokens` takes. Registered in the guard's `TENANT_TABLES`; `scripts/db/users.sql`
 * grants the app SELECT/INSERT/UPDATE (never DELETE — revoke is the soft `revoked_at`).
 */
export const personalAccessTokens = mysqlTable(
  'personal_access_tokens',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    userId: char('user_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 190 }).notNull(),
    /** SHA-256 hex of the plaintext — the only form of the secret that reaches the database. */
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    /** The safe display hint, e.g. `tmanage_pat_a1b2c3…`; not enough to reconstruct the token. */
    tokenPrefix: varchar('token_prefix', { length: 32 }).notNull(),
    /**
     * R13 s3 (0282). Space-separated scopes (`tmanage:read tmanage:write …`, `oauth/scopes.ts`).
     * The Bearer guard refuses a route whose class the token lacks; scopes only narrow.
     */
    scopes: varchar('scopes', { length: 190 }).notNull().default('tmanage:read tmanage:write'),
    /** R13 s3 (0282). Optional JSON list of IPs / CIDR ranges; NULL or `[]` means any address. */
    ipAllowlistJson: text('ip_allowlist_json'),
    lastUsedAt: datetime('last_used_at', { mode: 'date', fsp: 3 }),
    /** R15 (0286). `hashAddress` (40 hex of SHA-256) of the address of the token's latest use. */
    lastIpHash: char('last_ip_hash', { length: 40 }),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }),
    revokedAt: datetime('revoked_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_personal_access_tokens_hash').on(table.tokenHash),
    uniqueIndex('uq_personal_access_tokens_org_id').on(table.organizationId, table.id),
    index('ix_personal_access_tokens_membership').on(
      table.organizationId,
      table.membershipId,
      table.id,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// OAuth authorization server (0208, MCP connector S7)
// ─────────────────────────────────────────────────────────────────────────────
// TManage is its own OAuth 2.1 AS so AI apps can connect without a copied key. Only hashes of
// secrets are stored; tokens are opaque and checked against these rows on every request, so a
// `revoked_at` revokes immediately. `oauth_grants` is tenant-owned (TENANT_TABLES); the other
// four are global, resolved by hash before any tenant exists (NON_TENANT_TABLES).

/** A registered (DCR) or CIMD-published OAuth client. Public clients only — no secret issued. */
export const oauthClients = mysqlTable(
  'oauth_clients',
  {
    id: char('id', { length: 36 }).primaryKey(),
    /** The OAuth `client_id`: an opaque DCR id, or a CIMD document https URL. */
    clientId: varchar('client_id', { length: 512 }).notNull(),
    /** `dcr` or `cimd`. */
    kind: varchar('kind', { length: 16 }).notNull(),
    name: varchar('name', { length: 190 }).notNull(),
    /** The exact redirect URIs, matched by string equality. */
    redirectUrisJson: json('redirect_uris_json').$type<readonly string[]>().notNull(),
    verified: boolean('verified').notNull().default(false),
    /** SHA-256 of the registering IP (for the DCR rate limit); never the raw IP. */
    createdIpHash: char('created_ip_hash', { length: 64 }),
    lastUsedAt: datetime('last_used_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [uniqueIndex('uq_oauth_clients_client_id').on(table.clientId)],
);

/** A consented authorization: one client acting as one membership in one org. Tenant-owned. */
export const oauthGrants = mysqlTable(
  'oauth_grants',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    clientPk: char('client_pk', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    userId: char('user_id', { length: 36 }).notNull(),
    /** Space-separated consented scopes, e.g. `tmanage:read tmanage:write`. */
    scopes: varchar('scopes', { length: 255 }).notNull(),
    revokedAt: datetime('revoked_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_oauth_grants_org_id').on(table.organizationId, table.id),
    index('ix_oauth_grants_membership').on(table.organizationId, table.membershipId, table.id),
    index('ix_oauth_grants_client').on(table.clientPk),
  ],
);

/** A one-time authorization code, keyed by SHA-256 hex. Single-use, 60 s, PKCE/redirect-bound. */
export const oauthCodes = mysqlTable(
  'oauth_codes',
  {
    codeHash: char('code_hash', { length: 64 }).primaryKey(),
    grantId: char('grant_id', { length: 36 }).notNull(),
    /** The PKCE S256 challenge; the verifier is checked at token time. */
    challenge: varchar('challenge', { length: 128 }).notNull(),
    redirectUri: varchar('redirect_uri', { length: 2048 }).notNull(),
    resource: varchar('resource', { length: 512 }).notNull(),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    usedAt: datetime('used_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [index('ix_oauth_codes_grant').on(table.grantId)],
);

/** An opaque access token stored as SHA-256 hex. 30 min, audience-bound to `/mcp`. Global. */
export const oauthAccessTokens = mysqlTable(
  'oauth_access_tokens',
  {
    tokenHash: char('token_hash', { length: 64 }).primaryKey(),
    grantId: char('grant_id', { length: 36 }).notNull(),
    familyId: char('family_id', { length: 36 }).notNull(),
    audience: varchar('audience', { length: 512 }).notNull(),
    scopes: varchar('scopes', { length: 255 }).notNull(),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    revokedAt: datetime('revoked_at', { mode: 'date', fsp: 3 }),
    /** Reserved for a future DPoP confirmation (`cnf.jkt`); NULL in v1. */
    cnfJkt: varchar('cnf_jkt', { length: 255 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    index('ix_oauth_access_tokens_grant').on(table.grantId),
    index('ix_oauth_access_tokens_family').on(table.familyId),
  ],
);

/** An opaque refresh token stored as SHA-256 hex. Rotates on use; reuse revokes the family. */
export const oauthRefreshTokens = mysqlTable(
  'oauth_refresh_tokens',
  {
    tokenHash: char('token_hash', { length: 64 }).primaryKey(),
    familyId: char('family_id', { length: 36 }).notNull(),
    grantId: char('grant_id', { length: 36 }).notNull(),
    /** The refresh token this one was rotated from; NULL for the first in a family. */
    parentHash: char('parent_hash', { length: 64 }),
    usedAt: datetime('used_at', { mode: 'date', fsp: 3 }),
    /** Idle expiry: now + 30 days, refreshed on each rotation. */
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    /** Absolute expiry: first-issue + 90 days, carried forward unchanged on rotation. */
    absoluteExpiresAt: datetime('absolute_expires_at', { mode: 'date', fsp: 3 }).notNull(),
    revokedAt: datetime('revoked_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    index('ix_oauth_refresh_tokens_grant').on(table.grantId),
    index('ix_oauth_refresh_tokens_family').on(table.familyId),
  ],
);

/**
 * A confirm-class AI action waiting for its member's approval (0209, MCP connector S10). The op
 * id and frozen args run once, on the server, when the same member approves. Tenant-owned.
 */
export const pendingAiActions = mysqlTable(
  'pending_ai_actions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    userId: char('user_id', { length: 36 }).notNull(),
    clientId: varchar('client_id', { length: 512 }).notNull(),
    clientName: varchar('client_name', { length: 190 }).notNull(),
    opId: varchar('op_id', { length: 120 }).notNull(),
    argsJson: json('args_json').$type<Record<string, unknown>>().notNull(),
    argsSha256: char('args_sha256', { length: 64 }).notNull(),
    /** `pending` | `approved` | `declined` | `expired` | `failed`. */
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    decidedAt: datetime('decided_at', { mode: 'date', fsp: 3 }),
    resultStatus: int('result_status'),
    resultJson: json('result_json').$type<unknown>(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_pending_ai_actions_org_id').on(table.organizationId, table.id),
    index('ix_pending_ai_actions_member').on(
      table.organizationId,
      table.membershipId,
      table.status,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Tenant root
// ─────────────────────────────────────────────────────────────────────────────
// Tenant-owned, but its tenant key is `id` rather than `organization_id` — the guard's
// registry records that exception explicitly.

export const organizations = mysqlTable(
  'organizations',
  {
    id: char('id', { length: 36 }).primaryKey(),
    slug: varchar('slug', { length: 63 }).notNull(),
    name: varchar('name', { length: 190 }).notNull(),
    defaultLocale: varchar('default_locale', { length: 35 }).notNull().default('en'),
    timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
    /** 0224 (A11). The file asset that is the organization's logo; NULL shows the initials orb. */
    logoFileId: char('logo_file_id', { length: 36 }),
    /**
     * The organization half of the context's policy-version epoch (0023). Bumped by a future
     * org-policy write, never by a rename — so an unrelated `updated_at` change no longer
     * rotates every member's cache key. Stored rather than derived from `updated_at` for
     * exactly that reason; see `membership-resolver.repository.ts`.
     */
    policyVersion: bigint('policy_version', { mode: 'number', unsigned: true })
      .notNull()
      .default(1),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    archivedAt: datetime('archived_at', { mode: 'date', fsp: 3 }),
    /** 0206. Set by the platform operator; a suspended company's members are refused. */
    suspendedAt: datetime('suspended_at', { mode: 'date', fsp: 3 }),
    // ---- platform-admin v2 · PA-07 ---- 0243: soft delete, restore window, operator overrides.
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    billingModeOverride: varchar('billing_mode_override', { length: 16 }),
    operatorNotes: text('operator_notes'),
  },
  (table) => [uniqueIndex('uq_organizations_slug').on(table.slug)],
);

export const MEMBERSHIP_STATUS = ['invited', 'active', 'suspended', 'offboarded'] as const;

export const memberships = mysqlTable(
  'memberships',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    userId: char('user_id', { length: 36 }).notNull(),
    role: varchar('role', { length: 64 }).notNull(),
    status: mysqlEnum('status', MEMBERSHIP_STATUS).notNull().default('active'),
    /** Stored rather than derived, so a policy change cannot silently widen historical scope. */
    hasOrgWideScope: boolean('has_org_wide_scope').notNull().default(false),
    /**
     * A Workspace Admin's one-workspace reach (0023). NULL is the safe default — the
     * project-membership fallback, no widening — and a workspace id means every project in that
     * workspace and nothing outside it. The middle ground `has_org_wide_scope` (a boolean) has
     * no room for; multi-workspace admins are deferred. The composite FK including
     * `organization_id` keeps the scope inside the membership's own tenant.
     */
    workspaceScopeId: char('workspace_scope_id', { length: 36 }),
    /** PA-02 (0240): the support session a hidden `platform_support` membership belongs to. */
    platformSupportSessionId: char('platform_support_session_id', { length: 36 }),
    version: bigint('version', { mode: 'number', unsigned: true }).notNull().default(1),
    /**
     * The membership half of the context's policy-version epoch (0023). Bumped on a role or
     * scope change, never by unrelated `updated_at` churn — so a stale cache key is rotated
     * exactly when the principal's authority changes and not otherwise.
     */
    policyVersion: bigint('policy_version', { mode: 'number', unsigned: true })
      .notNull()
      .default(1),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_memberships_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_memberships_org_user').on(table.organizationId, table.userId),
    index('ix_memberships_user').on(table.userId),
    // The backing index for `fk_memberships_workspace_scope_tenant` (0023). InnoDB requires an
    // index whose leftmost columns are the referencing columns; none of the indexes above is a
    // usable prefix (`uq_memberships_org_id` is `(organization_id, id)`), so adding the composite
    // FK made the engine create this one implicitly under the constraint's own name. Declared
    // here only so `schema.ts` and the migrated database agree — it adds no migration.
    index('fk_memberships_workspace_scope_tenant').on(table.organizationId, table.workspaceScopeId),
    index('ix_memberships_support').on(table.platformSupportSessionId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Work graph
// ─────────────────────────────────────────────────────────────────────────────

export const workspaces = mysqlTable(
  'workspaces',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 190 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    archivedAt: datetime('archived_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [uniqueIndex('uq_workspaces_org_id').on(table.organizationId, table.id)],
);

export const projects = mysqlTable(
  'projects',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    workspaceId: char('workspace_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 190 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    ownerUserId: char('owner_user_id', { length: 36 }),
    /**
     * Calendar dates, carried as `'YYYY-MM-DD'` strings end to end (0012). A `Date` here
     * would re-import the day-early defect the migration removed: an instant rendered in a
     * reader's own zone moves the date west of UTC, a string never does.
     */
    committedAt: date('committed_at', { mode: 'string' }),
    forecastAt: date('forecast_at', { mode: 'string' }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    archivedAt: datetime('archived_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_projects_org_id').on(table.organizationId, table.id),
    index('ix_projects_org_workspace').on(table.organizationId, table.workspaceId),
  ],
);

export const projectMemberships = mysqlTable(
  'project_memberships',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    userId: char('user_id', { length: 36 }).notNull(),
    role: varchar('role', { length: 64 }).notNull().default('member'),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_project_memberships_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_project_memberships_identity').on(
      table.organizationId,
      table.projectId,
      table.userId,
    ),
    index('ix_project_memberships_user').on(table.organizationId, table.userId),
  ],
);

/**
 * CAL-01 / MTG-01 (x90). A project meeting — a title, a start instant and an agenda note.
 *
 * Tenant-scoped and project-owned like `conversations`. `startsAt` is a `DATETIME(3)` instant,
 * not a `DATE`: a meeting starts at a point in time that is meant to move with the reader's
 * zone, unlike `projects.forecastAt` (a calendar date). No decisions/actions linkage yet — doc
 * 38's "closes with linked decisions and actions" is the next slice. `0029_meetings.sql` is the
 * source of truth; this is its typed mirror.
 */
export const meetings = mysqlTable(
  'meetings',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    startsAt: datetime('starts_at', { mode: 'date', fsp: 3 }).notNull(),
    /** Audit gap 8 (0213): the end instant; NULL = no end recorded. `> startsAt` is the API's rule. */
    endsAt: datetime('ends_at', { mode: 'date', fsp: 3 }),
    agendaNote: text('agenda_note'),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    // 0237. Every option a Google Calendar event has; see the migration for the vocabularies.
    allDay: boolean('all_day').notNull().default(false),
    timeZone: varchar('time_zone', { length: 64 }),
    location: varchar('location', { length: 512 }),
    recurrenceRrule: varchar('recurrence_rrule', { length: 1024 }),
    visibility: varchar('visibility', { length: 16 }).notNull().default('default'),
    showAs: varchar('show_as', { length: 8 }).notNull().default('busy'),
    colorId: varchar('color_id', { length: 8 }),
    conference: varchar('conference', { length: 16 }).notNull().default('none'),
    reminders: varchar('reminders', { length: 255 }),
    guestsCanModify: boolean('guests_can_modify').notNull().default(false),
    guestsCanInviteOthers: boolean('guests_can_invite_others').notNull().default(true),
    guestsCanSeeOthers: boolean('guests_can_see_others').notNull().default(true),
    cancelledAt: datetime('cancelled_at', { mode: 'date', fsp: 3 }),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_meetings_org_id').on(table.organizationId, table.id),
    index('ix_meetings_org_project').on(table.organizationId, table.projectId, table.startsAt),
  ],
);

/**
 * R5 (0272). How a document or version `body` is to be read: `markdown` (every body before R5, the
 * column default) or `html` (sanitised by the API on save, R5-SPEC §3). Mirrors the ENUM.
 */
export const DOCUMENT_BODY_FORMATS = ['markdown', 'html'] as const;
export type DocumentBodyFormat = (typeof DOCUMENT_BODY_FORMATS)[number];

/**
 * DOC-01 (x91). A project document — a title and a plain-text body.
 *
 * Tenant-scoped and project-owned like `conversations` and `meetings` (0029). `body` is `TEXT` and
 * `NOT NULL`, the choice `conversations.body` made: a document is prose a person types. No wiki
 * tree, templates, decision register, versioning/history or Context Lens yet — doc 38 marks the
 * module "MVP-lite; collaboration later", and each is a later slice. `0030_documents.sql` is the
 * source of truth; this is its typed mirror.
 */
export const documents = mysqlTable(
  'documents',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    /** R5 (0272): MEDIUMTEXT — a sanitised HTML body is heavier than Markdown. */
    body: mediumtext('body').notNull(),
    /** R5 (0272): how `body` reads — legacy Markdown or server-sanitised HTML. */
    bodyFormat: mysqlEnum('body_format', DOCUMENT_BODY_FORMATS).notNull().default('markdown'),
    /** Docs audience (0203): internal-only, or published to the project's client people. */
    audience: mysqlEnum('audience', ['internal', 'client']).notNull().default('internal'),
    publishedAt: datetime('published_at', { mode: 'date', fsp: 3 }),
    publishedByUserId: char('published_by_user_id', { length: 36 }),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    /** 0227 (F2): who last renamed the document; NULL until its first rename. */
    titleUpdatedByUserId: char('title_updated_by_user_id', { length: 36 }),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_documents_org_id').on(table.organizationId, table.id),
    index('ix_documents_org_project').on(table.organizationId, table.projectId, table.id),
    index('ix_documents_org_updated').on(table.organizationId, table.updatedAt, table.id),
  ],
);

/**
 * CLIENT-003 (x125). A project update — a `title`, a `body`, and whether it is `published` —
 * against an existing project (0041). Tenant-scoped and project-owned like `documents` (0030):
 * a client can never be shown, and an internal poster can never write, an update against
 * another studio's project, because the composite foreign key binds `(organization_id,
 * project_id)` to `projects`.
 *
 * `published` is the client-visibility gate: an update exists as soon as it is posted, but the
 * portal read selects `published = 1` only — the way `client_projections` (0031) serves
 * published-only content. Milestones, risks, the portal people page and any update
 * edit/unpublish/comment lifecycle are later slices (NEXT-SCOPES-12). `0041_project_updates.sql`
 * is the source of truth; this is its typed mirror.
 */
export const projectUpdates = mysqlTable(
  'project_updates',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    body: text('body').notNull(),
    /** A10 (0223). The milestone this update reports on; no FK — see the migration header. */
    milestoneId: char('milestone_id', { length: 36 }),
    published: boolean('published').notNull().default(false),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_project_updates_org_id').on(table.organizationId, table.id),
    index('ix_project_updates_org_project').on(
      table.organizationId,
      table.projectId,
      table.createdAt,
    ),
  ],
);

/**
 * SEC / Portal update comments (x203, module 13). An internally-posted comment on a published
 * project update (0041) — the *comment* half the 0041 header named and deferred. Append-only and
 * internal-authored: a client reading the update's timeline is shown these comments, but a client
 * reply needs a client-write capability the matrix does not yet grant (Needs-Peter), so there is
 * no author-audience column. `fk_project_update_comments_update` binds `(organization_id,
 * update_id)` to `project_updates (organization_id, id)`, so a cross-tenant `update_id` is a
 * non-existent pair — migration `0084_project_update_comments.sql` is the source of truth.
 */
export const projectUpdateComments = mysqlTable(
  'project_update_comments',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    updateId: char('update_id', { length: 36 }).notNull(),
    body: text('body').notNull(),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_project_update_comments_org_id').on(table.organizationId, table.id),
    index('ix_project_update_comments_update').on(
      table.organizationId,
      table.updateId,
      table.createdAt,
      table.id,
    ),
  ],
);

/**
 * Requests / internal comments (x299, module 11). An internally-posted comment on a client request
 * (0006) — the studio's working-notes thread alongside a request, never projected to any client or
 * portal read path. Distinct from `project_update_comments` (0084), which hangs off a published
 * project update. `parent_id` is a nullable self-reference giving one level of reply;
 * `fk_request_comments_request` binds `(organization_id, request_id)` to `client_requests
 * (organization_id, id)` and `fk_request_comments_parent` binds `(organization_id, parent_id)` to
 * this table, so a cross-tenant request or parent is a non-existent pair. Append-only: INSERT +
 * DELETE + SELECT, never UPDATE — migration `0167_request_comments.sql` is the source of truth.
 */
export const requestComments = mysqlTable(
  'request_comments',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    requestId: char('request_id', { length: 36 }).notNull(),
    parentId: char('parent_id', { length: 36 }),
    body: text('body').notNull(),
    authorMembershipId: char('author_membership_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_request_comments_org_id').on(table.organizationId, table.id),
    index('ix_request_comments_request').on(
      table.organizationId,
      table.requestId,
      table.createdAt,
      table.id,
    ),
  ],
);

/**
 * Requests / client conversation (0212, audit gap 4). The shared client <-> studio thread on a
 * client request — distinct from `request_comments`, which is internal-only. `client_visible`
 * gates the client read (a query predicate); a client always posts client-visible. Append-only:
 * INSERT + SELECT — migration `0212_request_messages.sql` is the source of truth.
 */
export const requestMessages = mysqlTable(
  'request_messages',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    requestId: char('request_id', { length: 36 }).notNull(),
    authorMembershipId: char('author_membership_id', { length: 36 }).notNull(),
    authorKind: varchar('author_kind', { length: 16 }).$type<'internal' | 'client'>().notNull(),
    body: text('body').notNull(),
    clientVisible: boolean('client_visible').notNull().default(true),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_request_messages_org_id').on(table.organizationId, table.id),
    index('ix_request_messages_request').on(
      table.organizationId,
      table.requestId,
      table.createdAt,
      table.id,
    ),
  ],
);

/**
 * A8 (0221). Files attached to a request message — the portal reply card's "Attach file". Both
 * ends are bound by composite foreign keys that include `organization_id`; append-only (INSERT +
 * SELECT, a `BEFORE UPDATE` trigger). `0221_request_message_files.sql` is the source of truth.
 */
export const requestMessageFiles = mysqlTable(
  'request_message_files',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    messageId: char('message_id', { length: 36 }).notNull(),
    requestId: char('request_id', { length: 36 }).notNull(),
    fileAssetId: char('file_asset_id', { length: 36 }).notNull(),
    attachedByMembershipId: char('attached_by_membership_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_request_message_files_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_request_message_files_edge').on(
      table.organizationId,
      table.messageId,
      table.fileAssetId,
    ),
    index('ix_request_message_files_request').on(
      table.organizationId,
      table.requestId,
      table.createdAt,
      table.id,
    ),
    index('ix_request_message_files_file').on(table.organizationId, table.fileAssetId),
  ],
);

/**
 * Portal announcements (x304, migration 0172, POR client portal). A pinned banner an internal
 * staffer posts to one client organization's portal, live for an active window.
 *
 * Distinct from `project_update_comments`/`project_updates` (a post stream) and from org-wide
 * announcements: keyed by `client_id`, not by project or org alone. Tenant-scoped and client-owned —
 * the composite foreign key binds `(organization_id, client_id)` to `client_organizations`, so a
 * banner can never reference another studio's client. Created (INSERT) and retracted (DELETE), never
 * edited: `users.sql` withholds UPDATE, so the missing privilege is the control (the `doc_bookmarks`
 * posture, no immutability trigger). The client read selects `starts_at <= now` and `ends_at` null or
 * future. `0172_portal_announcements.sql` is the source of truth; this is its typed mirror.
 */
export const portalAnnouncements = mysqlTable(
  'portal_announcements',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    clientId: char('client_id', { length: 36 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    body: text('body').notNull(),
    startsAt: datetime('starts_at', { mode: 'date', fsp: 3 }).notNull(),
    endsAt: datetime('ends_at', { mode: 'date', fsp: 3 }),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_portal_announcements_org_id').on(table.organizationId, table.id),
    index('ix_portal_announcements_org_client').on(
      table.organizationId,
      table.clientId,
      table.startsAt,
      table.id,
    ),
  ],
);

/**
 * SEC / Client portal messages (x322, module "Client portal"). A message a client contact posts to
 * the studio from the portal — a `subject` and a `body` — scoped to the client organization
 * (`client_org_scope_id`) rather than a project. In-app relay only; no email dispatch. Append-only
 * and client-authored, distinct from `projectUpdateComments` (internal-authored, on one update) and
 * from chat conversations (internal membership threads). `fk_portal_client_messages_scope` binds
 * `(organization_id, client_org_scope_id)` to `client_organizations (organization_id, id)`, so a
 * cross-tenant scope id is a non-existent pair — migration `0190_portal_client_messages.sql` is the
 * source of truth.
 */
export const portalClientMessages = mysqlTable(
  'portal_client_messages',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    clientOrgScopeId: char('client_org_scope_id', { length: 36 }).notNull(),
    authorUserId: char('author_user_id', { length: 36 }).notNull(),
    subject: varchar('subject', { length: 190 }).notNull(),
    body: text('body').notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_portal_client_messages_org_id').on(table.organizationId, table.id),
    index('ix_portal_client_messages_scope').on(
      table.organizationId,
      table.clientOrgScopeId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const PROJECT_MILESTONE_STATUSES = ['planned', 'met', 'missed'] as const;

/**
 * SEC / Portal milestones (x139). A project milestone — a `title`, a `due_on` target day, a
 * client-safe `status` (`planned | met | missed`), and whether it is `published` — against an
 * existing project (0048). Tenant-scoped and project-owned like `project_updates` (0041) and
 * reusing its mechanism: a client can never be shown, and an internal author can never write, a
 * milestone against another studio's project, because the composite foreign key binds
 * `(organization_id, project_id)` to `projects`.
 *
 * `published` is the client-visibility gate: a milestone exists as soon as it is created, but the
 * portal read selects `published = 1` only — the way `client_projections` (0031) serves
 * published-only content. `status` is 12-PERMISSION-MATRIX §4's "milestone state", a client-safe
 * fact rather than the internal work lifecycle. Risks (x140), the portal people page (x142) and
 * any milestone edit/unpublish lifecycle are later slices (NEXT-SCOPES-13).
 * `0048_project_milestones.sql` is the source of truth; this is its typed mirror.
 */
export const projectMilestones = mysqlTable(
  'project_milestones',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    /** A9 (0222). "What is delivered" — optional prose. */
    description: text('description'),
    /** A9 (0222). The person answerable for the milestone; an active member of the tenant. */
    ownerUserId: char('owner_user_id', { length: 36 }),
    dueOn: date('due_on', { mode: 'string' }),
    status: mysqlEnum('status', PROJECT_MILESTONE_STATUSES).notNull().default('planned'),
    published: boolean('published').notNull().default(false),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    /** 53-07 (0305). The date promised to the client. */
    committedOn: date('committed_on', { mode: 'string' }),
    /** 53-07 (0305). The internal forecast; never in a client payload. */
    forecastOn: date('forecast_on', { mode: 'string' }),
    /** 53-07 (0305). Manual order on the timeline. */
    timelineOrder: int('timeline_order'),
    /** 53-07 (0305). The client-safe name the published copy uses. */
    clientTitle: varchar('client_title', { length: 300 }),
    /** 53-07 (0305). Optimistic concurrency for dragged dates. */
    version: int('version').notNull().default(1),
  },
  (table) => [
    uniqueIndex('uq_project_milestones_org_id').on(table.organizationId, table.id),
    index('ix_project_milestones_org_project').on(
      table.organizationId,
      table.projectId,
      table.dueOn,
    ),
  ],
);

/**
 * PROJ / module 8 (x236). The "depends-on" edge between two project milestones — milestone A
 * depends on milestone B (B is a prerequisite of A). Deeper flow on {@link projectMilestones}
 * (x139, 0048): x139 gave a project its milestones; this table is the many-to-many dependency
 * graph between them.
 *
 * Tenant-scoped and milestone-owned like {@link objectiveWorkLinks} (0047): two composite foreign
 * keys bind `(organization_id, milestone_id)` and `(organization_id, depends_on_milestone_id)` to
 * `project_milestones`, so an edge can only ever name milestones of its own tenant. It is never
 * edited — a row is created (link) and removed (unlink) — so the runtime credential holds INSERT
 * and DELETE only. The `(organization_id, milestone_id, depends_on_milestone_id)` unique key makes
 * a duplicate link idempotent rather than a second row; self-links and cycles are rejected in the
 * service (400), an invariant the composite keys cannot express.
 * `0108_milestone_links.sql` is the source of truth; this is its typed mirror.
 */
export const milestoneLinks = mysqlTable(
  'milestone_links',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    milestoneId: char('milestone_id', { length: 36 }).notNull(),
    dependsOnMilestoneId: char('depends_on_milestone_id', { length: 36 }).notNull(),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_milestone_links_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_milestone_links_pair').on(
      table.organizationId,
      table.milestoneId,
      table.dependsOnMilestoneId,
    ),
    index('ix_milestone_links_org_milestone').on(
      table.organizationId,
      table.milestoneId,
      table.createdAt,
    ),
  ],
);

/**
 * PROJ / cross-project dependencies (x309). A directed edge: `blocker_project_id` blocks
 * `blocked_project_id` (the blocked project depends on the blocker), with an optional human `note`.
 * Tenant-scoped and project-owned; the composite foreign keys bind both ends to `projects` of the
 * same tenant, so an edge can only ever name this studio's projects. An edge is created (link) and
 * removed (unlink), never edited, so the runtime credential holds INSERT and DELETE only. The
 * `(organization_id, blocker_project_id, blocked_project_id)` unique key makes a duplicate a 409
 * rather than a second row; a self-dependency (blocker == blocked) is rejected in the service (400),
 * an invariant the composite keys cannot express. Distinct from `work_dependencies_blockers`
 * (item-level) and `milestone_links` (milestone-level). `0177_project_dependencies.sql` is the source
 * of truth; this is its typed mirror.
 */
export const projectDependencies = mysqlTable(
  'project_dependencies',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    blockerProjectId: char('blocker_project_id', { length: 36 }).notNull(),
    blockedProjectId: char('blocked_project_id', { length: 36 }).notNull(),
    note: varchar('note', { length: 500 }),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_project_dependencies_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_project_dependencies_pair').on(
      table.organizationId,
      table.blockerProjectId,
      table.blockedProjectId,
    ),
    index('ix_project_dependencies_org_blocker').on(
      table.organizationId,
      table.blockerProjectId,
      table.createdAt,
    ),
    index('ix_project_dependencies_org_blocked').on(
      table.organizationId,
      table.blockedProjectId,
      table.createdAt,
    ),
  ],
);

export const PROJECT_RISK_SEVERITIES = ['low', 'medium', 'high'] as const;
export const PROJECT_RISK_STATUSES = ['open', 'mitigated', 'closed'] as const;

/**
 * SEC / Portal risks (x140). A project risk — an internal `title`, a client-safe `severity`
 * (`low | medium | high`), a `status` (`open | mitigated | closed`), an internal-only `internal_note`
 * (the substance), a client-facing `client_summary`, and whether it is `published` — against an
 * existing project (0049). Tenant-scoped and project-owned like `project_updates` (0041) and
 * `project_milestones` (0048), reusing their mechanism: a client can never be shown, and an internal
 * author can never write, a risk against another studio's project, because the composite foreign key
 * binds `(organization_id, project_id)` to `projects`.
 *
 * `published` is the client-visibility gate: a risk exists as soon as it is created, but the portal
 * read selects `published = 1` only — the way `client_projections` (0031) serves published-only
 * content. The audience boundary is the substance of the slice: `internal_note`, `title`,
 * `created_by_user_id` and `published` are internal; the client projection carries only
 * `client_summary`, `severity` and `status`. Any risk edit/unpublish lifecycle is a later slice
 * (NEXT-SCOPES-13). `0049_project_risks.sql` is the source of truth; this is its typed mirror.
 */
export const projectRisks = mysqlTable(
  'project_risks',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    severity: mysqlEnum('severity', PROJECT_RISK_SEVERITIES).notNull().default('medium'),
    status: mysqlEnum('status', PROJECT_RISK_STATUSES).notNull().default('open'),
    internalNote: text('internal_note'),
    clientSummary: varchar('client_summary', { length: 2000 }).notNull(),
    published: boolean('published').notNull().default(false),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_project_risks_org_id').on(table.organizationId, table.id),
    index('ix_project_risks_org_project').on(
      table.organizationId,
      table.projectId,
      table.createdAt,
    ),
  ],
);

/**
 * SEC / Client portal access log (x237). The fixed vocabulary of portal resources whose access is
 * recorded — the `record()` helper passes one of these literals, never client input. Kept in step
 * with the `resource_kind` ENUM in `0109_portal_access_log.sql`.
 */
export const PORTAL_ACCESS_RESOURCE_KINDS = [
  'project',
  'work_item',
  'deliverable',
  'deliverable_file',
  'update',
] as const;
export type PortalAccessResourceKind = (typeof PORTAL_ACCESS_RESOURCE_KINDS)[number];

/**
 * SEC / Client portal access log (x237, migration 0109).
 *
 * One row per client access event: the project accessed, the client membership that accessed it,
 * the kind of resource, and the instant. Recorded by a guarded internal `record()` helper from
 * within the existing portal read paths, and read by an **internal** audit screen behind
 * `project.manage` — it is never projected to a client. The row carries nothing sensitive (a fixed
 * `resource_kind` and a timestamp), and is append-only: `0109`'s triggers refuse every UPDATE and
 * DELETE, and the runtime credential holds INSERT alone, so there is no edit path. `organization_id`
 * scopes the tenant and both foreign keys are composite, so an event can only cite a project and a
 * member of its own tenant. `0109_portal_access_log.sql` is the source of truth; this is its typed
 * mirror.
 */
export const portalAccessLog = mysqlTable(
  'portal_access_log',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    clientMemberId: char('client_member_id', { length: 36 }).notNull(),
    resourceKind: mysqlEnum('resource_kind', PORTAL_ACCESS_RESOURCE_KINDS).notNull(),
    accessedAt: datetime('accessed_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_portal_access_log_org_id').on(table.organizationId, table.id),
    index('ix_portal_access_log_org_project').on(table.organizationId, table.projectId, table.id),
  ],
);

export const MEETING_NOTE_KINDS = ['note', 'decision'] as const;

/**
 * CAL-01 / MTG-01 second slice (x105). A meeting's captured note or decision — a `kind`, a
 * `body`, an author and a time, against an existing meeting (0029).
 *
 * A decision is the same row with `kind='decision'`; a dedicated `decisions` table with its own
 * approval/lock lifecycle is deferred to x105-b (see `0033_meeting_notes.sql`). The row carries
 * no `projectId`: the relation it is read and written by is the meeting's, resolved in the
 * service, so the two can never disagree. Immutable/append-only — `0033`'s trigger refuses every
 * UPDATE and there is no edit endpoint this slice. `0033_meeting_notes.sql` is the source of
 * truth; this is its typed mirror.
 */
export const meetingNotes = mysqlTable(
  'meeting_notes',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    meetingId: char('meeting_id', { length: 36 }).notNull(),
    kind: mysqlEnum('kind', MEETING_NOTE_KINDS).notNull(),
    body: text('body').notNull(),
    authorUserId: char('author_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_meeting_notes_org_id').on(table.organizationId, table.id),
    index('ix_meeting_notes_org_meeting').on(table.organizationId, table.meetingId, table.id),
  ],
);

/** 0237 widened with `tentative` (Google "maybe", Outlook "tentatively accepted"). */
export const MEETING_ATTENDEE_RSVPS = ['invited', 'accepted', 'declined', 'tentative'] as const;

/**
 * CAL-01 / MTG-01 attendees + RSVP (x126). A meeting's invited members and their answer — a
 * `membershipId` and an `rsvp` (`invited`/`accepted`/`declined`), against an existing meeting
 * (0029). It is the attendees/RSVP half NS-11 deferred (audit: Calendar Partial).
 *
 * An attendee is named by their membership row, not a bare user id — the same identity the roster
 * uses, kept inside the tenant by the composite FK. The row carries no `projectId`: the relation it
 * is read and written by is the meeting's, resolved in the service, so the two can never disagree.
 * Identity (`organizationId`/`meetingId`/`membershipId`) is immutable at the engine; `rsvp` is the
 * one column the PATCH may change (0042's trigger pins the rest). `0042_meeting_attendees.sql` is
 * the source of truth; this is its typed mirror.
 */
export const meetingAttendees = mysqlTable(
  'meeting_attendees',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    meetingId: char('meeting_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    rsvp: mysqlEnum('rsvp', MEETING_ATTENDEE_RSVPS).notNull().default('invited'),
    /** 0237. An optional guest (Google `optional`, Outlook attendee type `optional`). */
    optional: boolean('optional').notNull().default(false),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_meeting_attendees_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_meeting_attendees_meeting_member').on(
      table.organizationId,
      table.meetingId,
      table.membershipId,
    ),
    index('ix_meeting_attendees_org_meeting').on(table.organizationId, table.meetingId, table.id),
  ],
);

/**
 * BK5 (0217). A client person invited to a meeting — named by `client_membership_id`, beside the
 * internal roster. Only client people of a company the meeting's project is shared with (checked in
 * the service). `0217_meeting_client_attendees.sql` is the source of truth; this is its typed mirror.
 */
export const meetingClientAttendees = mysqlTable(
  'meeting_client_attendees',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    meetingId: char('meeting_id', { length: 36 }).notNull(),
    clientMembershipId: char('client_membership_id', { length: 36 }).notNull(),
    rsvp: mysqlEnum('rsvp', MEETING_ATTENDEE_RSVPS).notNull().default('invited'),
    /** 0237. An optional guest (Google `optional`, Outlook attendee type `optional`). */
    optional: boolean('optional').notNull().default(false),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_meeting_client_attendees_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_meeting_client_attendees_person').on(
      table.organizationId,
      table.meetingId,
      table.clientMembershipId,
    ),
    index('ix_meeting_client_attendees_meeting').on(
      table.organizationId,
      table.meetingId,
      table.id,
    ),
    index('ix_meeting_client_attendees_member').on(
      table.organizationId,
      table.clientMembershipId,
      table.meetingId,
    ),
  ],
);

export const MEETING_RSVP_RESPONSES = ['accepted', 'declined', 'tentative'] as const;

/**
 * CAL meeting RSVP (x240). A meeting attendee's own response — `accepted`, `declined` or
 * `tentative` — against an existing meeting (0029). Distinct from `meeting_attendees` (0042): the
 * roster is an organiser inviting members; this is a member answering for themselves, so the row is
 * keyed on the caller's own `memberId` and a caller can only ever set their own.
 *
 * A responder is named by their membership row, not a bare user id — the same identity the roster
 * uses, kept inside the tenant by the composite FK. The row carries no `projectId`: the relation it
 * is read and written by is the meeting's, resolved in the service, so the two can never disagree.
 * Identity (`organizationId`/`meetingId`/`memberId`) is immutable at the engine; `response` (and
 * `updatedAt`) is what an UPDATE may change (0112's trigger pins the rest). `0112_meeting_rsvps.sql`
 * is the source of truth; this is its typed mirror.
 */
export const meetingRsvps = mysqlTable(
  'meeting_rsvps',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    meetingId: char('meeting_id', { length: 36 }).notNull(),
    memberId: char('member_id', { length: 36 }).notNull(),
    response: mysqlEnum('response', MEETING_RSVP_RESPONSES).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_meeting_rsvps_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_meeting_rsvps_meeting_member').on(
      table.organizationId,
      table.meetingId,
      table.memberId,
    ),
    index('ix_meeting_rsvps_org_meeting').on(table.organizationId, table.meetingId, table.id),
  ],
);

export const MEETING_ACTION_ITEM_STATUSES = ['open', 'done'] as const;

/**
 * CAL / MTG-03 meeting action items (x266). An action captured on a meeting (0029) — a `title`
 * (what will be done), an optional `ownerMembershipId` (who owns it) and an optional `dueOn` (when) —
 * that moves between `open` and `done`. `0033_meeting_notes.sql` deferred the linked actions
 * explicitly; this is that table.
 *
 * The row carries no `projectId`: the relation it is read and written by is the meeting's, resolved
 * in the service, so the two can never disagree. The owner, when present, is a membership row (not a
 * bare user id) kept inside the tenant by the composite FK. Identity (`organizationId`/`meetingId`)
 * is immutable at the engine; `title`/`ownerMembershipId`/`dueOn`/`status` (and `updatedAt`) are what
 * an UPDATE may change (0136's trigger pins the rest). `0136_meeting_action_items.sql` is the source
 * of truth; this is its typed mirror.
 */
export const meetingActionItems = mysqlTable(
  'meeting_action_items',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    meetingId: char('meeting_id', { length: 36 }).notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    ownerMembershipId: char('owner_membership_id', { length: 36 }),
    dueOn: date('due_on', { mode: 'string' }),
    status: mysqlEnum('status', MEETING_ACTION_ITEM_STATUSES).notNull().default('open'),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_meeting_action_items_org_id').on(table.organizationId, table.id),
    index('ix_meeting_action_items_org_meeting').on(
      table.organizationId,
      table.meetingId,
      table.id,
    ),
  ],
);

/**
 * CAL meeting time-option poll (x298). A candidate time slot an organiser proposes for a meeting
 * (0029) — one `(optionStart, optionEnd)` pair per row — so invitees can vote (`meetingTimePollVotes`)
 * on when to hold it. Parent-owned by its meeting via the composite FK; it carries no `projectId`,
 * so the relation it is read and written by is the meeting's, resolved in the service, and the two
 * can never disagree. Created and read only — no edit surface — so identity has no immutability
 * trigger (the withheld UPDATE/DELETE grant is the control). `0165_meeting_time_polls.sql` is the
 * source of truth; this is its typed mirror.
 */
export const meetingTimePolls = mysqlTable(
  'meeting_time_polls',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    meetingId: char('meeting_id', { length: 36 }).notNull(),
    optionStart: datetime('option_start', { mode: 'date', fsp: 3 }).notNull(),
    optionEnd: datetime('option_end', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_meeting_time_polls_org_id').on(table.organizationId, table.id),
    index('ix_meeting_time_polls_org_meeting').on(table.organizationId, table.meetingId, table.id),
  ],
);

export const MEETING_TIME_POLL_VOTE_CHOICES = ['yes', 'maybe', 'no'] as const;

/**
 * CAL meeting time-option poll vote (x298). An invitee's own answer — `yes`, `maybe` or `no` —
 * against one candidate slot (`meetingTimePolls`). Keyed on the caller's own `membershipId`, so a
 * caller can only ever set their own; a re-vote UPDATEs the one row (the `(organizationId, optionId,
 * membershipId)` unique key), so the PUT is idempotent. Identity is immutable at the engine; `choice`
 * (and `updatedAt`) is what an UPDATE may change (0166's trigger pins the rest). No `projectId`: the
 * relation is the option's meeting's, resolved in the service. `0166_meeting_time_poll_votes.sql` is
 * the source of truth; this is its typed mirror.
 */
export const meetingTimePollVotes = mysqlTable(
  'meeting_time_poll_votes',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    optionId: char('option_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    choice: mysqlEnum('choice', MEETING_TIME_POLL_VOTE_CHOICES).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_mtp_votes_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_mtp_votes_option_member').on(
      table.organizationId,
      table.optionId,
      table.membershipId,
    ),
    index('ix_mtp_votes_org_option').on(table.organizationId, table.optionId, table.id),
  ],
);

export const MEETING_SERIES_FREQ = ['daily', 'weekly', 'monthly'] as const;

/** The per-occurrence override kinds (x213): a moved occurrence or a cancelled one. */
export const MEETING_OCCURRENCE_OVERRIDE_STATUS = ['moved', 'cancelled'] as const;

/**
 * CAL recurrence (x129). A recurring meeting *series* — a rule, not an event: a title, a recurrence
 * `freq`, an every-N `interval` and an optional end date `until`.
 *
 * Org-scoped, NOT project-owned (unlike `meetings` 0029): a series names no project, so it is
 * read/written behind `meeting.read`/`meeting.write` at the tenant level with no project relation.
 * The occurrences it implies are expanded on read in a bounded window and never materialised — there
 * is no per-occurrence row, so nothing to override or cancel yet (deferred to NS-13). Created and
 * read, never edited or removed this slice: no `updatedAt`, the runtime credential holds INSERT
 * alone, so the withheld privilege is the control (as `saved_context` 0035). `0043_meeting_series.sql`
 * is the source of truth; this is its typed mirror. The `recurrence_interval` column is named around
 * the MySQL reserved word `interval`; the property here is `interval`.
 */
export const meetingSeries = mysqlTable(
  'meeting_series',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    freq: mysqlEnum('freq', MEETING_SERIES_FREQ).notNull(),
    interval: int('recurrence_interval', { unsigned: true }).notNull(),
    /** A calendar date carried as `'YYYY-MM-DD'` (0012), or `null` for an open-ended series. */
    until: date('until', { mode: 'string' }),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_meeting_series_org_id').on(table.organizationId, table.id),
    index('ix_meeting_series_org_id_created').on(table.organizationId, table.id),
  ],
);

/**
 * CAL per-occurrence override (x213). One row per overridden occurrence of a recurring series
 * (`meeting_series`, 0043): a `cancelled` occurrence the expansion drops, or a `moved` occurrence the
 * expansion replaces with `newDate` (and an optional `newStartTime`/`newTitle`).
 *
 * Org-scoped like its parent (a series names no project), read/written behind
 * `meeting.read`/`meeting.write`. Keyed by the ORIGINAL occurrence date so the merge over the base
 * expansion is deterministic — exactly one override per (series, original date). `POST` upserts and
 * `DELETE` removes, so unlike the series this row carries an `updatedAt`. The composite foreign key
 * (organization_id, series_id) → meeting_series binds an override to the same tenant as its series
 * (ADR-0001 layer 1). `0091_meeting_occurrence_overrides.sql` is the source of truth; this mirrors it.
 * `new_start_time` is `TIME`; the property is `newStartTime`.
 */
export const meetingOccurrenceOverrides = mysqlTable(
  'meeting_occurrence_overrides',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    seriesId: char('series_id', { length: 36 }).notNull(),
    /** The original occurrence date the rule falls on, `'YYYY-MM-DD'` (0012) — the override's key. */
    occurrenceDate: date('occurrence_date', { mode: 'string' }).notNull(),
    status: mysqlEnum('status', MEETING_OCCURRENCE_OVERRIDE_STATUS).notNull(),
    /** For a `moved` override: the new calendar date, `'YYYY-MM-DD'`, or `null`. */
    newDate: date('new_date', { mode: 'string' }),
    /** For a `moved` override: an optional new time-of-day, `'HH:MM:SS'`, or `null`. */
    newStartTime: time('new_start_time'),
    /** For a `moved` override: an optional new title, or `null`. */
    newTitle: varchar('new_title', { length: 300 }),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_meeting_occurrence_overrides_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_meeting_occurrence_overrides_series_date').on(
      table.organizationId,
      table.seriesId,
      table.occurrenceDate,
    ),
    index('ix_meeting_occurrence_overrides_org_series').on(table.organizationId, table.seriesId),
  ],
);

/** One ordered agenda item in a template: a short title and its position in the list. */
export interface MeetingAgendaTemplateItem {
  readonly title: string;
  /** 0-based position; the application assigns it from the item's index in the ordered list. */
  readonly position: number;
}

/**
 * CAL agenda templates (x314). A reusable meeting agenda — a `name` and an ordered list of items
 * (`items_json`, {@link MeetingAgendaTemplateItem}[]) — that a member applies to a meeting to seed
 * its agenda items idempotently.
 *
 * Org-scoped, NOT project-owned (like `meeting_series` 0043 and `work_forms` 0052): a template names
 * no project, so it is read/written behind `meeting.read`/`meeting.write` at the tenant level with no
 * project relation. Applying one seeds the meeting's existing per-meeting item store (`meeting_notes`
 * 0033, kind `note`) — this table holds no per-meeting row and no meeting foreign key. Created,
 * listed, edited (idempotent PUT) and removed this slice, so `updated_at` tracks the last edit and
 * the 0182 BEFORE UPDATE trigger pins the immutable identity (as `saved_views` 0034).
 * `0182_meeting_agenda_templates.sql` is the source of truth; this is its typed mirror.
 */
export const meetingAgendaTemplates = mysqlTable(
  'meeting_agenda_templates',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 300 }).notNull(),
    itemsJson: json('items_json').$type<readonly MeetingAgendaTemplateItem[]>().notNull(),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_meeting_agenda_templates_org_id').on(table.organizationId, table.id),
    index('ix_meeting_agenda_templates_org_name').on(table.organizationId, table.name, table.id),
  ],
);

/** One remembered filter: a field name and the value the saved view pins it to. */
export interface SavedViewFilter {
  readonly field: string;
  readonly value: string;
}

/**
 * WK-08. The filter/grouping/columns configuration a saved view remembers. It is echoed back to
 * the client to drive the *existing* list/board reads — this slice adds no server-side filtering
 * beyond what WORK-001/WORK-003 already expose — so it is stored, not interpreted, here.
 */
export interface SavedViewConfig {
  readonly filters: readonly SavedViewFilter[];
  /** The field the view groups by, or `null` for a flat list. */
  readonly grouping: string | null;
  /** The columns the view shows, in order. */
  readonly columns: readonly string[];
}

/**
 * WK-08 (x107). A saved Work view — a named, reusable filter/grouping/columns configuration.
 *
 * Owner- and tenant-scoped: `ownerUserId` is who may edit it and `organizationId` scopes it to
 * the studio. `projectId` is NULL-able — a view is scoped to one project or is an org-wide view.
 * `config` is the remembered configuration, echoed to the client rather than interpreted here.
 * `shared` is a single flag (private to the owner, or visible to the owning studio); column-level
 * ACLs and cross-org sharing are NEXT-SCOPES-9. `0034_saved_views.sql` is the source of truth;
 * this is its typed mirror.
 */
export const savedViews = mysqlTable(
  'saved_views',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    ownerUserId: char('owner_user_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }),
    name: varchar('name', { length: 300 }).notNull(),
    config: json('config').$type<SavedViewConfig>().notNull(),
    shared: boolean('shared').notNull().default(false),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_saved_views_org_id').on(table.organizationId, table.id),
    index('ix_saved_views_org_owner').on(table.organizationId, table.ownerUserId, table.id),
    index('ix_saved_views_org_shared').on(table.organizationId, table.shared, table.id),
  ],
);

/** SRCH saved/recent (x214). One remembered search filter — a `{ field, value }` of short handles. */
export interface SavedSearchFilter {
  readonly field: string;
  readonly value: string;
}

/** The `kind` discriminator: a named, kept search or a recorded recent query. */
export const SAVED_SEARCH_KINDS = ['saved', 'recent'] as const;
export type SavedSearchKind = (typeof SAVED_SEARCH_KINDS)[number];

/**
 * SRCH saved/recent searches (x214, migration 0092).
 *
 * One table carries both kinds, keyed by `kind`: a `'saved'` row is an explicitly-named search the
 * owner keeps (`name` set, `query_text`/`filters` what it re-runs); a `'recent'` row is a query the
 * owner recently ran (`name` NULL, recorded as a side effect of the global search, pruned to the
 * newest N). Both are **private to one user in one studio**: `organization_id` scopes the tenant and
 * `user_id` the owner, so every read, the delete and the prune carry both predicates and one member
 * never sees another's. Created and deleted, never updated — the runtime credential holds INSERT and
 * DELETE alone, so the withheld UPDATE is the control (no immutability trigger, none needed).
 * `0092_saved_searches.sql` is the source of truth; this is its typed mirror.
 */
export const savedSearches = mysqlTable(
  'saved_searches',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    userId: char('user_id', { length: 36 }).notNull(),
    kind: mysqlEnum('kind', SAVED_SEARCH_KINDS).notNull(),
    name: varchar('name', { length: 300 }),
    queryText: varchar('query_text', { length: 300 }).notNull(),
    filters: json('filters').$type<readonly SavedSearchFilter[]>().notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_saved_searches_org_id').on(table.organizationId, table.id),
    index('ix_saved_searches_org_user_kind').on(
      table.organizationId,
      table.userId,
      table.kind,
      table.createdAt,
      table.id,
    ),
  ],
);

/**
 * SRCH saved-search sharing (x272, migration 0142).
 *
 * A member may share one of their own `saved_searches` rows with the whole studio, so teammates can
 * run it, and unshare it again. This table is the sharing half only (x214 built the per-user saved
 * searches; the alert/digest half is out of scope): one row means "this saved search is shared with
 * the org". `unique (organization_id, saved_search_id)` makes a share idempotent — a saved search is
 * shared at most once — and PUT/DELETE toggle the single row. The owner who shared is recorded in
 * `shared_by_membership_id`; the authoritative owner is always resolved from `saved_searches`
 * (read-only), so only the owning member may share or unshare, a non-owner is a 403 and an unknown
 * saved search is a 404.
 *
 * Tenant-owned: `organization_id` scopes the tenant and the `(organization_id, id)` unique key is the
 * per-tenant convention. It intentionally carries **no** foreign key to `saved_searches` — the
 * dependency on x214 is a soft read (resolve-then-404), not a schema-level hard dependency — only an
 * FK to `organizations`. Created and deleted, never updated: the runtime credential holds INSERT and
 * DELETE alone. `0142_saved_search_shares.sql` is the source of truth; this is its typed mirror.
 */
export const savedSearchShares = mysqlTable(
  'saved_search_shares',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    savedSearchId: char('saved_search_id', { length: 36 }).notNull(),
    sharedByMembershipId: char('shared_by_membership_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_saved_search_shares_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_saved_search_shares_org_saved').on(table.organizationId, table.savedSearchId),
  ],
);

/**
 * Search recent history (x288, migration 0157). Search module 16.
 *
 * A member's recently-run queries, so the search box can offer a "recent" list. Tenant-scoped
 * (`organization_id`) and membership-owned (`membership_id`): every read, the clear and the
 * retention prune carry both predicates, so one member never sees or clears another's history even
 * inside the same studio. One row per `(organization_id, membership_id, query)` — a repeat refreshes
 * `created_at` rather than adding a duplicate (the INSERT … ON DUPLICATE KEY UPDATE target), and the
 * newest {@link SEARCH_HISTORY_LIMIT} are kept. Created, refreshed (`created_at` only) and deleted;
 * the `BEFORE UPDATE` trigger holds identity immutable at the engine. `0157_search_history.sql` is
 * the source of truth; this is its typed mirror.
 */
export const searchHistory = mysqlTable(
  'search_history',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    query: varchar('query', { length: 300 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_search_history_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_search_history_member_query').on(
      table.organizationId,
      table.membershipId,
      table.query,
    ),
    index('ix_search_history_member_recent').on(
      table.organizationId,
      table.membershipId,
      table.createdAt,
      table.id,
    ),
  ],
);

/**
 * SRCH quick-access pins (x290, migration 0158).
 *
 * A member's pinned indexed entities — a `work_item`, `document`, `meeting` or `project` kept for
 * quick access from the Search module. A pin stores only a **type + id reference** (`objectType`,
 * `objectId`) and a display `label` the client caches; it holds no copy of the entity, so the
 * resolver reads the target's read side later and a pin to a non-readable object renders as
 * unavailable rather than leaking it. Private to one member in one studio: `organization_id` scopes
 * the tenant and `membership_id` the owner, so every read, the pin and the unpin carry both
 * predicates and one member never sees another's. Created and removed, never updated (a repeat pin
 * refreshes the label via the write's ON DUPLICATE KEY, which the INSERT grant covers) — the runtime
 * credential holds INSERT and DELETE alone, so the withheld UPDATE is the control (no immutability
 * trigger, none needed). `uq_search_pins_member_target` is the idempotence guard the PUT relies on.
 * `0158_search_pins.sql` is the source of truth; this is its typed mirror.
 */
export const searchPins = mysqlTable(
  'search_pins',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    objectType: varchar('object_type', { length: 64 }).notNull(),
    objectId: char('object_id', { length: 36 }).notNull(),
    label: varchar('label', { length: 300 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_search_pins_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_search_pins_member_target').on(
      table.organizationId,
      table.membershipId,
      table.objectType,
      table.objectId,
    ),
    index('ix_search_pins_org_member').on(
      table.organizationId,
      table.membershipId,
      table.createdAt,
      table.id,
    ),
  ],
);

/**
 * SRCH saved scopes (x334, migration 0200). The validated filter set a scope remembers — which object
 * types to search, an optional project and an optional date window. Stored as one JSON object on each
 * `search_scopes` row; the application validates and bounds it before the write.
 */
export interface SearchScopeFilters {
  /** The search-index object kinds this scope narrows to (a subset of `work_item` | `document`). */
  readonly objectTypes: readonly string[];
  /** Optional project filter, already resolved tenant-scoped by the service before the write. */
  readonly projectId?: string;
  /** Optional ISO-date window start (inclusive). */
  readonly from?: string;
  /** Optional ISO-date window end (inclusive). */
  readonly to?: string;
}

/**
 * SRCH saved scopes (x334, migration 0200).
 *
 * A member's named, reusable search **filter scopes** — a scope is a label plus a filter set
 * (`{ objectTypes[], projectId?, from?, to? }`) that pre-filters a search before it runs. Distinct
 * from `saved_searches` (a saved query string, 0092) and `saved_search_shares` (team sharing, 0142):
 * this is a filter scope, not a query, applied by returning its filters to the search read (no new
 * query engine, no new ranking).
 *
 * Every row is **private to one member in one studio**: `organization_id` scopes the tenant and
 * `member_user_id` the owner, so every read, the create, the update and the delete carry both
 * predicates and one member never sees or changes another's scopes. `unique (organization_id,
 * member_user_id, name)` makes a scope name unique per owner (a repeat is a 409). Created, edited in
 * place (idempotent PUT) and deleted; the 0200 trigger pins the tenant and owner immutable so the
 * granted UPDATE can change only the name/filters. `0200_search_scopes.sql` is the source of truth;
 * this is its typed mirror.
 */
export const searchScopes = mysqlTable(
  'search_scopes',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    memberUserId: char('member_user_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 300 }).notNull(),
    filters: json('filters').$type<SearchScopeFilters>().notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_search_scopes_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_search_scopes_org_member_name').on(
      table.organizationId,
      table.memberUserId,
      table.name,
    ),
    index('ix_search_scopes_org_member').on(
      table.organizationId,
      table.memberUserId,
      table.createdAt,
      table.id,
    ),
  ],
);

/**
 * DOC-02/DOC-03 (x112). The append-only version history behind a `documents` row.
 *
 * Each save appends one immutable snapshot (the body as it stood, and who saved it) and bumps the
 * parent `documents.body` to match, in one transaction. A restore appends a new version whose body
 * equals a prior snapshot — forward-append, never a rewrite — so history survives. `version_no`
 * counts a document's saves from 1, monotonic per document, and the `(organization_id, document_id,
 * version_no)` unique key is the list/compare index and the racing-save concurrency guard.
 * `0036_document_versions.sql` is the source of truth; this is its typed mirror.
 */
export const documentVersions = mysqlTable(
  'document_versions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    documentId: char('document_id', { length: 36 }).notNull(),
    versionNo: int('version_no', { unsigned: true }).notNull(),
    /** R5 (0272): MEDIUMTEXT, and the format the snapshot was saved in (written once, on INSERT). */
    body: mediumtext('body').notNull(),
    bodyFormat: mysqlEnum('body_format', DOCUMENT_BODY_FORMATS).notNull().default('markdown'),
    editedByUserId: char('edited_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_document_versions_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_document_versions_org_doc_version').on(
      table.organizationId,
      table.documentId,
      table.versionNo,
    ),
  ],
);

/**
 * DOC revision history (x241). The append-only revision trail behind a `documents` row — a parallel
 * of `document_versions` (0036) kept in its own table for this slice. Each capture appends one
 * immutable snapshot (the body as it stood, and who saved it) and bumps the parent `documents.body`
 * to match, in one transaction; a restore appends a new revision whose body equals a prior snapshot
 * — forward-append, never a rewrite. `rev_no` counts a document's captures from 1, monotonic per
 * document, and the `(organization_id, doc_id, rev_no)` unique key is the list/restore index and the
 * racing-capture concurrency guard. `0113_doc_revisions.sql` is the source of truth; this is its
 * typed mirror.
 */
export const docRevisions = mysqlTable(
  'doc_revisions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    docId: char('doc_id', { length: 36 }).notNull(),
    revNo: int('rev_no', { unsigned: true }).notNull(),
    bodySnapshot: mediumtext('body_snapshot').notNull(),
    savedBy: char('saved_by', { length: 36 }).notNull(),
    savedAt: datetime('saved_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_doc_revisions_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_doc_revisions_org_doc_rev').on(table.organizationId, table.docId, table.revNo),
  ],
);

/**
 * Docs "collaboration later" (x132). A comment on a `documents` row — a body, an author membership
 * and a time, against an existing document. Document-owned and tenant-scoped like `document_versions`
 * (0036): the comment carries no `project_id`; the relation it is read and written by is the
 * document's, resolved in the service, so the two can never disagree. Append-only/immutable —
 * `0045`'s trigger refuses every UPDATE and there is no edit endpoint this slice (edit/delete,
 * resolve and anchored ranges are NEXT-SCOPES-13). `0045_document_comments.sql` is the source of
 * truth; this is its typed mirror.
 */
export const documentComments = mysqlTable(
  'document_comments',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    documentId: char('document_id', { length: 36 }).notNull(),
    authorMembershipId: char('author_membership_id', { length: 36 }).notNull(),
    body: text('body').notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
    // ---- R5 (0272): comments anchored to selected text, and resolve/reopen. ----
    /** The `mark[data-comment]` id in the body; NULL = a whole-document comment. */
    anchorId: char('anchor_id', { length: 36 }),
    /** The text that was selected when the comment was made (≤ 500). */
    anchorQuote: varchar('anchor_quote', { length: 500 }),
    /** When the thread was resolved; NULL while open. */
    resolvedAt: datetime('resolved_at', { mode: 'date', fsp: 3 }),
    resolvedByUserId: char('resolved_by_user_id', { length: 36 }),
  },
  (table) => [
    uniqueIndex('uq_document_comments_org_id').on(table.organizationId, table.id),
    index('ix_document_comments_org_document').on(table.organizationId, table.documentId, table.id),
    index('ix_document_comments_org_doc_anchor').on(
      table.organizationId,
      table.documentId,
      table.anchorId,
    ),
  ],
);

/**
 * Docs review workflow (x313). The states a review of a document may hold. `pending` at creation; a
 * decision moves it to `approved` or `changes_requested` once, and it is immutable afterwards.
 * `0181_doc_reviews.sql` is the source of truth; this mirrors its `ENUM`.
 */
export const DOC_REVIEW_STATES = ['pending', 'approved', 'changes_requested'] as const;

/**
 * Docs review workflow (x313). A request to a named reviewer to sign off on a document, and the
 * reviewer's decision. In-app record only. Distinct from `document_comments` (0045, free prose) and
 * `document_versions` (0036, the content trail): this row is the *decision* on a document. It carries
 * no `project_id`; the relation it is read and written by is the document's, resolved in the service.
 * `0181_doc_reviews.sql` is the source of truth; this is its typed mirror.
 */
export const docReviews = mysqlTable(
  'doc_reviews',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    documentId: char('document_id', { length: 36 }).notNull(),
    /** The membership the review was requested under — the service passes `context.membershipId`. */
    requestedBy: char('requested_by', { length: 36 }).notNull(),
    /** The user asked to review; a member of this tenant (composite FK in 0181). */
    reviewerUserId: char('reviewer_user_id', { length: 36 }).notNull(),
    state: mysqlEnum('state', DOC_REVIEW_STATES).notNull().default('pending'),
    /** Optional on request/approve; required on a `changes_requested` decision (enforced in code). */
    note: text('note'),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    /** NULL while pending; stamped once on decision. */
    decidedAt: datetime('decided_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_doc_reviews_org_id').on(table.organizationId, table.id),
    index('ix_doc_reviews_org_document').on(table.organizationId, table.documentId, table.id),
    index('ix_doc_reviews_org_reviewer').on(table.organizationId, table.reviewerUserId),
  ],
);

/**
 * DEC-01 (x113). The statuses a decision on the register may hold. Set at creation this slice; the
 * transitions between them are the deferred lifecycle (NEXT-SCOPES-9). `0037_decisions.sql` is the
 * source of truth; this mirrors its `ENUM`.
 */
export const DECISION_STATUSES = ['proposed', 'accepted', 'superseded'] as const;

/** A15 (0225). Who a decision is visible to; mirrors the `decisions.audience` ENUM. */
export const DECISION_AUDIENCES = ['internal', 'client_visible'] as const;

/**
 * DEC-01 (x113). A project's decision register — the cross-meeting record of what a project has
 * decided: a title, the decision in words, its status, who took it and when, and an optional link to
 * the meeting it was taken in.
 *
 * Tenant-scoped and project-owned like `meetings` (0029) and `documents` (0030). `meetingId` is
 * nullable — a decision may be taken outside any meeting — and, when set, is bound to the same
 * tenant by the composite foreign key. `decidedAt` is a `DATETIME(3)` instant like
 * `meetings.startsAt`, not a calendar `DATE`. Append-only this slice (no edit surface); the
 * lifecycle (status transitions, supersede edges, linked actions) is a later slice.
 * `0037_decisions.sql` is the source of truth; this is its typed mirror.
 */
export const decisions = mysqlTable(
  'decisions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    meetingId: char('meeting_id', { length: 36 }),
    title: varchar('title', { length: 300 }).notNull(),
    statement: text('statement').notNull(),
    status: mysqlEnum('status', DECISION_STATUSES).notNull().default('proposed'),
    /** A15 (0225). The per-organization register number printed as `DEC-014`. */
    number: int('number', { unsigned: true }),
    /** A15 (0225). "Why we decided this" — optional prose. */
    rationale: text('rationale'),
    /** A15 (0225). The chat message the decision came from, resolved in-tenant by the service. */
    sourceMessageId: char('source_message_id', { length: 36 }),
    /** A15 (0225). "Visible to": the team only, or the team and the project's client people. */
    audience: mysqlEnum('audience', DECISION_AUDIENCES).notNull().default('internal'),
    decidedBy: char('decided_by', { length: 36 }).notNull(),
    decidedAt: datetime('decided_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_decisions_org_id').on(table.organizationId, table.id),
    index('ix_decisions_org_project').on(table.organizationId, table.projectId, table.decidedAt),
  ],
);

/**
 * DEC-01-b / DEC-02 (x117). The decision supersede-chain edge — the record of *by which* decision a
 * decision was superseded. 0037 has the `superseded` status value but nothing that says what
 * superseded it; this table is that "by which".
 *
 * Both ends are decisions of the acting tenant, bound by composite foreign keys on
 * `(organization_id, decision_id)` and `(organization_id, superseded_by_decision_id)`, so an edge
 * can never cross a tenant boundary. A decision is superseded at most once
 * (`uq_decision_supersessions_org_decision`) and can never supersede itself
 * (`chk_decision_supersessions_not_self`). Immutable once written, like the decision it records.
 * `0038_decision_supersessions.sql` is the source of truth; this is its typed mirror.
 */
export const decisionSupersessions = mysqlTable(
  'decision_supersessions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    decisionId: char('decision_id', { length: 36 }).notNull(),
    supersededByDecisionId: char('superseded_by_decision_id', { length: 36 }).notNull(),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_decision_supersessions_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_decision_supersessions_org_decision').on(
      table.organizationId,
      table.decisionId,
    ),
    index('ix_decision_supersessions_org_by').on(
      table.organizationId,
      table.supersededByDecisionId,
    ),
  ],
);

/**
 * DEC / module 12 (x149). The edge from a decision to the work item it drives — the "linked actions"
 * a decision spawns, recorded so the register can show what a decision set in motion.
 *
 * Both ends are of the acting tenant, bound by composite foreign keys on
 * `(organization_id, decision_id)` → `decisions (organization_id, id)` and
 * `(organization_id, work_item_id)` → `work_items (organization_id, id)`, so an edge can never cross a
 * tenant boundary even when both ids exist individually. The `(decision, work item)` pair is unique
 * (`uq_decision_work_links_pair`) so a decision links a work item at most once; the service resolves
 * both ids tenant- and project-scoped before the write (the Known-trap order) and this key is the
 * backstop for a race the pre-check cannot see. A link is a removable planning edge — created (link)
 * and removed (unlink), never edited — so the runtime credential holds INSERT and DELETE and no
 * UPDATE, the posture `objective_work_links` carries. `0055_decision_work_links.sql` is the source of
 * truth; this is its typed mirror.
 */
export const decisionWorkLinks = mysqlTable(
  'decision_work_links',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    decisionId: char('decision_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_decision_work_links_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_decision_work_links_pair').on(
      table.organizationId,
      table.decisionId,
      table.workItemId,
    ),
    index('ix_decision_work_links_org_decision').on(
      table.organizationId,
      table.decisionId,
      table.createdAt,
    ),
  ],
);

/**
 * SEC / Decisions (x150, migration 0056). The decision-lock record — the durable, append-only fact
 * that a decision has been sealed against further lifecycle writes: by whom (`locked_by`) and when
 * (`locked_at`). One per decision (`uq_decision_locks_org_decision`), bound to a decision of the
 * acting tenant by the composite foreign key on `(organization_id, decision_id)`, so a lock can never
 * cross a tenant boundary. Immutable once written — there is no unlock this slice (NEXT-SCOPES-13).
 * `0056_decision_locks.sql` is the source of truth; this is its typed mirror.
 */
export const decisionLocks = mysqlTable(
  'decision_locks',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    decisionId: char('decision_id', { length: 36 }).notNull(),
    lockedBy: char('locked_by', { length: 36 }).notNull(),
    lockedAt: datetime('locked_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_decision_locks_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_decision_locks_org_decision').on(table.organizationId, table.decisionId),
  ],
);

/**
 * x317. An internal comment on a decision (register discussion) — a body of prose, the membership
 * that wrote it, and a time, against an existing decision. Listed oldest-first; a member may delete
 * their own. Decision-owned and tenant-scoped like `decision_supersessions` (0038): the relation it
 * is read and written by is the decision's project, resolved in the service, so there is no
 * `project_id` column to drift. Never edited in place (the 0185 trigger refuses UPDATE), deletable
 * by its author. `0185_decision_comments.sql` is the source of truth; this is its typed mirror.
 */
export const decisionComments = mysqlTable(
  'decision_comments',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    decisionId: char('decision_id', { length: 36 }).notNull(),
    authorMembershipId: char('author_membership_id', { length: 36 }).notNull(),
    body: text('body').notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_decision_comments_org_id').on(table.organizationId, table.id),
    index('ix_decision_comments_org_decision').on(
      table.organizationId,
      table.decisionId,
      table.createdAt,
      table.id,
    ),
  ],
);

/**
 * DOC-04/ADM-06 (x119). An org-scoped document template — a name, a purpose, and a reusable body a
 * person applies to a project to seed a new `documents` row.
 *
 * Unlike `documents`, a template belongs to the organization, not a project: there is no
 * `project_id`. Applying a template creates an ordinary document in a project (see the docs
 * service); the template is never moved or mutated by an apply. No variable substitution or
 * per-template permission yet (DOC-04 advanced, deferred). `0039_document_templates.sql` is the
 * source of truth; this is its typed mirror.
 */
export const documentTemplates = mysqlTable(
  'document_templates',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 300 }).notNull(),
    purpose: varchar('purpose', { length: 300 }).notNull(),
    body: text('body').notNull(),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_document_templates_org_id').on(table.organizationId, table.id),
    index('ix_document_templates_org_name').on(table.organizationId, table.name, table.id),
  ],
);

/**
 * Automations (x167). A cron-like schedule for a workflow template — when a template should run on
 * its own. Tenant-owned and keyed to a `workflow_templates` row (x162, migration 0063) by a
 * composite key that includes `organization_id`, so a schedule can never cross a tenant boundary.
 *
 * `specJson` is the recurrence (`{ interval, hour?, dayOfWeek? }`), read and written whole; its shape
 * and bounds are the application's (`next-run.ts`). `nextRunAt` is computed deterministically at write
 * time; a dispatcher that fires runs is worker infrastructure (Needs-Peter), out of this slice.
 * `0067_automation_schedules.sql` is the source of truth; this is its typed mirror.
 */
export const automationSchedules = mysqlTable(
  'automation_schedules',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    templateId: char('template_id', { length: 36 }).notNull(),
    specJson: json('spec_json').notNull(),
    nextRunAt: datetime('next_run_at', { mode: 'date', fsp: 3 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_automation_schedules_org_id').on(table.organizationId, table.id),
    index('ix_automation_schedules_org_next').on(table.organizationId, table.nextRunAt, table.id),
  ],
);

/**
 * Billing usage alerts (module 19, x200). The metered dimensions a usage-alert rule may watch,
 * mirroring the application allowlist in `usage-alerts.controller.ts`. Stored as a short `VARCHAR`
 * (not a DB `ENUM`) so the set can grow without an `ALTER TABLE`; the column only ever holds a token
 * from here, validated before any write.
 */
export const BILLING_USAGE_ALERT_METRICS = ['seats', 'storage', 'api'] as const;

/**
 * Billing & entitlements (module 19, x200). An org-scoped usage-alert rule — a `metric`
 * (seats/storage/api), a `threshold_percent` (1–100), and whether it is `active`. Tenant-owned and
 * org-scoped like `workflow_templates` (0063): no `project_id`, the tenant key is `organization_id`
 * bound to `organizations`, and `(organization_id, metric)` is unique so an organization holds at most
 * one rule per metric. `metric`, `organization_id` and `created_by` are immutable at the engine (0083
 * trigger); `threshold_percent` and `active` are the two columns the update path may change.
 * `0083_billing_usage_alerts.sql` is the source of truth; this is its typed mirror.
 */
export const billingUsageAlerts = mysqlTable(
  'billing_usage_alerts',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    metric: varchar('metric', { length: 32 }).notNull(),
    thresholdPercent: smallint('threshold_percent', { unsigned: true }).notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_billing_usage_alerts_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_billing_usage_alerts_org_metric').on(table.organizationId, table.metric),
  ],
);

/** The two row kinds a `billing_cost_centers` row can be, mirroring the `0150` `ENUM`. */
export const BILLING_COST_CENTER_ROW_KINDS = ['def', 'assignment'] as const;

/**
 * Billing & entitlements (module 19, x281). An org-scoped billing cost center and its project
 * assignments, held in one table discriminated by `row_kind` (0150 is the source of truth): a `def`
 * row carries the display `name` for a `code` (one per `(organization_id, code)`, enforced through the
 * `def_code` column, trigger-maintained by `trg_billing_cost_centers_def_code_ins`/`_upd`), and an
 * `assignment` row shares that `code` and sets a
 * `project_id` (one per `(organization_id, code, project_id)`). Org-scoped like `billing_usage_alerts`
 * (0083): no `project_id` on the tenant key, which is `organization_id` bound to `organizations`. Rows
 * are only ever inserted or deleted — never updated — so there is no application update path; the
 * only triggers are the two that keep `def_code`.
 */
export const billingCostCenters = mysqlTable(
  'billing_cost_centers',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    rowKind: mysqlEnum('row_kind', BILLING_COST_CENTER_ROW_KINDS).notNull(),
    code: varchar('code', { length: 64 }).notNull(),
    /** Present on a `def` row; NULL on an `assignment` row. */
    name: varchar('name', { length: 190 }),
    /** Present on an `assignment` row; NULL on a `def` row. */
    projectId: char('project_id', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    /**
     * Trigger-maintained by `trg_billing_cost_centers_def_code_ins`/`_upd` (the code for a `def` row,
     * NULL otherwise); never written by the application.
     */
    defCode: varchar('def_code', { length: 64 }),
  },
  (table) => [
    uniqueIndex('uq_billing_cost_centers_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_billing_cost_centers_def').on(table.organizationId, table.defCode),
    uniqueIndex('uq_billing_cost_centers_assignment').on(
      table.organizationId,
      table.code,
      table.projectId,
    ),
    index('ix_billing_cost_centers_org_code').on(table.organizationId, table.code),
  ],
);

/**
 * BILLING / module 19 (x226). An org-scoped manual credit / adjustment ledger entry — a signed
 * `amount` in integer minor units (a positive credit or a negative adjustment), a free-text `reason`,
 * and who posted it and when. Tenant-owned and org-scoped like `billing_usage_alerts` (0083) and
 * `billing_contacts` (0082): no `project_id`, the tenant key is `organization_id` bound to
 * `organizations`. Append-only — a posted credit is immutable (no `updated_at`, no update path; the
 * runtime is granted INSERT and SELECT only), and the running balance is summed in-app, never stored
 * and never a settlement. `0100_billing_credits.sql` is the source of truth; this is its typed mirror.
 */
export const billingCredits = mysqlTable(
  'billing_credits',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    amount: int('amount').notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [uniqueIndex('uq_billing_credits_org_id').on(table.organizationId, table.id)],
);

/**
 * The purchase-order status set, mirroring the `0151` `ENUM`. A PO reference is `open` at creation and
 * its lifecycle transitions to `closed` (idempotently) through the close path.
 */
export const BILLING_PURCHASE_ORDER_STATUSES = ['open', 'closed'] as const;

/**
 * Billing & entitlements (module 19, x282). An org-scoped purchase-order (PO) reference — a
 * `po_number` (unique per organization), an optional `amount_minor` in the smallest unit of an
 * optional ISO-4217 `currency`, an optional `note`, and an open/closed `status`. Tenant-owned and
 * org-scoped like `billing_usage_alerts` (0083): no `project_id`, the tenant key is `organization_id`
 * bound to `organizations`, and `(organization_id, po_number)` is unique so an organization holds at
 * most one row per number. `organization_id` and `po_number` are immutable at the engine (0151
 * trigger); `status` is the one column the close path changes. It is a record, never a payment.
 * `0151_billing_purchase_orders.sql` is the source of truth; this is its typed mirror.
 */
export const billingPurchaseOrders = mysqlTable(
  'billing_purchase_orders',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    poNumber: varchar('po_number', { length: 128 }).notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number', unsigned: true }),
    currency: char('currency', { length: 3 }),
    note: varchar('note', { length: 500 }),
    status: mysqlEnum('status', BILLING_PURCHASE_ORDER_STATUSES).notNull().default('open'),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_billing_purchase_orders_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_billing_purchase_orders_org_number').on(table.organizationId, table.poNumber),
  ],
);

/**
 * The plan-change-request lifecycle, mirroring the `0153` ENUM. A request is `pending` at creation and
 * transitions once to `cancelled`; the `0153` trigger forbids the reverse move at the engine.
 */
export const PLAN_CHANGE_REQUEST_STATUSES = ['pending', 'cancelled'] as const;

/**
 * Billing & entitlements (module 19, x284). An organization's plan-change requests — a recorded intent
 * to move to another plan: the `target_plan_code` (validated against the application plan catalog),
 * the `effective_on` date, an optional `note`, and a `status`. A recorded intent only — nothing here
 * charges, calls a provider, or changes an entitlement.
 *
 * Org-scoped like `billing_usage_alerts` (0083): the tenant key is `organization_id` alone (no
 * project). At most one `pending` request per organization — the app checks inside the create
 * transaction (a second POST while pending is a 409) and the `0153` `pending_guard` column (kept by
 * the `trg_billing_plan_change_requests_pending_guard` trigger)
 * carries a UNIQUE key so the engine refuses a second pending row under a race. Identity is immutable;
 * only `status` is editable (`pending → cancelled`), pinned by the `0153` trigger.
 * `0153_billing_plan_change_requests.sql` is the source of truth; this is its typed mirror. The
 * engine-internal, trigger-maintained `pending_guard` column is mirrored here (as `active_item` on
 * `work_blockers` and `def_code` on `billing_cost_centers` are) so the schema names exactly the
 * columns the migrated database has — the app never reads or writes it.
 */
export const billingPlanChangeRequests = mysqlTable(
  'billing_plan_change_requests',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    targetPlanCode: varchar('target_plan_code', { length: 64 }).notNull(),
    effectiveOn: date('effective_on', { mode: 'string' }).notNull(),
    note: text('note'),
    status: mysqlEnum('status', PLAN_CHANGE_REQUEST_STATUSES).notNull().default('pending'),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    /**
     * Trigger-maintained by `trg_billing_plan_change_requests_pending_guard`; never written by the
     * application. See the migration.
     */
    pendingGuard: char('pending_guard', { length: 36 }),
  },
  (table) => [
    uniqueIndex('uq_billing_plan_change_requests_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_billing_plan_change_requests_pending').on(table.pendingGuard),
    index('ix_billing_plan_change_requests_org_created').on(table.organizationId, table.createdAt),
  ],
);

/**
 * BILLING / module 19 (x330). An org-scoped discount / adjustment record — a `label`, a `kind`
 * (`percent` or `fixed`), an integer `amount` (a whole percentage 0..100, or a non-negative fixed
 * amount in integer minor units) and an optional `expiresOn`. Tenant-owned and org-scoped like
 * `billing_credits` (0100) and `billing_usage_alerts` (0083): no `project_id`, the tenant key is
 * `organization_id` bound to `organizations`. Records only — a discount is created and deleted, never
 * edited (no `updated_at`; the runtime is granted INSERT and DELETE only). Whether a record is active or
 * expired is decided on the read side against the process clock, never stored, and nothing here moves
 * money or settles a charge. `0197_billing_discounts.sql` is the source of truth; this is its typed
 * mirror.
 */
export const billingDiscounts = mysqlTable(
  'billing_discounts',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    label: varchar('label', { length: 200 }).notNull(),
    kind: varchar('kind', { length: 16 }).notNull(),
    amount: int('amount').notNull(),
    expiresOn: date('expires_on', { mode: 'string' }),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [uniqueIndex('uq_billing_discounts_org_id').on(table.organizationId, table.id)],
);

/**
 * The project-objective status set, mirroring the `0040` `ENUM`. An objective is `open` at creation
 * and its lifecycle transitions to `met` or `missed`.
 */
export const PROJECT_OBJECTIVE_STATUSES = ['open', 'met', 'missed'] as const;

/**
 * PROJ / module 8 (x124). A project's objectives — the record of what a project is aiming at: a
 * name, an optional description and target, its status, and who created it and when.
 *
 * Tenant-scoped and project-owned like `meetings` (0029), `documents` (0030) and `decisions` (0037).
 * Unlike the append-only registers, an objective has a lifecycle (`open → met | missed`), so `status`
 * may change; the `0040` column-pinning trigger pins every other column at the engine.
 * `0040_project_objectives.sql` is the source of truth; this is its typed mirror.
 */
export const projectObjectives = mysqlTable(
  'project_objectives',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 300 }).notNull(),
    description: text('description'),
    target: varchar('target', { length: 300 }),
    status: mysqlEnum('status', PROJECT_OBJECTIVE_STATUSES).notNull().default('open'),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_project_objectives_org_id').on(table.organizationId, table.id),
    index('ix_project_objectives_org_project').on(
      table.organizationId,
      table.projectId,
      table.createdAt,
    ),
  ],
);

/** PROJ / module 8 (x209). The two axes of the internal risk matrix — a fixed three-point scale. */
export const PROJECT_INTERNAL_RISK_LIKELIHOODS = ['low', 'medium', 'high'] as const;
export const PROJECT_INTERNAL_RISK_IMPACTS = ['low', 'medium', 'high'] as const;
/** PROJ / module 8 (x209). Where a logged risk sits in its lifecycle. */
export const PROJECT_INTERNAL_RISK_STATUSES = [
  'open',
  'mitigating',
  'mitigated',
  'closed',
] as const;

/**
 * PROJ / module 8 (x209). A project's **internal** risk register — distinct from `project_risks`
 * (0049, x140), which is the clients-module surface that publishes a `severity` + `client_summary`
 * to a client's portal. This table is internal-only: a `title`, a `likelihood` and an `impact` (the
 * two axes of a risk matrix), an optional `mitigation` plan, a lifecycle `status`, and who logged it
 * and when. `severity` is deliberately NOT a column — it is computed from `likelihood` × `impact` in
 * the service, so the matrix is the single source of truth. This register is never projected to a
 * client (no `client_summary`, no `published`; the portal service does not read it).
 *
 * Tenant-scoped and project-owned like `project_objectives` (0040) and `project_milestones` (0048):
 * the composite foreign key binds `(organization_id, project_id)` to `projects`. Its identity columns
 * are pinned by the `0088` `BEFORE UPDATE` trigger; its substance is editable.
 * `0088_project_internal_risks.sql` is the source of truth; this is its typed mirror.
 */
export const projectInternalRisks = mysqlTable(
  'project_internal_risks',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    likelihood: mysqlEnum('likelihood', PROJECT_INTERNAL_RISK_LIKELIHOODS)
      .notNull()
      .default('medium'),
    impact: mysqlEnum('impact', PROJECT_INTERNAL_RISK_IMPACTS).notNull().default('medium'),
    mitigation: text('mitigation'),
    status: mysqlEnum('status', PROJECT_INTERNAL_RISK_STATUSES).notNull().default('open'),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_project_internal_risks_org_id').on(table.organizationId, table.id),
    index('ix_project_internal_risks_org_project').on(
      table.organizationId,
      table.projectId,
      table.createdAt,
    ),
  ],
);

/** PROJ / module 8 (x235). The status bands an internal project status update may record. */
export const PROJECT_STATUS_BANDS = ['on_track', 'at_risk', 'off_track'] as const;

/**
 * PROJ / module 8 (x235). A project's **internal** status-update log — distinct from `project_updates`
 * (0041, x125), which is the clients-module surface that publishes an update to a client's portal.
 * This table is the studio's own running changelog of where a project stands: a `status_band`
 * (`on_track` / `at_risk` / `off_track`), a free-text `body`, and who posted it and when. It is never
 * projected to a client (no `published`, no `client_summary`; the portal service does not read it).
 *
 * Tenant-scoped and project-owned like `project_objectives` (0040), `project_milestones` (0048) and
 * `project_internal_risks` (0088): the composite foreign key binds `(organization_id, project_id)` to
 * `projects`. A status update is a point-in-time post — the whole row is immutable; the `0107`
 * `BEFORE UPDATE` trigger refuses every UPDATE and the runtime credential is granted INSERT only.
 * `0107_project_status_updates.sql` is the source of truth; this is its typed mirror.
 */
export const projectStatusUpdates = mysqlTable(
  'project_status_updates',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    statusBand: mysqlEnum('status_band', PROJECT_STATUS_BANDS).notNull().default('on_track'),
    body: text('body').notNull(),
    postedBy: char('posted_by', { length: 36 }).notNull(),
    postedAt: datetime('posted_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_project_status_updates_org_id').on(table.organizationId, table.id),
    index('ix_project_status_updates_org_project').on(
      table.organizationId,
      table.projectId,
      table.postedAt,
      table.id,
    ),
  ],
);

/** PROJ / module 8 (x310). Whether a `project_custom_fields` row is a field definition or a value. */
export const PROJECT_CUSTOM_FIELD_ROW_KINDS = ['definition', 'value'] as const;

/** PROJ / module 8 (x310). The value type a project custom field declares. */
export const PROJECT_CUSTOM_FIELD_TYPES = ['text', 'number', 'select'] as const;

/**
 * PROJ / module 8 (x310). An organization's custom fields for projects — one table with a `rowKind`
 * discriminator (the x294/x306 precedent): a `definition` row declares a field for the whole tenant
 * (`fieldKey`, `name`, `fieldType`, `optionsJson`), and a `value` row is one project's value for a
 * field.
 *
 * A definition carries the empty sentinel `''` in `projectId` (never NULL) so the unique key
 * `(organizationId, projectId, fieldKey)` enforces one definition per key and one value per field per
 * project in a single index. There is no composite foreign key on a value's project: `projectId` is
 * `''` for definitions, which is not a project, so the service resolves the project tenant-scoped
 * before the write (the `inboxSnoozes` posture). `0178_project_custom_fields.sql` is the source of
 * truth; this is its typed mirror.
 */
export const projectCustomFields = mysqlTable(
  'project_custom_fields',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    rowKind: mysqlEnum('row_kind', PROJECT_CUSTOM_FIELD_ROW_KINDS).notNull(),
    projectId: char('project_id', { length: 36 }).notNull().default(''),
    fieldKey: varchar('field_key', { length: 120 }).notNull(),
    name: varchar('name', { length: 200 }),
    fieldType: mysqlEnum('field_type', PROJECT_CUSTOM_FIELD_TYPES),
    optionsJson: json('options_json').$type<readonly string[]>(),
    valueText: text('value_text'),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_project_custom_fields_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_project_custom_fields_scope').on(
      table.organizationId,
      table.projectId,
      table.fieldKey,
    ),
    index('ix_project_custom_fields_org_kind_project').on(
      table.organizationId,
      table.rowKind,
      table.projectId,
      table.fieldKey,
    ),
  ],
);

/** PROJ / module 8 (x311). The retrospective categories a project retro note may be filed under. */
export const PROJECT_RETRO_NOTE_CATEGORIES = ['went_well', 'to_improve', 'action'] as const;

/**
 * PROJ / module 8 (x311). A project's retrospective-notes log — a categorised reflection captured
 * during a retro. Each note is filed under one of `went_well` / `to_improve` / `action`, carries a
 * free-text `body`, and may optionally reference the `project_milestones` row the retro was held for
 * (`milestone_id` NULL when the note is about the project as a whole).
 *
 * Distinct from `project_status_updates` (0107, x235), the studio's status-band changelog, and from
 * `project_update_comments` (0084), threaded discussion under a published client update: a retro note
 * is an append-oriented, categorised reflection with no status and no assignment. It is deletable
 * (unlike the immutable status log): the runtime credential holds INSERT, DELETE and SELECT.
 *
 * Tenant-scoped and project-owned: the composite foreign key binds `(organization_id, project_id)` to
 * `projects`, and the optional `(organization_id, milestone_id)` to `project_milestones`, so both
 * always resolve inside the note's own tenant. `0179_project_retro_notes.sql` is the source of truth;
 * this is its typed mirror.
 */
export const projectRetroNotes = mysqlTable(
  'project_retro_notes',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    milestoneId: char('milestone_id', { length: 36 }),
    category: mysqlEnum('category', PROJECT_RETRO_NOTE_CATEGORIES).notNull(),
    body: text('body').notNull(),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_project_retro_notes_org_id').on(table.organizationId, table.id),
    index('ix_project_retro_notes_org_project').on(
      table.organizationId,
      table.projectId,
      table.createdAt,
      table.id,
    ),
  ],
);

/** A9 (0222). One milestone a template copies; `offsetDays` counts from the project's start date. */
export interface ProjectTemplateMilestone {
  readonly title: string;
  readonly offsetDays: number;
  readonly description?: string;
  readonly clientVisible?: boolean;
}

/** A9 (0222). One work item a template copies; `offsetDays` (optional) sets its due date. */
export interface ProjectTemplateWorkItem {
  readonly title: string;
  readonly offsetDays?: number;
}

/** A9 (0222). Mirrors the `project_templates.repeat_interval` ENUM. */
export const PROJECT_TEMPLATE_REPEAT_INTERVALS = ['monthly'] as const;

/**
 * PROJ / module 8 (x234). A reusable project template — a saved shape a studio can stamp out a new
 * project from: a `name`, an optional `description`, and the objective titles a project made from the
 * template should start with (`default_objectives_json`).
 *
 * Org-scoped, not project-owned: unlike {@link projectObjectives} (0040) or {@link projectInternalRisks}
 * (0088) there is no `project_id` — a template belongs to the organization, and authorization is
 * org-scoped (`project.manage`) rather than relation-gated on a project. `(organization_id, name)` is
 * unique (a template name is unique within its tenant; the create path maps a collision to 409), and
 * `(organization_id, created_at)` is the order templates are listed by. The runtime credential holds
 * INSERT only (no edit route this slice). `0106_project_templates.sql` is the source of truth; this is
 * its typed mirror.
 */
export const projectTemplates = mysqlTable(
  'project_templates',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 190 }).notNull(),
    description: text('description'),
    defaultObjectivesJson: json('default_objectives_json').$type<readonly string[]>(),
    /** A9 (0222). The milestones a project made from the template starts with. */
    milestonesJson: json('milestones_json').$type<readonly ProjectTemplateMilestone[]>(),
    /** A9 (0222). The work items a project made from the template starts with. */
    workItemsJson: json('work_items_json').$type<readonly ProjectTemplateWorkItem[]>(),
    /** A9 (0222). Whether a project made from it is shared with the chosen client. */
    clientPortalOn: boolean('client_portal_on').notNull().default(false),
    /** A9 (0222). `monthly` for a retainer; NULL for a one-off project. */
    repeatInterval: mysqlEnum('repeat_interval', PROJECT_TEMPLATE_REPEAT_INTERVALS),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_project_templates_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_project_templates_org_name').on(table.organizationId, table.name),
    index('ix_project_templates_org_created').on(table.organizationId, table.createdAt),
  ],
);

/**
 * PROJ / project detail (x293). A project's planned budget — effort (`budgetMinutes`) and/or an
 * amount (`budgetAmountMinor` + `currency`) — read back against the effort already tracked on the
 * project's work items (`work_item_time_logs`, 0103). One row per project, keyed
 * `(organization_id, project_id)`, upserted `INSERT ... ON DUPLICATE KEY UPDATE`.
 *
 * Budget effort is stored in **minutes**, the same unit `work_item_time_logs.minutes` uses, so the
 * budget-vs-tracked arithmetic is exact integer subtraction; the API speaks in hours and the service
 * converts at the edge. The amount is a plain planning figure — numbers only, never charged, no
 * ledger, no rate. Identity columns are pinned by the `0160` `BEFORE UPDATE` trigger; the substance
 * (`budgetMinutes`, `budgetAmountMinor`, `currency`, `updatedAt`) is editable.
 * `0160_project_budgets.sql` is the source of truth; this is its typed mirror.
 */
export const projectBudgets = mysqlTable(
  'project_budgets',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    budgetMinutes: int('budget_minutes', { unsigned: true }),
    budgetAmountMinor: bigint('budget_amount_minor', { mode: 'number', unsigned: true }),
    currency: char('currency', { length: 3 }),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- 52-05 (0291) burn ----
    /** `hours` | `money` | `both`, checked in the application. */
    budgetType: varchar('budget_type', { length: 8 }).notNull().default('hours'),
    includeExpenses: boolean('include_expenses').notNull().default(true),
    clientVisible: boolean('client_visible').notNull().default(false),
    /** One to four whole percents, ascending, comma-separated. */
    alertThresholds: varchar('alert_thresholds', { length: 32 }).notNull().default('70,85,95,100'),
    lastAlertBp: int('last_alert_bp').notNull().default(0),
    usedMinutesCache: int('used_minutes_cache').notNull().default(0),
    usedAmountCacheMinor: bigint('used_amount_cache_minor', { mode: 'number' })
      .notNull()
      .default(0),
    cacheRefreshedAt: datetime('cache_refreshed_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_project_budgets_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_project_budgets_org_project').on(table.organizationId, table.projectId),
  ],
);

/**
 * PROJ / module 8 (x294). A project's timeline **phases** — named, ordered columns a project
 * manager groups milestones into.
 *
 * `0161_project_phases.sql` is the source of truth; this is its typed mirror. One table carries two
 * row kinds, told apart by `milestoneId`:
 *
 * - **Phase definition** (`milestoneId` NULL): a named, positioned column; its handle
 *   `(organizationId, projectId, name)` is unique (duplicate name in a project ⇒ 409).
 * - **Milestone assignment** (`milestoneId` set): a milestone placed into a phase (`phaseId` points
 *   at a definition row); its handle `(organizationId, milestoneId)` is unique (a milestone sits in
 *   at most one phase, so re-assigning is idempotent). `name`/`position` are NULL.
 *
 * The assignment is recorded here, never on `project_milestones` (0048), so this slice references
 * milestone ids without editing the milestones table.
 */
export const projectPhases = mysqlTable(
  'project_phases',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    /** Definition rows only; NULL on assignment rows. */
    name: varchar('name', { length: 200 }),
    /** Definition rows only; the phase column's left-to-right order. NULL on assignment rows. */
    position: int('position'),
    /** Assignment rows only; the milestone being placed. NULL on definition rows. */
    milestoneId: char('milestone_id', { length: 36 }),
    /** Assignment rows only; the definition row (`project_phases.id`) the milestone is placed into. */
    phaseId: char('phase_id', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    /** 53-07 (0305). Definition rows only: the phase band's explicit start. */
    startsOn: date('starts_on', { mode: 'string' }),
    /** 53-07 (0305). Definition rows only: the phase band's explicit end. */
    endsOn: date('ends_on', { mode: 'string' }),
    /** 53-07 (0305). Definition rows only: a design-token name for the band colour. */
    colorToken: varchar('color_token', { length: 32 }),
  },
  (table) => [
    uniqueIndex('uq_project_phases_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_project_phases_org_project_name').on(
      table.organizationId,
      table.projectId,
      table.name,
    ),
    uniqueIndex('uq_project_phases_org_milestone').on(table.organizationId, table.milestoneId),
    index('ix_project_phases_org_project').on(
      table.organizationId,
      table.projectId,
      table.position,
    ),
  ],
);

/**
 * PROJ / module 8 (x295). One frozen milestone in a baseline's `snapshot` JSON — a milestone id and
 * the target date it held at snapshot time (`YYYY-MM-DD`, or null when the milestone had no committed
 * date). The array of these is the plan the variance view compares today's milestones against.
 */
export interface ProjectBaselineMilestoneSnapshot {
  readonly milestoneId: string;
  /** The frozen target day, or null when the milestone had no committed date at snapshot time. */
  readonly targetDate: string | null;
}

/**
 * PROJ / module 8 (x295). A project's **milestone-plan baseline** — a point-in-time, named snapshot
 * of the current milestone plan. A `label`, the freezing user and instant, and a frozen `snapshot`
 * (an array of `{milestoneId, targetDate}`) captured from `project_milestones` (0048) at snapshot
 * time. The variance view recomputes today's dates against this frozen plan at read time, so the
 * snapshot itself is immutable.
 *
 * Tenant-scoped and project-owned like `project_milestones` (0048): the composite foreign key binds
 * `(organization_id, project_id)` to `projects`. Append-only — INSERT and DELETE, never UPDATE
 * (users.sql), so it carries no `updated_at` and no update trigger. `0162_project_baselines.sql` is
 * the source of truth; this is its typed mirror.
 */
export const projectBaselines = mysqlTable(
  'project_baselines',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    label: varchar('label', { length: 300 }).notNull(),
    snapshot: json('snapshot').$type<readonly ProjectBaselineMilestoneSnapshot[]>().notNull(),
    // ---- R17-c · 53-05 (0298) ---- 'milestones' | 'full' (app-checked); the one current baseline
    // per project (the only column the 0298 trigger lets change); an internal note.
    kind: varchar('kind', { length: 12 }).notNull().default('milestones'),
    isCurrent: boolean('is_current').notNull().default(false),
    note: varchar('note', { length: 500 }),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_project_baselines_org_id').on(table.organizationId, table.id),
    index('ix_project_baselines_org_project').on(
      table.organizationId,
      table.projectId,
      table.createdAt,
    ),
  ],
);

/** DOC-04 (x130). The value kinds a template variable can declare. */
export const DOCUMENT_TEMPLATE_VARIABLE_TYPES = ['text', 'date', 'number'] as const;

/**
 * DOC-04 (x130). A document template's declared variables — the named placeholders a template
 * exposes so a later slice can substitute them when the template is applied.
 *
 * A variable belongs to one `document_templates` row, which belongs to the organization (not a
 * project). The tenant key is `(organization_id, template_id)`, bound by a composite foreign key to
 * `document_templates (organization_id, id)`. `(organization_id, template_id, key)` is unique — a
 * template cannot declare the same key twice — and is the order a template's variables are listed
 * by. `0044_document_template_variables.sql` is the source of truth; this is its typed mirror.
 */
export const documentTemplateVariables = mysqlTable(
  'document_template_variables',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    templateId: char('template_id', { length: 36 }).notNull(),
    key: varchar('key', { length: 120 }).notNull(),
    label: varchar('label', { length: 300 }).notNull(),
    type: mysqlEnum('type', DOCUMENT_TEMPLATE_VARIABLE_TYPES).notNull().default('text'),
    required: boolean('required').notNull().default(false),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_document_template_variables_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_document_template_variables_org_template_key').on(
      table.organizationId,
      table.templateId,
      table.key,
    ),
  ],
);

/**
 * The org-objective status set, mirroring the `0046` `ENUM`. An objective is `open` at creation and
 * its lifecycle transitions to `met` or `missed` — the same lifecycle as {@link projectObjectives}.
 */
export const ORG_OBJECTIVE_STATUSES = ['open', 'met', 'missed'] as const;

/**
 * PROJ / module 8 (x136). An organization's objectives / OKRs — the record of what the whole
 * organization is aiming at: a name, an optional description and target, its status, and who created
 * it and when.
 *
 * The org-level counterpart of {@link projectObjectives} (x124): tenant-scoped like every sibling,
 * but with no `project_id` — an org objective belongs to the tenant, not to a project, so
 * authorization is org-scoped rather than relation-gated on a project. Like the project objective, it
 * has a lifecycle (`open → met | missed`), so `status` may change; the `0046` column-pinning trigger
 * pins every other column at the engine. `0046_org_objectives.sql` is the source of truth; this is
 * its typed mirror.
 */
export const orgObjectives = mysqlTable(
  'org_objectives',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 300 }).notNull(),
    description: text('description'),
    target: varchar('target', { length: 300 }),
    status: mysqlEnum('status', ORG_OBJECTIVE_STATUSES).notNull().default('open'),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_org_objectives_org_id').on(table.organizationId, table.id),
    index('ix_org_objectives_org_created').on(table.organizationId, table.createdAt),
  ],
);

/**
 * PROJ / module 8 (x138). The edge from a project objective to a work item — which work items advance
 * which objective.
 *
 * Tenant-scoped and project-owned like every sibling; both ends are bound to the acting tenant by the
 * composite foreign keys in `0047`, and a `(organization_id, objective_id, work_item_id)` unique key
 * makes a duplicate link a conflict rather than a second row. A row is created and removed, never
 * edited (no lifecycle, no trigger). `0047_objective_work_links.sql` is the source of truth; this is
 * its typed mirror.
 */
export const objectiveWorkLinks = mysqlTable(
  'objective_work_links',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    objectiveId: char('objective_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_objective_work_links_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_objective_work_links_pair').on(
      table.organizationId,
      table.objectiveId,
      table.workItemId,
    ),
    index('ix_objective_work_links_org_objective').on(
      table.organizationId,
      table.objectiveId,
      table.createdAt,
    ),
  ],
);

/**
 * PROJ / module 8 (x207). A project objective's key results — the measurable children of a
 * {@link projectObjectives} row: a title, a numeric `target`/`current` value, the `unit` they are
 * expressed in, who created it and when, and when it last changed.
 *
 * Objective-owned and tenant-scoped like {@link objectiveWorkLinks} (0047): the composite foreign key
 * binds `(organization_id, objective_id)` to `project_objectives`, so a key result can only ever name
 * an objective of its own tenant. Progress (%) is computed from `current / target` on read (bounded,
 * div-by-zero safe) and is deliberately *not* stored, so it cannot drift. The body (`title`,
 * `targetValue`, `currentValue`, `unit`) is editable — `status` has no analogue here — so the `0087`
 * column-pinning trigger pins only the identity/provenance columns and lets the body and `updated_at`
 * change. `0087_objective_key_results.sql` is the source of truth; this is its typed mirror.
 */
export const objectiveKeyResults = mysqlTable(
  'objective_key_results',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    objectiveId: char('objective_id', { length: 36 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    targetValue: bigint('target_value', { mode: 'number' }).notNull(),
    currentValue: bigint('current_value', { mode: 'number' }).notNull().default(0),
    unit: varchar('unit', { length: 64 }).notNull(),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_objective_key_results_org_id').on(table.organizationId, table.id),
    index('ix_objective_key_results_org_objective').on(
      table.organizationId,
      table.objectiveId,
      table.createdAt,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Client access
// ─────────────────────────────────────────────────────────────────────────────

export const clientOrganizations = mysqlTable(
  'client_organizations',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 190 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    archivedAt: datetime('archived_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [uniqueIndex('uq_client_organizations_org_id').on(table.organizationId, table.id)],
);

export const clientMemberships = mysqlTable(
  'client_memberships',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    clientOrganizationId: char('client_organization_id', { length: 36 }).notNull(),
    userId: char('user_id', { length: 36 }).notNull(),
    role: varchar('role', { length: 64 }).notNull(),
    status: mysqlEnum('status', MEMBERSHIP_STATUS).notNull().default('active'),
    /** Client access is time-bounded by default; a first-class column so expiry is testable. */
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_client_memberships_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_client_memberships_identity').on(
      table.organizationId,
      table.clientOrganizationId,
      table.userId,
    ),
    index('ix_client_memberships_user').on(table.userId),
  ],
);

export const INVITATION_STATUS = ['pending', 'accepted', 'expired', 'revoked'] as const;

/**
 * TEN-003. One table for two destinations: `client_organization_id` is the discriminator, and
 * null means an internal membership invitation.
 *
 * `token_hash` is described here because the column exists; nothing projects it. The service's
 * `InvitationView` has no such field, so there is no code path that could return it.
 */
export const invitations = mysqlTable(
  'invitations',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    clientOrganizationId: char('client_organization_id', { length: 36 }),
    email: varchar('email', { length: 320 }).notNull(),
    role: varchar('role', { length: 64 }).notNull(),
    /** A1 (0218). The inviter's personal note, shown to the invitee; null when none. */
    note: varchar('note', { length: 500 }),
    /** SHA-256 hex. The token itself is never stored — see `0005_invitations.sql`. */
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    status: mysqlEnum('status', INVITATION_STATUS).notNull().default('pending'),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    invitedByUserId: char('invited_by_user_id', { length: 36 }).notNull(),
    acceptedByUserId: char('accepted_by_user_id', { length: 36 }),
    acceptedAt: datetime('accepted_at', { mode: 'date', fsp: 3 }),
    revokedAt: datetime('revoked_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_invitations_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_invitations_token').on(table.tokenHash),
    index('ix_invitations_org_email').on(table.organizationId, table.email, table.status),
    index('ix_invitations_expiry').on(table.status, table.expiresAt),
  ],
);

/**
 * A1 (0218). A project an invited person joins on acceptance (r-invite "Add to projects"). Nothing is
 * granted at issue; `0218_invitation_projects_note.sql` is the source of truth, this its typed mirror.
 */
export const invitationProjects = mysqlTable(
  'invitation_projects',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    invitationId: char('invitation_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_invitation_projects_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_invitation_projects_pair').on(
      table.organizationId,
      table.invitationId,
      table.projectId,
    ),
    index('ix_invitation_projects_project').on(table.organizationId, table.projectId),
  ],
);

export const projectClients = mysqlTable(
  'project_clients',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    clientOrganizationId: char('client_organization_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_project_clients_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_project_clients_identity').on(
      table.organizationId,
      table.projectId,
      table.clientOrganizationId,
    ),
    index('ix_project_clients_client_org').on(table.organizationId, table.clientOrganizationId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Work items
// ─────────────────────────────────────────────────────────────────────────────

export const WORK_ITEM_AUDIENCE = ['internal', 'client_visible', 'client_action_required'] as const;

export const workItems = mysqlTable(
  'work_items',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    type: varchar('type', { length: 32 }).notNull().default('task'),
    title: varchar('title', { length: 300 }).notNull(),
    /** A6 (0219). The item's plain-text description; `NULL` when none was written. */
    description: text('description'),
    state: varchar('state', { length: 32 }).notNull().default('triage'),
    ownerUserId: char('owner_user_id', { length: 36 }),
    audience: mysqlEnum('audience', WORK_ITEM_AUDIENCE).notNull().default('internal'),
    startAt: datetime('start_at', { mode: 'date', fsp: 3 }),
    dueAt: datetime('due_at', { mode: 'date', fsp: 3 }),
    /**
     * When the person who moved this item to `done` said it was completed (0013). `NULL`
     * until then, and `NULL` again if it is reopened — see the migration's note.
     */
    completedAt: datetime('completed_at', { mode: 'date', fsp: 3 }),
    /**
     * Optimistic concurrency (spec §3 step 7), incremented by the repository.
     *
     * `mode: 'number'` rather than `'bigint'`: the column is `BIGINT UNSIGNED`, but a row
     * would have to be updated 2^53 times to leave the safe integer range, and mysql2 is
     * configured with `supportBigNumbers` so a value that did exceed it would arrive as a
     * string rather than as a silently wrong number.
     */
    version: bigint('version', { mode: 'number', unsigned: true }).notNull().default(1),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_work_items_org_id').on(table.organizationId, table.id),
    index('ix_work_items_org_project_state_due').on(
      table.organizationId,
      table.projectId,
      table.state,
      table.dueAt,
    ),
    index('ix_work_items_org_owner_state_due').on(
      table.organizationId,
      table.ownerUserId,
      table.state,
      table.dueAt,
    ),
    // H2 (0234): search's newest-first read; `updated_at` is a DESC key part in the migration.
    index('ix_work_items_org_updated').on(table.organizationId, table.updatedAt, table.id),
  ],
);

/**
 * WORK-003. The successor points at its predecessor — `work_item_id` depends on
 * `depends_on_work_item_id`. Edges are immutable at the engine (0011's trigger);
 * correcting one is delete-and-add, and the delete is audited because it destroys the
 * only record of the edge. Cycles beyond self-reference are refused by the service's
 * recursive walk before the insert.
 */
export const workItemDependencies = mysqlTable(
  'work_item_dependencies',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    dependsOnWorkItemId: char('depends_on_work_item_id', { length: 36 }).notNull(),
    // 53-04 (0293): FS | SS | FF | SF, signed working-day lag, who made it, active | suspended —
    // closed lists checked in the application. Only these four may change after insert (trigger).
    kind: varchar('kind', { length: 2 }).notNull().default('FS'),
    lagWorkingDays: smallint('lag_working_days').notNull().default(0),
    createdSource: varchar('created_source', { length: 12 }).notNull().default('ui'),
    status: varchar('status', { length: 10 }).notNull().default('active'),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_work_item_dependencies_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_work_item_dependencies_edge').on(
      table.organizationId,
      table.workItemId,
      table.dependsOnWorkItemId,
    ),
    index('ix_work_item_dependencies_predecessor').on(
      table.organizationId,
      table.dependsOnWorkItemId,
    ),
  ],
);

/**
 * WORK-003. US-B04's blocker as a ledger: raised (reason, ask, optional owner, since) and
 * resolved (outcome, when, by whom), never deleted, never rewritten — the one legal update
 * is resolving an open entry, exactly once (0011's trigger). `active_item` is a
 * trigger-maintained column (`trg_work_blockers_active_item` on insert,
 * `trg_work_blockers_resolve_once` on update) — the work item id while unresolved, NULL after — so
 * `uq_work_blockers_one_active` is the engine enforcing "one active blocker per item",
 * which the state machine's own note assumes when leaving `blocked` resolves *the* active
 * blocker, singular.
 */
export const workBlockers = mysqlTable(
  'work_blockers',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    reason: varchar('reason', { length: 1000 }).notNull(),
    ask: varchar('ask', { length: 1000 }).notNull(),
    ownerUserId: char('owner_user_id', { length: 36 }),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    resolvedAt: datetime('resolved_at', { mode: 'date', fsp: 3 }),
    resolution: varchar('resolution', { length: 1000 }),
    resolvedByUserId: char('resolved_by_user_id', { length: 36 }),
    /**
     * Trigger-maintained by `trg_work_blockers_active_item` / `trg_work_blockers_resolve_once`; never
     * written by the application. See the migration.
     */
    activeItem: char('active_item', { length: 36 }),
  },
  (table) => [
    uniqueIndex('uq_work_blockers_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_work_blockers_one_active').on(table.organizationId, table.activeItem),
    index('ix_work_blockers_item').on(table.organizationId, table.workItemId, table.createdAt),
  ],
);

/**
 * x145 (0051). A work item's checklist / sub-items: a labelled, ordered list of done/not-done
 * entries hanging off one work item. Parent- and tenant-owned — the composite foreign key
 * `fk_work_item_checklist_items_work_item` binds `(organization_id, work_item_id)` to
 * `work_items`, so a cross-tenant parent is a non-existent pair rather than a leak. `label`,
 * `done` and `position` are editable; `organization_id` and `work_item_id` are pinned immutable
 * by the migration's `BEFORE UPDATE` trigger.
 */
export const workItemChecklistItems = mysqlTable(
  'work_item_checklist_items',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    label: varchar('label', { length: 300 }).notNull(),
    done: boolean('done').notNull().default(false),
    position: int('position', { unsigned: true }).notNull().default(0),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_work_item_checklist_items_org_id').on(table.organizationId, table.id),
    index('ix_work_item_checklist_items_item').on(
      table.organizationId,
      table.workItemId,
      table.position,
      table.id,
    ),
  ],
);

/**
 * x307 (0175). A work item's ordered subtasks / breakdown (Work module). A titled, ordered list of
 * done/not-done child rows hanging off one work item, with a `created_by` author and a delete —
 * distinct from `work_item_checklist_items` (0051), which records neither. The composite foreign key
 * `fk_work_item_subtasks_parent` binds `(organization_id, parent_work_item_id)` to `work_items`, so a
 * cross-tenant parent is a non-existent pair rather than a leak. `title`, `is_done` and `position`
 * are editable; `organization_id` and `parent_work_item_id` are pinned immutable by the migration's
 * `BEFORE UPDATE` trigger.
 */
export const workItemSubtasks = mysqlTable(
  'work_item_subtasks',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    parentWorkItemId: char('parent_work_item_id', { length: 36 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    isDone: boolean('is_done').notNull().default(false),
    position: int('position', { unsigned: true }).notNull().default(0),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_work_item_subtasks_org_id').on(table.organizationId, table.id),
    index('ix_work_item_subtasks_parent').on(
      table.organizationId,
      table.parentWorkItemId,
      table.position,
      table.id,
    ),
  ],
);

/**
 * x147. A work item's comments / activity (Work module 7). Append-only, internal-only, and
 * distinct from the channel-scoped conversation `messages`: a comment is about *this work item*,
 * authored by a membership of the studio. `fk_work_item_comments_work_item` binds
 * `(organization_id, work_item_id)` to `work_items (organization_id, id)`, so a cross-tenant
 * `work_item_id` is a non-existent pair — migration `0053_work_item_comments.sql`.
 */
export const workItemComments = mysqlTable(
  'work_item_comments',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    authorMembershipId: char('author_membership_id', { length: 36 }).notNull(),
    body: text('body').notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_work_item_comments_org_id').on(table.organizationId, table.id),
    index('ix_work_item_comments_item').on(
      table.organizationId,
      table.workItemId,
      table.createdAt,
      table.id,
    ),
  ],
);

/** x204's typed relation between two work items. `blocks`: from blocks to; `relates`: undirected. */
export const WORK_ITEM_LINK_TYPES = ['blocks', 'blocked_by', 'relates'] as const;

/**
 * x204 (migration 0085). A typed link between two work items of one studio — the general,
 * user-authored relationship the detail screen needs, distinct from the `depends_on` edge of
 * `0011`. Both ends bind `(organization_id, from_work_item_id)` and `(organization_id,
 * to_work_item_id)` to `work_items (organization_id, id)`, so a cross-tenant end is a non-existent
 * pair; `uq_work_item_links_edge` admits one row per typed ordered pair. Rows are immutable
 * (`0085`'s trigger) — correcting a link is delete-and-add. `0085_work_item_links.sql` is the
 * source of truth; this is its typed mirror.
 */
export const workItemLinks = mysqlTable(
  'work_item_links',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    fromWorkItemId: char('from_work_item_id', { length: 36 }).notNull(),
    toWorkItemId: char('to_work_item_id', { length: 36 }).notNull(),
    linkType: mysqlEnum('link_type', WORK_ITEM_LINK_TYPES).notNull(),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_work_item_links_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_work_item_links_edge').on(
      table.organizationId,
      table.fromWorkItemId,
      table.toWorkItemId,
      table.linkType,
    ),
    index('ix_work_item_links_from').on(
      table.organizationId,
      table.fromWorkItemId,
      table.createdAt,
      table.id,
    ),
    index('ix_work_item_links_to').on(table.organizationId, table.toWorkItemId),
  ],
);

/**
 * x205 (Work module 7). The join between a work item and an already-uploaded file — the audit's
 * "Work built; Files built; no join between them". A link names one work item and one file asset
 * of the same studio (`organization_id`) and, enforced in the service, the same project. Both
 * ends are bound by composite foreign keys that include `organization_id`
 * (`0086_work_item_files.sql`), so a cross-tenant work item id OR a cross-tenant file id is a
 * non-existent pair, not a leak. A link is added and removed (detach is a DELETE), never edited:
 * the 0086 trigger pins every column immutable for the credentials that hold UPDATE, and the
 * runtime credential holds INSERT and DELETE only. `0086_work_item_files.sql` is the source of
 * truth; this is its typed mirror.
 */
export const workItemFiles = mysqlTable(
  'work_item_files',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    fileAssetId: char('file_asset_id', { length: 36 }).notNull(),
    attachedByMembershipId: char('attached_by_membership_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_work_item_files_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_work_item_files_edge').on(
      table.organizationId,
      table.workItemId,
      table.fileAssetId,
    ),
    index('ix_work_item_files_item').on(
      table.organizationId,
      table.workItemId,
      table.createdAt,
      table.id,
    ),
  ],
);

/**
 * x231 (0103). Logged effort per work item (Work module 7). Each entry records `minutes` spent by
 * one membership (`logged_by`) on a calendar day (`spent_on`), with an optional `note`. Parent- and
 * tenant-owned — the composite foreign key `fk_work_item_time_logs_work_item` binds
 * `(organization_id, work_item_id)` to `work_items`, so a cross-tenant parent is a non-existent pair
 * rather than a leak. 52-01 (0265) adds the timed span, billable, source, needs_review, project_id
 * and the later-slice lock/timesheet columns; the replaced trigger pins tenant, author and a named
 * work item, and refuses every edit of a locked row.
 */
export const workItemTimeLogs = mysqlTable(
  'work_item_time_logs',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    /** 52-01 (0265): NULL files the entry in the project's unsorted bucket. */
    workItemId: char('work_item_id', { length: 36 }),
    /** 52-01 (0265): the work item's project (backfilled), or the timer's project. */
    projectId: char('project_id', { length: 36 }),
    loggedBy: char('logged_by', { length: 36 }).notNull(),
    minutes: int('minutes', { unsigned: true }).notNull(),
    spentOn: date('spent_on', { mode: 'string' }).notNull(),
    startedAt: datetime('started_at', { mode: 'date', fsp: 3 }),
    endedAt: datetime('ended_at', { mode: 'date', fsp: 3 }),
    billable: boolean('billable').notNull().default(true),
    /** `manual` | `timer`, checked in `modules/time/time-rules.ts`. */
    source: varchar('source', { length: 16 })
      .$type<'manual' | 'timer'>()
      .notNull()
      .default('manual'),
    needsReview: boolean('needs_review').notNull().default(false),
    note: varchar('note', { length: 500 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }),
    updatedBy: char('updated_by', { length: 36 }),
    /** 52-03 fills it; a locked row refuses every edit (0265 trigger). */
    lockedAt: datetime('locked_at', { mode: 'date', fsp: 3 }),
    /** 52-02 fills it. */
    timesheetId: char('timesheet_id', { length: 36 }),
  },
  (table) => [
    uniqueIndex('uq_work_item_time_logs_org_id').on(table.organizationId, table.id),
    index('ix_work_item_time_logs_item').on(
      table.organizationId,
      table.workItemId,
      table.spentOn,
      table.id,
    ),
    index('ix_witl_member_day').on(table.organizationId, table.loggedBy, table.spentOn, table.id),
    index('ix_witl_project_day').on(table.organizationId, table.projectId, table.spentOn, table.id),
  ],
);

/**
 * x258 (0128). An effort estimate per work item (Work module). A single planned figure
 * (`estimate_minutes`) read back beside x231's logged actual — estimate vs actual and the variance
 * between them. Parent- and tenant-owned — the composite foreign key
 * `fk_work_item_estimates_work_item` binds `(organization_id, work_item_id)` to `work_items`, so a
 * cross-tenant parent is a non-existent pair rather than a leak. One estimate per item:
 * `uq_work_item_estimates_org_item` is the upsert key, so setting or revising the estimate is an
 * `INSERT ... ON DUPLICATE KEY UPDATE`, never a second row. `organization_id` and `work_item_id` are
 * pinned immutable by the migration's `BEFORE UPDATE` trigger; only `estimate_minutes` is edited.
 */
export const workItemEstimates = mysqlTable(
  'work_item_estimates',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    estimateMinutes: int('estimate_minutes', { unsigned: true }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    /** 53-08 (0309): manual remaining override; NULL → derived `max(0, estimate − logged)`. */
    remainingMinutes: int('remaining_minutes', { unsigned: true }),
  },
  (table) => [
    uniqueIndex('uq_work_item_estimates_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_work_item_estimates_org_item').on(table.organizationId, table.workItemId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Client requests
// ─────────────────────────────────────────────────────────────────────────────

/** `23-ERD-AND-STATE-MACHINES` §6's "committed date or explicit unscheduled state". */
export const CLIENT_REQUEST_COMMITMENT = ['committed', 'unscheduled'] as const;

/**
 * REQ-001. The one thing every client role may do — `client_request.submit` is in all four
 * ceilings — and the row a triage decision is recorded on.
 *
 * `state` carries no `.default()` here because the column has no `DEFAULT` in
 * `0006_client_requests.sql`; see the note there about `work_items.state`.
 */
export const clientRequests = mysqlTable(
  'client_requests',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    clientOrganizationId: char('client_organization_id', { length: 36 }).notNull(),
    submittedByUserId: char('submitted_by_user_id', { length: 36 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    category: varchar('category', { length: 64 }).notNull().default('general'),
    description: text('description').notNull(),
    urgencyReason: varchar('urgency_reason', { length: 500 }),
    /**
     * What the client asked for. Never what the studio agreed to — that is `committedAt`.
     * A calendar date carried as a `'YYYY-MM-DD'` string (0012), same as the project dates.
     */
    desiredAt: date('desired_at', { mode: 'string' }),
    state: varchar('state', { length: 32 }).notNull(),
    clarificationQuestion: text('clarification_question'),
    clientVisibleReason: varchar('client_visible_reason', { length: 1000 }),
    clientSafeScopeSummary: text('client_safe_scope_summary'),
    commitment: mysqlEnum('commitment', CLIENT_REQUEST_COMMITMENT),
    committedAt: date('committed_at', { mode: 'string' }),
    linkedWorkItemId: char('linked_work_item_id', { length: 36 }),
    /** A7 (0220): when a deferred request comes back to triage; null when not parked on a date. */
    deferUntil: datetime('defer_until', { mode: 'date', fsp: 3 }),
    /** A7 (0220): remind the deferrer when the request reopens. */
    reopenReminder: boolean('reopen_reminder').notNull().default(false),
    /** A7 (0220): who deferred it — the reminder's recipient. */
    deferredByUserId: char('deferred_by_user_id', { length: 36 }),
    version: bigint('version', { mode: 'number', unsigned: true }).notNull().default(1),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_client_requests_org_id').on(table.organizationId, table.id),
    index('ix_client_requests_org_project_state').on(
      table.organizationId,
      table.projectId,
      table.state,
      table.createdAt,
    ),
    index('ix_client_requests_org_client_state').on(
      table.organizationId,
      table.clientOrganizationId,
      table.state,
      table.createdAt,
    ),
    // A7 (0220): the cross-tenant defer sweep's predicate.
    index('ix_client_requests_state_defer_until').on(table.state, table.deferUntil),
  ],
);

/**
 * Free-text triage labels on a client request (x316, Requests module 11). Unlike `work_item_labels`'
 * definition/assignment split, the label is the free text itself, carried on the row; a request may
 * carry a label only once (`uq_request_tags_label`, folded case-insensitively by the table
 * collation). `fk_request_tags_request` binds `(organization_id, client_request_id)` to
 * `client_requests`, so a cross-tenant request id is a non-existent pair — migration
 * `0184_request_tags.sql`.
 */
export const requestTags = mysqlTable(
  'request_tags',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    clientRequestId: char('client_request_id', { length: 36 }).notNull(),
    label: varchar('label', { length: 120 }).notNull(),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_request_tags_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_request_tags_label').on(
      table.organizationId,
      table.clientRequestId,
      table.label,
    ),
    index('ix_request_tags_request').on(table.organizationId, table.clientRequestId, table.id),
  ],
);

export type RequestTagRow = typeof requestTags.$inferSelect;
export type NewRequestTagRow = typeof requestTags.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// Approvals — FR-05 (0027)
// ─────────────────────────────────────────────────────────────────────────────

/** `23-ERD-AND-STATE-MACHINES` §8: how multiple reviewers combine (domain `ApprovalPolicy`). */
export const APPROVAL_POLICIES = ['all_required', 'any_one', 'ordered_sequence'] as const;

/**
 * 0211 (audit gap 1). One named piece of work on a project that the team versions and sends to the
 * client for approval. No lifecycle column — the state is derived from the newest version's
 * approval, so it can never disagree with the append-only `approvals` record.
 */
export const deliverables = mysqlTable(
  'deliverables',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    description: text('description'),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_deliverables_org_id').on(table.organizationId, table.id),
    index('ix_deliverables_org_project').on(table.organizationId, table.projectId, table.createdAt),
  ],
);

/**
 * FR-05. The immutable identity of governed content: an exact deliverable at an exact
 * `contentHash`. There is no `deliverables` table yet (the aggregate is domain-only), so
 * `deliverableId` is a logical reference, not a foreign key. A version is immutable — the
 * repository has no update path and `0027`'s trigger refuses one — so a governed content change
 * is a new row, never an edit.
 */
export const deliverableVersions = mysqlTable(
  'deliverable_versions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    deliverableId: char('deliverable_id', { length: 36 }).notNull(),
    /** 0211. 1, 2, 3 … per deliverable; NULL on versions written before 0211. */
    versionNo: int('version_no', { unsigned: true }),
    /** A lowercase hex SHA-256 digest (`content-hash.ts`). */
    contentHash: char('content_hash', { length: 64 }).notNull(),
    /** 0211. The attached file and the exact file version the reviewer saw. */
    fileAssetId: char('file_asset_id', { length: 36 }),
    fileVersionId: char('file_version_id', { length: 36 }),
    /** 0211. The team's note for this version ("what changed"). */
    note: text('note'),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_deliverable_versions_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_deliverable_versions_org_deliverable_no').on(
      table.organizationId,
      table.deliverableId,
      table.versionNo,
    ),
    index('ix_deliverable_versions_org_deliverable').on(
      table.organizationId,
      table.deliverableId,
      table.createdAt,
    ),
  ],
);

/**
 * FR-05. One reviewer request bound to exactly one immutable version and the `contentHash`
 * captured at request time. The decision transaction re-checks that captured hash against the
 * deliverable's current governed version and invalidates rather than deciding on a mismatch
 * (INT-16/INT-17); `0027`'s trigger keeps the row append-only once terminal.
 *
 * `state` carries no `.default()` — the column has no `DEFAULT` in `0027`; see the note in the
 * client-requests table above.
 */
export const approvals = mysqlTable(
  'approvals',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    deliverableId: char('deliverable_id', { length: 36 }).notNull(),
    deliverableVersionId: char('deliverable_version_id', { length: 36 }).notNull(),
    contentHash: char('content_hash', { length: 64 }).notNull(),
    state: varchar('state', { length: 32 }).notNull(),
    policy: mysqlEnum('policy', APPROVAL_POLICIES).notNull().default('all_required'),
    /** The reviewer relation — the real gate (AUTH-08). A JSON array of user ids. */
    reviewerIds: json('reviewer_ids').$type<string[]>().notNull(),
    decidedByUserId: char('decided_by_user_id', { length: 36 }),
    decidedAt: datetime('decided_at', { mode: 'date', fsp: 3 }),
    feedback: text('feedback'),
    invalidationReason: varchar('invalidation_reason', { length: 500 }),
    version: bigint('version', { mode: 'number', unsigned: true }).notNull().default(1),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_approvals_org_id').on(table.organizationId, table.id),
    index('ix_approvals_org_deliverable_state').on(
      table.organizationId,
      table.deliverableId,
      table.state,
      table.createdAt,
    ),
  ],
);

/**
 * The decision states a single approval step (0183, x315) may hold. A closed application allowlist
 * mirrored by `approval_steps.state`: an off-list token is a 400 with no write and the column only
 * ever holds a known value. Kept in the application (not a MySQL `ENUM`) so the set can grow without
 * an `ALTER TABLE`, the same division `approvals.state` uses. The *active* step is the lowest
 * `position` still `pending`.
 */
export const APPROVAL_STEP_STATES = ['pending', 'approved', 'rejected'] as const;
export type ApprovalStepState = (typeof APPROVAL_STEP_STATES)[number];

/**
 * Sequential approval steps (0183, x315). An ordered chain over one {@link approvals} row: each step
 * is an approver role (and optionally a specific `approver_user_id`) at a fixed `position`, plus the
 * step's own `state`/`decided_by`/`decided_at`. Keyed to its approval through the composite
 * `(organization_id, approval_id)` foreign key so a step can never point across a tenant boundary.
 * `state` is a fixed application allowlist ({@link APPROVAL_STEP_STATES}) validated before any write;
 * `position` is unique within an approval. Identity (`organization_id`, `approval_id`, `position`,
 * `approver_role`, `approver_user_id`) is immutable at the engine; the app is granted INSERT (define)
 * and UPDATE (record a decision). Distinct from `approval_delegations` (x300, who may act) — this is
 * the ordered chain itself. `0183_approval_steps.sql` is the source of truth; this is its typed mirror.
 */
export const approvalSteps = mysqlTable(
  'approval_steps',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    approvalId: char('approval_id', { length: 36 }).notNull(),
    position: int('position', { unsigned: true }).notNull(),
    approverRole: varchar('approver_role', { length: 64 }).notNull(),
    approverUserId: char('approver_user_id', { length: 36 }),
    state: varchar('state', { length: 16 }).notNull().default('pending'),
    decidedBy: char('decided_by', { length: 36 }),
    decidedAt: datetime('decided_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_approval_steps_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_approval_steps_org_approval_position').on(
      table.organizationId,
      table.approvalId,
      table.position,
    ),
  ],
);

/**
 * One reviewer's decision on a multi-reviewer approval (0235, wave 9 S5 / F15). The approval moves
 * to a terminal state only when these rows, aggregated by the approval's policy, are final. One row
 * per `(organization_id, approval_id, reviewer_user_id)`; INSERT-only for the API credential.
 * `0235_approval_reviewer_decisions.sql` is the source of truth; this is its typed mirror.
 */
export const APPROVAL_REVIEWER_OUTCOMES = ['approved', 'changes_requested'] as const;
export const approvalReviewerDecisions = mysqlTable(
  'approval_reviewer_decisions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    approvalId: char('approval_id', { length: 36 }).notNull(),
    reviewerUserId: char('reviewer_user_id', { length: 36 }).notNull(),
    outcome: mysqlEnum('outcome', APPROVAL_REVIEWER_OUTCOMES).notNull(),
    decidedAt: datetime('decided_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_approval_reviewer_decisions_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_approval_reviewer_decisions_reviewer').on(
      table.organizationId,
      table.approvalId,
      table.reviewerUserId,
    ),
  ],
);

/**
 * The client-safe payload of a published projection — 12-PERMISSION-MATRIX §1's allowlist and no
 * more. Held as JSON (`0031`), built from an allowlist at the service so a forbidden internal field
 * (cost, estimates, staff review, private threads, risk rationale, security metadata, other-client
 * data — 25 §7) can never reach it. `deliverableVersion` is the bound version's identity, carried
 * as the row's typed columns rather than duplicated here.
 */
export interface ClientProjectionPayload {
  /** 12 §1 "public/client title". */
  readonly title: string;
  readonly summary: string | null;
  /** 12 §1 "milestone state". */
  readonly milestoneState: string | null;
  /** 12 §1 "committed/forecast date" — an ISO calendar date, or null. */
  readonly forecastDate: string | null;
  /** 12 §1 "published risk" — the client-visible risk, never the internal rationale. */
  readonly publishedRisk: string | null;
  /** 12 §1 "decision". */
  readonly decision: string | null;
  /** 12 §1 "approved contacts". */
  readonly approvedContacts: readonly string[];
}

/**
 * FR-05 (x97). The immutable client-facing view of one governed `deliverable_versions` row. An
 * internal `deliverable.publish` freezes the version's exact `content_hash` with a client-safe
 * `projection` payload (25 §7); a client reads it through `client_projection.read` and never the
 * internal record. One projection per version — `0031`'s UNIQUE (organization_id,
 * deliverable_version_id) is the append-only guard, and its trigger refuses every UPDATE.
 */
export const clientProjections = mysqlTable(
  'client_projections',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    deliverableId: char('deliverable_id', { length: 36 }).notNull(),
    deliverableVersionId: char('deliverable_version_id', { length: 36 }).notNull(),
    /** The governed version's frozen lowercase hex SHA-256 digest (`content-hash.ts`). */
    contentHash: char('content_hash', { length: 64 }).notNull(),
    /** The client-safe allowlisted payload (12 §1). */
    projection: json('projection').$type<ClientProjectionPayload>().notNull(),
    publishedByUserId: char('published_by_user_id', { length: 36 }).notNull(),
    publishedAt: datetime('published_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_client_projections_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_client_projections_org_version').on(
      table.organizationId,
      table.deliverableVersionId,
    ),
    index('ix_client_projections_org_deliverable').on(
      table.organizationId,
      table.deliverableId,
      table.publishedAt,
    ),
  ],
);

/**
 * SEC / Portal deliverable feedback (x321, module 13 Client Portal). One client contact's rating
 * (1–5) and optional comment on a *published* deliverable version — the client-authored counterpart
 * to the internal `client_projections` (0031) they can see. Distinct from `project_update_comments`
 * (x203, internal-authored on an update): this is a client write on a deliverable version.
 *
 * One feedback per (contact, version): the row is upserted on `(organization_id,
 * deliverable_version_id, client_contact_user_id)`, so a contact revises their own rating in place
 * rather than leaving a second row. `fk_portal_feedback_version_tenant` binds `(organization_id,
 * deliverable_version_id)` to `deliverable_versions (organization_id, id)`, so a cross-tenant
 * version is a non-existent pair; the service resolves the client-visible version through the x114
 * projection before it ever writes. Identity — the tenant, the version, and the authoring contact —
 * is immutable; only `rating`, `comment` and `updated_at` may change. `0189_portal_feedback.sql` is
 * the source of truth; this is its typed mirror.
 */
export const portalFeedback = mysqlTable(
  'portal_feedback',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    /** The published deliverable version this feedback is about (bound within the tenant). */
    deliverableVersionId: char('deliverable_version_id', { length: 36 }).notNull(),
    /** The client contact who authored it — `context.userId`, never a body field. */
    clientContactUserId: char('client_contact_user_id', { length: 36 }).notNull(),
    /** 1–5. The service refuses anything outside that range with 400 before the write. */
    rating: tinyint('rating').notNull(),
    /** Optional free text; `null` when the contact left a rating only. */
    comment: text('comment'),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_portal_feedback_org_id').on(table.organizationId, table.id),
    // One feedback per contact per version: the upsert key.
    uniqueIndex('uq_portal_feedback_org_version_contact').on(
      table.organizationId,
      table.deliverableVersionId,
      table.clientContactUserId,
    ),
    // The staff read: a version's feedback, newest-first.
    index('ix_portal_feedback_org_version').on(
      table.organizationId,
      table.deliverableVersionId,
      table.createdAt,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Files — FILE-001 (0015)
// ─────────────────────────────────────────────────────────────────────────────

/** `openapi.yaml` `CreateUploadSessionRequest.purpose`, and the ENUM on both file tables. */
export const UPLOAD_PURPOSES = [
  'message_attachment',
  'request_attachment',
  'deliverable',
  'document',
  // 0224 (A11): the organization's logo on the Organization settings card.
  'org_logo',
  // 0232: a file sent with a reply on a client request (A8), bound to the request like
  // `request_attachment` but listed only through `request_message_files`.
  'request_message',
  // 0292 (52-07): an expense receipt (image or PDF, <= 10 MB), internal upload and download only.
  'expense_receipt',
] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

/**
 * The reservation's own lifecycle (`49` §6 steps 4 and 7), not the file's nine states.
 * `completing` is the claim a completion takes on the row before it asks the provider
 * (migration 0017): its exits are `completed`, `failed`, and back to `reserved` when the
 * provider refused something the client can still put right. A cancel or a sweep finds a
 * `completing` row and leaves it alone.
 */
export const UPLOAD_SESSION_STATUSES = [
  'reserved',
  'completing',
  'completed',
  'cancelled',
  'expired',
  'failed',
] as const;
export type UploadSessionStatus = (typeof UPLOAD_SESSION_STATUSES)[number];

/** One presigned target, as the provider issued it. Kept on the row so a replay repeats it. */
export interface UploadTargetJson {
  readonly partNumber: number;
  readonly url: string;
}

/**
 * The entity kinds a Home pin may reference (HOME-05, migration 0035). Kept here beside the table
 * rather than in `packages/domain` so this slice stays inside `apps/api`; the migration's ENUM is
 * the source of truth and `schema.db.test.ts` holds this list to it.
 */
export const SAVED_CONTEXT_ENTITY_TYPES = ['message', 'doc', 'work', 'file'] as const;
export type SavedContextEntityType = (typeof SAVED_CONTEXT_ENTITY_TYPES)[number];

/**
 * HOME-05 saved/pinned context (migration 0035, x110).
 *
 * One row per pin: a per-user, per-tenant *reference* to an entity the user keeps at hand on their
 * Home, grouped by `project_id`. It stores the reference only (`entity_type` + `entity_id`), never a
 * copy of the entity — resolving each pin to a live title/preview is the deferred read-fan-out
 * follow-up. `entity_id` carries no FK (the target table depends on `entity_type`); tenant safety
 * rests on the service resolving `entity_id`/`project_id` tenant-scoped before the write. Created and
 * deleted, never updated — no `version`, no `updatedAt`, and the runtime credential holds INSERT and
 * DELETE alone.
 */
export const savedContext = mysqlTable(
  'saved_context',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    userId: char('user_id', { length: 36 }).notNull(),
    entityType: mysqlEnum('entity_type', SAVED_CONTEXT_ENTITY_TYPES).notNull(),
    entityId: char('entity_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_saved_context_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_saved_context_pin').on(
      table.organizationId,
      table.userId,
      table.entityType,
      table.entityId,
    ),
    index('ix_saved_context_org_user_project').on(
      table.organizationId,
      table.userId,
      table.projectId,
      table.createdAt,
    ),
  ],
);

/**
 * The three coarse Home targets HOME-05's follow-up can pin. Exported so the controller validates a
 * request against the same source of truth the column's ENUM is built from.
 */
export const HOME_PIN_TARGET_KINDS = ['work', 'project', 'document'] as const;
export type HomePinTargetKind = (typeof HOME_PIN_TARGET_KINDS)[number];

/**
 * HOME-05 follow-up — membership-scoped Home pins (migration 0050, x144).
 *
 * One row per pin: a per-membership, per-tenant *reference* to a work item, project or document an
 * acting member keeps on their Home. It stores the reference only (`target_kind` + `target_id`),
 * never a copy of the target — resolving each pin to a live title/preview is the deferred read
 * fan-out. `target_id` carries no FK (the target table depends on `target_kind`); tenant safety
 * rests on the service resolving `target_id` tenant-scoped before the write. Created and deleted,
 * never updated — no `version`, no `updatedAt`, and the runtime credential holds INSERT and DELETE
 * alone. The unique pin key turns a duplicate into an engine collision the service maps to a 409.
 */
export const homePinnedItems = mysqlTable(
  'home_pinned_items',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    targetKind: mysqlEnum('target_kind', HOME_PIN_TARGET_KINDS).notNull(),
    targetId: char('target_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_home_pinned_items_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_home_pinned_items_pin').on(
      table.organizationId,
      table.membershipId,
      table.targetKind,
      table.targetId,
    ),
    index('ix_home_pinned_items_org_membership').on(
      table.organizationId,
      table.membershipId,
      table.createdAt,
      table.id,
    ),
  ],
);

/**
 * The fixed allowlist of object kinds the Home "Recently viewed" rail records (x324). Exported so
 * the controller validates a request against the same source of truth, and an `object_type` off this
 * list is refused with a 400 and no upsert.
 */
export const RECENT_ITEM_OBJECT_TYPES = ['work', 'project', 'document', 'meeting'] as const;
export type RecentItemObjectType = (typeof RECENT_ITEM_OBJECT_TYPES)[number];

/** The fixed cap on how many recents the rail keeps and returns per member — a bounded read. */
export const RECENT_ITEMS_CAP = 20;

/**
 * HOME / My Day — a member's own recently-viewed entities (migration 0192, x324).
 *
 * One row per (membership, object) is the fact "this membership last viewed this object at
 * `viewed_at`". It stores the *reference* only (`object_type` + `object_id`), never a copy of the
 * target and no resolved title, so a recent can leak nothing about an entity the caller could not
 * otherwise reach (the `home_pinned_items` target_id posture). `object_id` carries no FK (the target
 * table depends on `object_type`); tenant safety rests on every read/write being scoped by
 * `organization_id`, and an `object_type` off {@link RECENT_ITEM_OBJECT_TYPES} is a 400 at the route.
 * The upsert refreshes `viewed_at` in place against the unique key (idempotent record-a-view), and
 * the read is bounded to {@link RECENT_ITEMS_CAP} newest-first — never an unbounded scan. Identity is
 * immutable (the 0192 trigger); only `viewed_at` changes, and the runtime credential holds INSERT,
 * UPDATE, DELETE and SELECT.
 */
export const homeRecentItems = mysqlTable(
  'home_recent_items',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    objectType: varchar('object_type', { length: 40 }).notNull(),
    objectId: char('object_id', { length: 36 }).notNull(),
    viewedAt: datetime('viewed_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_home_recent_items_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_home_recent_items_object').on(
      table.organizationId,
      table.membershipId,
      table.objectType,
      table.objectId,
    ),
    index('ix_home_recent_items_org_membership').on(
      table.organizationId,
      table.membershipId,
      table.viewedAt,
      table.id,
    ),
  ],
);

/**
 * INBOX snooze (IN-01/IN-02, x259, migration 0129) — a member's own snoozes of inbox bundles.
 *
 * One row is the fact "this membership snoozed this bundle until `snoozed_until`". `bundle_id` is the
 * inbox's opaque `objectType:objectId` string, not a foreign key (the object lives in `work_items` or
 * `client_requests` per prefix), so the tenant boundary is the service's tenant-scoped resolve of the
 * object before the write, the `home_pinned_items` target_id posture. Keyed `(organization_id,
 * membership_id, bundle_id)` for the upsert; snoozes are private to a membership — every read, the
 * upsert and the delete are scoped by `membership_id`. Identity is immutable (the 0129 trigger); only
 * `snoozed_until`/`updated_at` change.
 */
export const inboxSnoozes = mysqlTable(
  'inbox_snoozes',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    bundleId: varchar('bundle_id', { length: 120 }).notNull(),
    snoozedUntil: datetime('snoozed_until', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_inbox_snoozes_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_inbox_snoozes_pin').on(
      table.organizationId,
      table.membershipId,
      table.bundleId,
    ),
    index('ix_inbox_snoozes_org_membership').on(
      table.organizationId,
      table.membershipId,
      table.snoozedUntil,
      table.id,
    ),
  ],
);

/**
 * INBOX source mutes (x318, migration 0186) — a member's own muted inbox sources.
 *
 * One row is the fact "this member muted this source in this studio". A source is
 * `(object_type, object_id)` — the inbox's own object-type prefix (`work_item`, `client_request`,
 * `organization_usage`) and the object's id — not a foreign key, since the object lives in a
 * different table per prefix (`organization_usage` names the organization itself); the tenant
 * boundary is the scoped predicate on every read/write, the `home_pinned_items` target_id posture.
 * Keyed by `member_user_id` (the global user id, the choice `notifications.recipient_user_id`
 * makes, because the inbox read this filters is recipient-user-scoped). Mutes are private to a
 * member — the list, the insert and the delete are all scoped by `member_user_id`. Created and
 * removed, never edited: only INSERT and DELETE, so there is no UPDATE grant and no immutability
 * trigger (the `home_pinned_items`/`saved_context` posture). `0186_inbox_source_mutes.sql` is the
 * source of truth; this is its typed mirror.
 */
export const inboxSourceMutes = mysqlTable(
  'inbox_source_mutes',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    memberUserId: char('member_user_id', { length: 36 }).notNull(),
    objectType: varchar('object_type', { length: 64 }).notNull(),
    objectId: varchar('object_id', { length: 64 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_inbox_source_mutes_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_inbox_source_mutes_pin').on(
      table.organizationId,
      table.memberUserId,
      table.objectType,
      table.objectId,
    ),
    index('ix_inbox_source_mutes_org_member').on(
      table.organizationId,
      table.memberUserId,
      table.id,
    ),
  ],
);

/**
 * The fixed ON-10 guided-tour steps a member's progress can record. Exported so the controller
 * validates a completion request against the same source of truth the column's ENUM is built from
 * (`onboarding-tour.steps.ts` re-derives the ordered, labelled list from this set).
 */
export const ONBOARDING_TOUR_STEPS = [
  'welcome',
  'create_project',
  'invite_team',
  'explore_work',
  'share_portal',
] as const;
export type OnboardingTourStep = (typeof ONBOARDING_TOUR_STEPS)[number];

/**
 * ON-10 guided-tour progress — per-membership completion of the fixed tour steps (migration 0059,
 * x155).
 *
 * One row per (membership, step) the acting member has completed. It stores completion progress only
 * — the `step` and when it was finished — never anything about the content of a tour step; sample-data
 * seeding and coach-marks are deferred (NS-13). Progress is private to a membership and idempotent:
 * every read and the completion upsert are scoped by `membership_id`, and the unique step key turns a
 * re-completion into an engine conflict the repository swallows rather than a second row. Written by
 * INSERT alone — no update of a row's identity, no delete — so the runtime credential holds INSERT
 * only and the withheld privileges are the immutability control.
 */
export const onboardingProgress = mysqlTable(
  'onboarding_progress',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    step: mysqlEnum('step', ONBOARDING_TOUR_STEPS).notNull(),
    completedAt: datetime('completed_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_onboarding_progress_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_onboarding_progress_step').on(
      table.organizationId,
      table.membershipId,
      table.step,
    ),
    index('ix_onboarding_progress_org_membership').on(
      table.organizationId,
      table.membershipId,
      table.completedAt,
      table.id,
    ),
  ],
);

/**
 * PREF-001 (x182) — the closed vocabularies a user preference can take. Each is a fixed allowlist
 * checked on write: a theme, locale or density outside its set is a 400 with no row written, so a
 * `prefs_json` blob can never hold a value the appearance/locale surface does not know how to
 * render. Kept here beside the table so the write validator and the column `$type` share one source.
 */
export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** The density of the internal shell — the two the design system lays out for. */
export const DENSITY_PREFERENCES = ['comfortable', 'compact'] as const;
export type DensityPreference = (typeof DENSITY_PREFERENCES)[number];

/**
 * The locales the app is translated for. A closed allowlist rather than any BCP-47 string: an
 * unknown locale would fall back to the default at render time anyway, so accepting only what the
 * bundle ships keeps "unset", "default" and "a locale we do not have" from being confused, and a
 * typo a 400 rather than a stored value nothing honours.
 */
export const PREFERENCE_LOCALES = ['en', 'en-GB', 'fr', 'de', 'es'] as const;
export type PreferenceLocale = (typeof PREFERENCE_LOCALES)[number];

/** The settings stored in `user_preferences.prefs_json` — the exact shape the GET/PUT exchanges. */
export interface UserPreferencesJson {
  readonly theme: ThemePreference;
  readonly locale: PreferenceLocale;
  readonly density: DensityPreference;
}

/**
 * PREF-001 appearance & accessibility preferences (x182, migration 0078). One row per membership
 * per studio, holding that member's own appearance/locale settings as a fixed-key JSON blob. Own-
 * principal: the read and the upsert are both scoped by `membership_id = the acting context's
 * membership`, so a member reaches only their own row and never another's, even inside one tenant.
 * Distinct from `notification_preferences` (that is delivery channels, keyed by user); this is the
 * appearance/locale surface the audit named absent. Created and replaced in place, never removed —
 * INSERT and UPDATE only (the upsert), no DELETE.
 */
export const userPreferences = mysqlTable(
  'user_preferences',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    prefsJson: json('prefs_json').$type<UserPreferencesJson>().notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_user_preferences_org_id').on(table.organizationId, table.id),
    // The upsert key: one row per membership per studio.
    uniqueIndex('uq_user_preferences_org_membership').on(table.organizationId, table.membershipId),
  ],
);

/**
 * x216 (0094) — a member's tenant-local editable profile (module 14 People & capacity). The
 * writable store x168's directory and x169's read-only profile never had: `display_name` is on the
 * GLOBAL `users` table, so it can never be edited from an org-scoped route (the reason x192 was
 * blocked). One row per member per studio, keyed by `(organization_id, user_id)`; all four fields
 * are NULLable and edited only through `/people/:membershipId/profile`. The composite FK binds the
 * pair to a membership of this same tenant.
 */
export const memberProfiles = mysqlTable(
  'member_profiles',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    userId: char('user_id', { length: 36 }).notNull(),
    /** The member's own job title in this studio (0215), edited only via `PUT …/me/profile`. */
    jobTitle: varchar('job_title', { length: 120 }),
    department: varchar('department', { length: 120 }),
    bio: varchar('bio', { length: 2000 }),
    contactEmail: varchar('contact_email', { length: 320 }),
    contactPhone: varchar('contact_phone', { length: 40 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_member_profiles_org_id').on(table.organizationId, table.id),
    // The upsert key: one profile per member per studio.
    uniqueIndex('uq_member_profiles_org_user').on(table.organizationId, table.userId),
  ],
);

/**
 * The field types a work intake form (0052, x146) can declare. Kept small and closed: a value
 * outside this set is a validation error (`work-forms.validate.ts`), never stored.
 */
export const WORK_FORM_FIELD_TYPES = ['text', 'number', 'date', 'checkbox'] as const;
export type WorkFormFieldType = (typeof WORK_FORM_FIELD_TYPES)[number];

/**
 * One field definition inside a work form's `fields_json` — a label, a type, and whether a
 * submission must supply it. The typed shape of the JSON column below; the application validates a
 * request against it before storing.
 */
export interface WorkFormFieldDef {
  readonly label: string;
  readonly type: WorkFormFieldType;
  readonly required: boolean;
}

/**
 * WORK intake forms (0052, x146). Org-scoped like `document_templates`: a reusable definition of the
 * fields an intake captures, from which a work item is created. `fields_json` holds the ordered list
 * of {@link WorkFormFieldDef}. Identity (`organization_id`, `created_by`) is immutable at the engine.
 */
export const workForms = mysqlTable(
  'work_forms',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 300 }).notNull(),
    fieldsJson: json('fields_json').$type<readonly WorkFormFieldDef[]>().notNull(),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    /** 0258 (52-20). The random public slug; NULL until first published, kept on unpublish. */
    publicSlug: varchar('public_slug', { length: 16 }),
    /** 0258 (52-20). An unpublished slug answers the same 404 as an unknown one. */
    publicEnabled: boolean('public_enabled').notNull().default(false),
    publishedAt: datetime('published_at', { mode: 'date', fsp: 3 }),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_work_forms_org_id').on(table.organizationId, table.id),
    index('ix_work_forms_org_name').on(table.organizationId, table.name, table.id),
    uniqueIndex('uq_work_forms_public_slug').on(table.publicSlug),
  ],
);

/** 0258 (52-20). A public submission's triage state — closed list checked in `public-forms`. */
export const FORM_SUBMISSION_STATES = ['new', 'converting', 'converted', 'spam'] as const;
export type FormSubmissionState = (typeof FORM_SUBMISSION_STATES)[number];

/**
 * 0258 (52-20). One accepted public intake submission. TENANT: keyed `(organization_id, id)`,
 * `reference` unique per organization, composite foreign key to `work_forms`. `values_json` is
 * the visitor's values keyed by field label, typed and length-capped by the public door. No IP
 * or user agent (52-21's telemetry keeps the abuse signal). `risk_*` copies 52-21's verdict.
 */
export const formSubmissions = mysqlTable(
  'form_submissions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    formId: char('form_id', { length: 36 }).notNull(),
    reference: varchar('reference', { length: 12 }).notNull(),
    valuesJson: text('values_json').notNull(),
    language: varchar('language', { length: 5 }),
    state: varchar('state', { length: 12 }).notNull().default('new'),
    riskDecision: varchar('risk_decision', { length: 12 }).notNull().default('allow'),
    riskScore: int('risk_score').notNull().default(0),
    riskReasons: varchar('risk_reasons', { length: 255 }),
    createdWorkItemId: char('created_work_item_id', { length: 36 }),
    convertedBy: char('converted_by', { length: 36 }),
    convertedAt: datetime('converted_at', { mode: 'date', fsp: 3 }),
    spamMarkedBy: char('spam_marked_by', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_form_submissions_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_form_submissions_reference').on(table.organizationId, table.reference),
    index('ix_form_submissions_form').on(
      table.organizationId,
      table.formId,
      table.createdAt,
      table.id,
    ),
  ],
);

/**
 * Organization settings / policy (Administration module 18, x153, migration 0058). One row per
 * allowlisted key per organization: a flat, validated key/value settings surface. The allowlist —
 * which keys exist, their defaults and their per-key validators — lives in `org-settings.allowlist.ts`,
 * not here: this is only the shape at rest. `setting_value` is stored as a string; the typed meaning
 * of each key is the allowlist's. `uq_org_settings_org_key` makes a re-set an upsert target, not a
 * second row. Identity (`organization_id`, `id`, `setting_key`) is immutable at the engine; only
 * `setting_value`/`updated_by`/`updated_at` move on an upsert. The runtime credential holds INSERT and
 * UPDATE (the upsert) and no DELETE — a setting is set and changed, never removed by a runtime path.
 */
export const orgSettings = mysqlTable(
  'org_settings',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    settingKey: varchar('setting_key', { length: 64 }).notNull(),
    settingValue: varchar('setting_value', { length: 255 }).notNull(),
    updatedBy: char('updated_by', { length: 36 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_org_settings_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_org_settings_org_key').on(table.organizationId, table.settingKey),
  ],
);
/**
 * Public-site contact / lead intake (0062, x161). GLOBAL, org-less — a lead is submitted by a
 * member of the public with no session and no organization, so it carries no `organization_id` and
 * is registered in the tenant guard's `NON_TENANT_TABLES`, not `TENANT_TABLES`. Write-only at
 * runtime (the app grant is INSERT only): there is no read/list endpoint in this slice. Every field
 * is bounded at the column behind the controller's validation. See `0062_marketing_leads.sql`.
 */
export const marketingLeads = mysqlTable(
  'marketing_leads',
  {
    id: char('id', { length: 36 }).primaryKey(),
    name: varchar('name', { length: 200 }).notNull(),
    email: varchar('email', { length: 254 }).notNull(),
    message: varchar('message', { length: 4000 }).notNull(),
    source: varchar('source', { length: 100 }).notNull(),
    /** 0255 (52-21): `clear | held | spam` — the abuse engine's verdict; held/spam are never delivered. */
    reviewStatus: varchar('review_status', { length: 16 }).notNull().default('clear'),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [index('ix_marketing_leads_created_at').on(table.createdAt, table.id)],
);

/**
 * The action configuration a workflow template (0063, x162) carries — a small, bounded object read
 * and written whole with the template. The application validates its size and shape before storing;
 * the column holds it whole. Typed loosely here (an arbitrary object) because the meaningful shape is
 * per-`action_kind` and validated in the module, not by the schema.
 */
export type WorkflowTemplateConfig = Record<string, unknown>;

/**
 * Automation workflow templates (0063, x162). Org-scoped like `work_forms`: a named pairing of a
 * trigger and an action, plus the action's bounded `config_json`. `trigger_kind` and `action_kind`
 * are validated against a fixed application allowlist before any write, so each column only ever holds
 * a known token. A definition at rest — nothing executes a template in this slice (runs are x163).
 * Identity (`organization_id`, `created_by`) is immutable at the engine.
 */
export const workflowTemplates = mysqlTable(
  'workflow_templates',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 300 }).notNull(),
    triggerKind: varchar('trigger_kind', { length: 64 }).notNull(),
    actionKind: varchar('action_kind', { length: 64 }).notNull(),
    configJson: json('config_json').$type<WorkflowTemplateConfig>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    /** A14 (0226): soft-delete stamp; NULL is a live rule, every read filters on it. */
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_workflow_templates_org_id').on(table.organizationId, table.id),
    index('ix_workflow_templates_org_name').on(table.organizationId, table.name, table.id),
  ],
);

/**
 * The bounded detail a workflow run (0064, x163) records — a small object describing what the in-app
 * action did (its kind, its planned effect). The application validates its size before storing; the
 * column holds it whole. Typed loosely here (an arbitrary object) because the meaningful shape is
 * per-`action_kind` and produced by the run service, not by the schema.
 */
export type WorkflowRunDetail = Record<string, unknown>;

/**
 * Automation workflow runs (0064, x163). Org-scoped append-only history of one execution of a
 * {@link workflowTemplates} row: the template it ran, a `status` from a fixed application allowlist
 * (`succeeded` | `failed`), the bounded `detail_json` the in-app action produced, and the start/finish
 * instants. The template reference is the composite `(organization_id, template_id)` key so a run
 * cannot point across a tenant boundary. Identity (`organization_id`, `template_id`) is immutable at
 * the engine; the app is granted INSERT only.
 */
export const workflowRuns = mysqlTable(
  'workflow_runs',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    templateId: char('template_id', { length: 36 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    detailJson: json('detail_json').$type<WorkflowRunDetail>().notNull(),
    startedAt: datetime('started_at', { mode: 'date', fsp: 3 }).notNull(),
    finishedAt: datetime('finished_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_workflow_runs_org_id').on(table.organizationId, table.id),
    index('ix_workflow_runs_org_template').on(
      table.organizationId,
      table.templateId,
      table.startedAt,
    ),
  ],
);

/** An integration connection's status: a live connection, or an intent awaiting a later exchange. */
export const INTEGRATION_CONNECTION_STATUSES = ['connected', 'pending'] as const;
export type IntegrationConnectionStatus = (typeof INTEGRATION_CONNECTION_STATUSES)[number];

/** A connection's non-secret settings bag: bounded scalar values under bounded keys, never a token. */
export type IntegrationConnectionConfig = Readonly<Record<string, string | number | boolean>>;

/**
 * Automations app/integration connections (0065, x165). Org-scoped like `work_forms`: which
 * code-defined catalog app the organization has connected, a display label, a `status`, and a bounded
 * bag of NON-SECRET settings in `config_json`. No credentials are ever stored — the application
 * rejects secret-shaped keys before a row is written. Identity (`organization_id`, `app_id`,
 * `created_by`) is immutable at the engine; `status` is stored as a VARCHAR validated by the
 * application, matching the on-disk DDL (0065).
 */
export const integrationConnections = mysqlTable(
  'integration_connections',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    appId: varchar('app_id', { length: 64 }).notNull(),
    label: varchar('label', { length: 300 }).notNull(),
    status: varchar('status', { length: 20 }).$type<IntegrationConnectionStatus>().notNull(),
    configJson: json('config_json').$type<IntegrationConnectionConfig>().notNull(),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_integration_connections_org_id').on(table.organizationId, table.id),
    index('ix_integration_connections_org_app').on(table.organizationId, table.appId, table.id),
  ],
);

export const webhookEndpoints = mysqlTable(
  'webhook_endpoints',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    url: varchar('url', { length: 2048 }).notNull(),
    eventKind: varchar('event_kind', { length: 64 }).notNull(),
    secretHash: char('secret_hash', { length: 64 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- 0281 · R13 slice 2 (webhooks v2) ----
    description: varchar('description', { length: 300 }),
    /** JSON array of subscribed webhook kinds (`webhook-event-catalog.ts`). Always written. */
    eventsJson: text('events_json').notNull(),
    /** 'active' | 'paused' | 'needs_rotation'. */
    status: varchar('status', { length: 16 }).notNull().default('active'),
    /** FieldCipher envelope (purpose `webhook_secret`, owner = endpoint id). Never projected. */
    secretEnc: text('secret_enc'),
    secretPrevEnc: text('secret_prev_enc'),
    secretPrevHash: char('secret_prev_hash', { length: 64 }),
    secretRotatedAt: datetime('secret_rotated_at', { mode: 'date', fsp: 3 }),
    secretPrevExpiresAt: datetime('secret_prev_expires_at', { mode: 'date', fsp: 3 }),
    failureStreak: int('failure_streak').notNull().default(0),
    pausedReason: varchar('paused_reason', { length: 200 }),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_webhook_endpoints_org_id').on(table.organizationId, table.id),
    index('ix_webhook_endpoints_org_created').on(table.organizationId, table.createdAt, table.id),
  ],
);

/**
 * Webhook delivery attempts (0097, x221). Org-scoped, append-only record of what was delivered to a
 * {@link webhookEndpoints} row: the outcome `status` (application allowlist), the HTTP `responseCode`
 * when one was received (else null), and the attempt instant. It stores neither the endpoint's
 * signing secret nor the request/response body — a delivery record carries the outcome, never the
 * content — so it cannot leak the secret or payload. Immutable: the runtime credential is granted
 * INSERT and SELECT only (`users.sql`), exactly like `audit_events`, so no column-pinning trigger is
 * needed. The `(organization_id, endpoint_id)` FK keys each row to a same-tenant endpoint.
 */
export const webhookDeliveries = mysqlTable(
  'webhook_deliveries',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    endpointId: char('endpoint_id', { length: 36 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    responseCode: smallint('response_code', { unsigned: true }),
    attemptedAt: datetime('attempted_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- 0281 · R13 slice 2 (webhooks v2): one row per attempt ----
    eventId: char('event_id', { length: 36 }),
    eventKind: varchar('event_kind', { length: 64 }),
    attempt: int('attempt').notNull().default(1),
    nextAttemptAt: datetime('next_attempt_at', { mode: 'date', fsp: 3 }),
    durationMs: int('duration_ms'),
    /** At most 500 chars of the target's answer — never the request body, never a secret. */
    responseExcerpt: varchar('response_excerpt', { length: 500 }),
    signatureKeyId: varchar('signature_key_id', { length: 8 }),
    resolvedIp: varchar('resolved_ip', { length: 45 }),
  },
  (table) => [
    uniqueIndex('uq_webhook_deliveries_org_id').on(table.organizationId, table.id),
    index('ix_webhook_deliveries_org_endpoint').on(
      table.organizationId,
      table.endpointId,
      table.id,
    ),
    index('ix_wd_next').on(table.organizationId, table.nextAttemptAt),
  ],
);

/**
 * The comparison operators a workflow condition (0081, x190) may use. A closed application allowlist
 * mirrored by `workflow_conditions.op`: an off-list operator is a 400 with no write and the column only
 * ever holds a known token. Kept in the application (not a MySQL `ENUM`) so the set can grow without an
 * `ALTER TABLE`, the same division `workflow_templates.trigger_kind` uses.
 */
export const WORKFLOW_CONDITION_OPS = ['eq', 'neq', 'gt', 'lt', 'contains'] as const;
export type WorkflowConditionOp = (typeof WORKFLOW_CONDITION_OPS)[number];

/**
 * Automation workflow conditions (0081, x190). Org-scoped per-step gate on a {@link workflowTemplates}
 * row: a `(field, op, value)` predicate and the `target_step` it governs — the run evaluator (x163)
 * reads these to decide whether a step fires. Keyed to its template through the composite
 * `(organization_id, template_id)` foreign key so a condition can never point across a tenant boundary.
 * `op` is a fixed application allowlist ({@link WORKFLOW_CONDITION_OPS}) validated before any write.
 * Identity (`organization_id`, `template_id`, `created_by`) is immutable at the engine; the app is
 * granted INSERT only.
 */
export const workflowConditions = mysqlTable(
  'workflow_conditions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    templateId: char('template_id', { length: 36 }).notNull(),
    field: varchar('field', { length: 200 }).notNull(),
    op: varchar('op', { length: 16 }).notNull(),
    value: varchar('value', { length: 500 }).notNull(),
    targetStep: int('target_step', { unsigned: true }).notNull(),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_workflow_conditions_org_id').on(table.organizationId, table.id),
    index('ix_workflow_conditions_org_template').on(
      table.organizationId,
      table.templateId,
      table.targetStep,
    ),
  ],
);

/**
 * Automation variables (0173, x305). Org-scoped, **non-secret** `(var_key -> var_value)` map a
 * workflow template may reference. Addressed by `var_key` within the tenant — the `(organization_id,
 * var_key)` unique key is the upsert target (`PUT` writes `INSERT ... ON DUPLICATE KEY UPDATE` against
 * it). Secrets/credentials are out of scope: the application refuses a secret-like key name and holds
 * `var_key` to a safe-identifier grammar before any write. Identity (`organization_id`, `var_key`) is
 * immutable at the engine; the app is granted INSERT/UPDATE/DELETE (upsert and remove). `0173_automation_variables.sql`
 * is the source of truth; this is its typed mirror.
 */
export const automationVariables = mysqlTable(
  'automation_variables',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    varKey: varchar('var_key', { length: 64 }).notNull(),
    varValue: varchar('var_value', { length: 2000 }).notNull(),
    updatedBy: char('updated_by', { length: 36 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_automation_variables_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_automation_variables_org_key').on(table.organizationId, table.varKey),
  ],
);

/**
 * Automation template tags (0201, x335). Org-scoped free-text labels attached to a {@link
 * workflowTemplates} row so a studio can categorise its automation templates and filter them by tag.
 * Keyed to its template through the composite `(organization_id, workflow_template_id)` foreign key so
 * a tag can never point across a tenant boundary. One tag per `(organization_id, workflow_template_id,
 * label)`, case-insensitively (the `utf8mb4_unicode_ci` collation folds case, the `person_skills`
 * posture); the application normalises the label before insert and turns a duplicate into a 409. A tag
 * is a label at rest — created and deleted, never edited — so identity (`organization_id`,
 * `workflow_template_id`, `label`, `created_by`) is immutable at the engine and the app is granted
 * INSERT + DELETE only. `0201_automation_template_tags.sql` is the source of truth; this is its typed
 * mirror.
 */
export const automationTemplateTags = mysqlTable(
  'automation_template_tags',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    workflowTemplateId: char('workflow_template_id', { length: 36 }).notNull(),
    label: varchar('label', { length: 80 }).notNull(),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_automation_template_tags_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_automation_template_tags_label').on(
      table.organizationId,
      table.workflowTemplateId,
      table.label,
    ),
    index('ix_automation_template_tags_template').on(
      table.organizationId,
      table.workflowTemplateId,
      table.label,
    ),
  ],
);

/**
 * C1 (0230). One firing of a `work_item_due_soon` rule for one work item on one day — the claim the
 * worker's due-soon sweep inserts (`INSERT IGNORE`) before it runs the rule, so the unique
 * `(organization_id, template_id, work_item_id, fire_date)` key makes the trigger idempotent per item
 * per day. Both references use the composite tenant keys. Worker-written only (INSERT); never updated
 * or deleted. `0230_workflow_due_soon_fires.sql` is the source of truth; this is its typed mirror.
 */
export const workflowDueSoonFires = mysqlTable(
  'workflow_due_soon_fires',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    templateId: char('template_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    fireDate: date('fire_date', { mode: 'string' }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_workflow_due_soon_fires_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_workflow_due_soon_fires_claim').on(
      table.organizationId,
      table.templateId,
      table.workItemId,
      table.fireDate,
    ),
    index('ix_workflow_due_soon_fires_item').on(table.organizationId, table.workItemId),
  ],
);

/** D5 (0231). The vocabularies of the two privacy tables, mirrored from the migration's ENUMs. */
export const PRIVACY_EXPORT_KINDS = ['company', 'member'] as const;
export const PRIVACY_EXPORT_STATUSES = ['preparing', 'ready', 'failed'] as const;
export const PRIVACY_EXPORT_SCAN_STATUSES = ['clean', 'not_scanned'] as const;
export const PRIVACY_DELETION_KINDS = ['company', 'account'] as const;
export const PRIVACY_DELETION_STATUSES = ['scheduled', 'cancelled', 'executed'] as const;

/**
 * D5 (0231). A data-export request: the owner's company archive or one person's personal data. The
 * privacy job claims a `preparing` row, writes the archive through the scanner and moves it to `ready`
 * (with `expires_at`) or `failed`. `0231_privacy_requests.sql` is the source of truth.
 */
export const privacyExports = mysqlTable(
  'privacy_exports',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    kind: mysqlEnum('kind', PRIVACY_EXPORT_KINDS).notNull(),
    subjectUserId: char('subject_user_id', { length: 36 }),
    requestedByUserId: char('requested_by_user_id', { length: 36 }).notNull(),
    status: mysqlEnum('status', PRIVACY_EXPORT_STATUSES).notNull().default('preparing'),
    progressPercent: tinyint('progress_percent', { unsigned: true }).notNull().default(0),
    objectKey: varchar('object_key', { length: 255 }),
    sizeBytes: bigint('size_bytes', { mode: 'number', unsigned: true }),
    scanStatus: mysqlEnum('scan_status', PRIVACY_EXPORT_SCAN_STATUSES),
    failureCode: varchar('failure_code', { length: 64 }),
    claimedAt: datetime('claimed_at', { mode: 'date', fsp: 3 }),
    requestedAt: datetime('requested_at', { mode: 'date', fsp: 3 }).notNull(),
    completedAt: datetime('completed_at', { mode: 'date', fsp: 3 }),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }),
    purgedAt: datetime('purged_at', { mode: 'date', fsp: 3 }),
    version: bigint('version', { mode: 'number', unsigned: true }).notNull().default(1),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_privacy_exports_org_id').on(table.organizationId, table.id),
    index('ix_privacy_exports_org_requested').on(table.organizationId, table.requestedAt, table.id),
    index('ix_privacy_exports_org_subject').on(
      table.organizationId,
      table.subjectUserId,
      table.requestedAt,
    ),
    index('ix_privacy_exports_status').on(table.status, table.claimedAt),
  ],
);

/**
 * D5 (0231). A deletion request with a grace period: the company (owner-only) or one person's
 * account in this studio. `scheduled` until `scheduled_for`, cancellable until then, then `executed`
 * by the privacy job. `0231_privacy_requests.sql` is the source of truth.
 */
export const privacyDeletionRequests = mysqlTable(
  'privacy_deletion_requests',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    kind: mysqlEnum('kind', PRIVACY_DELETION_KINDS).notNull(),
    subjectUserId: char('subject_user_id', { length: 36 }),
    requestedByUserId: char('requested_by_user_id', { length: 36 }).notNull(),
    status: mysqlEnum('status', PRIVACY_DELETION_STATUSES).notNull().default('scheduled'),
    requestedAt: datetime('requested_at', { mode: 'date', fsp: 3 }).notNull(),
    scheduledFor: datetime('scheduled_for', { mode: 'date', fsp: 3 }).notNull(),
    cancelledAt: datetime('cancelled_at', { mode: 'date', fsp: 3 }),
    cancelledByUserId: char('cancelled_by_user_id', { length: 36 }),
    executedAt: datetime('executed_at', { mode: 'date', fsp: 3 }),
    /** 0233 (H3). When the job finished erasing a closed company's rows and files; NULL = to do. */
    purgedAt: datetime('purged_at', { mode: 'date', fsp: 3 }),
    version: bigint('version', { mode: 'number', unsigned: true }).notNull().default(1),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_privacy_deletion_requests_org_id').on(table.organizationId, table.id),
    index('ix_privacy_deletion_requests_org_kind').on(
      table.organizationId,
      table.kind,
      table.status,
    ),
    index('ix_privacy_deletion_requests_due').on(table.status, table.scheduledFor),
  ],
);

/**
 * PEOPLE / module 14 (x171). A person's allocation to a project — which membership, which project,
 * what share of their time (`percent`, 1..100), an optional `start_date`/`end_date` window, and when
 * the row was created. Tenant-scoped and project-owned like `project_objectives` (0040), plus a second
 * composite foreign key to `memberships` so both ids are proven to belong to the acting tenant. An
 * "active" allocation is one whose `end_date` is null; the one-active-per-(project, membership) rule is
 * an application invariant (409), since MySQL treats NULLs as distinct in a UNIQUE index.
 * `0069_person_allocations.sql` is the source of truth; this is its typed mirror.
 */
export const personAllocations = mysqlTable(
  'person_allocations',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    percent: tinyint('percent', { unsigned: true }).notNull(),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- R20-b · 53-08 (0308): tentative|confirmed (app-checked), explicit hours, a short note ----
    status: varchar('status', { length: 10 }).notNull().default('confirmed'),
    hoursPerWeek: decimal('hours_per_week', { precision: 5, scale: 2, mode: 'number' }),
    note: varchar('note', { length: 300 }),
  },
  (table) => [
    uniqueIndex('uq_person_allocations_org_id').on(table.organizationId, table.id),
    index('ix_person_allocations_org_project').on(
      table.organizationId,
      table.projectId,
      table.createdAt,
    ),
    index('ix_person_allocations_org_project_member').on(
      table.organizationId,
      table.projectId,
      table.membershipId,
    ),
  ],
);

/** A member skill's three fixed proficiency rungs (0070, x172). The set is the contract. */
export const PERSON_SKILL_LEVELS = ['basic', 'proficient', 'expert'] as const;
export type PersonSkillLevel = (typeof PERSON_SKILL_LEVELS)[number];

/**
 * People member skills (0070, x172). A `label` + `level` hung off a `memberships` row: what a member
 * can do, so they can be found for matching. Tenant-scoped (`organization_id`) and membership-owned
 * (`membership_id`); one skill per `(organization_id, membership_id, label)`. Identity
 * (`organization_id`, `membership_id`, `label`) is immutable at the engine — a re-label is a delete
 * and re-add. The app holds INSERT and DELETE only.
 */
export const personSkills = mysqlTable(
  'person_skills',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    label: varchar('label', { length: 80 }).notNull(),
    level: mysqlEnum('level', PERSON_SKILL_LEVELS).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_person_skills_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_person_skills_member_label').on(
      table.organizationId,
      table.membershipId,
      table.label,
    ),
    index('ix_person_skills_member_label').on(
      table.organizationId,
      table.membershipId,
      table.label,
      table.id,
    ),
  ],
);

/**
 * Person certifications (0194, x326). People module 14. A person's dated credentials — a `name`, an
 * `issuer`, an `issued_on` day and an optional `expires_on` day — hung off a `memberships` row by
 * `person_user_id` so it names a person *within* one tenant. Distinct from `person_skills` (0070,
 * proficiency tags): a certification is a dated credential, not a self-assessed skill level.
 *
 * Tenant-scoped (`organization_id`) and member-owned (`person_user_id`, composite FK to
 * `memberships (organization_id, user_id)`, ON DELETE CASCADE). Whether a certification is *expired*
 * is never stored — it is `expires_on < today` computed read-side against the process clock. The app
 * holds INSERT and DELETE only (a correction is a delete and re-add), so there is no editable column.
 * `0194_person_certifications.sql` is the source of truth; this is its typed mirror.
 */
export const personCertifications = mysqlTable(
  'person_certifications',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    personUserId: char('person_user_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    issuer: varchar('issuer', { length: 200 }).notNull(),
    issuedOn: date('issued_on', { mode: 'string' }).notNull(),
    expiresOn: date('expires_on', { mode: 'string' }),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_person_certifications_org_id').on(table.organizationId, table.id),
    index('ix_person_certifications_person').on(
      table.organizationId,
      table.personUserId,
      table.issuedOn,
      table.id,
    ),
  ],
);

/**
 * Per-member weekly capacity (0068, x170). People module 14. Tenant-scoped: one active row per
 * member, keyed by `(organization_id, membership_id)`, holding the available hours a week and the
 * date the figure takes effect. `weekly_hours` is bounded [0,168] at the engine; identity
 * (`organization_id`, `membership_id`) is immutable at the engine. The PUT is an upsert against the
 * natural key, so this table is the current capacity at rest, not a history.
 */
export const personCapacity = mysqlTable(
  'person_capacity',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    weeklyHours: smallint('weekly_hours', { unsigned: true }).notNull(),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_person_capacity_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_person_capacity_org_membership').on(table.organizationId, table.membershipId),
  ],
);

/**
 * Member reporting lines (People module 14, org chart, x217, migration 0095). At most one row per
 * member, keyed by `(organization_id, member_id)`, recording the member they report to
 * (`manager_member_id`). The set of rows is the edge set of the tenant's reporting tree — the org-chart
 * screen draws it. `0095_member_reporting_lines.sql` is the source of truth; this is its typed mirror.
 *
 * Both member and manager are tenant-bound composite FKs to `memberships`, so neither can name another
 * tenant's member. A member is never their own manager (a `CHECK`); a longer cycle is refused by the
 * controller before any write. Identity (`organization_id`, `member_id`) is immutable at the engine;
 * `manager_member_id` is the one editable field, rewritten by the upsert. The PUT is an upsert against
 * `uq_member_reporting_lines_org_member`, so this table is the current reporting line at rest, not a
 * history; clearing a line deletes the row.
 */
export const memberReportingLines = mysqlTable(
  'member_reporting_lines',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    memberId: char('member_id', { length: 36 }).notNull(),
    managerMemberId: char('manager_member_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_member_reporting_lines_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_member_reporting_lines_org_member').on(table.organizationId, table.memberId),
    index('ix_member_reporting_lines_org_manager').on(table.organizationId, table.managerMemberId),
  ],
);

/**
 * Member availability / out-of-office windows (People module 14, x218, migration 0096). A *list*
 * (unlike person_capacity's one-row-per-member): zero or more dated OOO windows per member, keyed
 * `(organization_id, member_id)`, tenant-owned and registered in the query guard's TENANT_TABLES.
 * A window is added (INSERT) and removed (DELETE), never edited — `kind` is validated against a
 * fixed allowlist by the application and the 0096 trigger pins rows immutable at the engine.
 */
export const memberAvailability = mysqlTable(
  'member_availability',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    memberId: char('member_id', { length: 36 }).notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    kind: varchar('kind', { length: 20 }).notNull(),
    note: varchar('note', { length: 500 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_member_availability_org_id').on(table.organizationId, table.id),
    index('ix_member_availability_member').on(
      table.organizationId,
      table.memberId,
      table.startDate,
      table.id,
    ),
  ],
);

/**
 * Custom roles (Administration module 18, x173, migration 0071). One row per named role per
 * organization: a role's display name and the capability subset it grants. The capability list is a
 * subset of the fixed `CAPABILITIES` allowlist (`12-PERMISSION-MATRIX` §2) — no new capability is ever
 * defined here and nothing is granted beyond the role's author; `roles.controller.ts` refuses any
 * off-allowlist string (400) and any capability the caller cannot itself exercise (403) before a
 * write. `capabilities_json` stores the subset as a JSON array of allowlisted strings. A role is
 * created once — `uq_custom_roles_org_name` makes a duplicate name a 409, not a second row — and cloned
 * (INSERT). x195 adds edit in place (UPDATE): `role-edit.controller.ts` re-checks the new/cloned subset
 * against the allowlist (400) and the caller (403) before the write, so an edit or clone can never widen
 * a role past its author. The runtime credential holds INSERT and UPDATE but no DELETE: removing a role
 * is a later slice, and the withheld DELETE stays the immutability control against deletion.
 */
export const customRoles = mysqlTable(
  'custom_roles',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    capabilitiesJson: text('capabilities_json').notNull(),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_custom_roles_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_custom_roles_org_name').on(table.organizationId, table.name),
  ],
);

/**
 * Admin private member notes (Administration module 18, x280, migration 0149). An org admin's
 * private, internal annotation about a member — an HR-style note attached to a membership, added and
 * removed by `org.manage` holders and **never** surfaced on any member-facing read path. One row per
 * note: the member it is about (`subject_membership_id`), the note body, the author membership (an
 * `org.manage` holder, the acting membership — never a body value) and when it was written.
 *
 * Tenant-scoped and membership-owned. `member-notes.service.ts` resolves the subject membership
 * tenant-scoped **before** the `org.manage` authorize, so a cross-tenant or unknown membership id is
 * a 404 with no write; the composite foreign key on `(organization_id, subject_membership_id)` is the
 * engine half of that trap. Append-only: the runtime credential holds INSERT and DELETE but no
 * UPDATE, and the `0149` `BEFORE UPDATE` trigger refuses any amendment — a note's body and
 * attribution are fixed once written, so correcting one is delete-and-re-add.
 */
export const memberAdminNotes = mysqlTable(
  'member_admin_notes',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    subjectMembershipId: char('subject_membership_id', { length: 36 }).notNull(),
    body: text('body').notNull(),
    authorMembershipId: char('author_membership_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_member_admin_notes_org_id').on(table.organizationId, table.id),
    index('ix_member_admin_notes_subject').on(
      table.organizationId,
      table.subjectMembershipId,
      table.id,
    ),
  ],
);

/**
 * The typed access-policy document stored in `org_policies.policy_json` (Administration module 18,
 * x174). The typed shape of the JSON column below; the application validates a request against the
 * fixed-key allowlist (`policies.allowlist.ts`) before storing, and reads it back through the same
 * module's normaliser. Distinct from `org_settings` (general string key/value preferences): this is
 * the org's *access policy* — session lifetime, invite-domain allowlist, guest access — one typed,
 * bounded document per organization.
 */
export interface OrgPolicyValue {
  readonly session_max_hours: number;
  readonly invite_domain_allowlist: readonly string[];
  readonly guest_access_enabled: boolean;
  /** R3. Sign out after this many idle minutes (since the last refresh); 0 = Off. */
  readonly idle_signout_minutes: number;
  /**
   * R13 s3 (56-09). Personal access token policy. Optional: absent means the default
   * (`policies.allowlist.ts` `resolvePatPolicy`: 365 days, no never-expiring tokens, all scopes).
   */
  readonly 'pat.max_expiry_days'?: number;
  readonly 'pat.allow_no_expiry'?: boolean;
  readonly 'pat.allowed_scopes'?: readonly string[];
  /** R18-e (56-25). Sign-in policy; absent = every method, nobody required, no grace. */
  readonly 'signin.allowed_methods'?: readonly string[];
  readonly 'security.require_two_step_roles'?: string;
  readonly 'security.two_step_grace_until'?: string;
}

/**
 * Organization access policies (Administration module 18, x174, migration 0072). Exactly **one row
 * per organization** (`uq_org_policies_org`): the org's access-policy document, held as typed JSON.
 * The allowlist (`policies.allowlist.ts`) is the single source of which policies exist, their defaults,
 * and their per-key validators; this is only the shape at rest. Identity (`organization_id`, `id`) is
 * immutable at the engine. The runtime credential holds INSERT and UPDATE (the upsert) and no DELETE —
 * a policy document is created and edited, never removed by a runtime path.
 */
export const orgPolicies = mysqlTable(
  'org_policies',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    policyJson: json('policy_json').$type<OrgPolicyValue>().notNull(),
    updatedBy: char('updated_by', { length: 36 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_org_policies_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_org_policies_org').on(table.organizationId),
  ],
);

/** The subscription status set, mirroring the `0074` `ENUM`. */
export const SUBSCRIPTION_STATUSES = ['active', 'pending_change'] as const;

/**
 * Billing / module 19 (x177). An organization's current subscription — the plan it is on, that
 * plan's status, and when the current period ends.
 *
 * Tenant-scoped, one row per organization (`uq_subscriptions_org`): the subscription is a property
 * of the tenant, not a log. The billing screen reads it (defaulting to the free/base tier when no
 * row exists), and a plan change upserts it with `status = 'pending_change'` — a recorded intent,
 * never a charge (real payment is out of this slice). `organization_id` is pinned by the `0074`
 * trigger; `plan_id`, `status` and `current_period_end` are the mutable state a change writes.
 * `0074_subscriptions.sql` is the source of truth; this is its typed mirror.
 */
export const subscriptions = mysqlTable(
  'subscriptions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    planId: varchar('plan_id', { length: 64 }).notNull(),
    status: mysqlEnum('status', SUBSCRIPTION_STATUSES).notNull().default('active'),
    currentPeriodEnd: datetime('current_period_end', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_subscriptions_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_subscriptions_org').on(table.organizationId),
  ],
);

/**
 * A billing profile's postal address — the typed shape of `billing_profiles.address_json`. All
 * fields are nullable: a profile may carry only some of them. The application validates and bounds
 * each field before storing; the column holds the object whole.
 */
export interface BillingAddress {
  readonly line1: string | null;
  readonly line2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
}

/**
 * Billing profile (module 19, x180, migration 0077). Org-scoped, exactly one row per organization:
 * the non-secret billing metadata a studio keeps — a contact email, a company name, a tax id and a
 * postal address. There are deliberately no payment-instrument columns: card and bank numbers are
 * held by the payment provider (04-SECURITY-PRIVACY §4), never here, and the application rejects any
 * card/PAN-shaped value into these fields. `organization_id` is immutable at the engine (0077's
 * trigger); everything else is editable via the upsert. `uq_billing_profiles_org` (organization_id
 * alone) is the upsert key.
 */
export const billingProfiles = mysqlTable(
  'billing_profiles',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    billingEmail: varchar('billing_email', { length: 320 }),
    companyName: varchar('company_name', { length: 190 }),
    taxId: varchar('tax_id', { length: 64 }),
    addressJson: json('address_json').$type<BillingAddress>().notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_billing_profiles_org_id').on(table.organizationId, table.id),
    // The upsert key: one row per organization.
    uniqueIndex('uq_billing_profiles_org').on(table.organizationId),
  ],
);

/**
 * Billing contacts (module 19, x199, migration 0082). Org-scoped list of the people a studio nominates
 * for its billing and account notices — each a name, an email and an optional role label. Contacts are
 * added and removed, never edited in place (no update path), so there is no `updated_at`. As with the
 * billing profile there are deliberately no payment-instrument columns: card and bank numbers are held
 * by the payment provider (04-SECURITY-PRIVACY §4), never here, and the application rejects any
 * card/PAN-shaped value into these fields. `organization_id` is immutable at the engine (0082's
 * trigger). No email is sent to these contacts — delivery is Needs-Peter; the row is the whole effect.
 */
export const billingContacts = mysqlTable(
  'billing_contacts',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 190 }).notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    role: varchar('role', { length: 80 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_billing_contacts_org_id').on(table.organizationId, table.id),
    // The org-scoped list read leads with organization_id, newest first.
    index('ix_billing_contacts_org_created').on(table.organizationId, table.createdAt),
  ],
);

/**
 * The closed country allowlist — ISO 3166-1 alpha-2 codes, upper-case. A closed set rather than any
 * two-letter string, the reason {@link PREFERENCE_LOCALES} gives: a value outside it is a typo or an
 * unknown country, so the application refuses it (400) rather than storing a code nothing recognises.
 * Consumed by the billing tax-details slice ({@link billingTaxDetails}); the natural home for any later
 * country-scoped field. Frozen so no caller can mutate the shared list.
 */
export const ISO_COUNTRY_CODES = Object.freeze([
  'AD',
  'AE',
  'AF',
  'AG',
  'AI',
  'AL',
  'AM',
  'AO',
  'AQ',
  'AR',
  'AS',
  'AT',
  'AU',
  'AW',
  'AX',
  'AZ',
  'BA',
  'BB',
  'BD',
  'BE',
  'BF',
  'BG',
  'BH',
  'BI',
  'BJ',
  'BL',
  'BM',
  'BN',
  'BO',
  'BQ',
  'BR',
  'BS',
  'BT',
  'BV',
  'BW',
  'BY',
  'BZ',
  'CA',
  'CC',
  'CD',
  'CF',
  'CG',
  'CH',
  'CI',
  'CK',
  'CL',
  'CM',
  'CN',
  'CO',
  'CR',
  'CU',
  'CV',
  'CW',
  'CX',
  'CY',
  'CZ',
  'DE',
  'DJ',
  'DK',
  'DM',
  'DO',
  'DZ',
  'EC',
  'EE',
  'EG',
  'EH',
  'ER',
  'ES',
  'ET',
  'FI',
  'FJ',
  'FK',
  'FM',
  'FO',
  'FR',
  'GA',
  'GB',
  'GD',
  'GE',
  'GF',
  'GG',
  'GH',
  'GI',
  'GL',
  'GM',
  'GN',
  'GP',
  'GQ',
  'GR',
  'GS',
  'GT',
  'GU',
  'GW',
  'GY',
  'HK',
  'HM',
  'HN',
  'HR',
  'HT',
  'HU',
  'ID',
  'IE',
  'IL',
  'IM',
  'IN',
  'IO',
  'IQ',
  'IR',
  'IS',
  'IT',
  'JE',
  'JM',
  'JO',
  'JP',
  'KE',
  'KG',
  'KH',
  'KI',
  'KM',
  'KN',
  'KP',
  'KR',
  'KW',
  'KY',
  'KZ',
  'LA',
  'LB',
  'LC',
  'LI',
  'LK',
  'LR',
  'LS',
  'LT',
  'LU',
  'LV',
  'LY',
  'MA',
  'MC',
  'MD',
  'ME',
  'MF',
  'MG',
  'MH',
  'MK',
  'ML',
  'MM',
  'MN',
  'MO',
  'MP',
  'MQ',
  'MR',
  'MS',
  'MT',
  'MU',
  'MV',
  'MW',
  'MX',
  'MY',
  'MZ',
  'NA',
  'NC',
  'NE',
  'NF',
  'NG',
  'NI',
  'NL',
  'NO',
  'NP',
  'NR',
  'NU',
  'NZ',
  'OM',
  'PA',
  'PE',
  'PF',
  'PG',
  'PH',
  'PK',
  'PL',
  'PM',
  'PN',
  'PR',
  'PS',
  'PT',
  'PW',
  'PY',
  'QA',
  'RE',
  'RO',
  'RS',
  'RU',
  'RW',
  'SA',
  'SB',
  'SC',
  'SD',
  'SE',
  'SG',
  'SH',
  'SI',
  'SJ',
  'SK',
  'SL',
  'SM',
  'SN',
  'SO',
  'SR',
  'SS',
  'ST',
  'SV',
  'SX',
  'SY',
  'SZ',
  'TC',
  'TD',
  'TF',
  'TG',
  'TH',
  'TJ',
  'TK',
  'TL',
  'TM',
  'TN',
  'TO',
  'TR',
  'TT',
  'TV',
  'TW',
  'TZ',
  'UA',
  'UG',
  'UM',
  'US',
  'UY',
  'UZ',
  'VA',
  'VC',
  'VE',
  'VG',
  'VI',
  'VN',
  'VU',
  'WF',
  'WS',
  'YE',
  'YT',
  'ZA',
  'ZM',
  'ZW',
] as const);
export type IsoCountryCode = (typeof ISO_COUNTRY_CODES)[number];

/** The set form of {@link ISO_COUNTRY_CODES} for O(1) membership checks. */
export const ISO_COUNTRY_CODE_SET: ReadonlySet<string> = new Set(ISO_COUNTRY_CODES);

/**
 * Billing tax / legal-entity details (module 19, x283, migration 0152). Org-scoped, exactly one row per
 * organization: the studio's legal invoicing entity — a required legal name, an optional tax/VAT id, an
 * optional registration number and a 2-letter ISO tax country. Distinct from {@link billingProfiles}
 * (contact/company/address) and {@link billingContacts} (notified people): legal/tax fields only. There
 * are deliberately no payment-instrument columns — card and bank numbers are held by the payment
 * provider (04-SECURITY-PRIVACY §4), never here, and the application rejects any card/PAN-shaped value
 * into these fields. `tax_country` is validated against {@link ISO_COUNTRY_CODES}. `organization_id` is
 * immutable at the engine (0152's trigger); `uq_billing_tax_details_org` (organization_id alone) is the
 * upsert key.
 */
export const billingTaxDetails = mysqlTable(
  'billing_tax_details',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    legalName: varchar('legal_name', { length: 190 }).notNull(),
    taxId: varchar('tax_id', { length: 64 }),
    registrationNo: varchar('registration_no', { length: 120 }),
    taxCountry: char('tax_country', { length: 2 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_billing_tax_details_org_id').on(table.organizationId, table.id),
    // The upsert key: one row per organization.
    uniqueIndex('uq_billing_tax_details_org').on(table.organizationId),
  ],
);

/**
 * Organization security settings (Administration module 18, x176, migration 0073). Exactly one row per
 * organization: the org-wide security posture — whether a second factor is enforced (`enforce_2fa`) and
 * an IP allowlist (`ip_allowlist_json`, an array of validated IPv4/IPv6 addresses and CIDR ranges; empty
 * means no restriction). This slice **stores** the posture; enforcing it in the auth path is a later
 * identity slice, so this is only the config at rest. `uq_security_settings_org` makes a re-save an
 * upsert target, not a second row. Identity (`organization_id`, `id`) is immutable at the engine; only
 * `enforce_2fa`/`ip_allowlist_json`/`updated_by`/`updated_at` move on an upsert. The runtime credential
 * holds INSERT and UPDATE (the upsert) and no DELETE — a posture is set and changed, never removed.
 */
export const securitySettings = mysqlTable(
  'security_settings',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    enforce2fa: boolean('enforce_2fa').notNull().default(false),
    ipAllowlistJson: json('ip_allowlist_json').$type<readonly string[]>().notNull(),
    updatedBy: char('updated_by', { length: 36 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_security_settings_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_security_settings_org').on(table.organizationId),
  ],
);

/**
 * Organization IP allowlist entries (Administration module 18, x277, migration 0146). An itemised,
 * advisory list of allowed source networks — each an IPv4/IPv6 address or CIDR block with an optional
 * human label — added and removed on the security settings screen. Distinct from `security_settings`
 * (0073): that carries one posture blob per org (`ip_allowlist_json` on one row); this is a separate
 * entry table a screen lists, adds to and removes from. Advisory only — this slice **records** ranges
 * and does not enforce them at request time (a later slice does). `uq_org_ip_allowlist_org_cidr` makes
 * a repeated add a 409 rather than a second row. Identity (`organization_id`, `id`) is immutable at the
 * engine; entries are added and removed, never edited, so the runtime credential holds INSERT and
 * DELETE and no UPDATE. The application (`cidr.ts`) proves every stored `cidr` is a valid address/range.
 */
export const orgIpAllowlist = mysqlTable(
  'org_ip_allowlist',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    cidr: varchar('cidr', { length: 49 }).notNull(),
    label: varchar('label', { length: 120 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_org_ip_allowlist_org_id').on(table.organizationId, table.id),
    // One row per (organization, cidr): a repeated add is a 409, not a second row.
    uniqueIndex('uq_org_ip_allowlist_org_cidr').on(table.organizationId, table.cidr),
  ],
);

/**
 * Admin security-event alert configuration (Administration, security monitoring, x329, migration
 * 0196). One row per (organization, `event_type_key`): the tenant's choice to raise an in-app alert
 * for a security event type. `enabled` is toggled by a repeated PUT (the upsert), the row removed by
 * DELETE; `uq_admin_security_alerts_org_event` makes the second write a target rather than a second
 * row. Identity (`organization_id`, `id`, `event_type_key`) is immutable at the engine (the 0196
 * trigger); only `enabled` moves on an upsert. This table stores config only — the read-side match
 * against `audit_events` is read-only, and no dispatch exists (Needs-Peter). Keys are validated
 * against a fixed allowlist in the application before a write reaches here.
 */
export const adminSecurityAlerts = mysqlTable(
  'admin_security_alerts',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    eventTypeKey: varchar('event_type_key', { length: 190 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_admin_security_alerts_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_admin_security_alerts_org_event').on(table.organizationId, table.eventTypeKey),
  ],
);

export const INVOICE_STATUSES = ['paid', 'open', 'void'] as const;

/**
 * One line of an invoice's breakdown, carried in the `line_items` JSON column. Detail, not a
 * queryable relation — the detail read returns a bounded array of these; there is no child table.
 * Money is integer cents (`unitAmountCents`, `amountCents`), never a float.
 */
export interface InvoiceLineItemDef {
  readonly description: string;
  readonly quantity: number;
  readonly unitAmountCents: number;
  readonly amountCents: number;
}

/**
 * FEAT: Billing & plan management (module 19) — invoice history (x179). A tenant-scoped, read-only
 * billing record: a number, a billing period, a total in integer cents, a currency, a status and an
 * issued time, plus a bounded line-item breakdown for the detail read. Rows are produced by the
 * subscription lifecycle or the seed; this slice reads them (there is no invoice mutation route, and
 * the runtime credential is granted no write). `0076_invoices.sql` is the source of truth; this is
 * its typed mirror.
 */
export const invoices = mysqlTable(
  'invoices',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    number: varchar('number', { length: 64 }).notNull(),
    periodStart: datetime('period_start', { mode: 'date', fsp: 3 }).notNull(),
    periodEnd: datetime('period_end', { mode: 'date', fsp: 3 }).notNull(),
    // Integer cents, never a float — a billing total must be exact.
    amountCents: bigint('amount_cents', { mode: 'number', unsigned: true }).notNull(),
    // ISO-4217, stored uppercase.
    currency: char('currency', { length: 3 }).notNull(),
    status: mysqlEnum('status', INVOICE_STATUSES).notNull().default('open'),
    lineItems: json('line_items').$type<readonly InvoiceLineItemDef[]>(),
    issuedAt: datetime('issued_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_invoices_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_invoices_org_number').on(table.organizationId, table.number),
    index('ix_invoices_org_issued').on(table.organizationId, table.issuedAt),
  ],
);

/**
 * FEAT: Billing & plan management (module 19) — per-invoice line-item detail (x225). A tenant-scoped,
 * read-only child of {@link invoices}: one billed line — a description, a quantity, a per-unit price
 * and a line total, all in integer minor units — carrying a stable display `position`. Rows are
 * produced by the subscription lifecycle or the seed; this slice reads them (there is no line
 * mutation route, and the runtime credential is granted no write). The summed `amountCents` of an
 * invoice's lines reconciles to the header's stored total. `0099_invoice_line_items.sql` is the
 * source of truth; this is its typed mirror.
 */
export const invoiceLineItems = mysqlTable(
  'invoice_line_items',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    invoiceId: char('invoice_id', { length: 36 }).notNull(),
    description: varchar('description', { length: 255 }).notNull(),
    // Integer, never a float.
    quantity: int('quantity', { unsigned: true }).notNull(),
    // Integer minor units, never a float — a billing total must be exact.
    unitAmountCents: bigint('unit_amount_cents', { mode: 'number', unsigned: true }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'number', unsigned: true }).notNull(),
    position: int('position', { unsigned: true }).notNull().default(0),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_invoice_line_items_org_id').on(table.organizationId, table.id),
    index('ix_invoice_line_items_org_invoice').on(
      table.organizationId,
      table.invoiceId,
      table.position,
    ),
  ],
);

export const usageCounters = mysqlTable(
  'usage_counters',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    metricKey: varchar('metric_key', { length: 64 }).notNull(),
    usedValue: bigint('used_value', { mode: 'number', unsigned: true }).notNull().default(0),
    reservedValue: bigint('reserved_value', { mode: 'number', unsigned: true })
      .notNull()
      .default(0),
    version: bigint('version', { mode: 'number', unsigned: true }).notNull().default(1),
    reconciledAt: datetime('reconciled_at', { mode: 'date', fsp: 3 }),
    /**
     * USAGE-001 slice 4 (migration 0024). The threshold band this counter is currently in —
     * 0, 70, 85, 95 or 100 — carried on the row so a rising crossing fires its
     * `usage.threshold_reached.v1` event exactly once and a fall back below the hysteresis
     * floor re-arms it. Not part of the `version` optimistic-lock value: it moves on a band
     * change, which is orthogonal to a used/reserved value change.
     */
    thresholdBand: tinyint('threshold_band', { unsigned: true }).notNull().default(0),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_usage_counters_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_usage_counters_org_metric').on(table.organizationId, table.metricKey),
  ],
);

/**
 * USAGE-001 slice 2. The append-only ledger behind {@link usageCounters}: one immutable row
 * per counter move, written in the move's own transaction (migration 0021). `counter` names
 * the dimension (`used` | `reserved`, the Q8 divergence); `delta` is signed; `sourceEventId`
 * points at the {@link outboxEvents} row the move produced. No `updatedAt`, no `version`:
 * append-only, and the runtime credential holds INSERT alone.
 */
export const usageLedgerEntries = mysqlTable(
  'usage_ledger_entries',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    counter: mysqlEnum('counter', ['used', 'reserved']).notNull(),
    delta: bigint('delta', { mode: 'number' }).notNull(),
    reason: varchar('reason', { length: 32 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 96 }).notNull(),
    sourceEventId: char('source_event_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_usage_ledger_entries_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_usage_ledger_entries_org_idem').on(table.organizationId, table.idempotencyKey),
    index('ix_usage_ledger_entries_org_source').on(table.organizationId, table.sourceEventId),
  ],
);

export const fileAssets = mysqlTable(
  'file_assets',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    clientOrganizationId: char('client_organization_id', { length: 36 }),
    ownerUserId: char('owner_user_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    purpose: mysqlEnum('purpose', UPLOAD_PURPOSES).notNull(),
    /** The row `purpose` says this file belongs to (0016). No FK: the table depends on the purpose. */
    objectId: char('object_id', { length: 36 }),
    audience: mysqlEnum('audience', WORK_ITEM_AUDIENCE).notNull().default('internal'),
    /** `23-ERD` §10's nine states, driven by `uploadStateMachine`. */
    status: varchar('status', { length: 32 }).notNull(),
    rejectionCode: varchar('rejection_code', { length: 64 }),
    /** FILE-002 slice B. The scan pass's claim on a `scanning` row; stale after fifteen minutes. */
    scanClaimedAt: datetime('scan_claimed_at', { mode: 'date', fsp: 3 }),
    /**
     * FILE-003 (0025). When the retention-lifecycle job deleted this rejected object's provider
     * bytes and gave the counted bytes back — NULL until then, so the job's selection and its
     * one-shot claim both turn on `purged_at IS NULL`. The row itself is never deleted
     * (`49-PRICING` §6: never delete customer data automatically); this column is the record
     * that its bytes were removed, and the evidence trail stays.
     */
    purgedAt: datetime('purged_at', { mode: 'date', fsp: 3 }),
    version: bigint('version', { mode: 'number', unsigned: true }).notNull().default(1),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_file_assets_org_id').on(table.organizationId, table.id),
    index('ix_file_assets_org_project_status').on(
      table.organizationId,
      table.projectId,
      table.status,
      table.createdAt,
    ),
    index('ix_file_assets_org_object').on(table.organizationId, table.objectId),
    /**
     * FILE-003's retention scan: which rejected assets are past their window and not yet
     * purged. `(status, updated_at)` serves both the cross-tenant "which organizations hold
     * one" read and the per-organization list — `updated_at` is when the asset was rejected
     * (its last transition), so the range predicate lands on the index rather than a scan.
     */
    index('ix_file_assets_status_updated').on(table.status, table.updatedAt),
  ],
);

export const fileVersions = mysqlTable(
  'file_versions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    fileAssetId: char('file_asset_id', { length: 36 }).notNull(),
    versionNo: int('version_no', { unsigned: true }).notNull(),
    /** Internal. Never a response field — `FORBIDDEN_CLIENT_FIELDS` names `objectKey`. */
    objectKey: varchar('object_key', { length: 512 }).notNull(),
    /** The provider's count, never the declaration. */
    sizeBytes: bigint('size_bytes', { mode: 'number', unsigned: true }).notNull(),
    declaredMimeType: varchar('declared_mime_type', { length: 150 }).notNull(),
    detectedMimeType: varchar('detected_mime_type', { length: 150 }),
    contentHash: varchar('content_hash', { length: 128 }),
    /** FILE-002 slice B (0019). `clean` | `infected` | `unscanned`; write-once with its time and scanner. */
    scanVerdict: varchar('scan_verdict', { length: 16 }),
    scannedAt: datetime('scanned_at', { mode: 'date', fsp: 3 }),
    scanner: varchar('scanner', { length: 64 }),
    /**
     * 56-06 (0307). Who judged the bytes: `tmanage` | `provider` | `none`; written with the verdict.
     * NULL on older rows reads as `resolveScanSource` (`files/file-safety.ts`) answers it.
     */
    scanSource: varchar('scan_source', { length: 8 }),
    /** Which zone holds the servable object: `quarantine` at birth, `private` once promoted (ADR-0006). */
    trustZone: varchar('trust_zone', { length: 16 }).notNull().default('quarantine'),
    etag: varchar('etag', { length: 255 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_file_versions_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_file_versions_org_asset_no').on(
      table.organizationId,
      table.fileAssetId,
      table.versionNo,
    ),
  ],
);

/**
 * C7 (0228). Version history for plain attachments: version 1 is the root file asset itself (the
 * one a work item, request or document links to); each row here makes another asset version N of
 * it. Append-only (INSERT + SELECT, a `BEFORE UPDATE` trigger). `0228_attachment_versions.sql`.
 */
export const attachmentVersions = mysqlTable(
  'attachment_versions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    rootFileAssetId: char('root_file_asset_id', { length: 36 }).notNull(),
    fileAssetId: char('file_asset_id', { length: 36 }).notNull(),
    versionNo: int('version_no', { unsigned: true }).notNull(),
    note: varchar('note', { length: 2000 }),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_attachment_versions_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_attachment_versions_org_root_no').on(
      table.organizationId,
      table.rootFileAssetId,
      table.versionNo,
    ),
    uniqueIndex('uq_attachment_versions_org_file').on(table.organizationId, table.fileAssetId),
  ],
);

/**
 * R4 slice 2 (0267). One derivative TManage made of an uploaded version — a sanitised SVG, a
 * thumbnail, a page image, a flattened PSD, a ZIP listing, media/Office metadata. `page_no` is 0
 * for a whole-file derivative. `objectKey` names the bytes in the `derived` zone and never leaves
 * the API. Identity columns are immutable and `object_key` write-once (trigger).
 * `0267_file_previews.sql`; `modules/files/file-previews.repository.ts`.
 */
export const filePreviews = mysqlTable(
  'file_previews',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    fileAssetId: char('file_asset_id', { length: 36 }).notNull(),
    fileVersionId: char('file_version_id', { length: 36 }).notNull(),
    kind: varchar('kind', { length: 32 }).notNull(),
    pageNo: int('page_no', { unsigned: true }).notNull().default(0),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    /** Internal. Never a response field — `FORBIDDEN_CLIENT_FIELDS` names `objectKey`. */
    objectKey: varchar('object_key', { length: 512 }),
    mimeType: varchar('mime_type', { length: 150 }),
    sizeBytes: bigint('size_bytes', { mode: 'number', unsigned: true }),
    width: int('width', { unsigned: true }),
    height: int('height', { unsigned: true }),
    /** MariaDB answers JSON as text; the repository parses it. */
    meta: json('meta').$type<Record<string, unknown>>(),
    errorCode: varchar('error_code', { length: 64 }),
    attempts: tinyint('attempts', { unsigned: true }).notNull().default(0),
    claimedAt: datetime('claimed_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_file_previews_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_file_previews_version_kind_page').on(
      table.organizationId,
      table.fileVersionId,
      table.kind,
      table.pageNo,
    ),
    index('ix_file_previews_pending').on(table.status, table.claimedAt, table.createdAt),
    index('ix_file_previews_asset').on(table.organizationId, table.fileAssetId),
  ],
);

/**
 * R4 slice 5 (0268). A proofing thread: a numbered pin, box, drawing, moment or cell on a file
 * (the ROOT asset of its version chain) — `subject_type = 'file_asset'` — and the version it was
 * drawn on. `number` is monotonic per subject (unique key; the service retries a lost race).
 * `audience` and the identity columns are immutable (trigger). Soft delete per PA-03.
 * `0268_review_threads.sql`; `modules/files/review-threads.repository.ts`.
 */
export const reviewThreads = mysqlTable(
  'review_threads',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    subjectType: varchar('subject_type', { length: 16 }).notNull(),
    subjectId: char('subject_id', { length: 36 }).notNull(),
    fileVersionId: char('file_version_id', { length: 36 }),
    anchorKind: varchar('anchor_kind', { length: 8 }).notNull().default('none'),
    /** MariaDB answers JSON as text; the repository parses it. */
    anchor: json('anchor').$type<Record<string, unknown>>(),
    pageNo: int('page_no', { unsigned: true }),
    timeMs: int('time_ms', { unsigned: true }),
    number: int('number', { unsigned: true }).notNull(),
    audience: varchar('audience', { length: 16 }).notNull().default('internal'),
    status: varchar('status', { length: 10 }).notNull().default('open'),
    resolvedByMembershipId: char('resolved_by_membership_id', { length: 36 }),
    resolvedAt: datetime('resolved_at', { mode: 'date', fsp: 3 }),
    carriedFromThreadId: char('carried_from_thread_id', { length: 36 }),
    /**
     * R4 slice 11 (0269). '' for a thread somebody opened; the target `file_versions.id` for a
     * copy carried to a new version, which keeps its number (the unique key holds this column).
     */
    carryScope: char('carry_scope', { length: 36 }).notNull().default(''),
    createdByMembershipId: char('created_by_membership_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_review_threads_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_review_threads_number').on(
      table.organizationId,
      table.subjectType,
      table.subjectId,
      table.number,
      table.carryScope,
    ),
    index('ix_review_threads_subject').on(
      table.organizationId,
      table.subjectType,
      table.subjectId,
      table.status,
      table.createdAt,
    ),
    index('ix_review_threads_version').on(table.organizationId, table.fileVersionId),
    index('ix_review_threads_project').on(table.organizationId, table.projectId),
    index('ix_review_threads_org_deleted').on(table.organizationId, table.deletedAt),
    index('ix_review_threads_purge').on(table.purgeAfter),
  ],
);

export type ReviewThreadRow = typeof reviewThreads.$inferSelect;

/**
 * R4 slice 5 (0268). One comment on a proofing thread, oldest first. `mentions` holds the user ids
 * it names. Edited by its author within a short window (`edited_at`); soft delete per PA-03.
 */
export const reviewComments = mysqlTable(
  'review_comments',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    threadId: char('thread_id', { length: 36 }).notNull(),
    body: text('body').notNull(),
    /** MariaDB answers JSON as text; the repository parses it. */
    mentions: json('mentions').$type<string[]>(),
    createdByMembershipId: char('created_by_membership_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    editedAt: datetime('edited_at', { mode: 'date', fsp: 3 }),
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_review_comments_org_id').on(table.organizationId, table.id),
    index('ix_review_comments_thread').on(
      table.organizationId,
      table.threadId,
      table.createdAt,
      table.id,
    ),
    index('ix_review_comments_org_deleted').on(table.organizationId, table.deletedAt),
    index('ix_review_comments_purge').on(table.purgeAfter),
  ],
);

export type ReviewCommentRow = typeof reviewComments.$inferSelect;

/**
 * R4 slice 11 (0269). Approve / Request changes on one version of a plain attachment (deliverables
 * keep `approvals`). Append-only: the newest row of a version is its state. A request for changes
 * carries a note (trigger). `decidedByMembershipId` names a `memberships` or `client_memberships`
 * row, as `principalKind` says. `0269_file_review_decisions.sql`;
 * `modules/files/file-review-decisions.repository.ts`.
 */
export const fileReviewDecisions = mysqlTable(
  'file_review_decisions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    rootFileAssetId: char('root_file_asset_id', { length: 36 }).notNull(),
    fileAssetId: char('file_asset_id', { length: 36 }).notNull(),
    fileVersionId: char('file_version_id', { length: 36 }),
    decision: varchar('decision', { length: 20 }).notNull(),
    note: text('note'),
    decidedByMembershipId: char('decided_by_membership_id', { length: 36 }).notNull(),
    decidedByUserId: char('decided_by_user_id', { length: 36 }).notNull(),
    principalKind: varchar('principal_kind', { length: 8 }).notNull(),
    clientOrganizationId: char('client_organization_id', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_file_review_decisions_org_id').on(table.organizationId, table.id),
    index('ix_file_review_decisions_version').on(
      table.organizationId,
      table.fileAssetId,
      table.createdAt,
    ),
    index('ix_file_review_decisions_root').on(
      table.organizationId,
      table.rootFileAssetId,
      table.createdAt,
    ),
    index('ix_file_review_decisions_project').on(table.organizationId, table.projectId),
  ],
);

export type FileReviewDecisionRow = typeof fileReviewDecisions.$inferSelect;

/**
 * R4 slice 13 (0270). A member's Figma personal access token, as the SeedCipher envelope only
 * (`tokenCiphertext`, never a response field); `tokenHint` is the last four characters.
 * `0270_figma_links.sql`; `modules/figma/figma.repository.ts`.
 */
export const figmaConnections = mysqlTable(
  'figma_connections',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    /** Internal. Never a response field. */
    tokenCiphertext: varchar('token_ciphertext', { length: 1024 }).notNull(),
    tokenHint: varchar('token_hint', { length: 8 }).notNull(),
    figmaUserHandle: varchar('figma_user_handle', { length: 190 }),
    status: varchar('status', { length: 16 }).notNull().default('connected'),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_figma_connections_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_figma_connections_member').on(table.organizationId, table.membershipId),
  ],
);

export type FigmaConnectionRow = typeof figmaConnections.$inferSelect;

/**
 * R4 slice 13 (0270). A Figma file attached to a project (optionally to a work item, deliverable
 * version or request). `audience` is immutable (trigger). Soft delete per PA-03.
 */
export const figmaLinks = mysqlTable(
  'figma_links',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    fileKey: varchar('file_key', { length: 128 }).notNull(),
    fileName: varchar('file_name', { length: 300 }),
    url: varchar('url', { length: 1000 }).notNull(),
    attachedToType: varchar('attached_to_type', { length: 24 }),
    attachedToId: char('attached_to_id', { length: 36 }),
    audience: varchar('audience', { length: 16 }).notNull().default('internal'),
    createdByMembershipId: char('created_by_membership_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_figma_links_org_id').on(table.organizationId, table.id),
    index('ix_figma_links_project').on(table.organizationId, table.projectId),
    index('ix_figma_links_attached').on(
      table.organizationId,
      table.attachedToType,
      table.attachedToId,
    ),
  ],
);

export type FigmaLinkRow = typeof figmaLinks.$inferSelect;

/**
 * R4 slice 13 (0270). One frame of a Figma link and its last PNG snapshot (`snapshotObjectKey`
 * names the bytes in the `derived` zone and never leaves the API). `sizeChanged` is set when a
 * later snapshot found the frame at another size.
 */
export const figmaFrames = mysqlTable(
  'figma_frames',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    linkId: char('link_id', { length: 36 }).notNull(),
    nodeId: varchar('node_id', { length: 64 }).notNull(),
    name: varchar('name', { length: 300 }).notNull(),
    width: int('width', { unsigned: true }).notNull().default(0),
    height: int('height', { unsigned: true }).notNull().default(0),
    /** Internal. Never a response field. */
    snapshotObjectKey: varchar('snapshot_object_key', { length: 512 }),
    snapshotHash: char('snapshot_hash', { length: 64 }),
    snapshotStatus: varchar('snapshot_status', { length: 16 }).notNull().default('pending'),
    snapshotAttempts: tinyint('snapshot_attempts', { unsigned: true }).notNull().default(0),
    claimedAt: datetime('claimed_at', { mode: 'date', fsp: 3 }),
    capturedAt: datetime('captured_at', { mode: 'date', fsp: 3 }),
    sizeChanged: boolean('size_changed').notNull().default(false),
    sortOrder: int('sort_order', { unsigned: true }).notNull().default(0),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_figma_frames_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_figma_frames_node').on(table.organizationId, table.linkId, table.nodeId),
    index('ix_figma_frames_pending').on(table.snapshotStatus, table.claimedAt),
  ],
);

export type FigmaFrameRow = typeof figmaFrames.$inferSelect;

export const uploadSessions = mysqlTable(
  'upload_sessions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    clientOrganizationId: char('client_organization_id', { length: 36 }),
    actorUserId: char('actor_user_id', { length: 36 }).notNull(),
    fileAssetId: char('file_asset_id', { length: 36 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    purpose: mysqlEnum('purpose', UPLOAD_PURPOSES).notNull(),
    objectId: char('object_id', { length: 36 }),
    declaredName: varchar('declared_name', { length: 255 }).notNull(),
    declaredMimeType: varchar('declared_mime_type', { length: 150 }).notNull(),
    declaredBytes: bigint('declared_bytes', { mode: 'number', unsigned: true }).notNull(),
    declaredContentHash: varchar('declared_content_hash', { length: 128 }),
    committedBytes: bigint('committed_bytes', { mode: 'number', unsigned: true }),
    partSizeBytes: int('part_size_bytes', { unsigned: true }).notNull(),
    partCount: int('part_count', { unsigned: true }).notNull(),
    /** Internal. Never a response field. */
    objectKey: varchar('object_key', { length: 512 }).notNull(),
    providerUploadId: varchar('provider_upload_id', { length: 255 }).notNull(),
    uploadTargetsJson: json('upload_targets_json').$type<readonly UploadTargetJson[]>().notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    version: bigint('version', { mode: 'number', unsigned: true }).notNull().default(1),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    completedAt: datetime('completed_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_upload_sessions_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_upload_sessions_org_idempotency').on(
      table.organizationId,
      table.idempotencyKey,
    ),
    index('ix_upload_sessions_org_status_expires').on(
      table.organizationId,
      table.status,
      table.expiresAt,
    ),
    index('ix_upload_sessions_org_project_status').on(
      table.organizationId,
      table.projectId,
      table.status,
      table.createdAt,
    ),
    index('ix_upload_sessions_org_object').on(table.organizationId, table.objectId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Conversations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CHAT-001. A project channel — `22-SCREEN-BY-SCREEN` §4 TM-06.
 *
 * `projectId` is `NOT NULL` because `conversation.read` is relation-gated on project
 * membership and a conversation with no project has no relation for the evaluator to check.
 * TM-07's direct messages need that relation before they can exist; see `0007_conversations.sql`.
 *
 * `nextSequenceNo` is the allocator behind `messages.sequenceNo`. A message insert takes this
 * row's lock, writes the value it read, and increments it, inside one transaction.
 */
export const CONVERSATION_KINDS = ['project_channel', 'group', 'direct'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];
export const CONVERSATION_MEMBER_ROLES = ['member', 'admin'] as const;
export type ConversationMemberRole = (typeof CONVERSATION_MEMBER_ROLES)[number];
export const MESSAGE_KINDS = ['text', 'voice', 'system', 'location'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const conversations = mysqlTable(
  'conversations',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    // R7 (0275): a project channel, a group with no project, or a one-to-one direct chat.
    kind: mysqlEnum('kind', CONVERSATION_KINDS).notNull().default('project_channel'),
    /** NULL for a group or a direct conversation (0275); every project channel names one. */
    projectId: char('project_id', { length: 36 }),
    /** The two people of a direct conversation, sorted (low < high); NULL otherwise. */
    directUserLowId: char('direct_user_low_id', { length: 36 }),
    directUserHighId: char('direct_user_high_id', { length: 36 }),
    name: varchar('name', { length: 120 }).notNull(),
    /** A group photo: a scanned `file_assets` row. */
    photoFileAssetId: char('photo_file_asset_id', { length: 36 }),
    description: varchar('description', { length: 500 }),
    onlyAdminsCanSend: tinyint('only_admins_can_send').notNull().default(0),
    /** A group invite link's token (43 url-safe characters); NULL when no link is live. */
    inviteToken: char('invite_token', { length: 43 }),
    nextSequenceNo: bigint('next_sequence_no', { mode: 'number', unsigned: true })
      .notNull()
      .default(1),
    /** Stamped by every post, for the chat list. */
    lastMessageId: char('last_message_id', { length: 36 }),
    lastMessageAt: datetime('last_message_at', { mode: 'date', fsp: 3 }),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    version: bigint('version', { mode: 'number', unsigned: true }).notNull().default(1),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    archivedAt: datetime('archived_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_conversations_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_conversations_project_name').on(
      table.organizationId,
      table.projectId,
      table.name,
    ),
    uniqueIndex('uq_conversations_direct_pair').on(
      table.organizationId,
      table.directUserLowId,
      table.directUserHighId,
    ),
    uniqueIndex('uq_conversations_invite').on(table.organizationId, table.inviteToken),
    index('ix_conversations_last_message').on(table.organizationId, table.lastMessageAt),
  ],
);

/**
 * CHAT-001. Who is in a channel.
 *
 * No `role` column: `12-PERMISSION-MATRIX` §2 makes "Moderate messages" a property of the
 * organization role rather than of a per-channel grant.
 */
export const conversationMemberships = mysqlTable(
  'conversation_memberships',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    conversationId: char('conversation_id', { length: 36 }).notNull(),
    userId: char('user_id', { length: 36 }).notNull(),
    // R7 (0275): a group's admins; per-person pin and archive for the chat list.
    role: mysqlEnum('role', CONVERSATION_MEMBER_ROLES).notNull().default('member'),
    pinnedAt: datetime('pinned_at', { mode: 'date', fsp: 3 }),
    archivedAt: datetime('archived_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_conversation_memberships_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_conversation_memberships_identity').on(
      table.organizationId,
      table.conversationId,
      table.userId,
    ),
    index('ix_conversation_memberships_user').on(table.organizationId, table.userId),
  ],
);

/**
 * x247 (0119). A message pinned to a conversation's pinned-context list — CH-07 "Message actions"
 * (pin) and CH-02 "pinned context". Tenant-owned: a pin names a message and a conversation, both
 * tenant rows. The unique key on `(organization_id, conversation_id, message_id)` makes pinning
 * idempotent (a second pin of the same message collides rather than adding a row); the service
 * turns that collision into the idempotent PUT and enforces the per-conversation cap. `messageId`
 * FKs to a message of the same tenant only — the conversation match is the service's, resolved
 * before the write.
 */
export const conversationPinnedMessages = mysqlTable(
  'conversation_pinned_messages',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    conversationId: char('conversation_id', { length: 36 }).notNull(),
    messageId: char('message_id', { length: 36 }).notNull(),
    pinnedByUserId: char('pinned_by_user_id', { length: 36 }).notNull(),
    pinnedAt: datetime('pinned_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_conversation_pinned_messages_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_conversation_pinned_messages_pin').on(
      table.organizationId,
      table.conversationId,
      table.messageId,
    ),
    index('ix_conversation_pinned_messages_list').on(
      table.organizationId,
      table.conversationId,
      table.pinnedAt,
      table.id,
    ),
  ],
);

/**
 * CHAT-001. One thing somebody said.
 *
 * `depth` and `parentDepth` are not redundant bookkeeping: together with
 * `uq_messages_org_id_depth` they are how `fk_messages_parent_is_root` forces a reply's parent
 * to be a top-level message, so "a thread is one level deep" is an invariant InnoDB holds
 * rather than one this application promises. `0007_conversations.sql` has the argument.
 *
 * `body` is plain text as of this ticket. `CHAT-002` is the one that decides what markup is
 * admissible and sanitises it.
 */
export const messages = mysqlTable(
  'messages',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    conversationId: char('conversation_id', { length: 36 }).notNull(),
    authorUserId: char('author_user_id', { length: 36 }).notNull(),
    /** Allocated from `conversations.nextSequenceNo`. Never supplied by a caller. */
    sequenceNo: bigint('sequence_no', { mode: 'number', unsigned: true }).notNull(),
    parentMessageId: char('parent_message_id', { length: 36 }),
    depth: tinyint('depth', { unsigned: true }).notNull().default(0),
    parentDepth: tinyint('parent_depth', { unsigned: true }),
    /** R7 (0275): what the message is; `metaJson` carries that kind's facts. */
    kind: mysqlEnum('kind', MESSAGE_KINDS).notNull().default('text'),
    body: text('body').notNull(),
    /**
     * The sanitised rich-text document, exactly as `sanitizeRichText` admitted it, or NULL
     * for a plain-text message (every CHAT-001 row, and every plain post since). `body` is
     * derived from it by `richTextToPlainText`, so the two cannot disagree about what was
     * said. See `0008_message_rich_text.sql`.
     */
    bodyRich: json('body_rich').$type<unknown>(),
    /** R7 (0275): reply / forward / voice / location / system facts, validated per kind. */
    metaJson: json('meta_json').$type<unknown>(),
    clientGeneratedId: char('client_generated_id', { length: 36 }),
    editedAt: datetime('edited_at', { mode: 'date', fsp: 3 }),
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_messages_org_id_depth').on(table.organizationId, table.id, table.depth),
    uniqueIndex('uq_messages_sequence').on(
      table.organizationId,
      table.conversationId,
      table.sequenceNo,
    ),
    uniqueIndex('uq_messages_client_generated').on(
      table.organizationId,
      table.authorUserId,
      table.clientGeneratedId,
    ),
    index('ix_messages_thread').on(
      table.organizationId,
      table.conversationId,
      table.parentMessageId,
      table.sequenceNo,
    ),
    // H2 (0234): search's newest-first read; `updated_at` is a DESC key part in the migration.
    index('ix_messages_org_updated').on(table.organizationId, table.updatedAt, table.id),
  ],
);

/**
 * Edit history — the bodies a message had before each change (CHAT-002).
 *
 * Engine-authored: `trg_messages_record_revision` in `0008_message_rich_text.sql` writes
 * these rows with the trigger definer's privileges, and `users.sql` grants the runtime
 * credential nothing here beyond the database-wide SELECT — the application cannot forge,
 * suppress or delete a revision. That is also why there is no CHAR(36) id: the engine has no
 * UUIDv7, and `(organization_id, message_id, revision_no)` is what a revision *is*. No
 * `edited_by_user_id` either — only the author may edit, so the editor is
 * `messages.author_user_id`, already recorded.
 */
export const messageRevisions = mysqlTable(
  'message_revisions',
  {
    organizationId: char('organization_id', { length: 36 }).notNull(),
    messageId: char('message_id', { length: 36 }).notNull(),
    /** 1 for the body the message was created with, counting up. */
    revisionNo: bigint('revision_no', { mode: 'number', unsigned: true }).notNull(),
    /** The body as it stood BEFORE the edit that displaced it. */
    body: text('body').notNull(),
    bodyRich: json('body_rich').$type<unknown>(),
    /** When this body was written: `created_at` for revision 1, the prior edit after that. */
    writtenAt: datetime('written_at', { mode: 'date', fsp: 3 }).notNull(),
    /** When this body stopped being current — the edit that displaced it. */
    replacedAt: datetime('replaced_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.messageId, table.revisionNo] })],
);

/**
 * The message-to-work relation — CHAT-003, FR-02's "source link is immutable".
 *
 * One conversion per message and one source per work item, both as unique keys — the keys
 * ARE INT-07's idempotency, so there is no idempotency_records machinery here. Written once
 * by the application (INSERT is the only write grant in `users.sql`) and refused UPDATE by
 * trigger for every credential. See `0009_message_work_links.sql`.
 */
export const messageWorkLinks = mysqlTable(
  'message_work_links',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    messageId: char('message_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_message_work_links_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_message_work_links_message').on(table.organizationId, table.messageId),
    uniqueIndex('uq_message_work_links_work_item').on(table.organizationId, table.workItemId),
  ],
);

/**
 * x246. One member's one emoji reaction on one message — CH-07 "Message actions".
 *
 * `0118_message_reactions.sql` is the source of truth; this is its typed mirror. The reaction
 * is a membership's, self-scoped: the add and remove are predicated on the acting
 * `membership_id`, so a member only ever touches their own. `uq_message_reactions_identity`
 * makes the add idempotent and lets the tally count distinct memberships per emoji.
 */
export const messageReactions = mysqlTable(
  'message_reactions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    messageId: char('message_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    emoji: varchar('emoji', { length: 24 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_message_reactions_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_message_reactions_identity').on(
      table.organizationId,
      table.messageId,
      table.membershipId,
      table.emoji,
    ),
    index('ix_message_reactions_message').on(table.organizationId, table.messageId, table.emoji),
  ],
);

/**
 * A member's privately saved messages — CH-07's "Save" message action (x248). Distinct from
 * `document_bookmarks` (x242): that saves a document, this saves a `messages` row.
 *
 * One row means "this membership saved this message". `home_pinned_items`' posture applied to a
 * message: private to one membership (every read, the save and the unsave scoped by
 * `membership_id`), idempotent by `(organization_id, message_id, membership_id)`, created and
 * deleted only. The runtime credential holds INSERT and DELETE alone — the withheld UPDATE is the
 * control, so no immutability trigger is needed. `0120_message_bookmarks.sql` is the source of
 * truth; this is its typed mirror.
 */
export const messageBookmarks = mysqlTable(
  'message_bookmarks',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    messageId: char('message_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_message_bookmarks_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_message_bookmarks_bookmark').on(
      table.organizationId,
      table.messageId,
      table.membershipId,
    ),
    index('ix_message_bookmarks_org_membership').on(
      table.organizationId,
      table.membershipId,
      table.createdAt,
      table.id,
    ),
  ],
);

/**
 * A message's thread replies — x249, planning ref CH-05 "Thread".
 *
 * Append-only and lighter than the `messages` threading it sits beside: a reply here never
 * enters the channel sequence, never edits and never deletes. Written once by the application
 * (INSERT is the only write grant in `users.sql`) and refused UPDATE by trigger for every
 * credential. The author is the caller's **membership**, not a bare user id — the reply
 * belongs to the actor inside this studio. See `0121_conversation_thread_replies.sql`.
 */
export const conversationThreadReplies = mysqlTable(
  'conversation_thread_replies',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    conversationId: char('conversation_id', { length: 36 }).notNull(),
    rootMessageId: char('root_message_id', { length: 36 }).notNull(),
    authorMembershipId: char('author_membership_id', { length: 36 }).notNull(),
    body: text('body').notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_conversation_thread_replies_org_id').on(table.organizationId, table.id),
    index('ix_conversation_thread_replies_root').on(
      table.organizationId,
      table.rootMessageId,
      table.createdAt,
    ),
  ],
);

/**
 * A file attached to a chat message — CH-06's composer attachments (x275). One row links an
 * already-uploaded `file_assets` row to a `messages` row; there is no upload here, the file store
 * is reused read-only.
 *
 * `message_bookmarks`' posture applied to a link between a message and a file: created and deleted
 * only (the runtime credential holds INSERT and DELETE alone, the withheld UPDATE is the control),
 * idempotent by `(organization_id, message_id, file_asset_id)`. `attached_by_membership_id` records
 * the author who attached it — only the message author may attach or detach.
 * `0144_message_attachments.sql` is the source of truth; this is its typed mirror.
 */
export const messageAttachments = mysqlTable(
  'message_attachments',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    messageId: char('message_id', { length: 36 }).notNull(),
    fileAssetId: char('file_asset_id', { length: 36 }).notNull(),
    attachedByMembershipId: char('attached_by_membership_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_message_attachments_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_message_attachments_message_file').on(
      table.organizationId,
      table.messageId,
      table.fileAssetId,
    ),
    index('ix_message_attachments_org_message').on(
      table.organizationId,
      table.messageId,
      table.createdAt,
      table.id,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Platform primitives
// ─────────────────────────────────────────────────────────────────────────────

export const outboxEvents = mysqlTable(
  'outbox_events',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    type: varchar('type', { length: 190 }).notNull(),
    schemaVersion: int('schema_version', { unsigned: true }).notNull().default(1),
    aggregateType: varchar('aggregate_type', { length: 64 }).notNull(),
    aggregateId: char('aggregate_id', { length: 36 }).notNull(),
    /** A reference envelope, never a content copy (spec §10). */
    payloadJson: json('payload_json').notNull(),
    correlationId: char('correlation_id', { length: 36 }),
    occurredAt: datetime('occurred_at', { mode: 'date', fsp: 3 }).notNull(),
    availableAt: datetime('available_at', { mode: 'date', fsp: 3 }).notNull(),
    publishedAt: datetime('published_at', { mode: 'date', fsp: 3 }),
    attempts: int('attempts', { unsigned: true }).notNull().default(0),
    lastError: varchar('last_error', { length: 1000 }),
  },
  (table) => [
    uniqueIndex('uq_outbox_events_org_id').on(table.organizationId, table.id),
    index('ix_outbox_events_unpublished').on(table.publishedAt, table.availableAt),
    index('ix_outbox_events_org_aggregate').on(
      table.organizationId,
      table.aggregateType,
      table.aggregateId,
    ),
  ],
);

/**
 * NOTIF-001. One person told one thing — a reference envelope like the outbox row it came
 * from, never content: a notification outlives the access decision that allowed it, so the
 * read path resolves the object through ordinary authorized reads at display time
 * (`24-EVENT-CATALOG` §6). `uq_notifications_dedupe` is the consumer's idempotency under
 * at-least-once redelivery, and the seam a future bundler widens. Only `read_at` may ever
 * change, forward only — the trigger in `0010_notifications.sql` refuses the rest.
 */
export const notifications = mysqlTable(
  'notifications',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    recipientUserId: char('recipient_user_id', { length: 36 }).notNull(),
    type: varchar('type', { length: 190 }).notNull(),
    objectType: varchar('object_type', { length: 64 }).notNull(),
    objectId: char('object_id', { length: 36 }).notNull(),
    dedupeKey: varchar('dedupe_key', { length: 190 }).notNull(),
    readAt: datetime('read_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_notifications_org_id').on(table.organizationId, table.id),
    index('ix_notifications_recipient_time').on(
      table.organizationId,
      table.recipientUserId,
      table.createdAt,
    ),
    // 0014, INBOX-001: the inbox pages on `id` (UUIDv7, so creation order) and this is the
    // index that read uses; the contract's `created_at` index above is kept.
    index('ix_notifications_recipient_id').on(
      table.organizationId,
      table.recipientUserId,
      table.id,
    ),
    uniqueIndex('uq_notifications_dedupe').on(
      table.organizationId,
      table.recipientUserId,
      table.dedupeKey,
    ),
  ],
);

/** TM-27's digest windows. `off` is immediate delivery; the two others are bundling windows. */
export const DIGEST_FREQUENCIES = ['off', 'daily', 'weekly'] as const;

/**
 * NOTIF-001. How one person, in one studio, wants to be told — `22-SCREEN-BY-SCREEN` TM-27's
 * "notification channels, quiet hours, digest", keyed by `(organization_id, user_id)`. The
 * two channels are `24-EVENT-CATALOG` §2's: the durable email path and the in-app/realtime
 * projection. This slice stores the settings; honouring them in delivery is a later slice.
 * Quiet-hours columns are nullable and stored for INBOX-001, which is what reads them.
 * `0022_notification_preferences.sql` is the source of truth; this is its typed mirror.
 */
export const notificationPreferences = mysqlTable(
  'notification_preferences',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    userId: char('user_id', { length: 36 }).notNull(),
    inAppEnabled: boolean('in_app_enabled').notNull().default(true),
    emailEnabled: boolean('email_enabled').notNull().default(true),
    digestFrequency: mysqlEnum('digest_frequency', DIGEST_FREQUENCIES).notNull().default('off'),
    quietHoursStart: time('quiet_hours_start'),
    quietHoursEnd: time('quiet_hours_end'),
    quietHoursTimezone: varchar('quiet_hours_timezone', { length: 64 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_notification_preferences_org_id').on(table.organizationId, table.id),
    // The upsert key: one row per person per studio.
    uniqueIndex('uq_notification_preferences_org_user').on(table.organizationId, table.userId),
  ],
);

/**
 * The person-facing notification families a member can opt out of (x152). Closed and small: a value
 * outside this set is a validation error in the route and a write error at the engine, never stored.
 * A new family is a deliberate schema + ENUM change, not a stray string.
 */
export const NOTIFICATION_KINDS = [
  'client_request',
  'work_item',
  'message',
  'file',
  // CQ-12 (0207): "Mentions" — being @mentioned in a channel or a document comment.
  'mention',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * Per-kind notification opt-out (migration 0057, x152) — the finer sibling of
 * `notification_preferences` (0022). One row per (membership, kind) recording whether that one kind
 * of notification is wanted; keyed by membership like `home_pinned_items`, private to the acting
 * seat. Absence of a row means the kind is enabled (an account opted out of nothing is reachable
 * about everything), so the read fills defaults for unset kinds. This slice stores the intent;
 * honouring a disabled kind at delivery time is the deferred half (NS-13). The unique pref key makes
 * the write an upsert — a second save of the same pair updates `enabled` in place, never a new row.
 */
export const notificationKindPrefs = mysqlTable(
  'notification_kind_prefs',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    kind: mysqlEnum('kind', NOTIFICATION_KINDS).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_notification_kind_prefs_org_id').on(table.organizationId, table.id),
    // The upsert key: one row per membership per kind, and the order the one read is served by.
    uniqueIndex('uq_notification_kind_prefs_pref').on(
      table.organizationId,
      table.membershipId,
      table.kind,
    ),
  ],
);

/**
 * A11Y-183 font-scale steps (module 20 Preferences & accessibility, x183). A small, closed
 * vocabulary — `md` is the shipped default. A value outside this set is a validation error
 * (`a11y.controller.ts`), never stored; the JSON column carries the chosen step whole.
 */
export const A11Y_FONT_SCALES = ['sm', 'md', 'lg', 'xl'] as const;
export type A11yFontScale = (typeof A11Y_FONT_SCALES)[number];

/**
 * The accessibility settings one member keeps in one studio, stored whole in
 * `a11y_preferences.a11y_json`. The typed shape of that JSON column below; the application
 * validates a request against it before storing (the same division `work_forms.fields_json`
 * and `saved_views.config` take).
 */
export interface A11yPreferences {
  readonly fontScale: A11yFontScale;
  readonly reduceMotion: boolean;
  readonly highContrast: boolean;
}

/**
 * A11Y-183 — a member's own accessibility preferences (migration 0079, x183, module 20).
 *
 * One row per `(organization_id, membership_id)`: the font-scale/reduced-motion/high-contrast
 * settings the acting member applies to the app shell. Keyed by membership (like
 * `home_pinned_items`) rather than the global user, because it is scoped to who the caller is
 * *in this studio* and never leaves the tenant. `a11y_json` holds the whole {@link A11yPreferences}
 * object; the settings are read and written as one, never queried across rows. The write is a
 * single upsert against `uq_a11y_preferences_org_membership`, so a second save updates in place;
 * `updated_at` follows the column's `ON UPDATE`. Absence is a default, not an error — the read
 * returns the shipped defaults when no row exists.
 */
export const a11yPreferences = mysqlTable(
  'a11y_preferences',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    a11yJson: json('a11y_json').$type<A11yPreferences>().notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_a11y_preferences_org_id').on(table.organizationId, table.id),
    // The upsert key: one row per member per studio.
    uniqueIndex('uq_a11y_preferences_org_membership').on(table.organizationId, table.membershipId),
  ],
);

/**
 * PREF-QUIET (x215, module 20 Preferences & accessibility). A member's notification quiet-hours
 * window, stored whole in `pref_quiet_hours.quiet_json`. Distinct from the per-kind notification
 * opt-out (x152): this is a *time-window* do-not-disturb rule, not a per-kind switch. `days` is the
 * set of weekdays (0 = Sunday … 6 = Saturday) the window applies to; `startTime`/`endTime` are
 * `HH:MM` (24-hour) local to `timezone` (an IANA zone). The application validates a request against
 * this shape before storing (the same division `a11y_preferences.a11y_json` takes).
 */
export interface QuietHours {
  readonly enabled: boolean;
  readonly startTime: string;
  readonly endTime: string;
  readonly timezone: string;
  readonly days: readonly number[];
}

/**
 * PREF-QUIET — a member's own notification quiet-hours (migration 0093, x215, module 20).
 *
 * One row per `(organization_id, membership_id)`: the do-not-disturb window the acting member sets.
 * Keyed by membership (like `a11y_preferences`) rather than the global user, because it is scoped to
 * who the caller is *in this studio* and never leaves the tenant. `quiet_json` holds the whole
 * {@link QuietHours} object; the settings are read and written as one, never queried across rows. The
 * write is a single upsert against `uq_pref_quiet_hours_org_membership`, so a second save updates in
 * place; `updated_at` follows the column's `ON UPDATE`. Absence is the shipped default (disabled), not
 * an error — the read returns the defaults when no row exists.
 */
export const quietHours = mysqlTable(
  'pref_quiet_hours',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    quietJson: json('quiet_json').$type<QuietHours>().notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_pref_quiet_hours_org_id').on(table.organizationId, table.id),
    // The upsert key: one row per member per studio.
    uniqueIndex('uq_pref_quiet_hours_org_membership').on(table.organizationId, table.membershipId),
  ],
);

/** The cadences a notification digest may be delivered on. A fixed, closed vocabulary. */
export const DIGEST_CADENCE = ['immediate', 'daily', 'weekly'] as const;
export type DigestCadence = (typeof DIGEST_CADENCE)[number];

/**
 * PREF-DIGEST (x245, module 20 Preferences & accessibility). A member's notification digest cadence,
 * stored whole in `pref_digest.digest_json`. Distinct from the quiet-hours time window (x215) and the
 * per-kind notification opt-out (x152): this chooses *how often* the batched digest is delivered.
 * `cadence` is one of {@link DIGEST_CADENCE}; `sendHour` is the hour of day (0–23) the digest is
 * sent; `dayOfWeek` (0 = Sunday … 6 = Saturday) is the weekday a `weekly` digest is sent (inert for
 * `immediate`/`daily`, but still validated and stored whole). The application validates a request
 * against this shape before storing (the same division `pref_quiet_hours.quiet_json` takes). No
 * dispatcher or email is built by this slice — this is preference storage only.
 */
export interface DigestPreference {
  readonly cadence: DigestCadence;
  readonly sendHour: number;
  readonly dayOfWeek: number;
}

/**
 * PREF-DIGEST — a member's own notification digest cadence (migration 0117, x245, module 20).
 *
 * One row per `(organization_id, membership_id)`: the digest cadence the acting member sets. Keyed by
 * membership (like `pref_quiet_hours`) rather than the global user, because it is scoped to who the
 * caller is *in this studio* and never leaves the tenant. `digest_json` holds the whole
 * {@link DigestPreference} object; the settings are read and written as one, never queried across
 * rows. The write is a single upsert against `uq_pref_digest_org_membership`, so a second save
 * updates in place; `updated_at` follows the column's `ON UPDATE`. Absence is the shipped default
 * (daily at 08:00), not an error — the read returns the defaults when no row exists.
 */
export const digestPreferences = mysqlTable(
  'pref_digest',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    digestJson: json('digest_json').$type<DigestPreference>().notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_pref_digest_org_id').on(table.organizationId, table.id),
    // The upsert key: one row per member per studio.
    uniqueIndex('uq_pref_digest_org_membership').on(table.organizationId, table.membershipId),
  ],
);

/**
 * CH-09 — a member's own mute/unmute state for one conversation (migration 0124, x252, module Chat).
 *
 * One row per `(organization_id, conversation_id, membership_id)`: whether the acting member has
 * muted a channel's notifications. Keyed by membership (like `pref_quiet_hours`) rather than the
 * global user, because it is scoped to who the caller is *in this studio* and never leaves the tenant.
 * The write is a single upsert against `uq_conversation_mutes_org_conv_membership`, so a second save
 * flips `muted` in place; `updated_at` follows the column's `ON UPDATE`. Absence is the shipped
 * default (not muted), not an error — the read returns `false` when no row exists. Read-only preference
 * this slice: nothing dispatches off it yet.
 */
export const conversationMutes = mysqlTable(
  'conversation_mutes',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    conversationId: char('conversation_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    muted: boolean('muted').notNull().default(false),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_conversation_mutes_org_id').on(table.organizationId, table.id),
    // The upsert key: one row per member per conversation.
    uniqueIndex('uq_conversation_mutes_org_conv_membership').on(
      table.organizationId,
      table.conversationId,
      table.membershipId,
    ),
  ],
);

/**
 * BK3 (COL-03, 0214). A one-to-one direct conversation between two members of one studio.
 * `userLowId` / `userHighId` are the two user ids sorted by the service, so the pair key makes
 * create-or-get idempotent. The relation rule (internal-internal always; a client only with someone
 * they share a project with) lives in `DirectConversationsService` and is re-checked on every read.
 */
export const directConversations = mysqlTable(
  'direct_conversations',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    userLowId: char('user_low_id', { length: 36 }).notNull(),
    userHighId: char('user_high_id', { length: 36 }).notNull(),
    nextSequenceNo: bigint('next_sequence_no', { mode: 'number', unsigned: true })
      .notNull()
      .default(1),
    // 0216: each participant's last-read sequence number (BK3-left unread counts).
    userLowLastReadSequenceNo: bigint('user_low_last_read_sequence_no', {
      mode: 'number',
      unsigned: true,
    })
      .notNull()
      .default(0),
    userHighLastReadSequenceNo: bigint('user_high_last_read_sequence_no', {
      mode: 'number',
      unsigned: true,
    })
      .notNull()
      .default(0),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    lastMessageAt: datetime('last_message_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_direct_conversations_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_direct_conversations_pair').on(
      table.organizationId,
      table.userLowId,
      table.userHighId,
    ),
    index('ix_direct_conversations_high').on(table.organizationId, table.userHighId),
  ],
);

/** BK3 (COL-03, 0214). One message in a direct conversation. Append-only (INSERT + SELECT). */
export const directMessages = mysqlTable(
  'direct_messages',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    directConversationId: char('direct_conversation_id', { length: 36 }).notNull(),
    authorUserId: char('author_user_id', { length: 36 }).notNull(),
    sequenceNo: bigint('sequence_no', { mode: 'number', unsigned: true }).notNull(),
    body: text('body').notNull(),
    clientGeneratedId: char('client_generated_id', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_direct_messages_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_direct_messages_sequence').on(
      table.organizationId,
      table.directConversationId,
      table.sequenceNo,
    ),
    uniqueIndex('uq_direct_messages_client_generated').on(
      table.organizationId,
      table.authorUserId,
      table.clientGeneratedId,
    ),
  ],
);

/**
 * PRF keyboard shortcuts (x286, module 20 Preferences & accessibility). A member's own override of
 * one command-palette action's keyboard chord (migration 0155).
 *
 * One row per `(organization_id, membership_id, action_key)`: the chord the acting member has bound
 * to a command-palette action. Keyed by membership (like `home_widget_prefs`) rather than the global
 * user, because it is scoped to who the caller is *in this studio* and never leaves the tenant.
 * `action_key` is a command id from the palette's fixed registry (the application validates it before
 * an insert; an unknown key is a 400) and `chord` is validated against a fixed grammar. Absence of a
 * row means the action resolves to its shipped default, so a read overlays the stored overrides on the
 * defaults. The rebind is a single upsert against `uq_user_shortcut_prefs_org_membership_action`, so a
 * repeated rebind updates in place; the reset is a delete of the caller's own row; `updated_at` follows
 * the column's `ON UPDATE`.
 */
export const userShortcutPrefs = mysqlTable(
  'user_shortcut_prefs',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    actionKey: varchar('action_key', { length: 64 }).notNull(),
    chord: varchar('chord', { length: 64 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_user_shortcut_prefs_org_id').on(table.organizationId, table.id),
    // The upsert key: one row per member per action per studio.
    uniqueIndex('uq_user_shortcut_prefs_org_membership_action').on(
      table.organizationId,
      table.membershipId,
      table.actionKey,
    ),
  ],
);

/**
 * PREF-STARTUP (x287, module 20 Preferences & accessibility). The closed vocabulary of screens the
 * app may open to after sign-in. The application validates a saved `landingKey` against this set
 * before storing (the same division `a11y_preferences.a11y_json` takes); a value off the list is a
 * 400 and nothing is written. `home` is the shipped default an unsaved member routes to.
 */
export const LANDING_KEYS = ['home', 'inbox', 'my-work', 'calendar'] as const;
export type LandingKey = (typeof LANDING_KEYS)[number];

/**
 * PREF-STARTUP — a member's own default startup landing view (migration 0156, x287, module 20).
 *
 * One row per `(organization_id, membership_id)`: the screen the shell routes to on sign-in. Keyed
 * by membership (like `a11y_preferences` and `pref_quiet_hours`) rather than the global user, because
 * it is scoped to who the caller is *in this studio* and never leaves the tenant. `landing_key` holds
 * one value from {@link LANDING_KEYS}, validated by the application. The write is a single upsert
 * against `uq_user_startup_prefs_org_membership`, so a second save updates in place; `updated_at`
 * follows the column's `ON UPDATE`. Absence is the shipped default (`home`), not an error — the read
 * returns `home` when no row exists.
 */
export const userStartupPrefs = mysqlTable(
  'user_startup_prefs',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    landingKey: varchar('landing_key', { length: 32 }).$type<LandingKey>().notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_user_startup_prefs_org_id').on(table.organizationId, table.id),
    // The upsert key: one row per member per studio.
    uniqueIndex('uq_user_startup_prefs_org_membership').on(
      table.organizationId,
      table.membershipId,
    ),
  ],
);

export const IDEMPOTENCY_STATUS = ['in_progress', 'succeeded', 'failed'] as const;

export const idempotencyRecords = mysqlTable(
  'idempotency_records',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    actorUserId: char('actor_user_id', { length: 36 }).notNull(),
    operation: varchar('operation', { length: 190 }).notNull(),
    /** `key` is reserved in MySQL; the contract in tmanage-core.dbml names the column `key`. */
    key: varchar('key', { length: 190 }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    status: mysqlEnum('status', IDEMPOTENCY_STATUS).notNull().default('in_progress'),
    responseJson: json('response_json'),
    responseStatus: smallint('response_status', { unsigned: true }),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    completedAt: datetime('completed_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_idempotency_records_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_idempotency_records_identity').on(
      table.organizationId,
      table.actorUserId,
      table.operation,
      table.key,
    ),
    index('ix_idempotency_records_expiry').on(table.expiresAt),
  ],
);

export const AUDIT_RESULT = ['allowed', 'denied', 'error'] as const;

/**
 * Append-only. There is intentionally no update or delete path to this table anywhere in
 * the application: triggers reject both for every credential, and `scripts/db/users.sql`
 * withholds the privileges from the runtime user so the attempt cannot even be made.
 */
export const auditEvents = mysqlTable(
  'audit_events',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    actorUserId: char('actor_user_id', { length: 36 }),
    effectiveActorId: char('effective_actor_id', { length: 36 }),
    action: varchar('action', { length: 190 }).notNull(),
    objectType: varchar('object_type', { length: 64 }).notNull(),
    objectId: char('object_id', { length: 36 }),
    result: mysqlEnum('result', AUDIT_RESULT).notNull(),
    correlationId: char('correlation_id', { length: 36 }).notNull(),
    /** Identifiers and classifications, never request bodies or content (spec §12). */
    metadataJson: json('metadata_json').notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    /** PA-02 (0241): where the action came from, and the support session it ran in. */
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 255 }),
    platformSupportSessionId: char('platform_support_session_id', { length: 36 }),
    /** 56-11 (0261): position in the organization's hash chain; NULL for pre-chain rows. */
    chainSeq: bigint('chain_seq', { mode: 'number' }),
    prevHash: char('prev_hash', { length: 64 }),
    rowHash: char('row_hash', { length: 64 }),
  },
  (table) => [
    uniqueIndex('uq_audit_events_org_id').on(table.organizationId, table.id),
    index('ix_audit_events_support').on(table.platformSupportSessionId),
    index('ix_audit_events_time_global').on(table.createdAt, table.id),
    index('ix_audit_events_org_time').on(table.organizationId, table.createdAt),
    index('ix_audit_events_org_actor_time').on(
      table.organizationId,
      table.actorUserId,
      table.createdAt,
    ),
    index('ix_audit_events_org_object').on(table.organizationId, table.objectType, table.objectId),
    index('ix_audit_events_org_action_time').on(
      table.organizationId,
      table.action,
      table.createdAt,
    ),
    index('ix_audit_events_org_chain').on(table.organizationId, table.chainSeq),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Credentials — ID-002, migration 0004
// ─────────────────────────────────────────────────────────────────────────────
//
// None of these four carries an `organization_id`, for the reason `users` and `sessions`
// do not: a person is one account holding memberships in many organizations. They are
// listed in the tenant guard's `NON_TENANT_TABLES`, so the omission is declared rather
// than merely true.

/** One row per user, or none. `user_id` is the key: a second password is not a state. */
export const userPasswords = mysqlTable('user_passwords', {
  userId: char('user_id', { length: 36 }).primaryKey(),
  /** Argon2id PHC string. The salt and every cost parameter travel inside the value. */
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  setAt: datetime('set_at', { mode: 'date', fsp: 3 }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
});

/**
 * Password reset links (0204, ACC-02). Global like the other credential tables; only the hash of
 * the mailed token is stored, and `used_at` makes a link single-use.
 */
export const passwordResetTokens = mysqlTable(
  'password_reset_tokens',
  {
    id: char('id', { length: 36 }).primaryKey(),
    userId: char('user_id', { length: 36 }).notNull(),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    usedAt: datetime('used_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [uniqueIndex('uq_password_reset_tokens_hash').on(table.tokenHash)],
);

/**
 * 0205. External sign-in identities ("Continue with Google"): the provider's stable subject,
 * linked to one person. Global (no `organization_id`), like the other credential tables.
 */
export const userIdentities = mysqlTable(
  'user_identities',
  {
    id: char('id', { length: 36 }).primaryKey(),
    userId: char('user_id', { length: 36 }).notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    subject: varchar('subject', { length: 255 }).notNull(),
    email: varchar('email', { length: 254 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    lastUsedAt: datetime('last_used_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_user_identities_subject').on(table.provider, table.subject),
    uniqueIndex('uq_user_identities_user_provider').on(table.userId, table.provider),
  ],
);

/**
 * 0206. Platform admin (the TManage operator). Global tables — they describe the operator and
 * the service, not a tenant — registered in `NON_TENANT_TABLES`. A step-up is a fresh password
 * (+ two-step code) confirmation bound to one session for 15 minutes.
 */
export const platformAdminStepUps = mysqlTable(
  'platform_admin_step_ups',
  {
    id: char('id', { length: 36 }).primaryKey(),
    userId: char('user_id', { length: 36 }).notNull(),
    sessionId: char('session_id', { length: 36 }).notNull(),
    mfaVerified: boolean('mfa_verified').notNull().default(false),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    index('ix_platform_admin_step_ups_session').on(table.userId, table.sessionId, table.expiresAt),
  ],
);

/** 0206. Every platform action with its typed reason. Append-only by grant. */
export const platformAdminAuditEvents = mysqlTable(
  'platform_admin_audit_events',
  {
    id: char('id', { length: 36 }).primaryKey(),
    actorUserId: char('actor_user_id', { length: 36 }).notNull(),
    actorEmail: varchar('actor_email', { length: 254 }).notNull(),
    action: varchar('action', { length: 96 }).notNull(),
    targetType: varchar('target_type', { length: 32 }).notNull(),
    targetId: char('target_id', { length: 36 }),
    targetLabel: varchar('target_label', { length: 254 }),
    /** PA-02 (0239): organization, support session, redacted before/after, IP and device. */
    organizationId: char('organization_id', { length: 36 }),
    reason: varchar('reason', { length: 500 }),
    correlationId: char('correlation_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    supportSessionId: char('support_session_id', { length: 36 }),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 255 }),
  },
  (table) => [
    index('ix_platform_admin_audit_events_time').on(table.createdAt),
    index('ix_paae_org_time').on(table.organizationId, table.createdAt),
    index('ix_paae_support').on(table.supportSessionId),
    index('ix_platform_admin_audit_events_target').on(
      table.targetType,
      table.targetId,
      table.createdAt,
    ),
  ],
);

/** 0206. Operator switches; today `public_signup` = `open` | `closed`. */
export const platformSettings = mysqlTable('platform_settings', {
  settingKey: varchar('setting_key', { length: 64 }).primaryKey(),
  settingValue: text('setting_value').notNull(),
  updatedByUserId: char('updated_by_user_id', { length: 36 }),
  updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
});

/**
 * Second factors. A table rather than a column because the plural is the real case — a
 * phone, a tablet, and later a passkey.
 */
export const userMfaFactors = mysqlTable(
  'user_mfa_factors',
  {
    id: char('id', { length: 36 }).primaryKey(),
    userId: char('user_id', { length: 36 }).notNull(),
    /** `totp` is the only kind implemented. `webauthn` would be a value, not a table. */
    kind: varchar('kind', { length: 32 }).notNull(),
    label: varchar('label', { length: 190 }).notNull(),
    /**
     * The shared secret, stored recoverably because TOTP verification needs the secret
     * itself. That is a property of the algorithm and the reason a passkey is the better
     * credential: a WebAuthn public key is useless to whoever steals the database.
     *
     * Since D07 (2026-09-06) the column holds an `mfa1.` envelope — AES-256-GCM under a
     * versioned key held outside the database — rather than the bare base32 seed, so a dump
     * discloses nothing usable. `credentials.repository.ts` is the only place it is opened.
     */
    secret: varchar('secret', { length: 255 }).notNull(),
    /** NULL until a code has been produced from it. An unconfirmed factor authorises nothing. */
    confirmedAt: datetime('confirmed_at', { mode: 'date', fsp: 3 }),
    /** RFC 6238 counter of the last accepted code — the column that prevents replay. */
    lastAcceptedCounter: bigint('last_accepted_counter', { mode: 'number' }),
    lastUsedAt: datetime('last_used_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    /** Soft-disabled: "this factor was removed on the 3rd" is a question a deletion cannot answer. */
    disabledAt: datetime('disabled_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [index('ix_user_mfa_factors_user').on(table.userId, table.disabledAt)],
);

/**
 * One row per recovery code.
 *
 * A row rather than a JSON blob because codes are individually single-use: spending one is
 * an `UPDATE ... WHERE used_at IS NULL`, which the database serialises, instead of a
 * read-modify-write of ten that two concurrent spends would race on.
 */
export const userRecoveryCodes = mysqlTable(
  'user_recovery_codes',
  {
    id: char('id', { length: 36 }).primaryKey(),
    userId: char('user_id', { length: 36 }).notNull(),
    /** Groups the ten issued together, so regenerating revokes the old set in one statement. */
    batchId: char('batch_id', { length: 36 }).notNull(),
    codeHash: char('code_hash', { length: 64 }).notNull(),
    usedAt: datetime('used_at', { mode: 'date', fsp: 3 }),
    /** Distinct from `usedAt`: "spent" and "replaced" are different answers. */
    revokedAt: datetime('revoked_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_user_recovery_codes_hash').on(table.codeHash),
    index('ix_user_recovery_codes_user').on(table.userId, table.usedAt, table.revokedAt),
    index('ix_user_recovery_codes_batch').on(table.batchId),
  ],
);

/**
 * The pre-tenant security log — append-only, enforced by triggers and by grants.
 *
 * Not `audit_events`, because that table's `organization_id` is NOT NULL and authentication
 * happens before any tenant exists. Migration 0004's header carries the full argument.
 */
export const authenticationEvents = mysqlTable(
  'authentication_events',
  {
    id: char('id', { length: 36 }).primaryKey(),
    /** NULL when the attempt named an address no account holds. That row is the enumeration trace. */
    userId: char('user_id', { length: 36 }),
    action: varchar('action', { length: 64 }).notNull(),
    outcome: varchar('outcome', { length: 16 }).notNull(),
    /** The precise cause. Recorded here and never returned to the caller. */
    reason: varchar('reason', { length: 64 }),
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 255 }),
    correlationId: char('correlation_id', { length: 36 }),
    occurredAt: datetime('occurred_at', { mode: 'date', fsp: 3 }).notNull(),
    /** R12 (0280). 0–100: how much the sign-in looked like a script (`automation-signal.ts`). */
    automationScore: tinyint('automation_score', { unsigned: true }),
    /** R12 (0280). The reasons behind the score, e.g. `["webdriver","form_too_fast"]`. */
    automationReasonsJson: json('automation_reasons_json').$type<readonly string[]>(),
    /** R12 (0280). `Sec-CH-UA` / the page's reported brands, clamped to 255. */
    clientHints: varchar('client_hints', { length: 255 }),
  },
  (table) => [
    index('ix_authentication_events_user').on(table.userId, table.occurredAt),
    index('ix_authentication_events_occurred').on(table.occurredAt),
    index('ix_authentication_events_ip_occurred').on(table.ip, table.occurredAt),
  ],
);

/**
 * `D05d`. The queue that tells an account holder their own credentials changed.
 *
 * The transactional outbox, with the tenant column removed — same columns as
 * {@link outboxEvents}, same meaning for each, same claim index. It exists separately
 * because a credential is not tenant-owned and the identity path may not touch a tenant
 * table at all; `0020_credential_change_notices.sql` carries the whole argument, and
 * repeating it here would be the second place it could drift.
 *
 * A row is written by the transaction that changed the credential and by nothing else —
 * {@link CredentialsRepository.recordCredentialChange} writes the log row and this one
 * together, so "the change was recorded but nobody was told" is not a state a caller can
 * reach by forgetting a step.
 */
export const credentialChangeNotices = mysqlTable(
  'credential_change_notices',
  {
    id: char('id', { length: 36 }).primaryKey(),
    userId: char('user_id', { length: 36 }).notNull(),
    /** One of `CREDENTIAL_CHANGE_ACTIONS` — the four actions that change a credential. */
    action: varchar('action', { length: 64 }).notNull(),
    correlationId: char('correlation_id', { length: 36 }),
    occurredAt: datetime('occurred_at', { mode: 'date', fsp: 3 }).notNull(),
    availableAt: datetime('available_at', { mode: 'date', fsp: 3 }).notNull(),
    publishedAt: datetime('published_at', { mode: 'date', fsp: 3 }),
    attempts: int('attempts', { unsigned: true }).notNull().default(0),
    lastError: varchar('last_error', { length: 1000 }),
  },
  (table) => [
    index('ix_credential_change_notices_unpublished').on(table.publishedAt, table.availableAt),
    index('ix_credential_change_notices_user').on(table.userId, table.occurredAt),
  ],
);

/**
 * ON-09 (0028). The durable anchor for an onboarding-import attempt.
 *
 * This slice is the validate / dry-run half: one row per validation attempt, recording who ran
 * it, the source kind, the outcome (`validated` / `validated_with_errors`), and the counts.
 * `41 §ON-09`'s "progress" and `41 §ADM-10`'s "receipt" read from here; the commit half that
 * creates projects/work from a validated attempt is the follow-up and will add its own columns
 * (and an `import_rows` child) rather than reshape this one. Org-scoped like every tenant table:
 * `(organization_id, id)` is unique so a future child can reference a job without a cross-tenant
 * path.
 */
export const importJobs = mysqlTable(
  'import_jobs',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    /** One of `IMPORT_SOURCE_KINDS` (`import-validation.ts`); VARCHAR so a new kind is a value. */
    sourceKind: varchar('source_kind', { length: 32 }).notNull(),
    /** `validated` | `validated_with_errors` — the dry-run outcome. */
    status: varchar('status', { length: 32 }).notNull(),
    totalCount: int('total_count', { unsigned: true }).notNull(),
    validCount: int('valid_count', { unsigned: true }).notNull(),
    invalidCount: int('invalid_count', { unsigned: true }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    /**
     * The commit half's terminal transition (0032). NULL until a validated job is committed;
     * `status` then carries `committed` / `committed_with_errors` and these three carry the
     * receipt summary. A validate-only job keeps all three NULL.
     */
    committedAt: datetime('committed_at', { mode: 'date', fsp: 3 }),
    committedCount: int('committed_count', { unsigned: true }),
    failedCount: int('failed_count', { unsigned: true }),
  },
  (table) => [
    uniqueIndex('uq_import_jobs_org_id').on(table.organizationId, table.id),
    index('ix_import_jobs_org_created').on(table.organizationId, table.createdAt),
  ],
);

/**
 * ON-09 commit half (0032). One row per source row in a committed import — the per-row receipt
 * (ADM-10's "receipt" at row granularity). A valid row carries `outcome = 'created'` with the
 * created entity id; an invalid or refused row carries `outcome = 'failed'` with `errorDetail`,
 * in the same job — ON-09's "partial failure" made auditable. Org-scoped, and bound to its
 * parent job by the composite `(organization_id, job_id)` foreign key so a receipt can never
 * cite another tenant's job.
 */
export const importRows = mysqlTable(
  'import_rows',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    jobId: char('job_id', { length: 36 }).notNull(),
    /** Zero-based index of the source row in the committed batch. */
    sourceIndex: int('source_index', { unsigned: true }).notNull(),
    /** `created` | `failed`; VARCHAR so a later outcome is a value the code adds. */
    outcome: varchar('outcome', { length: 32 }).notNull(),
    /** The id of the entity this row created, or NULL for a failed row. */
    createdEntityId: char('created_entity_id', { length: 36 }),
    /** The error that stopped a failed row, or NULL for a created row. */
    errorDetail: varchar('error_detail', { length: 500 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_import_rows_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_import_rows_job_source').on(
      table.organizationId,
      table.jobId,
      table.sourceIndex,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Public & trust site — GLOBAL, deliberately NOT tenant-owned (0060, x159)
// ─────────────────────────────────────────────────────────────────────────────
// The public status page's incidents. Like `users`/`authentication_events`, this table carries
// no `organization_id`: it is read by anyone, before any tenant is named, and describes the
// service as a whole. It is registered in the guard's NON_TENANT_TABLES (not TENANT_TABLES) and
// read on the identity path.

/** DEC-01-style closed vocabulary. Mirrors the `0060` incident `ENUM`. */
export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;

/**
 * Public & trust site (x159, migration 0060). A status-page incident — a component, a lifecycle
 * `status`, a title, a public write-up, when it started and (if over) when it resolved, and whether
 * it is `published`.
 *
 * Global (org-less): a status page is the operator's public trust surface, read before any tenant is
 * resolved, so there is no `organization_id` and no tenant foreign key — the shape
 * `credential_change_notices` (0020) and `authentication_events` (0004) use. `published` is the
 * public-visibility gate: the read selects `published = 1` only, the way `project_updates` (0041)
 * gates client content, so a draft is never shown. `0060_incidents.sql` is the source of truth; this
 * is its typed mirror.
 */
export const incidents = mysqlTable(
  'incidents',
  {
    id: char('id', { length: 36 }).primaryKey(),
    component: varchar('component', { length: 190 }).notNull(),
    status: mysqlEnum('status', INCIDENT_STATUSES).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    body: text('body').notNull(),
    startedAt: datetime('started_at', { mode: 'date', fsp: 3 }).notNull(),
    resolvedAt: datetime('resolved_at', { mode: 'date', fsp: 3 }),
    published: boolean('published').notNull().default(false),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- 56-13 incident register (0302, R18-f) ---- never public: the status read lists its columns.
    severity: varchar('severity', { length: 4 }).notNull().default('SEV3'),
    detectedAt: datetime('detected_at', { mode: 'date', fsp: 3 }),
    containedAt: datetime('contained_at', { mode: 'date', fsp: 3 }),
    affectedOrgIdsJson: text('affected_org_ids_json'),
    dataCategoriesJson: text('data_categories_json'),
    countriesJson: text('countries_json'),
    personalData: boolean('personal_data').notNull().default(false),
    notifiedAuthorityAt: datetime('notified_authority_at', { mode: 'date', fsp: 3 }),
    notifiedCustomersAt: datetime('notified_customers_at', { mode: 'date', fsp: 3 }),
    postmortemUrl: varchar('postmortem_url', { length: 512 }),
    createdBy: char('created_by', { length: 36 }),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [index('ix_incidents_published_started').on(table.published, table.startedAt)],
);

/**
 * SRCH ranking (x148, migration 0054). The tenant-scoped, denormalised search index a ranked
 * `MATCH … AGAINST` reads instead of scanning the source tables. `project_id` and `audience` are
 * mirrored from the source row so `authorize()` still relation-gates each hit over one read; the
 * FULLTEXT index on `(title, body_text)` is expressed in the migration (Drizzle cannot describe a
 * FULLTEXT index), so it is absent here and `schema.db.test.ts` treats it the way it treats the
 * triggers the migrations also own.
 */
export const searchIndex = mysqlTable(
  'search_index',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    targetKind: varchar('target_kind', { length: 32 }).notNull(),
    targetId: char('target_id', { length: 36 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    bodyText: mediumtext('body_text').notNull(),
    audience: mysqlEnum('audience', WORK_ITEM_AUDIENCE).notNull().default('internal'),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_search_index_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_search_index_target').on(
      table.organizationId,
      table.targetKind,
      table.targetId,
    ),
    index('ix_search_index_org_updated').on(table.organizationId, table.updatedAt, table.id),
  ],
);

/**
 * GLOBAL (org-less) product-changelog entries — Public site, module 1 (x160), migration 0061.
 *
 * A single public record of what shipped: one flat list of published product updates, each with a
 * version handle, a title, a Markdown body and a category. It carries **no** `organization_id` — a
 * changelog is one record for the product, not a per-tenant one — so it is registered in
 * `NON_TENANT_TABLES` (tenant-guard.ts), never `TENANT_TABLES`, and the public read reaches it
 * through `TenantDatabase.identityRead()`.
 */
export const changelogEntries = mysqlTable(
  'changelog_entries',
  {
    id: char('id', { length: 36 }).primaryKey(),
    version: varchar('version', { length: 100 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    bodyMd: text('body_md').notNull(),
    /** `feature` | `fix` | `security`; VARCHAR with application validation, as `work_forms` does. */
    category: varchar('category', { length: 32 }).notNull(),
    /** Live on the public page. Drafts are never returned by the public read. */
    published: boolean('published').notNull(),
    /** When it went live, and the order key (newest first). NULL for a draft. */
    publishedAt: datetime('published_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [index('ix_changelog_published').on(table.published, table.publishedAt, table.id)],
);

// Platform states — GLOBAL, deliberately NOT tenant-owned (0080, x185)
// ─────────────────────────────────────────────────────────────────────────────
// The platform maintenance / degraded-mode window the app shell reads. Like `incidents` (0060)
// and `credential_change_notices` (0020), this table carries no `organization_id`: it announces the
// state of the whole service, is read before/independently of any tenant, and is registered in the
// guard's NON_TENANT_TABLES (not TENANT_TABLES) and read on the identity path.

/** The banner severities. Mirrors the `0080` `severity` ENUM. */
export const MAINTENANCE_SEVERITIES = ['info', 'degraded', 'down'] as const;

/**
 * Platform states (x185, migration 0080). A platform maintenance / degraded-mode window — a public
 * `message`, a `severity` the banner renders, the window's `starts_at`/`ends_at` bounds, and whether
 * it is `published`.
 *
 * Global (org-less): a maintenance window describes the whole service and is read by the app shell
 * before any tenant is resolved, so there is no `organization_id` and no tenant foreign key — the
 * shape `incidents` (0060) and `credential_change_notices` (0020) use. `published` is the
 * public-visibility gate: the read selects `published = 1` only, so a draft window is never announced.
 * `0080_maintenance_windows.sql` is the source of truth; this is its typed mirror.
 */
export const maintenanceWindows = mysqlTable(
  'maintenance_windows',
  {
    id: char('id', { length: 36 }).primaryKey(),
    message: text('message').notNull(),
    severity: mysqlEnum('severity', MAINTENANCE_SEVERITIES).notNull(),
    startsAt: datetime('starts_at', { mode: 'date', fsp: 3 }).notNull(),
    endsAt: datetime('ends_at', { mode: 'date', fsp: 3 }).notNull(),
    published: boolean('published').notNull().default(false),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-10 (0244) ---- the Arabic message, the sign-in gate, edits and an
    // early end.
    messageAr: text('message_ar'),
    blockSignIn: boolean('block_sign_in').notNull().default(false),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }),
    endedAt: datetime('ended_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [index('ix_maintenance_windows_published_ends').on(table.published, table.endsAt)],
);

/** The insights reports a saved view may name. Mirrors the `0089` `report_kind` ENUM. */
export const INSIGHT_REPORT_KINDS = [
  'portfolio',
  'delivery-flow',
  'approval-cycle',
  'workload',
  'adoption',
  'forecast',
] as const;
export type InsightReportKind = (typeof INSIGHT_REPORT_KINDS)[number];

/** A saved insights view's remembered filter set — a small `{ field: value }` object, stored whole. */
export type InsightViewFilters = Readonly<Record<string, string>>;

/**
 * Insights saved views (x210, migration 0089). A member's own named, saved insights filter set — a
 * display `name`, the `report_kind` it names (a closed vocabulary), and the `filters` it remembers.
 *
 * Owner- and tenant-scoped, and private to its creator: `owner_user_id` is who may see or remove it
 * and `organization_id` scopes it to the studio. Unlike `saved_views` (0034) there is no `shared`
 * flag — an insights view is one person's this slice. `filters` is the remembered configuration,
 * echoed to the client rather than interpreted here. `0089_insight_saved_views.sql` is the source of
 * truth; this is its typed mirror.
 */
export const insightSavedViews = mysqlTable(
  'insight_saved_views',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    ownerUserId: char('owner_user_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 300 }).notNull(),
    reportKind: mysqlEnum('report_kind', INSIGHT_REPORT_KINDS).notNull(),
    filters: json('filters').$type<InsightViewFilters>().notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_insight_saved_views_org_id').on(table.organizationId, table.id),
    index('ix_insight_saved_views_org_owner').on(table.organizationId, table.ownerUserId, table.id),
  ],
);

/**
 * The insight-snapshot report kinds, mirroring the `0090` `ENUM`. A snapshot freezes one org-level
 * insights read: `portfolio` (the portfolio roll-up) or `workload` (the org-wide workload roll-up).
 * An unknown kind is a 400 in the controller, never a stored row.
 */
export const INSIGHT_SNAPSHOT_KINDS = ['portfolio', 'workload'] as const;

/**
 * Insight snapshots (x211). A point-in-time capture of a computed insights metric, so a studio can
 * compare today's numbers against a stored snapshot over time (audit: Insights are live-only — no
 * historical snapshots). Tenant-owned and keyed by the composite `(organization_id, id)` every
 * tenant-scoped table carries, so a snapshot can never be fetched across a tenant boundary.
 *
 * `payloadJson` is the computed metrics stored whole (the JSON the read returned), read and written
 * as one value; its shape is the application's (`SnapshotView.payload`). `capturedAt` is the instant
 * the metrics were computed, bound by the application — NOT a server-clock default — the admin-pool
 * clock trap. A snapshot is captured and read, never edited: the 0090 trigger pins every column
 * immutable and `users.sql` grants INSERT only. `0090_insight_snapshots.sql` is the source of truth;
 * this is its typed mirror.
 */
export const insightSnapshots = mysqlTable(
  'insight_snapshots',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    kind: mysqlEnum('kind', INSIGHT_SNAPSHOT_KINDS).notNull(),
    capturedAt: datetime('captured_at', { mode: 'date', fsp: 3 }).notNull(),
    payloadJson: json('payload_json').notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_insight_snapshots_org_id').on(table.organizationId, table.id),
    index('ix_insight_snapshots_org_kind_captured').on(
      table.organizationId,
      table.kind,
      table.capturedAt,
      table.id,
    ),
  ],
);

/** The cadences a scheduled insights report may repeat on. Mirrors the `0101` `cadence` ENUM. */
export const INSIGHT_REPORT_CADENCES = ['daily', 'weekly'] as const;
export type InsightReportCadence = (typeof INSIGHT_REPORT_CADENCES)[number];

/**
 * Insight report schedules (x228, migration 0101). A member's own recurring insights-report
 * definition — the report it names (`report_key`, the closed `INSIGHT_REPORT_KINDS` vocabulary the
 * saved views reuse), the `cadence` it repeats on (daily or weekly), the `hour` of day it runs and,
 * for a weekly schedule, the `day_of_week` (0=Sunday) it lands on. `next_run_at` is the next instant
 * the definition is due, computed by the application from a bound `now` — NOT the admin-pool clock,
 * the trap the sibling snapshots avoid — and stored so a future dispatcher (out of this slice:
 * definition and next-run compute only, no dispatch or egress) can find due rows.
 *
 * Owner- and tenant-scoped, and private to its creator: `owner_user_id` is who may see or remove it
 * and `organization_id` scopes it to the studio, the exact shape `insight_saved_views` (0089) takes.
 * A schedule is created once and removed, never edited in place this slice, so the app is granted
 * INSERT and DELETE and no UPDATE. `0101_insight_report_schedules.sql` is the source of truth; this is
 * its typed mirror.
 */
export const insightReportSchedules = mysqlTable(
  'insight_report_schedules',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    ownerUserId: char('owner_user_id', { length: 36 }).notNull(),
    reportKey: mysqlEnum('report_key', INSIGHT_REPORT_KINDS).notNull(),
    cadence: mysqlEnum('cadence', INSIGHT_REPORT_CADENCES).notNull(),
    hour: tinyint('hour').notNull(),
    dayOfWeek: tinyint('day_of_week'),
    nextRunAt: datetime('next_run_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_insight_report_schedules_org_id').on(table.organizationId, table.id),
    index('ix_insight_report_schedules_org_owner').on(
      table.organizationId,
      table.ownerUserId,
      table.id,
    ),
  ],
);

/**
 * Insight annotations (x271). An explanatory note attached to an insight snapshot, so a frozen figure
 * carries the context that explains it (INS-01 "every score is explainable"). Tenant-owned and
 * parent-scoped: the composite `(organization_id, snapshot_id)` binds a note to a snapshot of its own
 * tenant, so a cross-tenant snapshot id is a non-existent pair, not a leak; `authorMembershipId` is
 * bound composite to a membership of the same tenant and is the key the author's own DELETE resolves
 * against. `createdAt` is the instant the note was posted, bound by the application — NOT a
 * server-clock default (the admin-pool clock trap). An annotation is inserted, read, and removed by
 * its author, never edited: the 0141 trigger pins every column immutable and `users.sql` grants INSERT
 * and DELETE only. `0141_insight_annotations.sql` is the source of truth; this is its typed mirror.
 */
export const insightAnnotations = mysqlTable(
  'insight_annotations',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    snapshotId: char('snapshot_id', { length: 36 }).notNull(),
    authorMembershipId: char('author_membership_id', { length: 36 }).notNull(),
    note: text('note').notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_insight_annotations_org_id').on(table.organizationId, table.id),
    index('ix_insight_annotations_org_snapshot_created').on(
      table.organizationId,
      table.snapshotId,
      table.createdAt,
      table.id,
    ),
  ],
);

/**
 * Billing seats (Billing module 19, 0075, x178). A seat is a licence a membership holds against the
 * organization's plan: `membership_id` is bound composite to a membership of the same tenant, and a
 * seat is granted (`assigned_at`) and later reclaimed by a soft close (`released_at`), never deleted.
 * Tenant-owned — an unscoped read would be every studio's seat roster — so it carries the
 * `(organization_id, id)` key and is registered in `TENANT_TABLES`.
 */
export const billingSeats = mysqlTable(
  'billing_seats',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    assignedAt: datetime('assigned_at', { mode: 'date', fsp: 3 }).notNull(),
    releasedAt: datetime('released_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_billing_seats_org_id').on(table.organizationId, table.id),
    index('ix_billing_seats_org_membership').on(
      table.organizationId,
      table.membershipId,
      table.releasedAt,
      table.id,
    ),
  ],
);

/**
 * What an admin data-export request may cover, a closed vocabulary mirrored by the `0098` `ENUM`:
 * `full` (the whole organization), `members`, `projects`, `work_items`, `billing`. An unknown scope
 * is a 400 in the controller, never a stored row.
 */
export const ADMIN_EXPORT_SCOPES = [
  'full',
  'members',
  'projects',
  'work_items',
  'billing',
] as const;

/** The lifecycle of an export request; created `pending`, moved on by a later async worker. */
export const ADMIN_EXPORT_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;

/**
 * Admin data-export requests (Administration & governance, module 18, x224, migration 0098). A
 * recorded, GDPR-style request to export a studio's data, with a status an administrator can track.
 * Distinct from the audit CSV export (x197, a synchronous read): the actual bulk file generation and
 * delivery is Needs-Peter (an async worker plus storage), so this slice records and tracks the request
 * only — no file is produced and nothing leaves the system.
 *
 * Tenant-owned and keyed by the composite `(organization_id, id)` every tenant-scoped table carries,
 * so a request can never be fetched across a tenant boundary. `requestedAt` is the instant the admin
 * asked, bound by the application — NOT a server-clock default — the admin-pool clock trap. A request
 * is recorded and read, never edited or removed by the API credential: the 0098 trigger pins the
 * identity and request facts immutable and `users.sql` grants INSERT only.
 * `0098_admin_export_requests.sql` is the source of truth; this is its typed mirror.
 */
export const adminExportRequests = mysqlTable(
  'admin_export_requests',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    scope: mysqlEnum('scope', ADMIN_EXPORT_SCOPES).notNull(),
    status: mysqlEnum('status', ADMIN_EXPORT_STATUSES).notNull().default('pending'),
    requestedBy: char('requested_by', { length: 36 }).notNull(),
    requestedAt: datetime('requested_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_admin_export_requests_org_id').on(table.organizationId, table.id),
    index('ix_admin_export_requests_org_requested').on(
      table.organizationId,
      table.requestedAt,
      table.id,
    ),
  ],
);

/**
 * The insights-metric target vocabulary, mirroring the `0102` `ENUM`. A target judges one org-wide
 * roll-up figure: `open_items` / `scheduled_items` / `active_projects` / `active_assignees` — the four
 * totals `InsightsService.orgWorkload` computes. An unknown metric is a 400 in the controller, never a
 * stored row.
 */
export const INSIGHT_TARGET_METRICS = [
  'open_items',
  'scheduled_items',
  'active_projects',
  'active_assignees',
] as const;

/** The cadence a target applies to — display/grouping only, mirroring the `0102` `ENUM`. */
export const INSIGHT_TARGET_PERIODS = ['weekly', 'monthly', 'quarterly'] as const;

/**
 * Insight metric targets (x230). One org-wide target/goal line per insights metric, so a studio can
 * measure a live figure against a goal (audit: insights are reported and snapshotted, but there is no
 * target to judge them against). Tenant-owned and keyed by the composite `(organization_id, id)` every
 * tenant-scoped table carries, plus a `(organization_id, metric)` upsert key — one target per metric
 * per studio, so setting a metric's target a second time replaces it in place.
 *
 * `metric` and `period` are closed vocabularies (the ENUMs above); `targetValue` is a bounded
 * non-negative count the status read compares the live metric against, guarding a zero target so the
 * attainment ratio never divides by zero. The row is set and re-set, never edited by column: the 0102
 * trigger pins `organization_id` and `metric` immutable and `users.sql` grants INSERT + UPDATE (the
 * upsert), no DELETE. `0102_insight_targets.sql` is the source of truth; this is its typed mirror.
 */
export const insightTargets = mysqlTable(
  'insight_targets',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    metric: mysqlEnum('metric', INSIGHT_TARGET_METRICS).notNull(),
    targetValue: int('target_value', { unsigned: true }).notNull(),
    period: mysqlEnum('period', INSIGHT_TARGET_PERIODS).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_insight_targets_org_id').on(table.organizationId, table.id),
    // The upsert key: one target per metric per studio.
    uniqueIndex('uq_insight_targets_org_metric').on(table.organizationId, table.metric),
  ],
);

/**
 * The insight-metric-alert vocabulary, mirroring the `0187` `ENUM`. An alert watches one org-wide
 * workload roll-up figure: `open_items` / `scheduled_items` / `active_projects` / `active_assignees` —
 * the four totals `InsightsService.orgWorkload` computes and a `workload` snapshot (0090) freezes. An
 * unknown key is a 400 in the controller, never a stored row.
 */
export const INSIGHT_ALERT_METRICS = [
  'open_items',
  'scheduled_items',
  'active_projects',
  'active_assignees',
] as const;

/** How a live figure is compared to the threshold — `gte` breaches at or above, `lte` at or below. */
export const INSIGHT_ALERT_COMPARATORS = ['gte', 'lte'] as const;

/**
 * Insight metric alerts (x319). A member's own threshold alert on one insights metric, so a member can
 * say "watch open items and mark it breached when it crosses N" (audit: insights are reported,
 * snapshotted, compared and given org-wide targets, but a member has no personal threshold alert).
 * Tenant-owned and self-scoped: keyed by the composite `(organization_id, id)` every tenant-scoped
 * table carries, plus a `(organization_id, member_user_id, metric_key)` upsert key — one alert per
 * member per metric, so setting a metric's alert a second time replaces its comparator/threshold in
 * place (an idempotent PUT).
 *
 * `metric_key` and `comparator` are closed vocabularies (the ENUMs above); `threshold` is a bounded
 * non-negative count the read compares the latest workload snapshot against to mark breached. The row
 * is set and re-set, never edited by column beyond comparator/threshold: the 0187 trigger pins
 * `organization_id`, `member_user_id` and `metric_key` immutable and `users.sql` grants INSERT +
 * UPDATE (the upsert) + DELETE (a member removes their own alert). `0187_insight_metric_alerts.sql` is
 * the source of truth; this is its typed mirror.
 */
export const insightMetricAlerts = mysqlTable(
  'insight_metric_alerts',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    memberUserId: char('member_user_id', { length: 36 }).notNull(),
    metricKey: mysqlEnum('metric_key', INSIGHT_ALERT_METRICS).notNull(),
    comparator: mysqlEnum('comparator', INSIGHT_ALERT_COMPARATORS).notNull(),
    threshold: int('threshold', { unsigned: true }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_insight_metric_alerts_org_id').on(table.organizationId, table.id),
    // The upsert key: one alert per member per metric.
    uniqueIndex('uq_insight_metric_alerts_org_member_metric').on(
      table.organizationId,
      table.memberUserId,
      table.metricKey,
    ),
  ],
);

/**
 * The metric keys a custom insight report may compose (x320, migration 0188). The same four org-wide
 * roll-up figures `InsightsService.orgWorkload` computes and `INSIGHT_TARGET_METRICS` (0102) judges —
 * a custom report composes an *arbitrary ordered selection* of them (distinct from `insight_targets`,
 * one goal per metric). A metric key off this allowlist is a 400 in the controller, never a stored row.
 */
export const INSIGHT_CUSTOM_REPORT_METRICS = [
  'open_items',
  'scheduled_items',
  'active_projects',
  'active_assignees',
] as const;
export type InsightCustomReportMetric = (typeof INSIGHT_CUSTOM_REPORT_METRICS)[number];

/** How a custom report is laid out on the screen — a closed vocabulary, mirroring the `0188` ENUM. */
export const INSIGHT_CUSTOM_REPORT_LAYOUTS = ['list', 'grid'] as const;
export type InsightCustomReportLayout = (typeof INSIGHT_CUSTOM_REPORT_LAYOUTS)[number];

/** A custom report's ordered metric-key selection — a JSON array of allowlisted metric keys. */
export type InsightCustomReportMetricKeys = readonly InsightCustomReportMetric[];

/**
 * Insight custom reports (x320, migration 0188). A member's own named, custom insight report — a
 * display `name`, an ordered `metric_keys` selection over the known metric allowlist, and a `layout`
 * hint. It composes already-built insight metrics (no new metric computation): the by-id read renders
 * each selected key via the existing insights read services.
 *
 * Owner- and tenant-scoped, and private to its creator: `owner_user_id` is who may see, replace or
 * remove it and `organization_id` scopes it to the studio. Distinct from `insight_saved_views` (0089,
 * a filter preset over one fixed report) — this composes an arbitrary metric set. `metric_keys` is the
 * ordered selection stored whole (validated against the allowlist in the controller, never queried
 * across rows). The row is created (POST), replaced in place (idempotent PUT) and removed (DELETE):
 * the app is granted INSERT, UPDATE and DELETE, and the `0188` BEFORE UPDATE trigger pins
 * `organization_id`/`owner_user_id` immutable at the engine. `0188_insight_custom_reports.sql` is the
 * source of truth; this is its typed mirror.
 */
export const insightCustomReports = mysqlTable(
  'insight_custom_reports',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    ownerUserId: char('owner_user_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 300 }).notNull(),
    metricKeys: json('metric_keys').$type<InsightCustomReportMetricKeys>().notNull(),
    layout: mysqlEnum('layout', INSIGHT_CUSTOM_REPORT_LAYOUTS).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_insight_custom_reports_org_id').on(table.organizationId, table.id),
    index('ix_insight_custom_reports_org_owner').on(
      table.organizationId,
      table.ownerUserId,
      table.id,
    ),
  ],
);

/**
 * SEC / Client portal (module 13, x238). A project's client-portal settings / branding — one row per
 * project, keyed `(organization_id, project_id)`. Every column is a presentation field (the welcome
 * message, the accent colour, and whether the team and timeline are shown) except `updated_by`, the
 * internal stamp of which member last saved the settings. The client-facing projection never carries
 * `updated_by`; there is no internal-notes column (portal settings are branding, not a private
 * record). The read/upsert repository writes `INSERT ... ON DUPLICATE KEY UPDATE` against the
 * `(organization_id, project_id)` unique key, so a second save updates in place. Tenant-scoped and
 * project-owned: the composite foreign key binds `(organization_id, project_id)` to `projects`, and
 * the `0110` `BEFORE UPDATE` trigger pins the identity columns immutable.
 * `0110_portal_settings.sql` is the source of truth; this is its typed mirror.
 */
export const portalSettings = mysqlTable(
  'portal_settings',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    welcomeMessage: varchar('welcome_message', { length: 2000 }),
    accentColor: varchar('accent_color', { length: 7 }).notNull().default('#2563eb'),
    showTeam: boolean('show_team').notNull().default(true),
    showTimeline: boolean('show_timeline').notNull().default(true),
    updatedBy: char('updated_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_portal_settings_org_id').on(table.organizationId, table.id),
    // The upsert key: one settings row per project per studio.
    uniqueIndex('uq_portal_settings_org_project').on(table.organizationId, table.projectId),
  ],
);

/**
 * Per-client-organization portal branding (x323, migration 0191, module 13 / Client Portal).
 *
 * A different axis from `portal_settings` (0110, per project): one branding row per client
 * organization holds the client-facing accent colour and welcome copy that every project shared with
 * that client themes by. Keyed `(organization_id, client_org_scope_id)`, so a studio brands each of
 * its clients independently. The read/upsert repository writes `INSERT ... ON DUPLICATE KEY UPDATE`
 * against that unique key, so a second save updates in place. Text and colour only this slice (no logo
 * upload). Every column is a presentation field a client may read except `updated_by` — which member
 * last edited the branding — which the client projection (`client_projection.read`) never carries.
 * Tenant-scoped and client-owned: the composite foreign key binds `(organization_id,
 * client_org_scope_id)` to `client_organizations`, and the `0191` `BEFORE UPDATE` trigger pins the
 * identity columns immutable. `0191_portal_branding.sql` is the source of truth; this is its typed
 * mirror.
 */
export const portalBranding = mysqlTable(
  'portal_branding',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    clientOrgScopeId: char('client_org_scope_id', { length: 36 }).notNull(),
    accentColor: varchar('accent_color', { length: 7 }).notNull().default('#2563eb'),
    welcomeHeading: varchar('welcome_heading', { length: 200 }),
    welcomeText: varchar('welcome_text', { length: 2000 }),
    updatedBy: char('updated_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_portal_branding_org_id').on(table.organizationId, table.id),
    // The upsert key: one branding row per client organization per studio.
    uniqueIndex('uq_portal_branding_org_client').on(table.organizationId, table.clientOrgScopeId),
  ],
);

/**
 * The upper bounds the org-branding controller validates a save against, mirroring the `0195` column
 * widths. `product_name` is the display product name shown in the internal app chrome; `logo_text` is
 * a short logo label or set of initials. Over-length input is a 400 in the controller before the
 * engine, never a truncated store.
 */
export const ORG_BRANDING_PRODUCT_NAME_MAX_LENGTH = 120;
export const ORG_BRANDING_LOGO_TEXT_MAX_LENGTH = 48;

/**
 * ADM / org identity (Administration, module 18, x327, migration 0195). One row per organization: the
 * org-wide branding an admin sets for the *internal* app chrome — the display product name, an accent
 * colour, and a short logo text / initials. Any member reads it (via `work.read`) to render the shell;
 * only an admin (`org.manage`) sets it.
 *
 * Distinct from `portal_settings` (x238, per-project, client-facing) and from `org_settings`
 * (behaviour flags): this is org-wide *internal* chrome, text and colour only — no file upload this
 * slice. Tenant-owned and keyed by the composite `(organization_id, id)` every tenant-scoped table
 * carries, plus a `(organization_id)` upsert key — one branding row per studio, so setting it a second
 * time replaces it in place. `accent_color` is a hex token validated by an allowlist regex
 * (`#RGB`/`#RRGGBB`) in the controller (400, no upsert, for anything else) — not an ENUM, so the
 * palette is open, but no arbitrary string reaches the engine. `product_name`/`logo_text` are bounded
 * at the application layer to the widths above. The row is set and re-set, never edited by column: the
 * 0195 trigger pins `id`, `organization_id` and `created_at` immutable and `users.sql` grants
 * INSERT + UPDATE (the upsert), no DELETE. `0195_org_branding.sql` is the source of truth; this is its
 * typed mirror.
 */
export const orgBranding = mysqlTable(
  'org_branding',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    productName: varchar('product_name', { length: ORG_BRANDING_PRODUCT_NAME_MAX_LENGTH }),
    accentColor: varchar('accent_color', { length: 7 }).notNull().default('#2563eb'),
    logoText: varchar('logo_text', { length: ORG_BRANDING_LOGO_TEXT_MAX_LENGTH }),
    updatedBy: char('updated_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_org_branding_org_id').on(table.organizationId, table.id),
    // The upsert key: one branding row per studio.
    uniqueIndex('uq_org_branding_org').on(table.organizationId),
  ],
);

/**
 * C6 (0229). The company logo, held by the organization itself — no project. One row per
 * organization (`uq_organization_logos_org` is the upsert key). `content_base64` is a MEDIUMTEXT
 * holding the checked image: a raster logo as sent, an SVG only as the sanitiser rebuilt it.
 * Read only by `OrganizationLogoRepository`, which never selects the content column except to
 * serve the image.
 */
export const organizationLogos = mysqlTable(
  'organization_logos',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    mimeType: varchar('mime_type', { length: 32 }).notNull(),
    sizeBytes: int('size_bytes', { unsigned: true }).notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    contentBase64: mediumtext('content_base64').notNull(),
    version: bigint('version', { mode: 'number', unsigned: true }).notNull().default(1),
    updatedBy: char('updated_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_organization_logos_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_organization_logos_org').on(table.organizationId),
  ],
);

/**
 * Conversation read-state (x250, migration 0122, module CHAT / conversations).
 *
 * One row per `(organization_id, conversation_id, membership_id)`: the last message the acting member
 * has read in one channel, and when they read it. Keyed by membership (like `conversation_memberships`
 * is keyed by identity) because a read position is the caller's own and never leaves the tenant — the
 * route has no path or body field that could name another member's position, so a caller reads and
 * upserts their own row and no other. `last_read_message_id` is a plain column, not a composite
 * foreign key: `messages` carries no `(organization_id, id)` unique key to bind to (its key is
 * `(organization_id, id, depth)`), so the application resolves the message tenant-scoped and refuses a
 * `last_read_message_id` that is not in this conversation with a 400 before any write. The write is a
 * single upsert against `uq_conversation_read_state_member`, so a second mark-read updates in place;
 * unread is computed as the count of messages in the channel created after the last-read message's
 * `created_at`, self-scoped to the caller's row. Absence of a row means everything is unread.
 */
export const conversationReadState = mysqlTable(
  'conversation_read_state',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    conversationId: char('conversation_id', { length: 36 }).notNull(),
    /** An internal reader's membership; NULL on a client reader's row (0278). */
    membershipId: char('membership_id', { length: 36 }),
    /** R7 (0278): a client reader's `client_memberships` id; NULL on an internal reader's row. */
    clientMembershipId: char('client_membership_id', { length: 36 }),
    lastReadMessageId: char('last_read_message_id', { length: 36 }).notNull(),
    /** R7 (0275): the newest message delivered to this member, for receipts. */
    lastDeliveredMessageId: char('last_delivered_message_id', { length: 36 }),
    readAt: datetime('read_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_conversation_read_state_org_id').on(table.organizationId, table.id),
    // The upsert key: one read position per member per conversation.
    uniqueIndex('uq_conversation_read_state_member').on(
      table.organizationId,
      table.conversationId,
      table.membershipId,
    ),
    // R7 (0278): the client reader's upsert key.
    uniqueIndex('uq_conversation_read_state_client').on(
      table.organizationId,
      table.conversationId,
      table.clientMembershipId,
    ),
  ],
);

export type ConversationReadStateRow = typeof conversationReadState.$inferSelect;

/**
 * R7 (0275). One heartbeat per person per studio ("online" / "last seen"). No `id`: the primary
 * key `(organization_id, user_id)` leads with the tenant column, and the heartbeat is an upsert.
 */
export const userPresence = mysqlTable(
  'user_presence',
  {
    organizationId: char('organization_id', { length: 36 }).notNull(),
    userId: char('user_id', { length: 36 }).notNull(),
    lastSeenAt: datetime('last_seen_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })],
);

export const LINK_PREVIEW_STATUSES = ['pending', 'ready', 'failed'] as const;

/** R7 (0275). What the worker unfurled for one message's first link (SSRF-guarded, worker only). */
export const linkPreviews = mysqlTable(
  'link_previews',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    messageId: char('message_id', { length: 36 }).notNull(),
    url: varchar('url', { length: 2048 }).notNull(),
    title: varchar('title', { length: 300 }),
    description: varchar('description', { length: 500 }),
    imageUrl: varchar('image_url', { length: 2048 }),
    siteName: varchar('site_name', { length: 120 }),
    status: mysqlEnum('status', LINK_PREVIEW_STATUSES).notNull().default('pending'),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_link_previews_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_link_previews_message').on(table.organizationId, table.messageId),
    index('ix_link_previews_status').on(table.status, table.createdAt),
  ],
);

/**
 * x251 — a member's unsent composer draft for one conversation (CH-06 "Composer").
 *
 * One mutable scratch row per `(organization_id, conversation_id, membership_id)`, keyed to the
 * acting membership and never to the global user, so a draft is private to who the caller is in
 * this studio. The draft itself is `{ "body": "<composer text>" }` in `bodyJson`, read and written
 * whole. Nothing here enters the transcript — `messages` is the sent record; this is only what was
 * being typed. See `0123_conversation_message_drafts.sql`.
 */
export const conversationMessageDrafts = mysqlTable(
  'conversation_message_drafts',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    conversationId: char('conversation_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    bodyJson: json('body_json').$type<unknown>().notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_conversation_message_drafts_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_conversation_message_drafts_identity').on(
      table.organizationId,
      table.conversationId,
      table.membershipId,
    ),
  ],
);

/**
 * Every table this schema describes, keyed by its SQL name.
 *
 * `schema.db.test.ts` walks this to compare the description against `information_schema`,
 * so a table added to the file without being added here is itself a drift failure.
 */
/**
 * x232. A work item's watchers / subscribers (Work module 7). A self-service watch list: one row
 * per (work item, member) that a member creates and removes for themselves, so a later
 * notification path can reach the people who care. `fk_work_item_watchers_work_item` binds
 * `(organization_id, work_item_id)` to `work_items (organization_id, id)`, so a cross-tenant
 * `work_item_id` is a non-existent pair; `uq_work_item_watchers_member` makes a repeated subscribe
 * idempotent â€” migration `0104_work_item_watchers.sql`.
 */
export const workItemWatchers = mysqlTable(
  'work_item_watchers',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    memberId: char('member_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_work_item_watchers_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_work_item_watchers_member').on(
      table.organizationId,
      table.workItemId,
      table.memberId,
    ),
  ],
);

export type WorkItemWatcherRow = typeof workItemWatchers.$inferSelect;
export type NewWorkItemWatcherRow = typeof workItemWatchers.$inferInsert;

/**
 * x256 (0126). A personal reminder on a work item (Work module 7). One row per (work item, member)
 * that a member sets and clears for themselves: `remind_at` is "nudge me about this item then",
 * supplied as a bound instant so it is independent of any pool's clock. `fk_work_item_reminders_work_item`
 * binds `(organization_id, work_item_id)` to `work_items (organization_id, id)`, so a cross-tenant
 * `work_item_id` is a non-existent pair; `uq_work_item_reminders_member` makes "set my reminder" an
 * idempotent upsert — migration `0126_work_item_reminders.sql`. No notification is dispatched here.
 */
export const workItemReminders = mysqlTable(
  'work_item_reminders',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    remindAt: datetime('remind_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_work_item_reminders_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_work_item_reminders_member').on(
      table.organizationId,
      table.workItemId,
      table.membershipId,
    ),
    index('ix_work_item_reminders_due').on(
      table.organizationId,
      table.membershipId,
      table.remindAt,
      table.id,
    ),
  ],
);

export type WorkItemReminderRow = typeof workItemReminders.$inferSelect;
export type NewWorkItemReminderRow = typeof workItemReminders.$inferInsert;

/** The fixed palette a work label's `color` is drawn from â€” x233. A value outside this set is a 400. */
export const WORK_LABEL_COLORS = [
  'gray',
  'red',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const;

/**
 * x233. Work item labels / tags (Work module 7). One table, two row kinds distinguished by
 * nullability: a **definition** row carries `name` + `color` (with `work_item_id`/`label_id` NULL),
 * an **assignment** row carries `work_item_id` + `label_id` (with `name`/`color` NULL).
 * `fk_work_item_labels_work_item` binds `(organization_id, work_item_id)` to `work_items`, and the
 * self-referential `fk_work_item_labels_label` binds `(organization_id, label_id)` back to this
 * table, so a cross-tenant item or label id is a non-existent pair â€” migration
 * `0105_work_item_labels.sql`.
 */
export const workItemLabels = mysqlTable(
  'work_item_labels',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }),
    labelId: char('label_id', { length: 36 }),
    name: varchar('name', { length: 120 }),
    color: varchar('color', { length: 20 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_work_item_labels_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_work_item_labels_org_name').on(table.organizationId, table.name),
    uniqueIndex('uq_work_item_labels_assignment').on(
      table.organizationId,
      table.workItemId,
      table.labelId,
    ),
    index('ix_work_item_labels_item').on(table.organizationId, table.workItemId, table.id),
  ],
);

export type WorkItemLabelRow = typeof workItemLabels.$inferSelect;
export type NewWorkItemLabelRow = typeof workItemLabels.$inferInsert;

/** The kinds a work item custom-field row may be — x306. One table, two halves. */
export const WORK_ITEM_CUSTOM_FIELD_KINDS = ['definition', 'value'] as const;

/** The types a work item custom-field definition may declare — x306. `select` uses `options`. */
export const WORK_ITEM_CUSTOM_FIELD_TYPES = ['text', 'number', 'select'] as const;

/**
 * x306. Org-defined custom fields on work items (Work module). Two objects, one table (see
 * `0174_work_item_custom_fields.sql`), distinguished by `row_kind` — the x294 precedent: a
 * **definition** carries `definition_key` (unique per tenant), `name`, `field_type` and, for a
 * `select`, `options`; a **value** carries `work_item_id`, `value_key` (the definition's key) and
 * `value_text`, so a value references a definition without a second table.
 * `uq_work_item_custom_fields_definition` holds the per-tenant key unique; the value key
 * `(organization_id, work_item_id, value_key)` makes setting a value an idempotent upsert.
 * `fk_work_item_custom_fields_work_item` binds `(organization_id, work_item_id)` to `work_items`, so
 * a cross-tenant `work_item_id` is a non-existent pair rather than a leak; the migration's
 * `BEFORE UPDATE` trigger pins `organization_id` immutable.
 */
export const workItemCustomFields = mysqlTable(
  'work_item_custom_fields',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    rowKind: mysqlEnum('row_kind', WORK_ITEM_CUSTOM_FIELD_KINDS).notNull(),
    definitionKey: varchar('definition_key', { length: 80 }),
    name: varchar('name', { length: 160 }),
    fieldType: mysqlEnum('field_type', WORK_ITEM_CUSTOM_FIELD_TYPES),
    options: json('options').$type<readonly string[]>(),
    workItemId: char('work_item_id', { length: 36 }),
    valueKey: varchar('value_key', { length: 80 }),
    valueText: text('value_text'),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_work_item_custom_fields_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_work_item_custom_fields_definition').on(
      table.organizationId,
      table.definitionKey,
    ),
    uniqueIndex('uq_work_item_custom_fields_value').on(
      table.organizationId,
      table.workItemId,
      table.valueKey,
    ),
    index('ix_work_item_custom_fields_item').on(table.organizationId, table.workItemId, table.id),
  ],
);

export type WorkItemCustomFieldRow = typeof workItemCustomFields.$inferSelect;
export type NewWorkItemCustomFieldRow = typeof workItemCustomFields.$inferInsert;

/**
 * An organization's custom work-board columns — x308 (Work module 7; `0176_work_board_columns.sql`).
 *
 * An org-scoped, ordered list of board columns, each a `label` and the `state_key` it groups. It is
 * a display grouping over the existing work-item states — no work item lives here, and the state
 * machine is untouched. `state_key` names one of the machine's states (the allowlist is enforced in
 * the service). `position` is the column's slot, unique per studio.
 */
export const workBoardColumns = mysqlTable(
  'work_board_columns',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    label: varchar('label', { length: 120 }).notNull(),
    stateKey: varchar('state_key', { length: 40 }).notNull(),
    position: int('position').notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_work_board_columns_org_id').on(table.organizationId, table.id),
    // One column per board slot per studio: two columns cannot claim the same position.
    uniqueIndex('uq_work_board_columns_org_position').on(table.organizationId, table.position),
  ],
);

export type WorkBoardColumnRow = typeof workBoardColumns.$inferSelect;
export type NewWorkBoardColumnRow = typeof workBoardColumns.$inferInsert;

/** The cadences a work item recurrence rule may use — x257. A value outside this set is a 400. */
export const WORK_ITEM_RECURRENCE_FREQS = ['daily', 'weekly', 'monthly'] as const;

/**
 * x257. A work item's recurrence rule (Work module 7). One rule per work item: a `freq`
 * (`daily`/`weekly`/`monthly`), an `interval_count` (1..365), and an optional `until_at` bound.
 * `fk_work_item_recurrence_work_item` binds `(organization_id, work_item_id)` to `work_items`, so a
 * cross-tenant `work_item_id` is a non-existent pair; `uq_work_item_recurrence_item` holds the
 * one-rule-per-item invariant so a PUT upserts rather than duplicates. The next occurrence is
 * computed in-app from this rule — no worker generates anything, and this table holds only the
 * rule — migration `0127_work_item_recurrence.sql`.
 */
export const workItemRecurrence = mysqlTable(
  'work_item_recurrence',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    freq: varchar('freq', { length: 20 }).notNull(),
    intervalCount: int('interval_count').notNull(),
    untilAt: datetime('until_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- R17-e · 53-09 recurring work v2 (0300) ----
    rrule: varchar('rrule', { length: 512 }),
    startsOn: date('starts_on', { mode: 'string' }),
    byWeekday: varchar('by_weekday', { length: 32 }),
    byMonthday: tinyint('by_monthday'),
    bySetpos: tinyint('by_setpos'),
    timeZone: varchar('time_zone', { length: 64 }),
    spawnMode: varchar('spawn_mode', { length: 12 }).notNull().default('on_schedule'),
    spawnAheadDays: tinyint('spawn_ahead_days').notNull().default(1),
    holidayPolicy: varchar('holiday_policy', { length: 20 }).notNull().default('next_working_day'),
    countLimit: smallint('count_limit'),
    status: varchar('status', { length: 8 }).notNull().default('active'),
    templateJson: json('template_json').$type<Record<string, unknown>>(),
    ownerUserId: char('owner_user_id', { length: 36 }),
    lastOccurrenceKey: varchar('last_occurrence_key', { length: 32 }),
  },
  (table) => [
    uniqueIndex('uq_work_item_recurrence_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_work_item_recurrence_item').on(table.organizationId, table.workItemId),
    index('ix_work_item_recurrence_status').on(table.organizationId, table.status),
  ],
);

export type WorkItemRecurrenceRow = typeof workItemRecurrence.$inferSelect;
export type NewWorkItemRecurrenceRow = typeof workItemRecurrence.$inferInsert;

/**
 * x262. People teams (People module 14). One table, two row kinds distinguished by nullability
 * (the x233 `work_item_labels` pattern): a **definition** row carries `name` (with `team_id`/
 * `membership_id` NULL) and is the team; an **assignment** row carries `team_id` + `membership_id`
 * (with `name` NULL) and places one member on one team. `name` is unique per tenant so a duplicate
 * team name is a 409; `(organization_id, team_id, membership_id)` is unique so assigning is
 * idempotent. The self-referential `fk_member_teams_team` binds `(organization_id, team_id)` back to
 * this table and `fk_member_teams_member` binds `(organization_id, membership_id)` to `memberships`,
 * so a cross-tenant team or a non-member assignment is a non-existent pair — migration
 * `0132_member_teams.sql`.
 */
export const memberTeams = mysqlTable(
  'member_teams',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    teamId: char('team_id', { length: 36 }),
    membershipId: char('membership_id', { length: 36 }),
    name: varchar('name', { length: 120 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_member_teams_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_member_teams_org_name').on(table.organizationId, table.name),
    uniqueIndex('uq_member_teams_assignment').on(
      table.organizationId,
      table.teamId,
      table.membershipId,
    ),
    index('ix_member_teams_team').on(table.organizationId, table.teamId, table.id),
  ],
);

export type MemberTeamRow = typeof memberTeams.$inferSelect;
export type NewMemberTeamRow = typeof memberTeams.$inferInsert;

/**
 * x267. Project tags / labels (Projects / portfolio module). One table, two row kinds distinguished
 * by nullability — the `work_item_labels` (0105, x233) pattern scoped to projects instead of work
 * items: a **definition** row carries `name` (with `project_id`/`tag_id` NULL), an **assignment** row
 * carries `project_id` + `tag_id` (with `name` NULL). `fk_project_tags_project` binds
 * `(organization_id, project_id)` to `projects`, and the self-referential `fk_project_tags_tag` binds
 * `(organization_id, tag_id)` back to this table, so a cross-tenant project or tag id is a
 * non-existent pair — migration `0137_project_tags.sql`.
 */
export const projectTags = mysqlTable(
  'project_tags',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }),
    tagId: char('tag_id', { length: 36 }),
    name: varchar('name', { length: 120 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_project_tags_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_project_tags_org_name').on(table.organizationId, table.name),
    uniqueIndex('uq_project_tags_assignment').on(
      table.organizationId,
      table.tagId,
      table.projectId,
    ),
    index('ix_project_tags_project').on(table.organizationId, table.projectId, table.id),
  ],
);

export type ProjectTagRow = typeof projectTags.$inferSelect;
export type NewProjectTagRow = typeof projectTags.$inferInsert;

/**
 * x270. File tags (Files module). One table, two row kinds distinguished by nullability: a
 * **definition** row carries `name` (with `file_id`/`tag_id` NULL), an **assignment** row carries
 * `file_id` + `tag_id` (with `name` NULL). `fk_file_tags_file` binds `(organization_id, file_id)` to
 * `file_assets`, and the self-referential `fk_file_tags_tag` binds `(organization_id, tag_id)` back
 * to this table, so a cross-tenant file or tag id is a non-existent pair — migration
 * `0140_file_tags.sql`.
 */
export const fileTags = mysqlTable(
  'file_tags',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    fileId: char('file_id', { length: 36 }),
    tagId: char('tag_id', { length: 36 }),
    name: varchar('name', { length: 120 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_file_tags_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_file_tags_org_name').on(table.organizationId, table.name),
    uniqueIndex('uq_file_tags_assignment').on(table.organizationId, table.tagId, table.fileId),
    index('ix_file_tags_file').on(table.organizationId, table.fileId, table.id),
    index('ix_file_tags_tag').on(table.organizationId, table.tagId, table.id),
  ],
);

export type FileTagRow = typeof fileTags.$inferSelect;
export type NewFileTagRow = typeof fileTags.$inferInsert;

/**
 * x332. File folders (Files module). One table, two row kinds distinguished by nullability: a
 * **folder** row carries `project_id` + `name` + `created_by` (with `file_id`/`folder_id` NULL), a
 * **membership** row carries `file_id` + `folder_id` (with `name`/`created_by`/`project_id` NULL).
 * `fk_file_folders_project` binds `(organization_id, project_id)` to `projects`,
 * `fk_file_folders_file` binds `(organization_id, file_id)` to `file_assets`, and the
 * self-referential `fk_file_folders_folder` binds `(organization_id, folder_id)` back to this table,
 * so a cross-tenant project, file or folder id is a non-existent pair — migration
 * `0198_file_folders.sql`.
 */
export const fileFolders = mysqlTable(
  'file_folders',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }),
    fileId: char('file_id', { length: 36 }),
    folderId: char('folder_id', { length: 36 }),
    name: varchar('name', { length: 120 }),
    createdBy: char('created_by', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_file_folders_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_file_folders_project_name').on(
      table.organizationId,
      table.projectId,
      table.name,
    ),
    uniqueIndex('uq_file_folders_membership').on(table.organizationId, table.fileId),
    index('ix_file_folders_project').on(table.organizationId, table.projectId, table.id),
    index('ix_file_folders_folder').on(table.organizationId, table.folderId, table.id),
  ],
);

export type FileFolderRow = typeof fileFolders.$inferSelect;
export type NewFileFolderRow = typeof fileFolders.$inferInsert;

/**
 * x333. File comments (Files module). In-app discussion on a file asset: a member comments, the
 * thread reads oldest-first (`created_at` then `id`), and a member deletes their own comment
 * (`created_by` vs the acting membership). `fk_file_comments_file` binds `(organization_id,
 * file_asset_id)` to `file_assets`, so a cross-tenant file id is a non-existent pair — migration
 * `0199_file_comments.sql`. Distinct from `document_comments` (0045, on documents).
 */
export const fileComments = mysqlTable(
  'file_comments',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    fileAssetId: char('file_asset_id', { length: 36 }).notNull(),
    body: text('body').notNull(),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_file_comments_org_id').on(table.organizationId, table.id),
    index('ix_file_comments_file').on(
      table.organizationId,
      table.fileAssetId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type FileCommentRow = typeof fileComments.$inferSelect;
export type NewFileCommentRow = typeof fileComments.$inferInsert;

/**
 * DOC bookmarks / favorites (x242). A membership's private favorite of a `documents` row â€” the fact
 * "this membership bookmarked this document". Per-membership and tenant-scoped like `home_pinned_items`
 * (0050): created (INSERT) and removed (DELETE), never edited, so there is no immutability trigger â€”
 * the withheld UPDATE grant is the control. The `(organization_id, doc_id, membership_id)` unique key
 * makes a repeated bookmark a collision the service treats as success (idempotent PUT). Two composite
 * FKs bind the row within one tenant. `0114_doc_bookmarks.sql` is the source of truth; this is its
 * typed mirror.
 */
export const docBookmarks = mysqlTable(
  'doc_bookmarks',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    docId: char('doc_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_doc_bookmarks_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_doc_bookmarks_pin').on(table.organizationId, table.docId, table.membershipId),
    index('ix_doc_bookmarks_org_membership').on(
      table.organizationId,
      table.membershipId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type DocBookmarkRow = typeof docBookmarks.$inferSelect;
export type NewDocBookmarkRow = typeof docBookmarks.$inferInsert;

/**
 * DOC subscriptions (x312). A membership's explicit *follow* of a `documents` row — the fact "this
 * membership subscribed to (follows) this document". A read-side flag only; no notification dispatch
 * this slice. Distinct from `doc_bookmarks` (0114, a personal saved list): this is an opt-in follow
 * intent. Per-membership and tenant-scoped like `doc_bookmarks`: created (INSERT) and removed (DELETE),
 * never edited, so there is no immutability trigger — the withheld UPDATE grant is the control. The
 * `(organization_id, document_id, membership_id)` unique key makes a repeated subscribe a collision the
 * service treats as success (idempotent PUT). Two composite FKs bind the row within one tenant.
 * `0180_doc_subscriptions.sql` is the source of truth; this is its typed mirror.
 */
export const docSubscriptions = mysqlTable(
  'doc_subscriptions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    documentId: char('document_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_doc_subscriptions_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_doc_subscriptions_sub').on(
      table.organizationId,
      table.documentId,
      table.membershipId,
    ),
    index('ix_doc_subscriptions_org_membership').on(
      table.organizationId,
      table.membershipId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type DocSubscriptionRow = typeof docSubscriptions.$inferSelect;
export type NewDocSubscriptionRow = typeof docSubscriptions.$inferInsert;

/**
 * Calendar focus blocks (x255, migration 0125, module Calendar / CAL-04 "Focus block"). A member's
 * own protected time on the calendar: one row is the fact "this membership has protected
 * `[starts_at, ends_at)` for `title`". Per-membership and tenant-scoped like `doc_bookmarks` (0114):
 * created (INSERT) and removed (DELETE), never edited, so there is no immutability trigger — the
 * withheld UPDATE grant is the control. The composite FK `(organization_id, membership_id)` binds the
 * row to a membership of this same tenant, so a block can never cite a membership in another studio.
 * The application enforces `ends_at > starts_at` and a bounded duration (400 otherwise), so the store
 * holds only well-formed rows. `0125_focus_blocks.sql` is the source of truth; this is its typed
 * mirror.
 */
export const focusBlocks = mysqlTable(
  'focus_blocks',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    startsAt: datetime('starts_at', { mode: 'date', fsp: 3 }).notNull(),
    endsAt: datetime('ends_at', { mode: 'date', fsp: 3 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_focus_blocks_org_id').on(table.organizationId, table.id),
    // The one read: a membership's blocks in a bounded window, ordered by start, id breaking ties.
    index('ix_focus_blocks_org_membership_starts').on(
      table.organizationId,
      table.membershipId,
      table.startsAt,
      table.id,
    ),
  ],
);

export type FocusBlockRow = typeof focusBlocks.$inferSelect;
export type NewFocusBlockRow = typeof focusBlocks.$inferInsert;

/**
 * INBOX saved filters (IN-02 "All inbox", x261). A membership's private, named inbox filter set — the
 * fact "this membership saved this named inbox filter". `filterJson` is the client's opaque,
 * serialized facet set (source / project / kind); the server stores and returns it verbatim. Per
 * membership and tenant-scoped like `doc_bookmarks` (0114): created (INSERT) and removed (DELETE),
 * never edited, so there is no immutability trigger — the withheld UPDATE grant is the control. The
 * `(organization_id, membership_id, name)` unique key makes a second filter of the same name a
 * collision the service maps to 409. `0131_inbox_saved_filters.sql` is the source of truth; this is
 * its typed mirror.
 */
export const inboxSavedFilters = mysqlTable(
  'inbox_saved_filters',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    filterJson: text('filter_json').notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_inbox_saved_filters_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_inbox_saved_filters_name').on(
      table.organizationId,
      table.membershipId,
      table.name,
    ),
    index('ix_inbox_saved_filters_org_membership').on(
      table.organizationId,
      table.membershipId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type InboxSavedFilterRow = typeof inboxSavedFilters.$inferSelect;
export type NewInboxSavedFilterRow = typeof inboxSavedFilters.$inferInsert;

/**
 * DOC collections (x264). Named document collections — lightweight wiki spaces — and their membership,
 * in one table (the `work_item_labels` one-table posture). A row is EITHER a collection definition (its
 * `name` is set, `collectionId` and `documentId` are null, and the row's own `id` is the collection id)
 * OR a membership fact "this document belongs to this collection" (`collectionId` points at a definition
 * row, `documentId` at a `documents` row, `name` is null). Created (INSERT) and removed (DELETE), never
 * edited — the withheld UPDATE grant is the control, no immutability trigger. `uq_doc_collections_name`
 * makes a duplicate collection name a 409 (definitions only; members carry a null name and MySQL permits
 * many nulls in a unique key); `uq_doc_collections_member` makes adding a document twice idempotent. Two
 * composite FKs bind a membership row within one tenant. `0134_doc_collections.sql` is the source of
 * truth; this is its typed mirror.
 */
export const docCollections = mysqlTable(
  'doc_collections',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    collectionId: char('collection_id', { length: 36 }),
    documentId: char('document_id', { length: 36 }),
    name: varchar('name', { length: 200 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_doc_collections_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_doc_collections_name').on(table.organizationId, table.name),
    uniqueIndex('uq_doc_collections_member').on(
      table.organizationId,
      table.collectionId,
      table.documentId,
    ),
    index('ix_doc_collections_member').on(table.organizationId, table.collectionId, table.id),
  ],
);

export type DocCollectionRow = typeof docCollections.$inferSelect;
export type NewDocCollectionRow = typeof docCollections.$inferInsert;

/**
 * PROJ project favorites (x268). A membership's private favorite of a `projects` row — the fact
 * "this membership favorited this project", the star behind the compact project switcher. Per-
 * membership and tenant-scoped like `doc_bookmarks` (0114) / `home_pinned_items` (0050): created
 * (INSERT) and removed (DELETE), never edited, so there is no immutability trigger — the withheld
 * UPDATE grant is the control. The `(organization_id, project_id, membership_id)` unique key makes a
 * repeated star a collision the service treats as success (idempotent PUT). Two composite FKs bind
 * the row within one tenant. `0138_project_favorites.sql` is the source of truth; this is its typed
 * mirror.
 */
export const projectFavorites = mysqlTable(
  'project_favorites',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_project_favorites_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_project_favorites_fav').on(
      table.organizationId,
      table.projectId,
      table.membershipId,
    ),
    index('ix_project_favorites_org_membership').on(
      table.organizationId,
      table.membershipId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type ProjectFavoriteRow = typeof projectFavorites.$inferSelect;
export type NewProjectFavoriteRow = typeof projectFavorites.$inferInsert;

/**
 * x269. Document tags / labels (Docs module — DOC-01 hub filtering, findability). One table, two row
 * kinds distinguished by nullability: a **definition** row carries `name` (with `document_id`/`tag_id`
 * NULL), an **assignment** row carries `document_id` + `tag_id` (with `name` NULL).
 * `fk_doc_tags_document` binds `(organization_id, document_id)` to `documents`, and the
 * self-referential `fk_doc_tags_tag` binds `(organization_id, tag_id)` back to this table, so a
 * cross-tenant document or tag id is a non-existent pair — migration `0139_doc_tags.sql`.
 */
export const docTags = mysqlTable(
  'doc_tags',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    documentId: char('document_id', { length: 36 }),
    tagId: char('tag_id', { length: 36 }),
    name: varchar('name', { length: 120 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_doc_tags_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_doc_tags_org_name').on(table.organizationId, table.name),
    uniqueIndex('uq_doc_tags_assignment').on(table.organizationId, table.documentId, table.tagId),
    index('ix_doc_tags_document').on(table.organizationId, table.documentId, table.id),
  ],
);

export type DocTagRow = typeof docTags.$inferSelect;
export type NewDocTagRow = typeof docTags.$inferInsert;

/**
 * Org-wide admin announcement banners (Administration module 18, x276). One row is the fact "this
 * organization is broadcasting this message" — a title, a body, and an optional `[starts_at, ends_at]`
 * active window (null bounds are open). An admin (`org.manage`) posts and deletes; any member
 * (`work.read`) reads the announcements active right now. Posted (INSERT) and removed (DELETE), never
 * edited — like `doc_bookmarks` (0114) the withheld UPDATE grant is the control, so there is no
 * immutability trigger. Per-member dismissal is remembered in the browser this slice, so there is no
 * second table. The `(organization_id, created_by)` composite FK binds the author within one tenant.
 * `0145_org_announcements.sql` is the source of truth; this is its typed mirror.
 */
export const orgAnnouncements = mysqlTable(
  'org_announcements',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body').notNull(),
    startsAt: datetime('starts_at', { mode: 'date', fsp: 3 }),
    endsAt: datetime('ends_at', { mode: 'date', fsp: 3 }),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_org_announcements_org_id').on(table.organizationId, table.id),
    index('ix_org_announcements_org_created').on(table.organizationId, table.createdAt, table.id),
  ],
);

export type OrgAnnouncementRow = typeof orgAnnouncements.$inferSelect;
export type NewOrgAnnouncementRow = typeof orgAnnouncements.$inferInsert;

/**
 * DOC links + backlinks (x296). An author-created wiki-style relation between two `documents` rows —
 * the fact "source_doc links to target_doc". Tenant-scoped, created (INSERT) and removed (DELETE),
 * never edited (the withheld UPDATE grant plus a BEFORE UPDATE trigger are the control, the
 * work_item_links / doc_bookmarks posture). The `(organization_id, source_doc_id, target_doc_id)`
 * unique key makes a repeated link a collision the service treats as success (idempotent create); a
 * BEFORE INSERT trigger and the service both refuse a self-link. Two composite FKs bind both ends
 * within one tenant. `0163_doc_links.sql` is the source of truth; this is its typed mirror.
 */
export const docLinks = mysqlTable(
  'doc_links',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    sourceDocId: char('source_doc_id', { length: 36 }).notNull(),
    targetDocId: char('target_doc_id', { length: 36 }).notNull(),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_doc_links_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_doc_links_edge').on(table.organizationId, table.sourceDocId, table.targetDocId),
    index('ix_doc_links_source').on(
      table.organizationId,
      table.sourceDocId,
      table.createdAt,
      table.id,
    ),
    index('ix_doc_links_target').on(
      table.organizationId,
      table.targetDocId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type DocLinkRow = typeof docLinks.$inferSelect;
export type NewDocLinkRow = typeof docLinks.$inferInsert;

/**
 * DOC read state (x297). A membership's read cursor over a `documents` row — the fact "this membership
 * last read this document at this instant", powering a "new since you last looked" badge and a "mark all
 * read" affordance. Per-membership and tenant-scoped. Set (INSERT), refreshed (UPDATE via the upsert on
 * `uq_doc_read_state_pin`), and cleared (DELETE, mark-unread). Distinct from `conversation_read_state`
 * (0122) and `doc_bookmarks` (0114). Two composite FKs bind the row within one tenant.
 * `0164_doc_read_state.sql` is the source of truth; this is its typed mirror.
 */
export const docReadState = mysqlTable(
  'doc_read_state',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    docId: char('doc_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    lastReadAt: datetime('last_read_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_doc_read_state_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_doc_read_state_pin').on(table.organizationId, table.membershipId, table.docId),
    index('ix_doc_read_state_org_membership').on(table.organizationId, table.membershipId),
  ],
);

export type DocReadStateRow = typeof docReadState.$inferSelect;
export type NewDocReadStateRow = typeof docReadState.$inferInsert;

/**
 * Approval delegations (x300, migration 0168, module Approvals).
 *
 * One row per delegation: the fact that a delegator (the acting approver) has named a delegate to act
 * on approvals on their behalf between `starts_at` and `ends_at`. Keyed by `(organization_id, id)`
 * like every tenant table; the delegator is always the acting member (the route reads
 * `context.membershipId`, never a body field), so a member records only their own delegations. Created
 * and revoked, never edited — the only writes are INSERT and DELETE, no UPDATE grant — so a window is
 * changed by revoking and re-creating. Both membership columns are bound to a membership of this same
 * organization by composite foreign keys, the engine-level backstop behind the application's
 * resolve-before-write 404.
 */
export const approvalDelegations = mysqlTable(
  'approval_delegations',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    delegatorMembershipId: char('delegator_membership_id', { length: 36 }).notNull(),
    delegateMembershipId: char('delegate_membership_id', { length: 36 }).notNull(),
    startsAt: datetime('starts_at', { mode: 'date', fsp: 3 }).notNull(),
    endsAt: datetime('ends_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_approval_delegations_org_id').on(table.organizationId, table.id),
    // 07-DATA-MODEL §9: the one read — a delegator's delegations, newest first, id breaking ties.
    index('ix_approval_delegations_org_delegator').on(
      table.organizationId,
      table.delegatorMembershipId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type ApprovalDelegationRow = typeof approvalDelegations.$inferSelect;
export type NewApprovalDelegationRow = typeof approvalDelegations.$inferInsert;

/**
 * Person time-off (x325, migration 0193, module 14 People & capacity). Dated absences a manager files
 * against a person for capacity context: one row is the fact "this person is off between `starts_on`
 * and `ends_on`, of `kind`, in this studio". Keyed by `(organization_id, person_user_id)` — the
 * `member_profiles` (0094) posture, resolved membership -> (organization_id, user_id) before any
 * write — so an entry can never be filed for a non-member or a cross-tenant user; the composite FK
 * `(organization_id, person_user_id)` binds the person to a membership of this same tenant. Distinct
 * from `member_availability` (0096): that is a member managing their own recurring windows behind
 * `work.read`; this is a manager filing dated absences for another person behind `org.manage`. Created
 * (INSERT) and removed (DELETE), never edited, so there is no immutability trigger — the withheld
 * UPDATE grant is the control (the `focus_blocks` posture). The application enforces `kind` against a
 * fixed allowlist and `ends_on ≥ starts_on` (400 otherwise), so the store holds only well-formed rows.
 * `0193_person_time_off.sql` is the source of truth; this is its typed mirror.
 */
export const personTimeOff = mysqlTable(
  'person_time_off',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    personUserId: char('person_user_id', { length: 36 }).notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    kind: varchar('kind', { length: 20 }).notNull(),
    note: varchar('note', { length: 500 }),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_person_time_off_org_id').on(table.organizationId, table.id),
    // The one read: a person's entries in a studio, ordered by start, id breaking ties; the bounded
    // range GET filters overlap over this same prefix.
    index('ix_person_time_off_org_person').on(
      table.organizationId,
      table.personUserId,
      table.startsOn,
      table.id,
    ),
  ],
);

export type PersonTimeOffRow = typeof personTimeOff.$inferSelect;
export type NewPersonTimeOffRow = typeof personTimeOff.$inferInsert;

/**
 * The fixed set of Home-widget ids a member may order or hide (module 4 Home / My Day, x243). A
 * small, closed vocabulary â€” the widgets the Home screen actually renders. Every id in a saved
 * order or hidden list is validated against this set (`widget-prefs.controller.ts`); an id outside
 * it is a validation error (400), never stored. Adding a widget to the Home screen means adding its
 * id here.
 */
export const HOME_WIDGET_IDS = [
  'myDay',
  'waiting',
  'pulse',
  'summary',
  'pins',
  'savedContext',
] as const;
export type HomeWidgetId = (typeof HOME_WIDGET_IDS)[number];

/**
 * The Home widget layout one member keeps in one studio, stored across `home_widget_prefs`'
 * `widget_order_json` and `hidden_widgets_json`. The typed shape of those JSON columns below; the
 * application validates a request against {@link HOME_WIDGET_IDS} before storing (the same division
 * `work_forms.fields_json` and `a11y_preferences.a11y_json` take).
 */
export interface HomeWidgetPrefs {
  readonly order: readonly HomeWidgetId[];
  readonly hidden: readonly HomeWidgetId[];
}

/**
 * Home widget preferences (x243, migration 0115, module 4 Home / My Day).
 *
 * One row per `(organization_id, membership_id)`: the order the acting member wants the fixed Home
 * widgets in and the ids they have hidden. Keyed by membership (like `home_pinned_items` and
 * `a11y_preferences`) rather than the global user, because the layout is scoped to who the caller is
 * *in this studio* and never leaves the tenant. `widget_order_json` and `hidden_widgets_json` hold
 * the two lists whole; they are read and written as one, never queried across rows. The write is a
 * single upsert against `uq_home_widget_prefs_org_membership`, so a second save updates in place;
 * `updated_at` follows the column's `ON UPDATE`. Absence is the default layout, not an error â€” the
 * read returns an empty layout when no row exists.
 */
export const homeWidgetPrefs = mysqlTable(
  'home_widget_prefs',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    widgetOrderJson: json('widget_order_json').$type<HomeWidgetId[]>().notNull(),
    hiddenWidgetsJson: json('hidden_widgets_json').$type<HomeWidgetId[]>().notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_home_widget_prefs_org_id').on(table.organizationId, table.id),
    // The upsert key: one row per member per studio.
    uniqueIndex('uq_home_widget_prefs_org_membership').on(table.organizationId, table.membershipId),
  ],
);

export type HomeWidgetPrefRow = typeof homeWidgetPrefs.$inferSelect;

/**
 * Inbox flags (x260, migration 0130, module 4 Inbox / INBOX-001 IN-01 "Important inbox").
 *
 * One row marks one inbox bundle as important (starred) for one member, keyed
 * `(organization_id, membership_id, bundle_id)` — self-scoped like `home_widget_prefs` and
 * `doc_bookmarks`, never the global user, because the star is who the caller is *in this studio* and
 * never leaves the tenant. `bundle_id` is the inbox's own `objectType:objectId` (e.g.
 * `work_item:<uuid>`), the same id "mark read" takes; the flag row carries the string whole and never
 * joins on it, so — like `notifications.object_id` — it carries no foreign key of its own. The write
 * is find-then-insert idempotent against `uq_inbox_flags_org_membership_bundle`, so flagging twice is
 * one row; unflagging is a membership-scoped delete, idempotent by construction. Ownership is
 * re-checked at flag time against the caller's own notification rows (NOTIF-001's recipient-only rule),
 * so a member can only ever flag a bundle that is theirs to see — the row is never proof of access on
 * its own.
 */
export const inboxFlags = mysqlTable(
  'inbox_flags',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    bundleId: varchar('bundle_id', { length: 128 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_inbox_flags_org_id').on(table.organizationId, table.id),
    // The idempotency key: one row per member per bundle.
    uniqueIndex('uq_inbox_flags_org_membership_bundle').on(
      table.organizationId,
      table.membershipId,
      table.bundleId,
    ),
  ],
);

export type InboxFlagRow = typeof inboxFlags.$inferSelect;

/**
 * Org glossary of terms (x263, migration 0133, module Docs — the DOC hub's "decision register,
 * glossary"). One row is the fact "in this studio, this term means this": an org-wide, shared
 * vocabulary, not a per-membership or per-document surface. A member with the doc-authoring
 * capability adds a term (INSERT), edits its definition (UPDATE), or removes it (DELETE); any member
 * who may read docs searches and reads it. `uq_glossary_terms_org_term` under the column's
 * case-insensitive collation makes a repeated term (in any case) a collision the service maps to 409;
 * the tenant is immutable (BEFORE UPDATE trigger), the term and definition are not.
 * `0133_glossary_terms.sql` is the source of truth; this is its typed mirror.
 */
export const glossaryTerms = mysqlTable(
  'glossary_terms',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    term: varchar('term', { length: 190 }).notNull(),
    definition: text('definition').notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_glossary_terms_org_id').on(table.organizationId, table.id),
    // One term per studio, case-insensitively (the column's ci collation): a duplicate add collides
    // here and the service maps it to 409.
    uniqueIndex('uq_glossary_terms_org_term').on(table.organizationId, table.term),
    // The alphabetical list, and the prefix search the list route runs; id breaks ties for a total order.
    index('ix_glossary_terms_org_term').on(table.organizationId, table.term, table.id),
  ],
);

export type GlossaryTermRow = typeof glossaryTerms.$inferSelect;
export type NewGlossaryTermRow = typeof glossaryTerms.$inferInsert;

/**
 * The fixed set of triage categories a studio may file an incoming client request under (REQ-02
 * request triage, x265). A small, closed vocabulary — the buckets the triage panel offers. The
 * category on a `request_triage` row is validated against this set in `request-triage.controller.ts`;
 * a value outside it is a 400 and nothing is written. Widening the vocabulary means adding an id
 * here (and the panel picks it up). Internal-only: triage metadata never reaches the client
 * projection.
 */
export const REQUEST_TRIAGE_CATEGORIES = [
  'general',
  'bug',
  'change_request',
  'question',
  'billing',
  'feedback',
] as const;
export type RequestTriageCategory = (typeof REQUEST_TRIAGE_CATEGORIES)[number];

/**
 * Request triage metadata (x265, migration 0135, module 11 Requests).
 *
 * One row per `(organization_id, request_id)`: the category the studio filed an incoming client
 * request under and, optionally, the internal member it assigned the request to — the triage step
 * before commitment (REQ-02). Distinct from `client_requests`' own lifecycle: this is internal-only
 * routing metadata that is never part of the client-facing projection. The write is a single upsert
 * against `uq_request_triage_org_request`, so re-triaging updates in place rather than adding a
 * second row; `updated_at` follows the column's `ON UPDATE`. Absence means "not yet triaged", not an
 * error — the read returns a null category when no row exists. Both the request and, when named, the
 * assignee membership are bound to the acting tenant by composite foreign keys, so a triage row can
 * never point at another studio's request or member.
 */
export const requestTriage = mysqlTable(
  'request_triage',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    requestId: char('request_id', { length: 36 }).notNull(),
    category: varchar('category', { length: 64 }).notNull(),
    /** The internal member the request is assigned to. NULL until someone is picked. */
    assigneeMembershipId: char('assignee_membership_id', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_request_triage_org_id').on(table.organizationId, table.id),
    // The upsert key: one triage row per request per studio.
    uniqueIndex('uq_request_triage_org_request').on(table.organizationId, table.requestId),
    index('ix_request_triage_org_assignee').on(
      table.organizationId,
      table.assigneeMembershipId,
      table.requestId,
    ),
  ],
);

export type RequestTriageRow = typeof requestTriage.$inferSelect;
export type NewRequestTriageRow = typeof requestTriage.$inferInsert;

/**
 * Home quick links (x273, migration 0143, module 4 Home / My Day).
 *
 * A member's own small, ordered list of personal shortcuts on My Day — each a human `label` and a
 * relative in-app `path`. Keyed by `(organization_id, id)` and scoped to `membership_id` (like
 * `home_pinned_items` and `home_widget_prefs`) rather than the global user, because a quick link is
 * scoped to who the caller is *in this studio* and never leaves the tenant. `position` gives the
 * member's chosen order — a dense `0..n-1` sequence reassigned on reorder — with `created_at`
 * breaking ties. The application validates `path` is a leading-slash, scheme-less, same-origin path
 * (an open-redirect guard) and `label` is non-empty before storing, and caps the count; a malformed
 * body is a 400 and nothing is written.
 */
export const homeQuickLinks = mysqlTable(
  'home_quick_links',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    label: varchar('label', { length: 200 }).notNull(),
    path: varchar('path', { length: 512 }).notNull(),
    position: int('position', { unsigned: true }).notNull().default(0),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_home_quick_links_org_id').on(table.organizationId, table.id),
    // The listing/order index: one member's links in position order, id breaking ties.
    index('ix_home_quick_links_org_membership').on(
      table.organizationId,
      table.membershipId,
      table.position,
      table.id,
    ),
  ],
);

export type HomeQuickLinkRow = typeof homeQuickLinks.$inferSelect;

/**
 * Per-org optional-module feature flags (x278, migration 0147, module 18 Administration).
 *
 * One row per `(organization_id, flag_key)`: whether one optional module (a key from a fixed
 * application allowlist) is enabled for this studio, plus the membership that last changed it and
 * when. Tenant-owned and registered in the query guard's TENANT_TABLES. `flag_key` is validated
 * against the allowlist by the application before any write (a key off it is a 400, no upsert); the
 * read side resolves an absent row — and any unknown key — to the default (off), so "never set" and
 * "explicitly disabled" read alike. The write is a single upsert against
 * `uq_org_feature_flags_org_key`, so a second PUT for the same key updates in place; `updated_at`
 * follows the column's `ON UPDATE`.
 */
export const orgFeatureFlags = mysqlTable(
  'org_feature_flags',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    flagKey: varchar('flag_key', { length: 64 }).notNull(),
    enabled: boolean('enabled').notNull().default(false),
    updatedBy: char('updated_by', { length: 36 }),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_org_feature_flags_org_id').on(table.organizationId, table.id),
    // The upsert key: one row per flag per studio.
    uniqueIndex('uq_org_feature_flags_org_key').on(table.organizationId, table.flagKey),
  ],
);

export type OrgFeatureFlagRow = typeof orgFeatureFlags.$inferSelect;

/**
 * Audit-log retention policy (x279, migration 0148, Administration module 18).
 *
 * One row per organization (`uq_audit_retention_policy_org`): the number of days the org keeps its
 * `audit_events` before a later, separately-credentialed purge would remove them. This slice stores the
 * policy and previews how many rows fall outside the window; it never writes to `audit_events` (the
 * append-only table the runtime credential cannot amend). `retention_days` is bounded 1..3650 by the
 * application before any write — an out-of-range value is a 400 and nothing is stored. The write is a
 * single upsert against the per-organization unique key, so a re-save overwrites in place;
 * `updated_at` follows the column's `ON UPDATE`. `0148_audit_retention_policy.sql` is the source of
 * truth; this is its typed mirror.
 */
export const auditRetentionPolicy = mysqlTable(
  'audit_retention_policy',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    retentionDays: int('retention_days', { unsigned: true }).notNull(),
    // The membership's global user id that last set the policy — not tenant-owned, the same shape
    // `security_settings.updated_by` (0073) and `org_settings.updated_by` (0058) use for their actor.
    updatedBy: char('updated_by', { length: 36 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_audit_retention_policy_org_id').on(table.organizationId, table.id),
    // One row per organization. This is the upsert key: the repository writes
    // `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
    uniqueIndex('uq_audit_retention_policy_org').on(table.organizationId),
  ],
);

export type AuditRetentionPolicyRow = typeof auditRetentionPolicy.$inferSelect;

/**
 * PREF-DISPLAY (x285, module 20 Preferences & accessibility). The closed vocabularies a member's
 * display preferences draw from — each a fixed allowlist so a value the shell cannot render is a
 * validation error (`display-prefs.controller.ts`), never a stored state.
 *
 * `theme` is the app's colour mode and `density` the row spacing; `locale`, `timezone` and
 * `dateFormat` are small allowlists (a BCP-47 locale set, an IANA timezone set, and named date
 * layouts) rather than free text, so a row can only ever hold a value the UI knows how to apply.
 */
export const DISPLAY_THEMES = ['light', 'dark', 'system'] as const;
export type DisplayTheme = (typeof DISPLAY_THEMES)[number];
export const DISPLAY_DENSITIES = ['comfortable', 'compact'] as const;
export type DisplayDensity = (typeof DISPLAY_DENSITIES)[number];
export const DISPLAY_LOCALES = [
  'en-US',
  'en-GB',
  'fr-FR',
  'de-DE',
  'es-ES',
  'pt-BR',
  'ja-JP',
  'zh-CN',
  // The one right-to-left locale (02-UX-UI §Localization, 42-...-AND-RTL). The web allowlist in
  // `apps/web/src/lib/api/display-preferences.ts` mirrors this set exactly; the `locale` column
  // is `varchar(35)`, so no stored value or migration constrains it beyond this allowlist.
  'ar-EG',
] as const;
export type DisplayLocale = (typeof DISPLAY_LOCALES)[number];
/** Any IANA time zone (R9: every country), checked with `isIanaTimeZone`; `UTC` is the default. */
export type DisplayTimezone = string;
export const DISPLAY_DATE_FORMATS = ['iso', 'us', 'eu', 'long'] as const;
export type DisplayDateFormat = (typeof DISPLAY_DATE_FORMATS)[number];

/**
 * The display settings one member keeps in one studio, stored whole in
 * `user_display_preferences.display_json`. The typed shape of that JSON column; the application
 * validates a request against the closed vocabularies above before storing (the same division
 * `a11y_preferences.a11y_json` takes).
 */
export interface DisplayPreferences {
  readonly theme: DisplayTheme;
  readonly density: DisplayDensity;
  readonly locale: DisplayLocale;
  readonly timezone: DisplayTimezone;
  readonly dateFormat: DisplayDateFormat;
  /** 55-07 (R18-d). Optional: rows saved before 55-07 lack it and read as `'latin'`. */
  readonly numerals?: 'latin' | 'arabic_indic';
  /** 55-07 (R18-d). Display-only Hijri beside Gregorian; absent reads as `'gregorian'`. */
  readonly calendarDisplay?: 'gregorian' | 'gregorian_hijri';
  /**
   * 55-04 (R20-c). The member's own Simple/Power shell mode. Absent = inherit the org's
   * `default_ui_mode` setting — the effective mode is computed on read, never stored as a default.
   */
  readonly uiMode?: 'simple' | 'power';
}

/**
 * PREF-DISPLAY (x285, migration 0154, module 20 Preferences & accessibility). A member's own
 * unified display preferences — theme, density, locale, timezone and date format — one row per
 * `(organization_id, membership_id)`. Keyed by membership (like `a11y_preferences`) rather than the
 * global user, because it is scoped to who the caller is *in this studio* and never leaves the
 * tenant. `display_json` holds the whole {@link DisplayPreferences} object, read and written as one,
 * never queried across rows. The write is a single upsert against
 * `uq_user_display_preferences_org_membership`, so a second save updates in place; `updated_at`
 * follows the column's `ON UPDATE`. Distinct from `a11y_preferences` (0079) and the notification
 * digest (0117). Absence of a row is the shipped defaults, not an error.
 */
export const userDisplayPreferences = mysqlTable(
  'user_display_preferences',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    displayJson: json('display_json').$type<DisplayPreferences>().notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_user_display_preferences_org_id').on(table.organizationId, table.id),
    // The upsert key: one row per member per studio.
    uniqueIndex('uq_user_display_preferences_org_membership').on(
      table.organizationId,
      table.membershipId,
    ),
  ],
);

export type UserDisplayPreferenceRow = typeof userDisplayPreferences.$inferSelect;

/**
 * x292. Reusable work-item checklist templates (Work module 7). An org-scoped definition: a name
 * and an ordered list of checklist item labels a member defines once, then applies to a work item
 * to seed that item's checklist (`work_item_checklist_items`, 0051). `name` is unique per tenant
 * (`uq_work_checklist_templates_org_name`) so a duplicate define is a 409; `labels_json` holds the
 * ordered label array whole, validated and bounded by the application before the write (the same
 * division `saved_searches.filters` takes). `organization_id` is pinned immutable by the migration's
 * `BEFORE UPDATE` trigger — migration `0159_work_checklist_templates.sql`.
 */
export const workChecklistTemplates = mysqlTable(
  'work_checklist_templates',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    labelsJson: json('labels_json').$type<string[]>().notNull(),
    createdBy: char('created_by', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_work_checklist_templates_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_work_checklist_templates_org_name').on(table.organizationId, table.name),
    index('ix_work_checklist_templates_org').on(table.organizationId, table.name, table.id),
  ],
);

export type WorkChecklistTemplateRow = typeof workChecklistTemplates.$inferSelect;
export type NewWorkChecklistTemplateRow = typeof workChecklistTemplates.$inferInsert;

/**
 * INBOX-001 per-user routing rules (x301, migration 0169, module Inbox). The notification field a
 * rule matches on: `type` is the event type (`notifications.type`, e.g. `client_request.transitioned.v1`),
 * `object_type` is what the notification is about (`notifications.object_type`, e.g. `work_item`). A
 * request naming a match type outside this set is a validation error (400, `rules.controller.ts`),
 * never stored.
 */
export const INBOX_RULE_MATCH_TYPES = ['type', 'object_type'] as const;
export type InboxRuleMatchType = (typeof INBOX_RULE_MATCH_TYPES)[number];

/**
 * INBOX-001 the closed vocabulary of category labels a rule may apply (x301). Read-side only: the
 * resolve helper returns the first-matching category for a candidate; nothing is written back to the
 * notification. A request naming a category outside this set is a validation error (400), never stored.
 */
export const INBOX_RULE_CATEGORIES = ['urgent', 'follow_up', 'waiting', 'fyi', 'archive'] as const;
export type InboxRuleCategory = (typeof INBOX_RULE_CATEGORIES)[number];

/**
 * INBOX-001 per-user inbox routing rules (x301, migration 0169, module Inbox).
 *
 * One row is one member's ordered rule in one studio: when a candidate notification's `match_type`
 * field equals `match_value`, apply `category`. Keyed by `membership_id` (like `home_widget_prefs`
 * and `notification_kind_prefs`) rather than the global user, because a rule is scoped to who the
 * caller is *in this studio* and never leaves the tenant; the composite FK binds the row to a
 * membership of this same organization. Rules are applied read-side by the resolve helper and never
 * write to `notifications`. `position` orders a member's rules (lowest first); `match_type` and
 * `category` are each a closed enum validated in the controller. `0169_inbox_rules.sql` is the
 * source of truth; this is its typed mirror.
 */
export const inboxRules = mysqlTable(
  'inbox_rules',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    matchType: mysqlEnum('match_type', INBOX_RULE_MATCH_TYPES).notNull(),
    matchValue: varchar('match_value', { length: 190 }).notNull(),
    category: mysqlEnum('category', INBOX_RULE_CATEGORIES).notNull(),
    position: int('position', { unsigned: true }).notNull().default(0),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_inbox_rules_org_id').on(table.organizationId, table.id),
    // A member's rules are read in one ordered list; this is the index that read is served by.
    index('ix_inbox_rules_org_membership_position').on(
      table.organizationId,
      table.membershipId,
      table.position,
    ),
  ],
);

export type InboxRuleRow = typeof inboxRules.$inferSelect;

/**
 * The fixed, closed vocabulary of insight-dashboard metric tiles — the metric surfaces the Insights
 * dashboard actually renders (the portfolio roll-up, delivery-flow, approval-cycle, workload,
 * workload forecast, adoption, snapshots and saved views). Every tile key in a saved layout is
 * validated against this set (`dashboard-layout.controller.ts`); a key outside it is a validation
 * error (400), never stored. Adding a metric tile to the dashboard means adding its key here.
 */
export const INSIGHT_METRIC_KEYS = [
  'portfolio',
  'deliveryFlow',
  'approvalCycle',
  'workload',
  'workloadForecast',
  'adoption',
  'snapshots',
  'savedViews',
] as const;
export type InsightMetricKey = (typeof INSIGHT_METRIC_KEYS)[number];

/**
 * One tile in a member's insight-dashboard layout: which metric it is, where it sits, and whether it
 * is shown. The typed element of `insight_dashboard_layouts.tiles_json`; the application validates a
 * request against {@link INSIGHT_METRIC_KEYS} before storing (the same division
 * `home_widget_prefs.widget_order_json` and `a11y_preferences.a11y_json` take).
 */
export interface InsightDashboardTile {
  readonly key: InsightMetricKey;
  readonly position: number;
  readonly visible: boolean;
}

/**
 * Per-user insight dashboard layout (x302, migration 0170, module 16 Insights).
 *
 * One row per `(organization_id, membership_id)`: the metric tiles the acting member wants on the
 * insights dashboard, in what order, and which are hidden. Keyed by membership (like
 * `home_widget_prefs` and `a11y_preferences`) rather than the global user, because the layout is
 * scoped to who the caller is *in this studio* and never leaves the tenant. `tiles_json` holds the
 * list whole; it is read and written as one, never queried across rows. The write is a single upsert
 * against `uq_insight_dashboard_layouts_org_membership`, so a second save updates in place;
 * `updated_at` follows the column's `ON UPDATE`. Absence is the default layout, not an error — the
 * read returns the shipped default when no row exists.
 */
export const insightDashboardLayouts = mysqlTable(
  'insight_dashboard_layouts',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    tilesJson: json('tiles_json').$type<InsightDashboardTile[]>().notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_insight_dashboard_layouts_org_id').on(table.organizationId, table.id),
    // The upsert key: one row per member.
    uniqueIndex('uq_insight_dashboard_layouts_org_membership').on(
      table.organizationId,
      table.membershipId,
    ),
  ],
);

export type InsightDashboardLayoutRow = typeof insightDashboardLayouts.$inferSelect;

/**
 * The fixed set of insight metric ids a member may star (INS metric favorites, x303). A small, closed
 * vocabulary — the known insight numbers the Insights screens render as tiles. Every `metricKey` a
 * member stars is validated against this set (`metric-favorites.controller.ts`); a key outside it is a
 * 400, never stored. Adding a starrable metric means adding its id here. Distinct from x302's
 * dashboard layout, which orders the whole tile set: this is the subset a member pins to the top.
 */
export const INSIGHT_FAVORITE_METRIC_KEYS = [
  'portfolio.projectCount',
  'portfolio.openItemCount',
  'deliveryFlow.itemCount',
  'approvalCycle.approvalCount',
  'workload.assigneeCount',
  'workload.openItemCount',
  'workload.scheduledItemCount',
  'adoption.activeMembers',
] as const;
export type InsightFavoriteMetricKey = (typeof INSIGHT_FAVORITE_METRIC_KEYS)[number];

/**
 * Per-user favorite insight metrics (x303, migration 0171, module 15 Insights).
 *
 * One row per `(organization_id, membership_id, metric_key)`: the fact "this membership starred this
 * metric". Keyed by membership (like `doc_bookmarks` and `home_widget_prefs`) rather than the global
 * user, because a favorite is scoped to who the caller is *in this studio* and never leaves the
 * tenant. The only writes are INSERT (star) and DELETE (unstar) — there is no UPDATE path and no
 * UPDATE grant, so the withheld privilege is the control and no immutability trigger is needed.
 * `uq_insight_metric_favorites_star` makes a repeated star a collision the service treats as success,
 * so a repeated PUT is idempotent. `metric_key` is validated against {@link INSIGHT_FAVORITE_METRIC_KEYS} by
 * the application before the insert; the column stores it whole. `0171_insight_metric_favorites.sql`
 * is the source of truth; this is its typed mirror.
 */
export const insightMetricFavorites = mysqlTable(
  'insight_metric_favorites',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    metricKey: varchar('metric_key', { length: 64 }).$type<InsightFavoriteMetricKey>().notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_insight_metric_favorites_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_insight_metric_favorites_star').on(
      table.organizationId,
      table.membershipId,
      table.metricKey,
    ),
    index('ix_insight_metric_favorites_org_membership').on(
      table.organizationId,
      table.membershipId,
      table.createdAt,
      table.id,
    ),
  ],
);

export type InsightMetricFavoriteRow = typeof insightMetricFavorites.$inferSelect;
export type NewInsightMetricFavoriteRow = typeof insightMetricFavorites.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// Google Drive as company storage (0210)
// ─────────────────────────────────────────────────────────────────────────────
// All three tables are tenant-owned (TENANT_TABLES). The refresh token is stored only as an
// AES-256-GCM envelope (`refresh_token_enc`), never plaintext; a disconnect wipes it.

/** Which storage an organization uses, and its Google Drive connection when there is one. */
export const storageConnections = mysqlTable(
  'storage_connections',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    /** `google_drive` or `onedrive` (0236). */
    provider: varchar('provider', { length: 32 }).notNull(),
    /** `tmanage`, or the row's own provider when it is the company's storage (one per org). */
    storageMode: varchar('storage_mode', { length: 32 }).notNull().default('tmanage'),
    /** `connected`, `error` or `disconnected`. */
    status: varchar('status', { length: 32 }).notNull(),
    accountEmail: varchar('account_email', { length: 320 }),
    /** The encrypted refresh token envelope; NULL once disconnected. */
    refreshTokenEnc: text('refresh_token_enc'),
    rootFolderId: varchar('root_folder_id', { length: 128 }),
    sharedDriveId: varchar('shared_drive_id', { length: 128 }),
    sharedDriveName: varchar('shared_drive_name', { length: 190 }),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    /** 0236. OneDrive rows: the Graph drive of the chosen root, and its label. NULL for Google. */
    onedriveDriveId: varchar('onedrive_drive_id', { length: 128 }),
    onedriveDriveName: varchar('onedrive_drive_name', { length: 190 }),
    /** 0236. The scopes the grant holds (OneDrive: whether SharePoint libraries were consented). */
    grantedScopes: varchar('granted_scopes', { length: 512 }),
    /**
     * 0238. Google rows: the name of the place the `TManage/` root sits in — the picked folder, or
     * `My Drive`. NULL for rows saved before 0238 and for OneDrive (it uses `onedriveDriveName`).
     */
    locationName: varchar('location_name', { length: 190 }),
    connectedByUserId: char('connected_by_user_id', { length: 36 }),
    connectedAt: datetime('connected_at', { mode: 'date', fsp: 3 }),
    disconnectedAt: datetime('disconnected_at', { mode: 'date', fsp: 3 }),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_storage_connections_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_storage_connections_provider').on(table.organizationId, table.provider),
  ],
);

/** A Drive folder TManage created for a project or a work item under one `TManage/` root. */
export const googleDriveFolders = mysqlTable(
  'google_drive_folders',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    rootFolderId: varchar('root_folder_id', { length: 128 }).notNull(),
    /** `project` or `work_item`. */
    subjectKind: varchar('subject_kind', { length: 16 }).notNull(),
    subjectId: char('subject_id', { length: 36 }).notNull(),
    driveFolderId: varchar('drive_folder_id', { length: 128 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_google_drive_folders_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_google_drive_folders_subject').on(
      table.organizationId,
      table.rootFolderId,
      table.subjectKind,
      table.subjectId,
    ),
  ],
);

/** A Google Drive file attached to a work item. Detach is soft (`removed_at`). */
export const googleDriveAttachments = mysqlTable(
  'google_drive_attachments',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    driveFileId: varchar('drive_file_id', { length: 128 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 190 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    webViewLink: varchar('web_view_link', { length: 512 }),
    attachedByUserId: char('attached_by_user_id', { length: 36 }).notNull(),
    removedAt: datetime('removed_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_google_drive_attachments_org_id').on(table.organizationId, table.id),
    index('ix_google_drive_attachments_item').on(table.organizationId, table.workItemId, table.id),
  ],
);

export type StorageConnectionRow = typeof storageConnections.$inferSelect;
export type GoogleDriveFolderRow = typeof googleDriveFolders.$inferSelect;
export type GoogleDriveAttachmentRow = typeof googleDriveAttachments.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// OneDrive as company storage (0236)
// ─────────────────────────────────────────────────────────────────────────────
// Both tables are tenant-owned (TENANT_TABLES). Graph addresses an item by (drive id, item id).
// The connection itself is a `storage_connections` row with `provider = 'onedrive'`.

/** A OneDrive folder TManage created for a project or a work item under one `TManage/` root. */
export const onedriveFolders = mysqlTable(
  'onedrive_folders',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    driveId: varchar('drive_id', { length: 128 }).notNull(),
    rootItemId: varchar('root_item_id', { length: 255 }).notNull(),
    /** `project` or `work_item`. */
    subjectKind: varchar('subject_kind', { length: 16 }).notNull(),
    subjectId: char('subject_id', { length: 36 }).notNull(),
    itemId: varchar('item_id', { length: 255 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_onedrive_folders_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_onedrive_folders_subject').on(
      table.organizationId,
      table.rootItemId,
      table.subjectKind,
      table.subjectId,
    ),
  ],
);

/** A OneDrive file attached to a work item. Detach is soft (`removed_at`). */
export const onedriveAttachments = mysqlTable(
  'onedrive_attachments',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    driveId: varchar('drive_id', { length: 128 }).notNull(),
    itemId: varchar('item_id', { length: 255 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 190 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    webUrl: varchar('web_url', { length: 512 }),
    attachedByUserId: char('attached_by_user_id', { length: 36 }).notNull(),
    removedAt: datetime('removed_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_onedrive_attachments_org_id').on(table.organizationId, table.id),
    index('ix_onedrive_attachments_item').on(table.organizationId, table.workItemId, table.id),
  ],
);

export type OneDriveFolderRow = typeof onedriveFolders.$inferSelect;
export type OneDriveAttachmentRow = typeof onedriveAttachments.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Meetings connected to a person's own calendar (0237)
// ─────────────────────────────────────────────────────────────────────────────
// All four tables are tenant-owned (TENANT_TABLES). A calendar connection is ONE PERSON's link to
// their own Google or Microsoft calendar, never the company Drive connection.

export const calendarConnections = mysqlTable(
  'calendar_connections',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    userId: char('user_id', { length: 36 }).notNull(),
    /** `google` or `microsoft`. */
    provider: varchar('provider', { length: 16 }).notNull(),
    /** `connected`, `error` or `disconnected`. */
    status: varchar('status', { length: 16 }).notNull(),
    accountEmail: varchar('account_email', { length: 254 }),
    refreshTokenEnc: text('refresh_token_enc'),
    grantedScopes: varchar('granted_scopes', { length: 512 }),
    calendarId: varchar('calendar_id', { length: 255 }).notNull().default('primary'),
    syncCursor: varchar('sync_cursor', { length: 2048 }),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    lastSyncedAt: datetime('last_synced_at', { mode: 'date', fsp: 3 }),
    connectedAt: datetime('connected_at', { mode: 'date', fsp: 3 }),
    disconnectedAt: datetime('disconnected_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_calendar_connections_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_calendar_connections_person').on(
      table.organizationId,
      table.userId,
      table.provider,
    ),
    index('ix_calendar_connections_status').on(table.status, table.provider),
  ],
);

/** Which provider event a meeting is, in its organizer's calendar (one row per provider). */
export const meetingExternalEvents = mysqlTable(
  'meeting_external_events',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    meetingId: char('meeting_id', { length: 36 }).notNull(),
    connectionId: char('connection_id', { length: 36 }).notNull(),
    provider: varchar('provider', { length: 16 }).notNull(),
    externalEventId: varchar('external_event_id', { length: 255 }),
    externalCalendarId: varchar('external_calendar_id', { length: 255 }),
    icalUid: varchar('ical_uid', { length: 255 }),
    joinUrl: varchar('join_url', { length: 1024 }),
    htmlLink: varchar('html_link', { length: 1024 }),
    externalVersion: varchar('external_version', { length: 255 }),
    /** `pending`, `synced`, `error` or `deleted`. */
    syncStatus: varchar('sync_status', { length: 16 }).notNull().default('pending'),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    lastPushedAt: datetime('last_pushed_at', { mode: 'date', fsp: 3 }),
    lastPulledAt: datetime('last_pulled_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_meeting_external_events_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_meeting_external_events_meeting').on(
      table.organizationId,
      table.meetingId,
      table.provider,
    ),
    index('ix_meeting_external_events_event').on(
      table.organizationId,
      table.connectionId,
      table.externalEventId,
    ),
  ],
);

/** Someone invited to a meeting by email who is not a TManage user. */
export const meetingGuests = mysqlTable(
  'meeting_guests',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    meetingId: char('meeting_id', { length: 36 }).notNull(),
    email: varchar('email', { length: 254 }).notNull(),
    displayName: varchar('display_name', { length: 190 }),
    optional: boolean('optional').notNull().default(false),
    /** `invited`, `accepted`, `declined` or `tentative`. */
    rsvp: varchar('rsvp', { length: 16 }).notNull().default('invited'),
    comment: varchar('comment', { length: 512 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_meeting_guests_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_meeting_guests_email').on(table.organizationId, table.meetingId, table.email),
  ],
);

/** A Drive or OneDrive file attached to a meeting. Removal is soft (`removed_at`). */
export const meetingAttachments = mysqlTable(
  'meeting_attachments',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    meetingId: char('meeting_id', { length: 36 }).notNull(),
    /** `google_drive` or `onedrive`. */
    provider: varchar('provider', { length: 16 }).notNull(),
    fileId: varchar('file_id', { length: 255 }).notNull(),
    driveId: varchar('drive_id', { length: 128 }),
    title: varchar('title', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 190 }).notNull(),
    webUrl: varchar('web_url', { length: 1024 }),
    attachedByUserId: char('attached_by_user_id', { length: 36 }).notNull(),
    removedAt: datetime('removed_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    // ---- platform-admin v2 · PA-03 ---- 0245: soft delete + restore window (SPEC P7).
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    deletedReason: varchar('deleted_reason', { length: 500 }),
    purgeAfter: datetime('purge_after', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_meeting_attachments_org_id').on(table.organizationId, table.id),
    index('ix_meeting_attachments_meeting').on(table.organizationId, table.meetingId, table.id),
  ],
);

export type CalendarConnectionRow = typeof calendarConnections.$inferSelect;
export type MeetingExternalEventRow = typeof meetingExternalEvents.$inferSelect;
export type MeetingGuestRow = typeof meetingGuests.$inferSelect;
export type MeetingAttachmentRow = typeof meetingAttachments.$inferSelect;

export const TABLES = {
  focus_blocks: focusBlocks,
  inbox_flags: inboxFlags,
  request_triage: requestTriage,
  home_quick_links: homeQuickLinks,
  org_announcements: orgAnnouncements,
  org_feature_flags: orgFeatureFlags,
  audit_retention_policy: auditRetentionPolicy,
  work_checklist_templates: workChecklistTemplates,
  request_comments: requestComments,
  request_messages: requestMessages,
  request_message_files: requestMessageFiles,
  approval_delegations: approvalDelegations,
  inbox_rules: inboxRules,
  insight_dashboard_layouts: insightDashboardLayouts,
  person_time_off: personTimeOff,
  home_widget_prefs: homeWidgetPrefs,
  inbox_saved_filters: inboxSavedFilters,
  glossary_terms: glossaryTerms,
  doc_bookmarks: docBookmarks,
  doc_subscriptions: docSubscriptions,
  work_item_recurrence: workItemRecurrence,
  member_teams: memberTeams,
  doc_collections: docCollections,
  project_tags: projectTags,
  project_favorites: projectFavorites,
  doc_tags: docTags,
  doc_links: docLinks,
  doc_read_state: docReadState,
  insight_metric_favorites: insightMetricFavorites,
  work_board_columns: workBoardColumns,
  work_item_labels: workItemLabels,
  file_tags: fileTags,
  work_item_custom_fields: workItemCustomFields,
  file_folders: fileFolders,
  file_comments: fileComments,
  work_item_watchers: workItemWatchers,
  conversation_read_state: conversationReadState,
  user_presence: userPresence,
  link_previews: linkPreviews,
  users,
  sessions,
  session_refresh_tokens: sessionRefreshTokens,
  personal_access_tokens: personalAccessTokens,
  oauth_clients: oauthClients,
  oauth_grants: oauthGrants,
  oauth_codes: oauthCodes,
  oauth_access_tokens: oauthAccessTokens,
  oauth_refresh_tokens: oauthRefreshTokens,
  pending_ai_actions: pendingAiActions,
  organizations,
  memberships,
  workspaces,
  projects,
  project_memberships: projectMemberships,
  client_organizations: clientOrganizations,
  client_memberships: clientMemberships,
  invitations: invitations,
  invitation_projects: invitationProjects,
  project_clients: projectClients,
  work_items: workItems,
  work_item_dependencies: workItemDependencies,
  work_item_checklist_items: workItemChecklistItems,
  work_item_subtasks: workItemSubtasks,
  work_item_comments: workItemComments,
  work_item_time_logs: workItemTimeLogs,
  work_item_estimates: workItemEstimates,
  work_item_links: workItemLinks,
  work_blockers: workBlockers,
  client_requests: clientRequests,
  request_tags: requestTags,
  deliverables,
  deliverable_versions: deliverableVersions,
  approvals,
  approval_steps: approvalSteps,
  approval_reviewer_decisions: approvalReviewerDecisions,
  client_projections: clientProjections,
  portal_feedback: portalFeedback,
  conversations,
  conversation_memberships: conversationMemberships,
  conversation_pinned_messages: conversationPinnedMessages,
  messages,
  message_revisions: messageRevisions,
  message_work_links: messageWorkLinks,
  message_reactions: messageReactions,
  message_bookmarks: messageBookmarks,
  conversation_thread_replies: conversationThreadReplies,
  conversation_message_drafts: conversationMessageDrafts,
  conversation_mutes: conversationMutes,
  direct_conversations: directConversations,
  direct_messages: directMessages,
  message_attachments: messageAttachments,
  outbox_events: outboxEvents,
  idempotency_records: idempotencyRecords,
  audit_events: auditEvents,
  notifications,
  notification_preferences: notificationPreferences,
  a11y_preferences: a11yPreferences,
  pref_quiet_hours: quietHours,
  pref_digest: digestPreferences,
  user_shortcut_prefs: userShortcutPrefs,
  user_startup_prefs: userStartupPrefs,
  usage_counters: usageCounters,
  usage_ledger_entries: usageLedgerEntries,
  file_assets: fileAssets,
  file_versions: fileVersions,
  attachment_versions: attachmentVersions,
  file_previews: filePreviews,
  review_threads: reviewThreads,
  review_comments: reviewComments,
  file_review_decisions: fileReviewDecisions,
  figma_connections: figmaConnections,
  figma_links: figmaLinks,
  figma_frames: figmaFrames,
  upload_sessions: uploadSessions,
  user_passwords: userPasswords,
  password_reset_tokens: passwordResetTokens,
  user_identities: userIdentities,
  platform_admin_step_ups: platformAdminStepUps,
  platform_admin_audit_events: platformAdminAuditEvents,
  platform_settings: platformSettings,
  user_mfa_factors: userMfaFactors,
  user_recovery_codes: userRecoveryCodes,
  authentication_events: authenticationEvents,
  credential_change_notices: credentialChangeNotices,
  import_jobs: importJobs,
  meetings,
  documents,
  document_versions: documentVersions,
  doc_revisions: docRevisions,
  document_comments: documentComments,
  doc_reviews: docReviews,
  decisions,
  decision_supersessions: decisionSupersessions,
  decision_work_links: decisionWorkLinks,
  decision_locks: decisionLocks,
  decision_comments: decisionComments,
  document_templates: documentTemplates,
  project_objectives: projectObjectives,
  project_internal_risks: projectInternalRisks,
  project_templates: projectTemplates,
  project_status_updates: projectStatusUpdates,
  project_budgets: projectBudgets,
  project_phases: projectPhases,
  project_baselines: projectBaselines,
  project_custom_fields: projectCustomFields,
  project_retro_notes: projectRetroNotes,
  document_template_variables: documentTemplateVariables,
  org_objectives: orgObjectives,
  objective_work_links: objectiveWorkLinks,
  objective_key_results: objectiveKeyResults,
  import_rows: importRows,
  meeting_notes: meetingNotes,
  meeting_attendees: meetingAttendees,
  meeting_client_attendees: meetingClientAttendees,
  meeting_rsvps: meetingRsvps,
  meeting_action_items: meetingActionItems,
  meeting_time_polls: meetingTimePolls,
  meeting_time_poll_votes: meetingTimePollVotes,
  meeting_series: meetingSeries,
  meeting_occurrence_overrides: meetingOccurrenceOverrides,
  meeting_agenda_templates: meetingAgendaTemplates,
  saved_views: savedViews,
  saved_searches: savedSearches,
  saved_search_shares: savedSearchShares,
  search_history: searchHistory,
  search_pins: searchPins,
  search_scopes: searchScopes,
  saved_context: savedContext,
  project_updates: projectUpdates,
  project_update_comments: projectUpdateComments,
  portal_announcements: portalAnnouncements,
  portal_client_messages: portalClientMessages,
  project_milestones: projectMilestones,
  milestone_links: milestoneLinks,
  project_dependencies: projectDependencies,
  project_risks: projectRisks,
  portal_access_log: portalAccessLog,
  home_pinned_items: homePinnedItems,
  home_recent_items: homeRecentItems,
  inbox_snoozes: inboxSnoozes,
  inbox_source_mutes: inboxSourceMutes,
  work_forms: workForms,
  form_submissions: formSubmissions,
  search_index: searchIndex,
  notification_kind_prefs: notificationKindPrefs,
  org_settings: orgSettings,
  org_policies: orgPolicies,
  security_settings: securitySettings,
  org_ip_allowlist: orgIpAllowlist,
  admin_security_alerts: adminSecurityAlerts,
  onboarding_progress: onboardingProgress,
  incidents,
  changelog_entries: changelogEntries,
  marketing_leads: marketingLeads,
  workflow_templates: workflowTemplates,
  workflow_runs: workflowRuns,
  integration_connections: integrationConnections,
  webhook_endpoints: webhookEndpoints,
  webhook_deliveries: webhookDeliveries,
  automation_schedules: automationSchedules,
  maintenance_windows: maintenanceWindows,
  workflow_conditions: workflowConditions,
  automation_variables: automationVariables,
  automation_template_tags: automationTemplateTags,
  workflow_due_soon_fires: workflowDueSoonFires,
  privacy_exports: privacyExports,
  privacy_deletion_requests: privacyDeletionRequests,
  person_allocations: personAllocations,
  person_capacity: personCapacity,
  member_reporting_lines: memberReportingLines,
  member_availability: memberAvailability,
  person_skills: personSkills,
  person_certifications: personCertifications,
  custom_roles: customRoles,
  member_admin_notes: memberAdminNotes,
  subscriptions,
  billing_profiles: billingProfiles,
  billing_contacts: billingContacts,
  billing_tax_details: billingTaxDetails,
  billing_usage_alerts: billingUsageAlerts,
  billing_credits: billingCredits,
  billing_cost_centers: billingCostCenters,
  billing_purchase_orders: billingPurchaseOrders,
  billing_plan_change_requests: billingPlanChangeRequests,
  billing_discounts: billingDiscounts,
  work_item_files: workItemFiles,
  work_item_reminders: workItemReminders,
  insight_saved_views: insightSavedViews,
  insight_snapshots: insightSnapshots,
  insight_report_schedules: insightReportSchedules,
  insight_annotations: insightAnnotations,
  billing_seats: billingSeats,
  invoices: invoices,
  user_preferences: userPreferences,
  member_profiles: memberProfiles,
  admin_export_requests: adminExportRequests,
  invoice_line_items: invoiceLineItems,
  insight_targets: insightTargets,
  insight_metric_alerts: insightMetricAlerts,
  insight_custom_reports: insightCustomReports,
  portal_settings: portalSettings,
  user_display_preferences: userDisplayPreferences,
  portal_branding: portalBranding,
  org_branding: orgBranding,
  // C6 (0229): the company logo, organization-scoped.
  organization_logos: organizationLogos,
  storage_connections: storageConnections,
  google_drive_folders: googleDriveFolders,
  google_drive_attachments: googleDriveAttachments,
  onedrive_folders: onedriveFolders,
  onedrive_attachments: onedriveAttachments,
  calendar_connections: calendarConnections,
  meeting_external_events: meetingExternalEvents,
  meeting_guests: meetingGuests,
  meeting_attachments: meetingAttachments,
} as const;

export type SessionRow = typeof sessions.$inferSelect;
export type SessionRefreshTokenRow = typeof sessionRefreshTokens.$inferSelect;
export type PersonalAccessTokenRow = typeof personalAccessTokens.$inferSelect;
export type OauthClientRow = typeof oauthClients.$inferSelect;
export type OauthGrantRow = typeof oauthGrants.$inferSelect;
export type OauthCodeRow = typeof oauthCodes.$inferSelect;
export type OauthAccessTokenRow = typeof oauthAccessTokens.$inferSelect;
export type OauthRefreshTokenRow = typeof oauthRefreshTokens.$inferSelect;
export type PendingAiActionRow = typeof pendingAiActions.$inferSelect;
export type OrganizationRow = typeof organizations.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
/**
 * A6 (0219): `description` is optional in the row type only, so the hand-built test rows that
 * predate the column keep compiling; a row read from the database always carries it.
 */
export type WorkItemRow = Omit<typeof workItems.$inferSelect, 'description'> & {
  description?: string | null;
};
export type NewWorkItemRow = typeof workItems.$inferInsert;
export type WorkItemChecklistItemRow = typeof workItemChecklistItems.$inferSelect;
export type NewWorkItemChecklistItemRow = typeof workItemChecklistItems.$inferInsert;
export type WorkItemSubtaskRow = typeof workItemSubtasks.$inferSelect;
export type NewWorkItemSubtaskRow = typeof workItemSubtasks.$inferInsert;
export type WorkItemTimeLogRow = typeof workItemTimeLogs.$inferSelect;
export type NewWorkItemTimeLogRow = typeof workItemTimeLogs.$inferInsert;
export type WorkItemEstimateRow = typeof workItemEstimates.$inferSelect;
export type NewWorkItemEstimateRow = typeof workItemEstimates.$inferInsert;
export type WorkItemCommentRow = typeof workItemComments.$inferSelect;
export type NewWorkItemCommentRow = typeof workItemComments.$inferInsert;
export type RequestCommentRow = typeof requestComments.$inferSelect;
export type NewRequestCommentRow = typeof requestComments.$inferInsert;
export type RequestMessageRow = typeof requestMessages.$inferSelect;
export type NewRequestMessageRow = typeof requestMessages.$inferInsert;
export type RequestMessageFileRow = typeof requestMessageFiles.$inferSelect;
export type WorkItemLinkRow = typeof workItemLinks.$inferSelect;
export type NewWorkItemLinkRow = typeof workItemLinks.$inferInsert;
export type WorkItemFileRow = typeof workItemFiles.$inferSelect;
export type NewWorkItemFileRow = typeof workItemFiles.$inferInsert;
export type ClientRequestRow = typeof clientRequests.$inferSelect;
export type DeliverableRow = typeof deliverables.$inferSelect;
export type DeliverableVersionRow = typeof deliverableVersions.$inferSelect;
export type NewDeliverableVersionRow = typeof deliverableVersions.$inferInsert;
export type ApprovalRow = typeof approvals.$inferSelect;
export type NewApprovalRow = typeof approvals.$inferInsert;
export type ApprovalStepRow = typeof approvalSteps.$inferSelect;
export type ApprovalReviewerDecisionRow = typeof approvalReviewerDecisions.$inferSelect;
export type ClientProjectionRow = typeof clientProjections.$inferSelect;
export type NewClientProjectionRow = typeof clientProjections.$inferInsert;
export type PortalFeedbackRow = typeof portalFeedback.$inferSelect;
export type NewPortalFeedbackRow = typeof portalFeedback.$inferInsert;
export type ConversationRow = typeof conversations.$inferSelect;
export type UserPresenceRow = typeof userPresence.$inferSelect;
export type LinkPreviewRow = typeof linkPreviews.$inferSelect;
export type ConversationMembershipRow = typeof conversationMemberships.$inferSelect;
export type ConversationPinnedMessageRow = typeof conversationPinnedMessages.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type MessageRevisionRow = typeof messageRevisions.$inferSelect;
export type MessageWorkLinkRow = typeof messageWorkLinks.$inferSelect;
export type MessageReactionRow = typeof messageReactions.$inferSelect;
export type MessageBookmarkRow = typeof messageBookmarks.$inferSelect;
export type ConversationThreadReplyRow = typeof conversationThreadReplies.$inferSelect;
export type NewConversationThreadReplyRow = typeof conversationThreadReplies.$inferInsert;
export type ConversationMessageDraftRow = typeof conversationMessageDrafts.$inferSelect;
export type NewConversationMessageDraftRow = typeof conversationMessageDrafts.$inferInsert;
export type MessageAttachmentRow = typeof messageAttachments.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;
export type ClientOrganizationRow = typeof clientOrganizations.$inferSelect;
export type ClientMembershipRow = typeof clientMemberships.$inferSelect;
export type ProjectClientRow = typeof projectClients.$inferSelect;
export type InvitationRow = typeof invitations.$inferSelect;
export type ProjectMembershipRow = typeof projectMemberships.$inferSelect;
export type MeetingRow = typeof meetings.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type ProjectUpdateRow = typeof projectUpdates.$inferSelect;
export type ProjectUpdateCommentRow = typeof projectUpdateComments.$inferSelect;
export type PortalAnnouncementRow = typeof portalAnnouncements.$inferSelect;
export type PortalClientMessageRow = typeof portalClientMessages.$inferSelect;
export type ProjectMilestoneRow = typeof projectMilestones.$inferSelect;
export type ProjectRiskRow = typeof projectRisks.$inferSelect;
export type PortalAccessLogRow = typeof portalAccessLog.$inferSelect;
export type MeetingNoteRow = typeof meetingNotes.$inferSelect;
export type MeetingAttendeeRow = typeof meetingAttendees.$inferSelect;
export type MeetingClientAttendeeRow = typeof meetingClientAttendees.$inferSelect;
export type MeetingRsvpRow = typeof meetingRsvps.$inferSelect;
export type MeetingActionItemRow = typeof meetingActionItems.$inferSelect;
export type MeetingTimePollRow = typeof meetingTimePolls.$inferSelect;
export type MeetingTimePollVoteRow = typeof meetingTimePollVotes.$inferSelect;
export type MeetingSeriesRow = typeof meetingSeries.$inferSelect;
export type MeetingOccurrenceOverrideRow = typeof meetingOccurrenceOverrides.$inferSelect;
export type MeetingAgendaTemplateRow = typeof meetingAgendaTemplates.$inferSelect;
export type SavedViewRow = typeof savedViews.$inferSelect;
export type SavedSearchRow = typeof savedSearches.$inferSelect;
export type SavedSearchShareRow = typeof savedSearchShares.$inferSelect;
export type SearchHistoryRow = typeof searchHistory.$inferSelect;
export type SearchPinRow = typeof searchPins.$inferSelect;
export type SearchScopeRow = typeof searchScopes.$inferSelect;
export type DocumentVersionRow = typeof documentVersions.$inferSelect;
export type NewDocumentVersionRow = typeof documentVersions.$inferInsert;
export type DocRevisionRow = typeof docRevisions.$inferSelect;
export type NewDocRevisionRow = typeof docRevisions.$inferInsert;
export type DocumentCommentRow = typeof documentComments.$inferSelect;
export type NewDocumentCommentRow = typeof documentComments.$inferInsert;
export type DocReviewRow = typeof docReviews.$inferSelect;
export type NewDocReviewRow = typeof docReviews.$inferInsert;
export type DecisionRow = typeof decisions.$inferSelect;
export type WorkFormRow = typeof workForms.$inferSelect;
export type FormSubmissionRow = typeof formSubmissions.$inferSelect;
export type WorkflowTemplateRow = typeof workflowTemplates.$inferSelect;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type IntegrationConnectionRow = typeof integrationConnections.$inferSelect;
export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;
export type WorkflowConditionRow = typeof workflowConditions.$inferSelect;
export type AutomationVariableRow = typeof automationVariables.$inferSelect;
export type AutomationTemplateTagRow = typeof automationTemplateTags.$inferSelect;
export type PersonCapacityRow = typeof personCapacity.$inferSelect;
export type MemberReportingLineRow = typeof memberReportingLines.$inferSelect;
export type MemberAvailabilityRow = typeof memberAvailability.$inferSelect;
export type PersonSkillRow = typeof personSkills.$inferSelect;
export type PersonCertificationRow = typeof personCertifications.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type BillingProfileRow = typeof billingProfiles.$inferSelect;
export type BillingContactRow = typeof billingContacts.$inferSelect;
export type BillingTaxDetailsRow = typeof billingTaxDetails.$inferSelect;
export type InvoiceRow = typeof invoices.$inferSelect;
export type InvoiceLineItemRow = typeof invoiceLineItems.$inferSelect;
export type DecisionSupersessionRow = typeof decisionSupersessions.$inferSelect;
export type DecisionWorkLinkRow = typeof decisionWorkLinks.$inferSelect;
export type DecisionLockRow = typeof decisionLocks.$inferSelect;
export type DecisionCommentRow = typeof decisionComments.$inferSelect;
export type NewDecisionCommentRow = typeof decisionComments.$inferInsert;
export type DocumentTemplateRow = typeof documentTemplates.$inferSelect;
export type AutomationScheduleRow = typeof automationSchedules.$inferSelect;
export type BillingUsageAlertRow = typeof billingUsageAlerts.$inferSelect;
export type BillingCreditRow = typeof billingCredits.$inferSelect;
export type BillingCostCenterRow = typeof billingCostCenters.$inferSelect;
export type BillingPurchaseOrderRow = typeof billingPurchaseOrders.$inferSelect;
export type BillingPlanChangeRequestRow = typeof billingPlanChangeRequests.$inferSelect;
export type BillingDiscountRow = typeof billingDiscounts.$inferSelect;
export type NewDocumentTemplateRow = typeof documentTemplates.$inferInsert;
export type ProjectObjectiveRow = typeof projectObjectives.$inferSelect;
export type ProjectInternalRiskRow = typeof projectInternalRisks.$inferSelect;
export type ProjectTemplateRow = typeof projectTemplates.$inferSelect;
export type ProjectStatusUpdateRow = typeof projectStatusUpdates.$inferSelect;
export type ProjectBudgetRow = typeof projectBudgets.$inferSelect;
export type ProjectPhaseRow = typeof projectPhases.$inferSelect;
export type ProjectBaselineRow = typeof projectBaselines.$inferSelect;
export type ProjectCustomFieldRow = typeof projectCustomFields.$inferSelect;
export type NewProjectCustomFieldRow = typeof projectCustomFields.$inferInsert;
export type ProjectRetroNoteRow = typeof projectRetroNotes.$inferSelect;
export type DocumentTemplateVariableRow = typeof documentTemplateVariables.$inferSelect;
export type NewDocumentTemplateVariableRow = typeof documentTemplateVariables.$inferInsert;
export type OrgObjectiveRow = typeof orgObjectives.$inferSelect;
export type ObjectiveWorkLinkRow = typeof objectiveWorkLinks.$inferSelect;
export type MilestoneLinkRow = typeof milestoneLinks.$inferSelect;
export type ProjectDependencyRow = typeof projectDependencies.$inferSelect;
export type ObjectiveKeyResultRow = typeof objectiveKeyResults.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationPreferenceRow = typeof notificationPreferences.$inferSelect;
export type NotificationKindPrefRow = typeof notificationKindPrefs.$inferSelect;
export type A11yPreferenceRow = typeof a11yPreferences.$inferSelect;
export type QuietHoursRow = typeof quietHours.$inferSelect;
export type UserShortcutPrefRow = typeof userShortcutPrefs.$inferSelect;
export type UserStartupPrefRow = typeof userStartupPrefs.$inferSelect;
export type UserPreferenceRow = typeof userPreferences.$inferSelect;
export type DigestPreferenceRow = typeof digestPreferences.$inferSelect;
export type ConversationMuteRow = typeof conversationMutes.$inferSelect;
export type DirectConversationRow = typeof directConversations.$inferSelect;
export type DirectMessageRow = typeof directMessages.$inferSelect;
export type SavedContextRow = typeof savedContext.$inferSelect;
export type HomePinnedItemRow = typeof homePinnedItems.$inferSelect;
export type HomeRecentItemRow = typeof homeRecentItems.$inferSelect;
export type InboxSnoozeRow = typeof inboxSnoozes.$inferSelect;
export type InboxSourceMuteRow = typeof inboxSourceMutes.$inferSelect;
export type OrgSettingRow = typeof orgSettings.$inferSelect;
export type OrgPolicyRow = typeof orgPolicies.$inferSelect;
export type SecuritySettingsRow = typeof securitySettings.$inferSelect;
export type OrgIpAllowlistRow = typeof orgIpAllowlist.$inferSelect;
export type AdminSecurityAlertRow = typeof adminSecurityAlerts.$inferSelect;
export type OnboardingProgressRow = typeof onboardingProgress.$inferSelect;
export type PersonAllocationRow = typeof personAllocations.$inferSelect;
export type CustomRoleRow = typeof customRoles.$inferSelect;
export type MemberProfileRow = typeof memberProfiles.$inferSelect;
export type MemberAdminNoteRow = typeof memberAdminNotes.$inferSelect;
export type UsageCounterRow = typeof usageCounters.$inferSelect;
export type UsageLedgerEntryRow = typeof usageLedgerEntries.$inferSelect;
export type FileAssetRow = typeof fileAssets.$inferSelect;
export type FileVersionRow = typeof fileVersions.$inferSelect;
export type AttachmentVersionRow = typeof attachmentVersions.$inferSelect;
export type FilePreviewRow = typeof filePreviews.$inferSelect;
export type UploadSessionRow = typeof uploadSessions.$inferSelect;
export type WorkItemDependencyRow = typeof workItemDependencies.$inferSelect;
export type WorkBlockerRow = typeof workBlockers.$inferSelect;
export type UserPasswordRow = typeof userPasswords.$inferSelect;
export type UserMfaFactorRow = typeof userMfaFactors.$inferSelect;
export type UserRecoveryCodeRow = typeof userRecoveryCodes.$inferSelect;
export type AuthenticationEventRow = typeof authenticationEvents.$inferSelect;
export type CredentialChangeNoticeRow = typeof credentialChangeNotices.$inferSelect;
export type ImportJobRow = typeof importJobs.$inferSelect;
export type ImportRowRow = typeof importRows.$inferSelect;
export type SearchIndexRow = typeof searchIndex.$inferSelect;
export type NewSearchIndexRow = typeof searchIndex.$inferInsert;
export type IncidentRow = typeof incidents.$inferSelect;
export type ChangelogEntryRow = typeof changelogEntries.$inferSelect;
export type MarketingLeadRow = typeof marketingLeads.$inferSelect;
export type NewMarketingLeadRow = typeof marketingLeads.$inferInsert;
export type MaintenanceWindowRow = typeof maintenanceWindows.$inferSelect;
export type PlatformAdminStepUpRow = typeof platformAdminStepUps.$inferSelect;
export type PlatformAdminAuditEventRow = typeof platformAdminAuditEvents.$inferSelect;
export type PlatformSettingRow = typeof platformSettings.$inferSelect;
export type InsightSavedViewRow = typeof insightSavedViews.$inferSelect;
export type InsightSnapshotRow = typeof insightSnapshots.$inferSelect;
export type InsightSnapshotKind = (typeof INSIGHT_SNAPSHOT_KINDS)[number];
export type InsightReportScheduleRow = typeof insightReportSchedules.$inferSelect;
export type InsightAnnotationRow = typeof insightAnnotations.$inferSelect;
export type NewInsightAnnotationRow = typeof insightAnnotations.$inferInsert;
export type BillingSeatRow = typeof billingSeats.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type AdminExportRequestRow = typeof adminExportRequests.$inferSelect;
export type AdminExportScope = (typeof ADMIN_EXPORT_SCOPES)[number];
export type AdminExportStatus = (typeof ADMIN_EXPORT_STATUSES)[number];
export type InsightTargetRow = typeof insightTargets.$inferSelect;
export type InsightTargetMetric = (typeof INSIGHT_TARGET_METRICS)[number];
export type InsightMetricAlertRow = typeof insightMetricAlerts.$inferSelect;
export type InsightAlertMetric = (typeof INSIGHT_ALERT_METRICS)[number];
export type InsightAlertComparator = (typeof INSIGHT_ALERT_COMPARATORS)[number];
export type InsightTargetPeriod = (typeof INSIGHT_TARGET_PERIODS)[number];
export type PortalSettingsRow = typeof portalSettings.$inferSelect;
export type NewPortalSettingsRow = typeof portalSettings.$inferInsert;
export type InsightCustomReportRow = typeof insightCustomReports.$inferSelect;
export type PortalBrandingRow = typeof portalBranding.$inferSelect;
export type NewPortalBrandingRow = typeof portalBranding.$inferInsert;
export type OrgBrandingRow = typeof orgBranding.$inferSelect;
export type OrganizationLogoRow = typeof organizationLogos.$inferSelect;
export type PrivacyExportRow = typeof privacyExports.$inferSelect;
export type PrivacyDeletionRequestRow = typeof privacyDeletionRequests.$inferSelect;

// ---- platform-admin v2 · PA-02 ----

/**
 * 0239. The platform admin team (global, `NON_TENANT_TABLES`). `PLATFORM_ADMIN_EMAILS` stays the
 * bootstrap super admins and is never stored here. `preset` is `super_admin` | `support` |
 * `auditor` | `custom`; `permissions_json` holds the explicit list for `custom`.
 */
export const platformAdmins = mysqlTable(
  'platform_admins',
  {
    id: char('id', { length: 36 }).primaryKey(),
    userId: char('user_id', { length: 36 }).notNull(),
    preset: varchar('preset', { length: 32 }).notNull().default('support'),
    permissionsJson: text('permissions_json'),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdBy: char('created_by', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    disabledAt: datetime('disabled_at', { mode: 'date', fsp: 3 }),
    disabledReason: varchar('disabled_reason', { length: 500 }),
  },
  (table) => [
    uniqueIndex('uq_platform_admins_user').on(table.userId),
    index('ix_platform_admins_status').on(table.status),
  ],
);

/** 0239. Preset → permission mapping edited from D6 (`super_admin` is fixed in code). */
export const platformPermissionPresets = mysqlTable('platform_permission_presets', {
  preset: varchar('preset', { length: 32 }).primaryKey(),
  permissionsJson: text('permissions_json').notNull(),
  updatedBy: char('updated_by', { length: 36 }),
  updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
});

/** 0240. One platform admin's visit to one organization (global: read before a tenant exists). */
export const platformSupportSessions = mysqlTable(
  'platform_support_sessions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    adminUserId: char('admin_user_id', { length: 36 }).notNull(),
    browserSessionId: char('browser_session_id', { length: 36 }).notNull(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }),
    reason: varchar('reason', { length: 500 }),
    startedAt: datetime('started_at', { mode: 'date', fsp: 3 }).notNull(),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    endedAt: datetime('ended_at', { mode: 'date', fsp: 3 }),
    endedReason: varchar('ended_reason', { length: 32 }),
    actionsCount: int('actions_count').notNull().default(0),
    previousRole: varchar('previous_role', { length: 64 }),
    previousHasOrgWideScope: boolean('previous_has_org_wide_scope'),
  },
  (table) => [
    index('ix_pss_open').on(table.organizationId, table.endedAt, table.expiresAt),
    index('ix_pss_admin').on(table.adminUserId, table.startedAt),
  ],
);

/** 0241. Before/after values of one org audit event, one row per field. INSERT-only. */
export const auditEventChanges = mysqlTable(
  'audit_event_changes',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    auditEventId: char('audit_event_id', { length: 36 }).notNull(),
    field: varchar('field', { length: 64 }).notNull(),
    beforeValue: varchar('before_value', { length: 2000 }),
    afterValue: varchar('after_value', { length: 2000 }),
    redacted: boolean('redacted').notNull().default(false),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_aec_org_id').on(table.organizationId, table.id),
    index('ix_aec_event').on(table.organizationId, table.auditEventId),
  ],
);

export type PlatformAdminRow = typeof platformAdmins.$inferSelect;
export type PlatformPermissionPresetRow = typeof platformPermissionPresets.$inferSelect;
export type PlatformSupportSessionRow = typeof platformSupportSessions.$inferSelect;
export type AuditEventChangeRow = typeof auditEventChanges.$inferSelect;

// Registered after the definitions above: `TABLES` is declared earlier in the file, and a
// literal entry there would read these constants before they exist.
Object.assign(TABLES, {
  platform_admins: platformAdmins,
  platform_permission_presets: platformPermissionPresets,
  platform_support_sessions: platformSupportSessions,
  audit_event_changes: auditEventChanges,
});

// ---- platform-admin v2 · PA-01 ----

/**
 * 0242. One member's allow/deny override of a single capability (SPEC §3.3). Tenant-owned; revoked
 * by setting `revoked_at`, never deleted. Read by the membership resolver (live rows only) and by
 * `membership-overrides.repository.ts`.
 */
export const membershipPermissionOverrides = mysqlTable(
  'membership_permission_overrides',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    audience: varchar('audience', { length: 16 }).notNull().default('internal'),
    capability: varchar('capability', { length: 64 }).notNull(),
    effect: varchar('effect', { length: 8 }).notNull(),
    reason: varchar('reason', { length: 500 }),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    revokedAt: datetime('revoked_at', { mode: 'date', fsp: 3 }),
    revokedBy: char('revoked_by', { length: 36 }),
  },
  (table) => [
    uniqueIndex('uq_mpo_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_mpo_live').on(
      table.organizationId,
      table.membershipId,
      table.capability,
      table.revokedAt,
    ),
    index('ix_mpo_membership').on(table.organizationId, table.membershipId, table.revokedAt),
  ],
);

export type MembershipPermissionOverrideRow = typeof membershipPermissionOverrides.$inferSelect;

Object.assign(TABLES, {
  membership_permission_overrides: membershipPermissionOverrides,
});

// ---- platform-admin v2 · PA-10 ----

/**
 * 0244. One platform-level switch per optional module (`OPTIONAL_MODULE_FLAGS`): its platform
 * default and its rollout (`everyone` | `allowlist` | `percentage`). Global. Read and written with
 * raw SQL in `platform-admin/settings/flags.repository.ts`.
 */
export const platformFeatureFlags = mysqlTable('platform_feature_flags', {
  flagKey: varchar('flag_key', { length: 64 }).primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  rollout: varchar('rollout', { length: 16 }).notNull().default('everyone'),
  percentage: tinyint('percentage'),
  allowlistOrgIdsJson: text('allowlist_org_ids_json'),
  updatedBy: char('updated_by', { length: 36 }),
  updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
});

/** 0244. A flag forced on or off for one organization from the platform side. Global. */
export const platformOrgFlagOverrides = mysqlTable(
  'platform_org_flag_overrides',
  {
    id: char('id', { length: 36 }).primaryKey(),
    flagKey: varchar('flag_key', { length: 64 }).notNull(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    enabled: boolean('enabled').notNull(),
    removedAt: datetime('removed_at', { mode: 'date', fsp: 3 }),
    updatedBy: char('updated_by', { length: 36 }),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_pofo').on(table.flagKey, table.organizationId),
    index('ix_pofo_org').on(table.organizationId),
  ],
);

/**
 * 0244. The platform banner, EN + AR, with severity, link, audience, window and publish state.
 * Global. Delete sets `archived` (and unpublishes); nothing is hard-deleted.
 */
export const platformAnnouncements = mysqlTable(
  'platform_announcements',
  {
    id: char('id', { length: 36 }).primaryKey(),
    titleEn: varchar('title_en', { length: 190 }).notNull(),
    titleAr: varchar('title_ar', { length: 190 }),
    bodyEn: text('body_en').notNull(),
    bodyAr: text('body_ar'),
    severity: varchar('severity', { length: 16 }).notNull().default('info'),
    linkUrl: varchar('link_url', { length: 2048 }),
    audience: varchar('audience', { length: 16 }).notNull().default('everyone'),
    audienceOrgIdsJson: text('audience_org_ids_json'),
    dismissible: boolean('dismissible').notNull().default(true),
    startsAt: datetime('starts_at', { mode: 'date', fsp: 3 }),
    endsAt: datetime('ends_at', { mode: 'date', fsp: 3 }),
    published: boolean('published').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    createdBy: char('created_by', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [index('ix_pa_live').on(table.published, table.startsAt, table.endsAt)],
);

export type PlatformFeatureFlagRow = typeof platformFeatureFlags.$inferSelect;
export type PlatformOrgFlagOverrideRow = typeof platformOrgFlagOverrides.$inferSelect;
export type PlatformAnnouncementRow = typeof platformAnnouncements.$inferSelect;

// 0244 also adds `message_ar`, `block_sign_in`, `updated_at` and `ended_at` to
// `maintenance_windows`; the platform maintenance repository reads and writes them with raw SQL so
// the 0080 mirror above (`maintenanceWindows`) stays as it was.

Object.assign(TABLES, {
  platform_feature_flags: platformFeatureFlags,
  platform_org_flag_overrides: platformOrgFlagOverrides,
  platform_announcements: platformAnnouncements,
});

// ---- platform-admin v2 · PA-07 ----

/**
 * 0243. Per-organization limit overrides set by the platform operator (SPEC §6). One optional row
 * per organization; a NULL column means "the plan's value". `entitlementsFor()` merges the row over
 * the plan (the override wins). Tenant-owned, keyed `(organization_id, id)`.
 */
export const organizationLimits = mysqlTable(
  'organization_limits',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    peopleLimit: int('people_limit'),
    activeProjectsLimit: int('active_projects_limit'),
    storageBytesLimit: bigint('storage_bytes_limit', { mode: 'number' }),
    updatedBy: char('updated_by', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_org_limits_org').on(table.organizationId),
    uniqueIndex('uq_org_limits_org_id').on(table.organizationId, table.id),
  ],
);

export type OrganizationLimitsRow = typeof organizationLimits.$inferSelect;

Object.assign(TABLES, {
  organization_limits: organizationLimits,
});

// ---- platform-admin v2 · PA-09 ----

/**
 * 0246. The operators' CSV export jobs (SPEC §4 C6). Global (NON_TENANT_TABLES): the API inserts
 * a `queued` row, the worker writes the file and stamps `ready`/`failed`, the file expires 24 h
 * later. "Delete" is `status = 'deleted'` — no DELETE grant.
 */
export const platformExportJobs = mysqlTable(
  'platform_export_jobs',
  {
    id: char('id', { length: 36 }).primaryKey(),
    requestedBy: char('requested_by', { length: 36 }).notNull(),
    scope: varchar('scope', { length: 32 }).notNull(),
    filterJson: text('filter_json').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('queued'),
    rowCount: int('row_count'),
    objectKey: varchar('object_key', { length: 512 }),
    error: varchar('error', { length: 500 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    finishedAt: datetime('finished_at', { mode: 'date', fsp: 3 }),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    index('ix_platform_export_jobs_status').on(table.status, table.createdAt),
    index('ix_platform_export_jobs_requested').on(table.requestedBy, table.createdAt),
  ],
);

export type PlatformExportJobRow = typeof platformExportJobs.$inferSelect;

Object.assign(TABLES, {
  platform_export_jobs: platformExportJobs,
});

// ---- 56-02 FieldCipher ----

/**
 * 0249. The FieldCipher re-encrypt job's ledger (56-02). Global (NON_TENANT_TABLES): a rotation
 * spans every organization and holds counts and key ids only, never a key or a secret. The worker
 * (`apps/worker/src/jobs/field-cipher-rotation.ts`) resumes a killed run from `last_row_id`.
 */
export const keyRotations = mysqlTable(
  'key_rotations',
  {
    id: char('id', { length: 36 }).primaryKey(),
    purpose: varchar('purpose', { length: 32 }).notNull(),
    fromKeyId: varchar('from_key_id', { length: 16 }),
    toKeyId: varchar('to_key_id', { length: 16 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('queued'),
    rowsTotal: int('rows_total').notNull().default(0),
    rowsDone: int('rows_done').notNull().default(0),
    rowsSkipped: int('rows_skipped').notNull().default(0),
    rowsFailed: int('rows_failed').notNull().default(0),
    lastRowId: char('last_row_id', { length: 36 }),
    requestedBy: char('requested_by', { length: 36 }),
    error: varchar('error', { length: 500 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    startedAt: datetime('started_at', { mode: 'date', fsp: 3 }),
    heartbeatAt: datetime('heartbeat_at', { mode: 'date', fsp: 3 }),
    finishedAt: datetime('finished_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    index('ix_key_rotations_status').on(table.status, table.createdAt),
    index('ix_key_rotations_purpose').on(table.purpose, table.createdAt),
  ],
);

export type KeyRotationRow = typeof keyRotations.$inferSelect;

Object.assign(TABLES, {
  key_rotations: keyRotations,
});

// ---- 55-21 · usability measurement ----

/**
 * 0251. Metadata-only product events (55-21): allowlisted names and properties, a quarterly
 * salted actor hash, no content/email/IP. Tenant-owned (TENANT_TABLES); the API inserts, the
 * Platform admin scoreboard reads aggregates through the bootstrap path. No DELETE grant yet
 * (13-month retention purge is a follow-up).
 */
export const productEvents = mysqlTable(
  'product_events',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    occurredAt: datetime('occurred_at', { mode: 'date', fsp: 3 }).notNull(),
    receivedAt: datetime('received_at', { mode: 'date', fsp: 3 }).notNull(),
    eventName: varchar('event_name', { length: 64 }).notNull(),
    eventVersion: smallint('event_version').notNull().default(1),
    actorHash: char('actor_hash', { length: 64 }),
    principalKind: varchar('principal_kind', { length: 16 }).notNull(),
    locale: varchar('locale', { length: 10 }),
    platform: varchar('platform', { length: 16 }).notNull().default('web'),
    propertiesJson: text('properties_json'),
  },
  (table) => [
    index('ix_product_events_name_time').on(table.eventName, table.occurredAt),
    index('ix_product_events_org_time').on(table.organizationId, table.occurredAt),
  ],
);

export type ProductEventRow = typeof productEvents.$inferSelect;

Object.assign(TABLES, {
  product_events: productEvents,
});

// ---- 56-05 · durable rate limits and daily org quotas ----

/**
 * 0250. Durable rate-limit windows (56-05). GLOBAL (NON_TENANT_TABLES): anonymous callers have no
 * organization; `bucket_key` is `<policy>:<kind>:<m|h>:<hmac>` — a daily-peppered hash, never a
 * raw address. Charged by `rate-limit-buckets.repository.ts` (raw upsert), swept after 2 h.
 */
export const rateLimitBuckets = mysqlTable(
  'rate_limit_buckets',
  {
    bucketKey: varchar('bucket_key', { length: 190 }).primaryKey(),
    windowStart: datetime('window_start', { mode: 'date', fsp: 3 }).notNull(),
    hitCount: int('hit_count').notNull().default(0),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [index('ix_rate_limit_buckets_updated').on(table.updatedAt)],
);

export type RateLimitBucketRow = typeof rateLimitBuckets.$inferSelect;

/**
 * 0250. Per-organization daily quota counters (56-05): one row per org × metric × UTC day
 * (`api_calls`, `webhook_deliveries`, `public_link_views`, `push_sends`). Tenant-owned, keyed
 * `(organization_id, id)`; INSERT/UPDATE only.
 */
export const orgQuotaCounters = mysqlTable(
  'org_quota_counters',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    metricKey: varchar('metric_key', { length: 40 }).notNull(),
    dayUtc: date('day_utc', { mode: 'string' }).notNull(),
    usedCount: bigint('used_count', { mode: 'number' }).notNull().default(0),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_org_quota_counters_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_org_quota_counters_day').on(
      table.organizationId,
      table.metricKey,
      table.dayUtc,
    ),
  ],
);

export type OrgQuotaCounterRow = typeof orgQuotaCounters.$inferSelect;

Object.assign(TABLES, {
  rate_limit_buckets: rateLimitBuckets,
  org_quota_counters: orgQuotaCounters,
});

// ---- 51-11 · e-mail deliverability ----

/**
 * 0252. The e-mail suppression list (51-11). GLOBAL (NON_TENANT_TABLES): one row per suppressed
 * address hash (base64url SHA-256 of the trimmed, lower-cased address — never the address) and
 * scope (`notifications`). The API upserts on a one-click unsubscribe; the worker reads it before
 * each notification send. Transactional and security mail is never suppressed.
 */
export const emailSuppressions = mysqlTable(
  'email_suppressions',
  {
    addressHash: varchar('address_hash', { length: 64 }).notNull(),
    scope: varchar('scope', { length: 32 }).notNull().default('notifications'),
    reason: varchar('reason', { length: 32 }).notNull().default('one_click'),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.addressHash, table.scope] })],
);

export type EmailSuppressionRow = typeof emailSuppressions.$inferSelect;

Object.assign(TABLES, {
  email_suppressions: emailSuppressions,
});

// ---- 51-09 · backups ----

/**
 * 0253. One row per backup, off-site copy and restore drill (51-09, 56-12, 56-29). GLOBAL
 * (NON_TENANT_TABLES): backups belong to the platform. Written by `scripts/ops/backup.mjs` and
 * `restore-drill.mjs` through the migration credential; `/healthz/deep` reads the freshness.
 * `kind` scheduled | manual | drill; `status` ok | failed; `offsite_status` not_requested |
 * skipped | uploaded | failed — closed lists checked in the scripts.
 */
export const platformBackupRuns = mysqlTable(
  'platform_backup_runs',
  {
    id: char('id', { length: 36 }).primaryKey(),
    kind: varchar('kind', { length: 16 }).notNull(),
    frequencyKind: varchar('frequency_kind', { length: 16 }).notNull(),
    stamp: varchar('stamp', { length: 20 }),
    startedAt: datetime('started_at', { mode: 'date', fsp: 3 }).notNull(),
    finishedAt: datetime('finished_at', { mode: 'date', fsp: 3 }),
    status: varchar('status', { length: 16 }).notNull(),
    dbBytes: bigint('db_bytes', { mode: 'number' }),
    uploadsBytes: bigint('uploads_bytes', { mode: 'number' }),
    manifestSha: char('manifest_sha', { length: 64 }),
    gitSha: varchar('git_sha', { length: 64 }),
    offsiteStatus: varchar('offsite_status', { length: 16 }).notNull().default('not_requested'),
    offsiteLocation: varchar('offsite_location', { length: 255 }),
    offsiteAt: datetime('offsite_at', { mode: 'date', fsp: 3 }),
    error: varchar('error', { length: 500 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [index('ix_platform_backup_runs_kind_finished').on(table.kind, table.finishedAt)],
);

export type PlatformBackupRunRow = typeof platformBackupRuns.$inferSelect;

Object.assign(TABLES, {
  platform_backup_runs: platformBackupRuns,
});

// ---- 56-32 · host capacity ----

/**
 * 0254. The shared-hosting capacity budget's readings (56-32, spec 56 §12.2). GLOBAL
 * (NON_TENANT_TABLES): readings describe the host, never an organization. Written by the API's
 * `CapacitySampler` (a `sample` row every 5 min, a `nightly` row at 03:30 UTC; 90-day retention)
 * through `identityTransaction(['host_capacity_readings'])`. `source` sample | nightly | train —
 * closed list checked in code. The nightly-only columns are NULL on a sample row.
 */
export const hostCapacityReadings = mysqlTable(
  'host_capacity_readings',
  {
    id: char('id', { length: 36 }).primaryKey(),
    takenAt: datetime('taken_at', { mode: 'date', fsp: 3 }).notNull(),
    source: varchar('source', { length: 8 }).notNull(),
    rssMb: int('rss_mb').notNull(),
    heapMb: int('heap_mb').notNull(),
    loopLagMs: int('loop_lag_ms').notNull(),
    sockets: int('sockets'),
    inodes: int('inodes'),
    diskMb: int('disk_mb'),
    dbMb: int('db_mb'),
    dbConnections: int('db_connections'),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [index('ix_host_capacity_readings_taken').on(table.takenAt)],
);

export type HostCapacityReadingRow = typeof hostCapacityReadings.$inferSelect;

Object.assign(TABLES, {
  host_capacity_readings: hostCapacityReadings,
});

// ---- 56-31 · mail lanes ----

/**
 * 0256. The transactional e-mail priority lane (56-31). GLOBAL (NON_TENANT_TABLES):
 * `organization_id` is nullable — platform mail (sign-in codes, resets, alerts) has none. `lane`
 * auth | transactional | digest | bulk and `mailbox` security | noreply are fixed in code by
 * `laneForTemplate` (packages/mail/src/lanes.ts); `status` queued | sending | sent | deferred |
 * failed | suppressed. The API enqueues (INSERT); the worker drainer claims, sends and purges.
 */
export const mailQueue = mysqlTable(
  'mail_queue',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }),
    lane: varchar('lane', { length: 16 }).notNull(),
    mailbox: varchar('mailbox', { length: 16 }).notNull(),
    toHash: char('to_hash', { length: 64 }).notNull(),
    templateKey: varchar('template_key', { length: 64 }).notNull(),
    payloadJson: text('payload_json').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('queued'),
    attempts: tinyint('attempts').notNull().default(0),
    claimToken: char('claim_token', { length: 36 }),
    availableAt: datetime('available_at', { mode: 'date', fsp: 3 }).notNull(),
    deadlineAt: datetime('deadline_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    sentAt: datetime('sent_at', { mode: 'date', fsp: 3 }),
    providerMessageId: varchar('provider_message_id', { length: 255 }),
    error: varchar('error', { length: 255 }),
  },
  (table) => [
    index('ix_mail_queue_drain').on(table.status, table.lane, table.availableAt),
    index('ix_mail_queue_org').on(table.organizationId, table.id),
    index('ix_mail_queue_claim').on(table.claimToken),
  ],
);

export type MailQueueRow = typeof mailQueue.$inferSelect;

/** 0256. One send counter per mailbox per clock hour (56-31), upserted like `rate_limit_buckets`. */
export const mailHourWindows = mysqlTable(
  'mail_hour_windows',
  {
    mailbox: varchar('mailbox', { length: 16 }).notNull(),
    windowStart: datetime('window_start', { mode: 'date', fsp: 3 }).notNull(),
    count: int('count').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.mailbox, table.windowStart] })],
);

export type MailHourWindowRow = typeof mailHourWindows.$inferSelect;

Object.assign(TABLES, {
  mail_queue: mailQueue,
  mail_hour_windows: mailHourWindows,
});

// ---- 52-21 · public-endpoint abuse engine ----

/**
 * 0255. An organization's own block list for its public doors (52-21): one e-mail address, one
 * e-mail domain or one IP address per row. TENANT: keyed `(organization_id, id)`, unique per
 * `(organization_id, kind, value)`. `kind` email | domain | ip — closed list checked in
 * `public-abuse/block-rules.repository.ts`. Managed behind `org.security.manage`.
 */
export const orgBlockRules = mysqlTable(
  'org_block_rules',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    kind: varchar('kind', { length: 8 }).notNull(),
    value: varchar('value', { length: 254 }).notNull(),
    reason: varchar('reason', { length: 200 }),
    createdByUserId: char('created_by_user_id', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_org_block_rules_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_org_block_rules_value').on(table.organizationId, table.kind, table.value),
  ],
);

export type OrgBlockRuleRow = typeof orgBlockRules.$inferSelect;

/**
 * 0255. One row per assessed public action (52-21 abuse telemetry). GLOBAL (NON_TENANT_TABLES):
 * the caller is anonymous. No content — `key_hash` is an HMAC of the submitted values, `ip_text`
 * is truncated to /24 or /56 at write time. `decision` allow | hold | spam | blocked | challenge.
 * Purged after 30 days.
 */
export const publicAbuseEvents = mysqlTable(
  'public_abuse_events',
  {
    id: char('id', { length: 36 }).primaryKey(),
    kind: varchar('kind', { length: 32 }).notNull(),
    surface: varchar('surface', { length: 64 }).notNull(),
    keyHash: char('key_hash', { length: 64 }).notNull(),
    ipText: varchar('ip_text', { length: 45 }),
    decision: varchar('decision', { length: 16 }).notNull(),
    score: smallint('score').notNull(),
    reasons: varchar('reasons', { length: 255 }),
    organizationId: char('organization_id', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [index('ix_public_abuse_events_created').on(table.createdAt)],
);

export type PublicAbuseEventRow = typeof publicAbuseEvents.$inferSelect;

/**
 * 0255. An issued public challenge (52-21): e-mail code, proof-of-work or Turnstile. GLOBAL:
 * the target and the code are hashes. `kind` email_code | pow | turnstile. Purged once expired.
 */
export const publicChallenges = mysqlTable(
  'public_challenges',
  {
    id: char('id', { length: 36 }).primaryKey(),
    kind: varchar('kind', { length: 16 }).notNull(),
    targetHash: char('target_hash', { length: 64 }).notNull(),
    codeHash: char('code_hash', { length: 64 }),
    attempts: tinyint('attempts').notNull().default(0),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    solvedAt: datetime('solved_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [index('ix_public_challenges_expires').on(table.expiresAt)],
);

export type PublicChallengeRow = typeof publicChallenges.$inferSelect;

Object.assign(TABLES, {
  org_block_rules: orgBlockRules,
  public_abuse_events: publicAbuseEvents,
  public_challenges: publicChallenges,
});

// ---- 56-07 · public link system ----

/**
 * 0257. One link a person without an account opens (56-07): approval, intake, quote, share or
 * magic sign-in. TENANT: keyed `(organization_id, id)`. Only `token_hash` (HMAC-SHA-256 of the
 * token under the public-link pepper) is stored; `token_hint` is the token's last 6 characters.
 * `kind`, `decision` are closed lists checked in `public-links/public-link-targets.ts`.
 */
export const publicLinks = mysqlTable(
  'public_links',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    kind: varchar('kind', { length: 16 }).notNull(),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    tokenHint: varchar('token_hint', { length: 8 }).notNull(),
    targetType: varchar('target_type', { length: 32 }).notNull(),
    targetId: char('target_id', { length: 36 }).notNull(),
    versionHash: char('version_hash', { length: 64 }),
    audienceEmail: varchar('audience_email', { length: 320 }),
    requireCode: boolean('require_code').notNull().default(false),
    language: varchar('language', { length: 5 }).notNull().default('en'),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    maxUses: int('max_uses'),
    uses: int('uses').notNull().default(0),
    decision: varchar('decision', { length: 16 }),
    decidedAt: datetime('decided_at', { mode: 'date', fsp: 3 }),
    createdByUserId: char('created_by_user_id', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    revokedAt: datetime('revoked_at', { mode: 'date', fsp: 3 }),
    revokedByUserId: char('revoked_by_user_id', { length: 36 }),
    lastOpenedAt: datetime('last_opened_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_public_links_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_public_links_token_hash').on(table.tokenHash),
    index('ix_public_links_target').on(table.organizationId, table.targetType, table.targetId),
    index('ix_public_links_expires').on(table.expiresAt),
  ],
);

export type PublicLinkRow = typeof publicLinks.$inferSelect;

/**
 * 0257. Append-only evidence of what happened on a public link (56-07): opened, code_sent,
 * code_ok, decided, submitted, refused. TENANT. The IP is stored only as a peppered hash.
 */
export const publicLinkEvents = mysqlTable(
  'public_link_events',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    linkId: char('link_id', { length: 36 }).notNull(),
    kind: varchar('kind', { length: 16 }).notNull(),
    detail: varchar('detail', { length: 1000 }),
    ipHash: char('ip_hash', { length: 64 }),
    userAgent: varchar('user_agent', { length: 255 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_public_link_events_org_id').on(table.organizationId, table.id),
    index('ix_public_link_events_link').on(table.organizationId, table.linkId, table.createdAt),
  ],
);

export type PublicLinkEventRow = typeof publicLinkEvents.$inferSelect;

/**
 * 0257. The live e-mail code of one public link (56-07): hash only, 10 minutes, 5 attempts.
 * TENANT with no `id`: the primary key `(organization_id, link_id)` leads with the tenant column.
 */
export const publicLinkCodes = mysqlTable(
  'public_link_codes',
  {
    linkId: char('link_id', { length: 36 }).notNull(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    codeHash: char('code_hash', { length: 64 }).notNull(),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    attempts: tinyint('attempts').notNull().default(0),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.linkId] })],
);

export type PublicLinkCodeRow = typeof publicLinkCodes.$inferSelect;

Object.assign(TABLES, {
  public_links: publicLinks,
  public_link_events: publicLinkEvents,
  public_link_codes: publicLinkCodes,
});

// ---- 52-08 · quotes ----

/** 0259 (52-08). A quote's state — closed list checked in `quotes/quote-content.ts`. */
export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/**
 * 0259 (52-08). One quote. TENANT: keyed `(organization_id, id)`. Amounts are integer minor units
 * computed by the server from the lines; `content_hash` is written on send, after which the quote
 * is immutable and its 56-07 `quote` link binds that hash. `notes_text` is internal only.
 */
export const quotes = mysqlTable(
  'quotes',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    seq: int('seq').notNull(),
    number: varchar('number', { length: 32 }).notNull(),
    clientOrganizationId: char('client_organization_id', { length: 36 }),
    leadName: varchar('lead_name', { length: 200 }),
    leadEmail: varchar('lead_email', { length: 320 }),
    title: varchar('title', { length: 200 }).notNull(),
    language: varchar('language', { length: 5 }).notNull().default('en'),
    currency: char('currency', { length: 3 }).notNull(),
    status: varchar('status', { length: 16 }).$type<QuoteStatus>().notNull().default('draft'),
    validUntil: datetime('valid_until', { mode: 'date', fsp: 3 }).notNull(),
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull().default(0),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull().default(0),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull().default(0),
    termsText: text('terms_text'),
    notesText: text('notes_text'),
    contentHash: char('content_hash', { length: 64 }),
    sentAt: datetime('sent_at', { mode: 'date', fsp: 3 }),
    sentLinkId: char('sent_link_id', { length: 36 }),
    decidedAt: datetime('decided_at', { mode: 'date', fsp: 3 }),
    createdByUserId: char('created_by_user_id', { length: 36 }),
    version: int('version').notNull().default(1),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_quotes_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_quotes_org_number').on(table.organizationId, table.number),
    uniqueIndex('uq_quotes_org_seq').on(table.organizationId, table.seq),
    index('ix_quotes_org_status').on(table.organizationId, table.status, table.createdAt),
  ],
);

export type QuoteRow = typeof quotes.$inferSelect;

/**
 * 0259 (52-08). One line of a quote. TENANT. `quantity_centi` is hundredths (150 = 1.5);
 * `line_net_minor` / `line_tax_minor` are computed by the server. Replaced as a set while draft.
 */
export const quoteLines = mysqlTable(
  'quote_lines',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    quoteId: char('quote_id', { length: 36 }).notNull(),
    position: int('position').notNull(),
    description: varchar('description', { length: 500 }).notNull(),
    unit: varchar('unit', { length: 12 }).notNull().default('item'),
    quantityCenti: int('quantity_centi').notNull(),
    unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }).notNull(),
    taxBp: int('tax_bp').notNull().default(0),
    lineNetMinor: bigint('line_net_minor', { mode: 'number' }).notNull(),
    lineTaxMinor: bigint('line_tax_minor', { mode: 'number' }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_quote_lines_org_id').on(table.organizationId, table.id),
    index('ix_quote_lines_quote').on(table.organizationId, table.quoteId, table.position),
  ],
);

export type QuoteLineRow = typeof quoteLines.$inferSelect;

Object.assign(TABLES, {
  quotes,
  quote_lines: quoteLines,
});

// ---- 52-23 · money foundations ----

/**
 * 0260 (52-23). One finance profile per organization (`uq_ofp_org`). TENANT. Internal only: never
 * part of a client projection. Closed lists (`numbering_reset`, `digits`, `tax_scheme`) are checked
 * in `finance/finance-rules.ts`. Absent until the first save; the API answers defaults until then.
 */
/**
 * 52-12 (0310): a JSON object kept in a TEXT column (MariaDB-safe). Written only through
 * `parseAddressJson`; a stored value that is not an object reads as NULL.
 */
const addressJsonText = customType<{ data: StructuredAddressColumn; driverData: string }>({
  dataType: () => 'text',
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => {
    try {
      const parsed = JSON.parse(value) as unknown;
      return (
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
      ) as StructuredAddressColumn;
    } catch {
      return null as unknown as StructuredAddressColumn;
    }
  },
});
/** Mirrors `StructuredAddress` in `@tmanage/domain` (schema.ts imports nothing from the domain). */
export interface StructuredAddressColumn {
  readonly building: string;
  readonly street: string;
  readonly district: string;
  readonly city: string;
  readonly postalCode: string;
  readonly countryCode: string;
}

export const orgFinanceProfiles = mysqlTable(
  'org_finance_profiles',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    country: char('country', { length: 2 }).notNull(),
    baseCurrency: char('base_currency', { length: 3 }).notNull(),
    taxRegistrationNo: varchar('tax_registration_no', { length: 32 }),
    taxScheme: varchar('tax_scheme', { length: 16 }).notNull().default('VAT'),
    defaultTaxRateBp: int('default_tax_rate_bp').notNull().default(0),
    legalNameEn: varchar('legal_name_en', { length: 200 }),
    legalNameAr: varchar('legal_name_ar', { length: 200 }),
    addressEn: varchar('address_en', { length: 500 }),
    addressAr: varchar('address_ar', { length: 500 }),
    invoicePrefix: varchar('invoice_prefix', { length: 16 }).notNull().default('INV'),
    quotePrefix: varchar('quote_prefix', { length: 16 }).notNull().default('QT'),
    creditNotePrefix: varchar('credit_note_prefix', { length: 16 }).notNull().default('CN'),
    numberingReset: varchar('numbering_reset', { length: 8 })
      .$type<'yearly' | 'never'>()
      .notNull()
      .default('yearly'),
    roundingMinutes: int('rounding_minutes').notNull().default(15),
    weekStart: tinyint('week_start').notNull().default(0),
    digits: varchar('digits', { length: 8 }).$type<'latn' | 'arab'>().notNull().default('latn'),
    showHijri: boolean('show_hijri').notNull().default(false),
    bankDetailsText: text('bank_details_text'),
    paymentTermsDays: int('payment_terms_days').notNull().default(30),
    /** 52-28 (0303): `not_registered | registered`, app-checked. */
    vatRegistrationStatus: varchar('vat_registration_status', { length: 16 })
      .$type<'not_registered' | 'registered'>()
      .notNull()
      .default('not_registered'),
    /** 52-28 (0303): `zatca | eta | pint_ae | none`; NULL = derived from the country. */
    einvoiceRegime: varchar('einvoice_regime', { length: 8 }).$type<
      'zatca' | 'eta' | 'pint_ae' | 'none'
    >(),
    /** 52-12 (0310): the structured seller address (JSON text, `parseAddressJson`); NULL = none. */
    addressJson: addressJsonText('address_json'),
    version: int('version').notNull().default(1),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_ofp_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_ofp_org').on(table.organizationId),
  ],
);

export type OrgFinanceProfileRow = typeof orgFinanceProfiles.$inferSelect;

/** 0260 (52-23). An organization's tax rates, unique by `code`; archived, never deleted. TENANT. */
export const orgTaxRates = mysqlTable(
  'org_tax_rates',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    code: varchar('code', { length: 16 }).notNull(),
    nameEn: varchar('name_en', { length: 64 }).notNull(),
    nameAr: varchar('name_ar', { length: 64 }).notNull(),
    rateBp: int('rate_bp').notNull(),
    zatcaCategory: varchar('zatca_category', { length: 4 }).$type<'S' | 'Z' | 'E' | 'O'>(),
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: datetime('archived_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_otr_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_otr_org_code').on(table.organizationId, table.code),
  ],
);

export type OrgTaxRateRow = typeof orgTaxRates.$inferSelect;

/**
 * 0260 (52-23). Gapless counter per organization, document kind and period (`2026`, or `0000` for
 * never-reset). Locked FOR UPDATE inside the issuing transaction (`finance/document-sequences.ts`).
 */
export const orgDocumentSequences = mysqlTable(
  'org_document_sequences',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    kind: varchar('kind', { length: 16 }).$type<'invoice' | 'quote' | 'credit_note'>().notNull(),
    periodKey: char('period_key', { length: 4 }).notNull(),
    nextValue: int('next_value').notNull().default(1),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_ods_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_ods_key').on(table.organizationId, table.kind, table.periodKey),
  ],
);

export type OrgDocumentSequenceRow = typeof orgDocumentSequences.$inferSelect;

/** 0260 (52-23). Manual dated FX rates, one per pair per day. `rate` is DECIMAL(18,8) as text. */
export const orgExchangeRates = mysqlTable(
  'org_exchange_rates',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    fromCurrency: char('from_currency', { length: 3 }).notNull(),
    toCurrency: char('to_currency', { length: 3 }).notNull(),
    rate: decimal('rate', { precision: 18, scale: 8 }).notNull(),
    effectiveOn: date('effective_on', { mode: 'string' }).notNull(),
    source: varchar('source', { length: 32 }).notNull().default('manual'),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_oer_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_oer_pair_day').on(
      table.organizationId,
      table.fromCurrency,
      table.toCurrency,
      table.effectiveOn,
    ),
  ],
);

export type OrgExchangeRateRow = typeof orgExchangeRates.$inferSelect;

Object.assign(TABLES, {
  org_finance_profiles: orgFinanceProfiles,
  org_tax_rates: orgTaxRates,
  org_document_sequences: orgDocumentSequences,
  org_exchange_rates: orgExchangeRates,
});

// ---- 56-17 · vulnerability disclosure ----

/**
 * 0262 (56-17). One vulnerability report from the public disclosure form. GLOBAL
 * (NON_TENANT_TABLES): a report is about the platform, never one organization — no
 * `organization_id`. `reporter_email_enc` is a FieldCipher envelope (`reporter_email`, owner = id)
 * or NULL (none given / keyless host). `status` new | triaged | fixed | duplicate | invalid and
 * `severity_claimed` none | low | medium | high | critical are checked in
 * `security-reports/security-report-content.ts`. Retention 24 months.
 */
export const securityReports = mysqlTable(
  'security_reports',
  {
    id: char('id', { length: 36 }).primaryKey(),
    reference: varchar('reference', { length: 16 }).notNull(),
    reporterEmailEnc: varchar('reporter_email_enc', { length: 600 }),
    reporterName: varchar('reporter_name', { length: 200 }),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body').notNull(),
    severityClaimed: varchar('severity_claimed', { length: 16 }).notNull().default('none'),
    status: varchar('status', { length: 16 }).notNull().default('new'),
    riskDecision: varchar('risk_decision', { length: 16 }).notNull().default('allow'),
    language: varchar('language', { length: 5 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    acknowledgedAt: datetime('acknowledged_at', { mode: 'date', fsp: 3 }),
    resolvedAt: datetime('resolved_at', { mode: 'date', fsp: 3 }),
    creditName: varchar('credit_name', { length: 200 }),
    creditPublic: boolean('credit_public').notNull().default(false),
  },
  (table) => [
    uniqueIndex('uq_security_reports_reference').on(table.reference),
    index('ix_security_reports_status').on(table.status, table.createdAt),
    index('ix_security_reports_created').on(table.createdAt),
  ],
);

export type SecurityReportRow = typeof securityReports.$inferSelect;

Object.assign(TABLES, {
  security_reports: securityReports,
});

// ---- 56-11 · audit hash chain ----

/**
 * 0261 (56-11). One row per organization: the head of its audit hash chain. TENANT. Written only
 * inside an audit write's transaction (read FOR UPDATE, then advanced); the worker inserts the
 * chain-start row for organizations that have none. `legacy_last_event_id` names the newest
 * pre-chain `audit_events` row.
 */
export const auditHeads = mysqlTable(
  'audit_heads',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    chainSeq: bigint('chain_seq', { mode: 'number' }).notNull().default(0),
    headHash: char('head_hash', { length: 64 }).notNull(),
    lastEventId: char('last_event_id', { length: 36 }),
    legacyLastEventId: char('legacy_last_event_id', { length: 36 }),
    chainStartedAt: datetime('chain_started_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_audit_heads_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_audit_heads_org').on(table.organizationId),
  ],
);
export type AuditHeadRow = typeof auditHeads.$inferSelect;

/** 0261 (56-11). One daily anchor per organization (HMAC under AUDIT_ANCHOR_KEY, or NULL). TENANT. */
export const auditAnchors = mysqlTable(
  'audit_anchors',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    headHash: char('head_hash', { length: 64 }).notNull(),
    eventCount: bigint('event_count', { mode: 'number' }).notNull(),
    signature: varchar('signature', { length: 512 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_audit_anchors_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_audit_anchors_org_day').on(table.organizationId, table.day),
  ],
);
export type AuditAnchorRow = typeof auditAnchors.$inferSelect;

/** 0261 (56-11). One platform root per UTC day over that day's organization anchors. GLOBAL. */
export const platformAuditAnchors = mysqlTable(
  'platform_audit_anchors',
  {
    id: char('id', { length: 36 }).primaryKey(),
    day: date('day', { mode: 'string' }).notNull(),
    rootHash: char('root_hash', { length: 64 }).notNull(),
    orgCount: int('org_count').notNull(),
    signature: varchar('signature', { length: 512 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [uniqueIndex('uq_platform_audit_anchors_day').on(table.day)],
);
export type PlatformAuditAnchorRow = typeof platformAuditAnchors.$inferSelect;

Object.assign(TABLES, {
  audit_heads: auditHeads,
  audit_anchors: auditAnchors,
  platform_audit_anchors: platformAuditAnchors,
});

// ---- 56-23 · security signals ----

/**
 * 0263 (56-23). One deduplicated security signal per (scope, rule, subject, rule window). TENANT
 * with a NULLABLE `organization_id`: NULL = a platform signal (owners never see it — every org
 * read names its own id). `scope_key` (org id or `platform`) stands in for the org in the dedupe
 * key. Ids, counts and SHA-256 source hashes only; written by the worker detector, read by the API.
 */
export const securitySignals = mysqlTable(
  'security_signals',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }),
    scopeKey: varchar('scope_key', { length: 40 }).notNull(),
    ruleKey: varchar('rule_key', { length: 48 }).notNull(),
    severity: varchar('severity', { length: 16 }).notNull(),
    subjectType: varchar('subject_type', { length: 32 }).notNull(),
    subjectId: char('subject_id', { length: 36 }),
    subjectKey: varchar('subject_key', { length: 64 }).notNull(),
    sourceHash: char('source_hash', { length: 64 }),
    count: int('count').notNull().default(0),
    windowStart: datetime('window_start', { mode: 'date', fsp: 3 }).notNull(),
    firstSeen: datetime('first_seen', { mode: 'date', fsp: 3 }).notNull(),
    lastSeen: datetime('last_seen', { mode: 'date', fsp: 3 }).notNull(),
    notifyStatus: varchar('notify_status', { length: 16 }).notNull().default('pending'),
    notifiedAt: datetime('notified_at', { mode: 'date', fsp: 3 }),
    detailsJson: text('details_json'),
  },
  (table) => [
    uniqueIndex('uq_security_signals_dedupe').on(
      table.scopeKey,
      table.ruleKey,
      table.subjectKey,
      table.windowStart,
    ),
    uniqueIndex('uq_security_signals_org_id').on(table.organizationId, table.id),
    index('ix_security_signals_org_seen').on(table.organizationId, table.lastSeen),
    index('ix_security_signals_notify').on(table.notifyStatus, table.firstSeen),
    index('ix_security_signals_seen').on(table.lastSeen),
  ],
);
export type SecuritySignalRow = typeof securitySignals.$inferSelect;

/** 0263 (56-23). One row per detector rule: on/off, threshold JSON, cooldown. GLOBAL. */
export const platformAlertRules = mysqlTable('platform_alert_rules', {
  ruleKey: varchar('rule_key', { length: 48 }).primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  thresholdJson: text('threshold_json').notNull(),
  cooldownMinutes: int('cooldown_minutes').notNull().default(60),
  lastFiredAt: datetime('last_fired_at', { mode: 'date', fsp: 3 }),
  updatedBy: char('updated_by', { length: 36 }),
  updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
});
export type PlatformAlertRuleRow = typeof platformAlertRules.$inferSelect;

Object.assign(TABLES, {
  security_signals: securitySignals,
  platform_alert_rules: platformAlertRules,
});

// ---- 52-01 · timer (backend half) ----

/**
 * 0265 (52-01). The one running timer of one membership (`uq_time_timers_org_member`). TENANT.
 * Internal only. `started_at` is the server clock; the row is deleted when the timer stops (by
 * the member, by `force` on the next start, or by the worker's auto-stop). No foreign keys (the
 * 0257 convention): the service resolves the work item and project tenant-scoped first.
 */
export const timeTimers = mysqlTable(
  'time_timers',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    userId: char('user_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }),
    projectId: char('project_id', { length: 36 }),
    note: varchar('note', { length: 500 }),
    billable: boolean('billable').notNull().default(true),
    startedAt: datetime('started_at', { mode: 'date', fsp: 3 }).notNull(),
    lastHeartbeatAt: datetime('last_heartbeat_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_time_timers_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_time_timers_org_member').on(table.organizationId, table.membershipId),
    index('ix_time_timers_org_project').on(table.organizationId, table.projectId),
    index('ix_time_timers_started').on(table.startedAt),
  ],
);

export type TimeTimerRow = typeof timeTimers.$inferSelect;

Object.assign(TABLES, {
  time_timers: timeTimers,
});

// ---- R12 · IP intelligence ----

export const IP_NETWORK_KINDS = ['residential', 'hosting', 'local', 'unknown'] as const;
export type IpNetworkKind = (typeof IP_NETWORK_KINDS)[number];

/**
 * 0280 (R12). One row per IP address seen on a sign-in or a session: its approximate place and
 * network (DB-IP Lite, CC BY 4.0), cached and refreshed after 30 days. GLOBAL (NON_TENANT_TABLES):
 * an address belongs to no organization; sessions and events join on `ip`. The worker deletes rows
 * unseen for `GEOIP_RETENTION_DAYS`.
 */
export const ipLookups = mysqlTable(
  'ip_lookups',
  {
    ip: varchar('ip', { length: 45 }).primaryKey(),
    countryCode: char('country_code', { length: 2 }),
    country: varchar('country', { length: 80 }),
    region: varchar('region', { length: 120 }),
    city: varchar('city', { length: 120 }),
    postalCode: varchar('postal_code', { length: 16 }),
    asn: int('asn', { unsigned: true }),
    networkOwner: varchar('network_owner', { length: 190 }),
    networkKind: mysqlEnum('network_kind', IP_NETWORK_KINDS).notNull().default('unknown'),
    isTor: boolean('is_tor').notNull().default(false),
    vpnOrProxy: mysqlEnum('vpn_or_proxy', ['likely', 'unknown']).notNull().default('unknown'),
    source: varchar('source', { length: 16 }),
    lookedUpAt: datetime('looked_up_at', { mode: 'date', fsp: 3 }).notNull(),
    lastSeenAt: datetime('last_seen_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [index('ix_ip_lookups_last_seen').on(table.lastSeenAt)],
);

export type IpLookupRow = typeof ipLookups.$inferSelect;

Object.assign(TABLES, {
  ip_lookups: ipLookups,
});

// ---- R13 slice 5 · 57-14 Growth rollups ----

/** The period a growth rollup row covers (0284). */
export const GROWTH_PERIOD_KINDS = ['week', 'month'] as const;
export type GrowthPeriodKind = (typeof GROWTH_PERIOD_KINDS)[number];

/**
 * 0284 (57-14). One platform-wide number per (period, metric, dimension): sign-ups by source, the
 * activation funnels, time to first project, cohort retention, MRR from subscriptions, approval
 * turnaround. GLOBAL (NON_TENANT_TABLES): a rollup is about the whole platform, never one tenant —
 * counts, rates and durations only, no organization id or actor hash (PRIV-06). The worker's
 * nightly growth job upserts on the unique key; `GET /v1/platform/activity/growth` reads it.
 */
export const platformGrowthRollups = mysqlTable(
  'platform_growth_rollups',
  {
    id: char('id', { length: 36 }).primaryKey(),
    periodKind: varchar('period_kind', { length: 8 }).notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    metric: varchar('metric', { length: 48 }).notNull(),
    dimension: varchar('dimension', { length: 64 }).notNull().default(''),
    valueNum: decimal('value_num', { precision: 18, scale: 4 }).notNull(),
    sampleCount: int('sample_count').notNull().default(0),
    computedAt: datetime('computed_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_platform_growth_rollups_key').on(
      table.periodKind,
      table.periodStart,
      table.metric,
      table.dimension,
    ),
    index('ix_platform_growth_rollups_computed').on(table.computedAt),
  ],
);

export type PlatformGrowthRollupRow = typeof platformGrowthRollups.$inferSelect;

Object.assign(TABLES, {
  platform_growth_rollups: platformGrowthRollups,
});

// ---- R13-s4 · 53-02 working calendar ----

export const WORKING_CALENDAR_SCOPES = ['org', 'project'] as const;
export type WorkingCalendarScope = (typeof WORKING_CALENDAR_SCOPES)[number];
export const HOLIDAY_SOURCES = ['pack', 'custom'] as const;
export type HolidaySource = (typeof HOLIDAY_SOURCES)[number];

/**
 * 0283 (53-02). The company's working calendar (`scope = 'org'`, no project) or one project's
 * override. TENANT. `working_days_mask` bit 0 = Sunday; `day_start`/`day_end` are wall-clock in
 * `time_zone`; `version` is the optimistic-concurrency counter (a stale PUT is a 409). No row = the
 * default (Sun–Thu, 09:00–17:00, the organization's zone).
 */
export const orgWorkingCalendars = mysqlTable(
  'org_working_calendars',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    scope: varchar('scope', { length: 8 }).notNull(),
    projectId: char('project_id', { length: 36 }),
    workingDaysMask: tinyint('working_days_mask', { unsigned: true }).notNull(),
    dayStart: time('day_start').notNull(),
    dayEnd: time('day_end').notNull(),
    timeZone: varchar('time_zone', { length: 64 }).notNull(),
    version: int('version').notNull().default(1),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_org_working_calendars_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_org_working_calendars_scope').on(
      table.organizationId,
      table.scope,
      table.projectId,
    ),
  ],
);

export type OrgWorkingCalendarRow = typeof orgWorkingCalendars.$inferSelect;

/**
 * 0283 (53-02). One day off of one calendar: typed by an owner (`custom`) or imported from a static
 * holiday pack (`pack`, with `pack_key` + `pack_version`). `estimated` marks an expected Hijri date.
 * TENANT. One per calendar per date; the service caps a calendar at 400.
 */
export const orgHolidays = mysqlTable(
  'org_holidays',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    calendarId: char('calendar_id', { length: 36 }).notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    labelEn: varchar('label_en', { length: 80 }).notNull(),
    labelAr: varchar('label_ar', { length: 80 }),
    source: varchar('source', { length: 8 }).notNull(),
    packKey: varchar('pack_key', { length: 32 }),
    packVersion: varchar('pack_version', { length: 16 }),
    estimated: boolean('estimated').notNull().default(false),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_org_holidays_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_org_holidays_calendar_date').on(
      table.organizationId,
      table.calendarId,
      table.date,
    ),
  ],
);

export type OrgHolidayRow = typeof orgHolidays.$inferSelect;

Object.assign(TABLES, {
  org_working_calendars: orgWorkingCalendars,
  org_holidays: orgHolidays,
});

// ---- R15-c · 54-05 Slack + 54-06 Teams Phase 0 ----

export const CHANNEL_LINK_KINDS = ['slack', 'teams'] as const;
export type ChannelLinkKind = (typeof CHANNEL_LINK_KINDS)[number];
export const CHANNEL_POST_STATUSES = [
  'staged',
  'sending',
  'delivered',
  'failed',
  'cancelled',
] as const;
export type ChannelPostStatus = (typeof CHANNEL_POST_STATUSES)[number];

/**
 * 0289 (54-05 / 54-06 Phase 0). One pasted Slack / Teams incoming-webhook channel. TENANT. The URL
 * lives only in `webhookUrlEnc` (FieldCipher, AAD = link id) and is never projected; `urlHost` is
 * what a caller sees. `externalChannelId` = SHA-256 hex of the URL path. `projectId` NULL = org-wide.
 */
export const integrationChannelLinks = mysqlTable(
  'integration_channel_links',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    connectionId: char('connection_id', { length: 36 }).notNull(),
    kind: varchar('kind', { length: 8 }).notNull(),
    projectId: char('project_id', { length: 36 }),
    externalChannelId: varchar('external_channel_id', { length: 190 }).notNull(),
    externalChannelLabel: varchar('external_channel_label', { length: 300 }),
    webhookUrlEnc: text('webhook_url_enc').notNull(),
    urlHost: varchar('url_host', { length: 255 }).notNull(),
    eventsJson: text('events_json').notNull(),
    locale: varchar('locale', { length: 35 }).notNull().default('en'),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    failureStreak: int('failure_streak').notNull().default(0),
    pausedReason: varchar('paused_reason', { length: 200 }),
    lastPostedAt: datetime('last_posted_at', { mode: 'date', fsp: 3 }),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_icl_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_icl_conn_proj').on(
      table.organizationId,
      table.connectionId,
      table.projectId,
      table.externalChannelId,
    ),
    index('ix_icl_org_status').on(table.organizationId, table.status),
  ],
);

export type IntegrationChannelLinkRow = typeof integrationChannelLinks.$inferSelect;

/**
 * 0289. The channel post ledger, `webhook_deliveries`-shaped: one row per (link, outbox event),
 * retried in place. A test post has no outbox event. TENANT. Cascades with its link.
 */
export const integrationChannelPosts = mysqlTable(
  'integration_channel_posts',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    linkId: char('link_id', { length: 36 }).notNull(),
    outboxEventId: char('outbox_event_id', { length: 36 }),
    eventKind: varchar('event_kind', { length: 64 }).notNull(),
    locale: varchar('locale', { length: 35 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    attempt: int('attempt').notNull().default(1),
    nextAttemptAt: datetime('next_attempt_at', { mode: 'date', fsp: 3 }),
    lastStatusCode: smallint('last_status_code', { unsigned: true }),
    lastError: varchar('last_error', { length: 500 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_icp_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_icp_link_event').on(table.organizationId, table.linkId, table.outboxEventId),
    index('ix_icp_org_due').on(table.organizationId, table.status, table.nextAttemptAt),
    index('ix_icp_link_created').on(table.organizationId, table.linkId, table.createdAt),
  ],
);

export type IntegrationChannelPostRow = typeof integrationChannelPosts.$inferSelect;

Object.assign(TABLES, {
  integration_channel_links: integrationChannelLinks,
  integration_channel_posts: integrationChannelPosts,
});

/**
 * 0288 (52-03). One closed window of whole calendar months: every `work_item_time_logs` entry with
 * `spent_on` inside it carries `locked_at`. TENANT. `unlocked_*` + `reason` stamp a reopen (the row
 * stays as history); one row per organization per `period_start`. Open locks never overlap
 * (checked in `modules/time/locks.service.ts`).
 */
export const timePeriodLocks = mysqlTable(
  'time_period_locks',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    lockedBy: char('locked_by', { length: 36 }).notNull(),
    lockedAt: datetime('locked_at', { mode: 'date', fsp: 3 }).notNull(),
    unlockedBy: char('unlocked_by', { length: 36 }),
    unlockedAt: datetime('unlocked_at', { mode: 'date', fsp: 3 }),
    reason: varchar('reason', { length: 500 }),
    entriesLocked: int('entries_locked').notNull().default(0),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_time_period_locks_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_time_period_locks_start').on(table.organizationId, table.periodStart),
    index('ix_time_period_locks_end').on(table.organizationId, table.periodEnd),
  ],
);

export type TimePeriodLockRow = typeof timePeriodLocks.$inferSelect;

Object.assign(TABLES, {
  time_period_locks: timePeriodLocks,
});

// ---- R15-a · 52-04 rates ----

/**
 * 52-04 (0287). A rate card: one currency at one scope — `org` (`scope_id` NULL), `client` (a
 * client organization id) or `project` (a project id). Tenant-owned; `scope_id` is resolved
 * tenant-scoped by `modules/finance/rates.service.ts` before insert.
 */
export const rateCards = mysqlTable(
  'rate_cards',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    scope: varchar('scope', { length: 16 }).notNull(),
    scopeId: char('scope_id', { length: 36 }),
    name: varchar('name', { length: 120 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    archivedAt: datetime('archived_at', { mode: 'date', fsp: 3 }),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_rate_cards_org_id').on(table.organizationId, table.id),
    index('ix_rate_cards_scope').on(
      table.organizationId,
      table.scope,
      table.scopeId,
      table.archivedAt,
    ),
  ],
);

/** 52-04 (0287). One hourly sell rate of a card over `[effective_from, effective_to)`. */
export const rateCardEntries = mysqlTable(
  'rate_card_entries',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    rateCardId: char('rate_card_id', { length: 36 }).notNull(),
    targetType: varchar('target_type', { length: 16 }).notNull(),
    targetKey: varchar('target_key', { length: 64 }),
    hourlyMinor: bigint('hourly_minor', { mode: 'number' }).notNull(),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    effectiveTo: date('effective_to', { mode: 'string' }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_rate_card_entries_org_id').on(table.organizationId, table.id),
    index('ix_rate_card_entries_target').on(
      table.organizationId,
      table.rateCardId,
      table.targetType,
      table.targetKey,
      table.effectiveFrom,
    ),
  ],
);

/**
 * 52-04 (0287). A member's internal hourly cost (a salary proxy). Behind `finance.manage` only,
 * never in a list projection, redacted in audit changes; the worker holds no grant on it.
 */
export const memberCostRates = mysqlTable(
  'member_cost_rates',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    hourlyCostMinor: bigint('hourly_cost_minor', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    effectiveTo: date('effective_to', { mode: 'string' }),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_member_cost_rates_org_id').on(table.organizationId, table.id),
    index('ix_member_cost_rates_member').on(
      table.organizationId,
      table.membershipId,
      table.effectiveFrom,
    ),
  ],
);

export type RateCardRow = typeof rateCards.$inferSelect;
export type RateCardEntryRow = typeof rateCardEntries.$inferSelect;
export type MemberCostRateRow = typeof memberCostRates.$inferSelect;

/**
 * 52-04 (0287) column views over existing tables. The 0287 columns of `projects`, `work_items` and
 * `work_item_time_logs` are read and written through these narrow mirrors (same SQL table, only
 * the columns the rates code touches) so `ProjectRow` / `WorkItemRow` / `WorkItemTimeLogRow` and
 * the many fixtures built from them keep their shape. Not in `TABLES`: the full definitions above
 * are the registered ones.
 */
export const projectRateSettings = mysqlTable('projects', {
  id: char('id', { length: 36 }).primaryKey(),
  organizationId: char('organization_id', { length: 36 }).notNull(),
  billableDefault: boolean('billable_default').notNull().default(true),
  rateCardId: char('rate_card_id', { length: 36 }),
});

export const workItemBilling = mysqlTable('work_items', {
  id: char('id', { length: 36 }).primaryKey(),
  organizationId: char('organization_id', { length: 36 }).notNull(),
  projectId: char('project_id', { length: 36 }).notNull(),
  billable: boolean('billable'),
});

export const timeLogPricing = mysqlTable('work_item_time_logs', {
  id: char('id', { length: 36 }).primaryKey(),
  organizationId: char('organization_id', { length: 36 }).notNull(),
  projectId: char('project_id', { length: 36 }),
  loggedBy: char('logged_by', { length: 36 }).notNull(),
  spentOn: date('spent_on', { mode: 'string' }).notNull(),
  billable: boolean('billable').notNull().default(true),
  lockedAt: datetime('locked_at', { mode: 'date', fsp: 3 }),
  rateSnapshotMinor: bigint('rate_snapshot_minor', { mode: 'number' }),
  costSnapshotMinor: bigint('cost_snapshot_minor', { mode: 'number' }),
  snapshotCurrency: char('snapshot_currency', { length: 3 }),
  invoiceLineId: char('invoice_line_id', { length: 36 }),
});

Object.assign(TABLES, {
  rate_cards: rateCards,
  rate_card_entries: rateCardEntries,
  member_cost_rates: memberCostRates,
});

// ---- R16-a · 52-02 timesheets ----

/**
 * 0290 (52-02 / 52-03 approval half). One week of one membership: seven days from the org's
 * `week_start`. TENANT. `state` is `open` | `submitted` | `approved` | `changes_requested` (checked
 * in `modules/time/timesheets-rules.ts`); totals are recomputed by SUM with every entry change;
 * `version` is the optimistic lock of the batch edit. Entries point here through
 * `work_item_time_logs.timesheet_id` (no foreign key, app-checked).
 */
export const timesheets = mysqlTable(
  'timesheets',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    state: varchar('state', { length: 16 })
      .$type<'open' | 'submitted' | 'approved' | 'changes_requested'>()
      .notNull()
      .default('open'),
    submittedAt: datetime('submitted_at', { mode: 'date', fsp: 3 }),
    approvalId: char('approval_id', { length: 36 }),
    decidedBy: char('decided_by', { length: 36 }),
    decidedAt: datetime('decided_at', { mode: 'date', fsp: 3 }),
    decisionNote: varchar('decision_note', { length: 500 }),
    editedByManager: boolean('edited_by_manager').notNull().default(false),
    totalMinutes: int('total_minutes').notNull().default(0),
    billableMinutes: int('billable_minutes').notNull().default(0),
    version: bigint('version', { mode: 'number', unsigned: true }).notNull().default(1),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_timesheets_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_timesheets_member_period').on(
      table.organizationId,
      table.membershipId,
      table.periodStart,
    ),
    index('ix_timesheets_org_period_state').on(
      table.organizationId,
      table.periodStart,
      table.state,
    ),
  ],
);

export type TimesheetRow = typeof timesheets.$inferSelect;

Object.assign(TABLES, {
  timesheets,
});

// ---- R16-c · 52-07 expenses ----

/**
 * 52-07 (0292). One spend by one member (`membership_id` from the caller's context) on one day,
 * optionally on a project. `state` is checked in `modules/finance/expenses-rules.ts`;
 * `approval_id` and `invoice_line_id` are reserved; `locked_at` is set only by a later 52-09 path
 * and the 0292 triggers then keep the row's money, date, project and state fixed. Receipt ids name
 * an `expense_receipt` upload; no foreign key to the files tables (the 0257 rule).
 */
export const expenses = mysqlTable(
  'expenses',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }),
    clientOrganizationId: char('client_organization_id', { length: 36 }),
    membershipId: char('membership_id', { length: 36 }).notNull(),
    spentOn: date('spent_on', { mode: 'string' }).notNull(),
    category: varchar('category', { length: 24 }).notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    amountBaseMinor: bigint('amount_base_minor', { mode: 'number' }),
    fxRate: decimal('fx_rate', { precision: 18, scale: 8 }),
    taxBp: int('tax_bp').notNull().default(0),
    billable: boolean('billable').notNull().default(false),
    markupBp: int('markup_bp').notNull().default(0),
    note: varchar('note', { length: 500 }),
    receiptFileAssetId: char('receipt_file_asset_id', { length: 36 }),
    receiptFileVersionId: char('receipt_file_version_id', { length: 36 }),
    state: varchar('state', { length: 16 }).notNull().default('submitted'),
    approvalId: char('approval_id', { length: 36 }),
    approvedBy: char('approved_by', { length: 36 }),
    approvedAt: datetime('approved_at', { mode: 'date', fsp: 3 }),
    rejectedReason: varchar('rejected_reason', { length: 500 }),
    invoiceLineId: char('invoice_line_id', { length: 36 }),
    lockedAt: datetime('locked_at', { mode: 'date', fsp: 3 }),
    version: int('version', { unsigned: true }).notNull().default(1),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_expenses_org_id').on(table.organizationId, table.id),
    index('ix_expenses_project_day').on(table.organizationId, table.projectId, table.spentOn),
    index('ix_expenses_member_state').on(table.organizationId, table.membershipId, table.state),
    index('ix_expenses_receipt').on(table.organizationId, table.receiptFileVersionId),
  ],
);

export type ExpenseRow = typeof expenses.$inferSelect;

Object.assign(TABLES, {
  expenses,
});

// ---- R16-f · 54-11 contact suggestions (Phase 0) ----

export const CONTACT_SUGGESTION_SOURCES = ['csv', 'vcard'] as const;
export type ContactSuggestionSource = (typeof CONTACT_SUGGESTION_SOURCES)[number];

/**
 * 0295 (54-11 Phase 0). One address in one person's invite-suggestion list. TENANT and per user:
 * every read and write also predicates on `userId`, and no route lists another user's rows.
 * `expiresAt` = import time + 90 days, refreshed on re-import; expiry is lazy (read-side filter,
 * plus the caller's expired rows deleted on each import).
 */
export const contactSuggestions = mysqlTable(
  'contact_suggestions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    userId: char('user_id', { length: 36 }).notNull(),
    source: varchar('source', { length: 16 }).notNull(),
    displayName: varchar('display_name', { length: 300 }),
    email: varchar('email', { length: 320 }).notNull(),
    company: varchar('company', { length: 300 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_cs_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_cs_user_email').on(table.organizationId, table.userId, table.email),
    index('ix_cs_user_expiry').on(table.organizationId, table.userId, table.expiresAt),
  ],
);

export type ContactSuggestionRow = typeof contactSuggestions.$inferSelect;

Object.assign(TABLES, {
  contact_suggestions: contactSuggestions,
});

// ---- R16-e · 54-10 GitHub Phase 0 ----

export const GITHUB_HOOK_STATUSES = ['active', 'paused'] as const;
export type GithubHookStatus = (typeof GITHUB_HOOK_STATUSES)[number];
export const CODE_LINK_KINDS = ['branch', 'pr', 'commit'] as const;
export type CodeLinkKind = (typeof CODE_LINK_KINDS)[number];

/**
 * 0294 (54-10 Phase 0). One pasted GitHub repository webhook. TENANT. The HMAC secret lives only in
 * `secretEnc` (FieldCipher `integration_token`, AAD = hook id) and is never projected.
 * `projectIdsJson` = the frozen project ids a key may resolve in.
 */
export const githubRepoHooks = mysqlTable(
  'github_repo_hooks',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    connectionId: char('connection_id', { length: 36 }).notNull(),
    repoFullName: varchar('repo_full_name', { length: 300 }).notNull(),
    secretEnc: text('secret_enc').notNull(),
    projectIdsJson: text('project_ids_json').notNull(),
    status: varchar('status', { length: 10 }).notNull().default('active'),
    eventsHourStartedAt: datetime('events_hour_started_at', { mode: 'date', fsp: 3 }),
    eventsHourCount: int('events_hour_count').notNull().default(0),
    lastEventAt: datetime('last_event_at', { mode: 'date', fsp: 3 }),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_github_repo_hooks_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_github_repo_hooks_repo').on(table.organizationId, table.repoFullName),
  ],
);

export type GithubRepoHookRow = typeof githubRepoHooks.$inferSelect;

/** 0294. The replay guard: one row per (hook, `X-GitHub-Delivery`). TENANT. Cascades with its hook. */
export const githubDeliveries = mysqlTable(
  'github_deliveries',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    hookId: char('hook_id', { length: 36 }).notNull(),
    deliveryId: varchar('delivery_id', { length: 64 }).notNull(),
    receivedAt: datetime('received_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_github_deliveries_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_github_deliveries_delivery').on(
      table.organizationId,
      table.hookId,
      table.deliveryId,
    ),
    index('ix_github_deliveries_received').on(table.organizationId, table.hookId, table.receivedAt),
  ],
);

export type GithubDeliveryRow = typeof githubDeliveries.$inferSelect;

/** 0294. One branch / pull request / commit linked to one work item. TENANT. Internal only. */
export const workItemCodeLinks = mysqlTable(
  'work_item_code_links',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    connectionId: char('connection_id', { length: 36 }),
    provider: varchar('provider', { length: 16 }).notNull(),
    repoFullName: varchar('repo_full_name', { length: 300 }).notNull(),
    linkKind: varchar('link_kind', { length: 16 }).notNull(),
    externalId: varchar('external_id', { length: 190 }).notNull(),
    title: varchar('title', { length: 500 }),
    state: varchar('state', { length: 32 }),
    url: varchar('url', { length: 2048 }).notNull(),
    actorLogin: varchar('actor_login', { length: 190 }),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_wicl_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_wicl_item_ext').on(
      table.organizationId,
      table.workItemId,
      table.provider,
      table.linkKind,
      table.externalId,
    ),
  ],
);

export type WorkItemCodeLinkRow = typeof workItemCodeLinks.$inferSelect;

/**
 * 0294 column views over `projects` / `work_items` (the 0287 pattern): only the work-key columns,
 * so `ProjectRow` / `WorkItemRow` and their fixtures keep their shape. Not in `TABLES`.
 */
export const projectWorkKeys = mysqlTable('projects', {
  id: char('id', { length: 36 }).primaryKey(),
  organizationId: char('organization_id', { length: 36 }).notNull(),
  archivedAt: datetime('archived_at', { mode: 'date', fsp: 3 }),
  workKeyPrefix: varchar('work_key_prefix', { length: 10 }),
  workKeyNext: int('work_key_next', { unsigned: true }).notNull().default(1),
});

export const workItemWorkKeys = mysqlTable('work_items', {
  id: char('id', { length: 36 }).primaryKey(),
  organizationId: char('organization_id', { length: 36 }).notNull(),
  projectId: char('project_id', { length: 36 }).notNull(),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
  workKey: varchar('work_key', { length: 20 }),
});

Object.assign(TABLES, {
  github_repo_hooks: githubRepoHooks,
  github_deliveries: githubDeliveries,
  work_item_code_links: workItemCodeLinks,
});

// ---- R16-b · 52-05 budgets and burn ----

/**
 * 52-05 (0291). An optional split of a project's budget by phase. `phaseId` names a
 * `project_phases` definition row (resolved tenant-scoped by the service) or is NULL. Replace-all
 * on save, at most 20 lines.
 */
export const projectBudgetPhases = mysqlTable(
  'project_budget_phases',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    phaseId: char('phase_id', { length: 36 }),
    name: varchar('name', { length: 120 }).notNull(),
    budgetMinutes: int('budget_minutes'),
    budgetAmountMinor: bigint('budget_amount_minor', { mode: 'number' }),
    position: int('position').notNull().default(0),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_project_budget_phases_org_id').on(table.organizationId, table.id),
    index('ix_project_budget_phases_project').on(
      table.organizationId,
      table.projectId,
      table.position,
    ),
  ],
);

/**
 * 52-05 (0291). One threshold alert the burn sweep raised. History: inserted by the worker, never
 * updated or deleted. `notifiedTo` is a JSON array of user ids stored as TEXT.
 */
export const budgetAlertEvents = mysqlTable(
  'budget_alert_events',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    thresholdBp: int('threshold_bp').notNull(),
    usedBp: int('used_bp').notNull(),
    notifiedTo: text('notified_to').notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_budget_alert_events_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_budget_alert_events_dedupe').on(
      table.organizationId,
      table.projectId,
      table.thresholdBp,
      table.createdAt,
    ),
  ],
);

export type ProjectBudgetPhaseRow = typeof projectBudgetPhases.$inferSelect;
export type BudgetAlertEventRow = typeof budgetAlertEvents.$inferSelect;

Object.assign(TABLES, {
  project_budget_phases: projectBudgetPhases,
  budget_alert_events: budgetAlertEvents,
});

// ---- R17-c · 53-05 baselines on the timeline (0298) ----
/**
 * 53-05 (0298). One work item frozen into a 'full' project baseline: civil start/due dates in the
 * org calendar's zone at snapshot time, the working-day duration and the item's version then.
 * INSERT-only for the app; removed with its baseline (composite FK, ON DELETE CASCADE). No FK to
 * `work_items` — a purged item's frozen row is what variance reports as 'removed'.
 */
export const projectBaselineItems = mysqlTable(
  'project_baseline_items',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    baselineId: char('baseline_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    startAt: date('start_at', { mode: 'string' }),
    dueAt: date('due_at', { mode: 'string' }),
    durationWorkingDays: smallint('duration_working_days'),
    itemVersion: int('item_version', { unsigned: true }),
    milestoneId: char('milestone_id', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_project_baseline_items_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_project_baseline_items_baseline_item').on(
      table.organizationId,
      table.baselineId,
      table.workItemId,
    ),
  ],
);

export type ProjectBaselineItemRow = typeof projectBaselineItems.$inferSelect;

Object.assign(TABLES, {
  project_baseline_items: projectBaselineItems,
});

// ---- R17-a · 52-14 profitability and utilisation reports ----

/**
 * 0296 (52-14). One derived row per organization × day × project × member: the minutes and money
 * the profitability and utilisation reports read. TENANT. `projectId` / `membershipId` are '' when
 * absent (the unique grain cannot hold NULL). Rebuilt by DELETE + INSERT of a window — by the
 * worker's nightly loop and the on-demand rebuild route — never updated in place.
 */
export const financeDailyFacts = mysqlTable(
  'finance_daily_facts',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull().default(''),
    clientOrganizationId: char('client_organization_id', { length: 36 }),
    membershipId: char('membership_id', { length: 36 }).notNull().default(''),
    billableMinutes: int('billable_minutes').notNull().default(0),
    nonbillableMinutes: int('nonbillable_minutes').notNull().default(0),
    writeoffMinutes: int('writeoff_minutes').notNull().default(0),
    unpricedMinutes: int('unpriced_minutes').notNull().default(0),
    billedMinor: bigint('billed_minor', { mode: 'number' }).notNull().default(0),
    costMinor: bigint('cost_minor', { mode: 'number' }).notNull().default(0),
    expenseMinor: bigint('expense_minor', { mode: 'number' }).notNull().default(0),
    invoicedMinor: bigint('invoiced_minor', { mode: 'number' }).notNull().default(0),
    currency: char('currency', { length: 3 }),
    computedAt: datetime('computed_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_finance_daily_facts_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_finance_daily_facts_grain').on(
      table.organizationId,
      table.day,
      table.projectId,
      table.membershipId,
    ),
    index('ix_finance_daily_facts_client').on(
      table.organizationId,
      table.day,
      table.clientOrganizationId,
    ),
    index('ix_finance_daily_facts_project').on(table.organizationId, table.projectId, table.day),
    index('ix_finance_daily_facts_computed').on(table.organizationId, table.computedAt),
  ],
);

export type FinanceDailyFactRow = typeof financeDailyFacts.$inferSelect;

Object.assign(TABLES, {
  finance_daily_facts: financeDailyFacts,
});

// ---- R17-d · 52-06 retainers ----

/**
 * 52-06 (0299). A retainer: an allowance per period (hours and/or an amount in the base currency)
 * for one client organization. `period`, `rollover`, `billingTiming` and `state` are closed lists
 * checked in `modules/finance/retainers-rules.ts`. `rateCardId` is reserved for 52-09.
 */
export const retainers = mysqlTable(
  'retainers',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    clientOrganizationId: char('client_organization_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    period: varchar('period', { length: 12 }).notNull().default('monthly'),
    hoursPerPeriod: int('hours_per_period'),
    amountPerPeriodMinor: bigint('amount_per_period_minor', { mode: 'number' }),
    currency: char('currency', { length: 3 }),
    rollover: varchar('rollover', { length: 12 }).notNull().default('none'),
    rolloverCapMinutes: int('rollover_cap_minutes'),
    billingTiming: varchar('billing_timing', { length: 12 }).notNull().default('advance'),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }),
    state: varchar('state', { length: 12 }).notNull().default('active'),
    clientVisible: boolean('client_visible').notNull().default(true),
    rateCardId: char('rate_card_id', { length: 36 }),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_retainers_org_id').on(table.organizationId, table.id),
    index('ix_retainers_client_state').on(
      table.organizationId,
      table.clientOrganizationId,
      table.state,
    ),
  ],
);

/** 52-06 (0299). A project a retainer covers; one retainer per project at a time (service 409). */
export const retainerProjects = mysqlTable(
  'retainer_projects',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    retainerId: char('retainer_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_retainer_projects_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_retainer_projects_identity').on(
      table.organizationId,
      table.retainerId,
      table.projectId,
    ),
    index('ix_retainer_projects_project').on(table.organizationId, table.projectId),
  ],
);

/**
 * 52-06 (0299). One period of a retainer. `(organizationId, retainerId, periodStart)` is unique:
 * the worker roll's idempotency key. The caches are derived (frozen at close); `invoiceId` is
 * reserved for 52-09.
 */
export const retainerPeriods = mysqlTable(
  'retainer_periods',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    retainerId: char('retainer_id', { length: 36 }).notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    allowanceMinutes: int('allowance_minutes').notNull().default(0),
    rolloverInMinutes: int('rollover_in_minutes').notNull().default(0),
    usedMinutesCache: int('used_minutes_cache').notNull().default(0),
    overageMinutesCache: int('overage_minutes_cache').notNull().default(0),
    state: varchar('state', { length: 12 }).notNull().default('open'),
    invoiceId: char('invoice_id', { length: 36 }),
    closedAt: datetime('closed_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_retainer_periods_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_retainer_periods_start').on(
      table.organizationId,
      table.retainerId,
      table.periodStart,
    ),
    index('ix_retainer_periods_open').on(table.state, table.periodEnd),
  ],
);

/**
 * 0299's reserved `work_item_time_logs.retainer_period_id`, as a narrow mirror (the
 * `timeLogPricing` pattern) so `WorkItemTimeLogRow` and its fixtures keep their shape. Never
 * written in 52-06: attribution is a read-time SUM. Not in `TABLES`.
 */
export const timeLogRetainer = mysqlTable('work_item_time_logs', {
  id: char('id', { length: 36 }).primaryKey(),
  organizationId: char('organization_id', { length: 36 }).notNull(),
  retainerPeriodId: char('retainer_period_id', { length: 36 }),
});

export type RetainerRow = typeof retainers.$inferSelect;
export type RetainerProjectRow = typeof retainerProjects.$inferSelect;
export type RetainerPeriodRow = typeof retainerPeriods.$inferSelect;

Object.assign(TABLES, {
  retainers,
  retainer_projects: retainerProjects,
  retainer_periods: retainerPeriods,
});

// ---- R17-b · 53-06 critical path, float and schedule health ----

/**
 * 53-06 (0297). One project's critical-path answer per scheduled work item, replaced whole by each
 * recompute under one `batchId`. Dates are company-calendar civil dates (`YYYY-MM-DD`). No id: the
 * primary key leads with the tenant column. No foreign key to `work_items` (a deleted item has no
 * row in the next batch); the project is bound by the composite key.
 */
export const workItemScheduleStats = mysqlTable(
  'work_item_schedule_stats',
  {
    organizationId: char('organization_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    earlyStart: date('early_start', { mode: 'string' }),
    earlyFinish: date('early_finish', { mode: 'string' }),
    lateStart: date('late_start', { mode: 'string' }),
    lateFinish: date('late_finish', { mode: 'string' }),
    totalFloatDays: smallint('total_float_days'),
    isCritical: boolean('is_critical').notNull().default(false),
    batchId: char('batch_id', { length: 36 }).notNull(),
    computedAt: datetime('computed_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.workItemId] }),
    index('ix_work_item_schedule_stats_project').on(
      table.organizationId,
      table.projectId,
      table.isCritical,
    ),
  ],
);

export type WorkItemScheduleStatsRow = typeof workItemScheduleStats.$inferSelect;

Object.assign(TABLES, {
  work_item_schedule_stats: workItemScheduleStats,
});

// ---- R17-e · 53-09 recurring work v2 (0300) ----
/** The two states an occurrence row can record (checked in the application). */
export const WORK_ITEM_RECURRENCE_INSTANCE_STATUSES = ['created', 'skipped'] as const;

/**
 * 53-09 (0300). One occurrence a recurrence series has dealt with: `created` (an item was spawned)
 * or `skipped`. `uq_wiri_occurrence (organization_id, recurrence_id, occurrence_key)` is the spawner's
 * idempotency key — the row is inserted before the item is created, so a restart never spawns twice.
 * Removed with its rule (composite FK, ON DELETE CASCADE); never rewritten by "edit series".
 */
export const workItemRecurrenceInstances = mysqlTable(
  'work_item_recurrence_instances',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    recurrenceId: char('recurrence_id', { length: 36 }).notNull(),
    occurrenceKey: varchar('occurrence_key', { length: 32 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }),
    previousWorkItemId: char('previous_work_item_id', { length: 36 }),
    status: varchar('status', { length: 8 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_wiri_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_wiri_occurrence').on(
      table.organizationId,
      table.recurrenceId,
      table.occurrenceKey,
    ),
  ],
);

export type WorkItemRecurrenceInstanceRow = typeof workItemRecurrenceInstances.$inferSelect;

Object.assign(TABLES, {
  work_item_recurrence_instances: workItemRecurrenceInstances,
});

// ---- R18-a · 52-09 client invoices (0301) ----

export const CLIENT_INVOICE_STATES = [
  'draft',
  'sent',
  'partially_paid',
  'paid',
  'void',
  'credited',
] as const;
export type ClientInvoiceState = (typeof CLIENT_INVOICE_STATES)[number];

/**
 * 52-09 (0301). A client invoice. TENANT. Closed lists (`kind`, `language`, `state`) are checked in
 * `modules/finance/client-invoices-rules.ts`. `number` is NULL while draft and assigned at send; the
 * 0301 trigger freezes the money, dates, client, number and snapshots once `state <> 'draft'`.
 */
export const clientInvoices = mysqlTable(
  'client_invoices',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    clientOrganizationId: char('client_organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }),
    retainerPeriodId: char('retainer_period_id', { length: 36 }),
    quoteId: char('quote_id', { length: 36 }),
    number: varchar('number', { length: 32 }),
    kind: varchar('kind', { length: 16 }).notNull().default('standard'),
    language: varchar('language', { length: 2 }).notNull().default('bi'),
    state: varchar('state', { length: 16 }).$type<ClientInvoiceState>().notNull().default('draft'),
    documentLabel: varchar('document_label', { length: 16 }).notNull().default('invoice'),
    issueDate: date('issue_date', { mode: 'string' }),
    dueDate: date('due_date', { mode: 'string' }),
    supplyDate: date('supply_date', { mode: 'string' }),
    periodStart: date('period_start', { mode: 'string' }),
    periodEnd: date('period_end', { mode: 'string' }),
    currency: char('currency', { length: 3 }).notNull(),
    baseCurrency: char('base_currency', { length: 3 }).notNull(),
    fxRate: decimal('fx_rate', { precision: 18, scale: 8 }),
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull().default(0),
    discountMinor: bigint('discount_minor', { mode: 'number' }).notNull().default(0),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull().default(0),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull().default(0),
    paidMinor: bigint('paid_minor', { mode: 'number' }).notNull().default(0),
    depositAppliedMinor: bigint('deposit_applied_minor', { mode: 'number' }).notNull().default(0),
    poNumber: varchar('po_number', { length: 64 }),
    notesText: text('notes_text'),
    internalNote: text('internal_note'),
    termsText: text('terms_text'),
    buyerSnapshotJson: text('buyer_snapshot_json'),
    sellerSnapshotJson: text('seller_snapshot_json'),
    contentHash: char('content_hash', { length: 64 }),
    sendKeyHash: char('send_key_hash', { length: 64 }),
    pdfFileAssetId: char('pdf_file_asset_id', { length: 36 }),
    pdfFileVersionId: char('pdf_file_version_id', { length: 36 }),
    xmlFileAssetId: char('xml_file_asset_id', { length: 36 }),
    sentAt: datetime('sent_at', { mode: 'date', fsp: 3 }),
    sentTo: varchar('sent_to', { length: 254 }),
    viewedAt: datetime('viewed_at', { mode: 'date', fsp: 3 }),
    paidAt: datetime('paid_at', { mode: 'date', fsp: 3 }),
    voidedAt: datetime('voided_at', { mode: 'date', fsp: 3 }),
    voidReason: varchar('void_reason', { length: 500 }),
    exportedAt: datetime('exported_at', { mode: 'date', fsp: 3 }),
    exportTarget: varchar('export_target', { length: 24 }),
    /** 52-28 (0303): ETA uuid / ZATCA uuid / accounting-tool ref, entered by the agency. */
    taxRegistrationRef: varchar('tax_registration_ref', { length: 64 }),
    taxRegisteredAt: datetime('tax_registered_at', { mode: 'date', fsp: 3 }),
    /** 52-28 (0303): 1 when the "not a tax invoice" line went out with the sent document. */
    taxNoticeShown: boolean('tax_notice_shown').notNull().default(false),
    createdBy: char('created_by', { length: 36 }).notNull(),
    version: bigint('version', { mode: 'number', unsigned: true }).notNull().default(1),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_ci_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_ci_number').on(table.organizationId, table.number),
    index('ix_ci_client_state').on(
      table.organizationId,
      table.clientOrganizationId,
      table.state,
      table.issueDate,
    ),
    index('ix_ci_due').on(table.organizationId, table.state, table.dueDate),
  ],
);

/** 52-09 (0301). One line; `quantityCenti` is hundredths; amounts are server-computed. TENANT. */
export const clientInvoiceLines = mysqlTable(
  'client_invoice_lines',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    invoiceId: char('invoice_id', { length: 36 }).notNull(),
    position: int('position').notNull(),
    sourceType: varchar('source_type', { length: 16 }).notNull().default('manual'),
    descriptionEn: varchar('description_en', { length: 500 }),
    descriptionAr: varchar('description_ar', { length: 500 }),
    quantityCenti: int('quantity_centi').notNull(),
    unit: varchar('unit', { length: 12 }).notNull().default('item'),
    unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }).notNull(),
    discountBp: int('discount_bp').notNull().default(0),
    taxRateId: char('tax_rate_id', { length: 36 }),
    taxBp: int('tax_bp').notNull().default(0),
    taxCategory: varchar('tax_category', { length: 4 }),
    lineDiscountMinor: bigint('line_discount_minor', { mode: 'number' }).notNull().default(0),
    lineNetMinor: bigint('line_net_minor', { mode: 'number' }).notNull(),
    lineTaxMinor: bigint('line_tax_minor', { mode: 'number' }).notNull(),
    lineGrossMinor: bigint('line_gross_minor', { mode: 'number' }).notNull(),
    groupKey: varchar('group_key', { length: 64 }),
    sourceIdsJson: text('source_ids_json'),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_cil_org_id').on(table.organizationId, table.id),
    index('ix_cil_invoice').on(table.organizationId, table.invoiceId, table.position),
  ],
);

/** 52-09 (0301). A recorded payment. Append-only. TENANT. */
export const clientInvoicePayments = mysqlTable(
  'client_invoice_payments',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    invoiceId: char('invoice_id', { length: 36 }).notNull(),
    paidOn: date('paid_on', { mode: 'string' }).notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    method: varchar('method', { length: 16 }).notNull(),
    reference: varchar('reference', { length: 120 }),
    note: varchar('note', { length: 500 }),
    recordedBy: char('recorded_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_cip_org_id').on(table.organizationId, table.id),
    index('ix_cip_invoice').on(table.organizationId, table.invoiceId, table.paidOn),
  ],
);

/** 52-09 (0301). A credit note with its own gapless number. Append-only. TENANT. */
export const clientCreditNotes = mysqlTable(
  'client_credit_notes',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    invoiceId: char('invoice_id', { length: 36 }).notNull(),
    number: varchar('number', { length: 32 }).notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull(),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull(),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),
    contentHash: char('content_hash', { length: 64 }).notNull(),
    pdfFileAssetId: char('pdf_file_asset_id', { length: 36 }),
    xmlFileAssetId: char('xml_file_asset_id', { length: 36 }),
    issuedAt: datetime('issued_at', { mode: 'date', fsp: 3 }).notNull(),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_ccn_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_ccn_number').on(table.organizationId, table.number),
    index('ix_ccn_invoice').on(table.organizationId, table.invoiceId),
  ],
);

/** 52-09 (0301). One line of a credit note. Append-only. TENANT. */
export const clientCreditNoteLines = mysqlTable(
  'client_credit_note_lines',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    creditNoteId: char('credit_note_id', { length: 36 }).notNull(),
    position: int('position').notNull(),
    descriptionEn: varchar('description_en', { length: 500 }),
    descriptionAr: varchar('description_ar', { length: 500 }),
    quantityCenti: int('quantity_centi').notNull(),
    unit: varchar('unit', { length: 12 }).notNull().default('item'),
    unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }).notNull(),
    taxBp: int('tax_bp').notNull().default(0),
    lineNetMinor: bigint('line_net_minor', { mode: 'number' }).notNull(),
    lineTaxMinor: bigint('line_tax_minor', { mode: 'number' }).notNull(),
    lineGrossMinor: bigint('line_gross_minor', { mode: 'number' }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_ccnl_org_id').on(table.organizationId, table.id),
    index('ix_ccnl_note').on(table.organizationId, table.creditNoteId, table.position),
  ],
);

/** 52-09 (0301). The invoice timeline. Append-only. TENANT. */
export const clientInvoiceEvents = mysqlTable(
  'client_invoice_events',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    invoiceId: char('invoice_id', { length: 36 }).notNull(),
    kind: varchar('kind', { length: 24 }).notNull(),
    actorKind: varchar('actor_kind', { length: 8 }).notNull(),
    actorId: char('actor_id', { length: 36 }),
    ip: varchar('ip', { length: 45 }),
    ua: varchar('ua', { length: 255 }),
    payloadJson: text('payload_json'),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_cie_org_id').on(table.organizationId, table.id),
    index('ix_cie_invoice').on(table.organizationId, table.invoiceId, table.kind, table.createdAt),
  ],
);

/**
 * 0301's eight billing columns on `client_organizations`, as a narrow mirror (the `timeLogPricing`
 * pattern) so `clientOrganizations` and its fixtures keep their shape. Not in `TABLES`.
 */
export const clientOrganizationBilling = mysqlTable('client_organizations', {
  id: char('id', { length: 36 }).primaryKey(),
  organizationId: char('organization_id', { length: 36 }).notNull(),
  name: varchar('name', { length: 190 }).notNull(),
  legalNameEn: varchar('legal_name_en', { length: 200 }),
  legalNameAr: varchar('legal_name_ar', { length: 200 }),
  taxRegistrationNo: varchar('tax_registration_no', { length: 32 }),
  billingAddressEn: varchar('billing_address_en', { length: 500 }),
  billingAddressAr: varchar('billing_address_ar', { length: 500 }),
  billingEmail: varchar('billing_email', { length: 254 }),
  defaultCurrency: char('default_currency', { length: 3 }),
  paymentTermsDays: int('payment_terms_days'),
});

export type ClientInvoiceRow = typeof clientInvoices.$inferSelect;
export type ClientInvoiceLineRow = typeof clientInvoiceLines.$inferSelect;
export type ClientInvoicePaymentRow = typeof clientInvoicePayments.$inferSelect;
export type ClientCreditNoteRow = typeof clientCreditNotes.$inferSelect;
export type ClientCreditNoteLineRow = typeof clientCreditNoteLines.$inferSelect;
export type ClientInvoiceEventRow = typeof clientInvoiceEvents.$inferSelect;
export type ClientOrganizationBillingRow = typeof clientOrganizationBilling.$inferSelect;

Object.assign(TABLES, {
  client_invoices: clientInvoices,
  client_invoice_lines: clientInvoiceLines,
  client_invoice_payments: clientInvoicePayments,
  client_credit_notes: clientCreditNotes,
  client_credit_note_lines: clientCreditNoteLines,
  client_invoice_events: clientInvoiceEvents,
});

// ---- R19-b · 52-11 accounting export by file (0304) ----
/**
 * 52-11 (0304). One accounting export run: target, period, kinds, record counts and the SHA-256 of
 * its `manifest.json`. The zip itself is never stored (streamed once). Append-only. TENANT.
 */
export const financeExports = mysqlTable(
  'finance_exports',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    target: varchar('target', { length: 24 }).notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    kinds: varchar('kinds', { length: 64 }).notNull(),
    rowCountsJson: text('row_counts_json').notNull(),
    manifestSha256: char('manifest_sha256', { length: 64 }).notNull(),
    latinOnly: boolean('latin_only').notNull().default(false),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_finance_exports_org_id').on(table.organizationId, table.id),
    index('ix_finance_exports_org_created').on(table.organizationId, table.createdAt),
  ],
);

export type FinanceExportRow = typeof financeExports.$inferSelect;

Object.assign(TABLES, { finance_exports: financeExports });

// ---- R19-d · 53-21 iterations (light sprints) and points (0306) ----
/**
 * 53-21 (0306). A named, dated slice of one project's work. TENANT. `status` is planned | active |
 * completed (app-checked); `completedAt` is set once by complete-and-roll. No DELETE grant.
 */
export const iterations = mysqlTable(
  'iterations',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    goal: varchar('goal', { length: 300 }),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    status: varchar('status', { length: 12 }).notNull().default('planned'),
    completedAt: datetime('completed_at', { mode: 'date', fsp: 3 }),
    movedCount: int('moved_count'),
    leftCount: int('left_count'),
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
    version: int('version').notNull().default(1),
  },
  (table) => [
    uniqueIndex('uq_iterations_org_id').on(table.organizationId, table.id),
    index('ix_iterations_org_project_starts').on(
      table.organizationId,
      table.projectId,
      table.startsOn,
    ),
  ],
);

/**
 * 0306's three `work_items` planning columns, as a narrow mirror (the `timeLogPricing` pattern) so
 * `WorkItemRow` and its many fixtures keep their shape. Not in `TABLES`. Never read by a client
 * projection.
 */
export const workItemPlanning = mysqlTable('work_items', {
  id: char('id', { length: 36 }).primaryKey(),
  organizationId: char('organization_id', { length: 36 }).notNull(),
  projectId: char('project_id', { length: 36 }).notNull(),
  title: varchar('title', { length: 300 }).notNull(),
  state: varchar('state', { length: 32 }).notNull(),
  audience: varchar('audience', { length: 32 }).notNull(),
  completedAt: datetime('completed_at', { mode: 'date', fsp: 3 }),
  deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
  iterationId: char('iteration_id', { length: 36 }),
  points: smallint('points'),
  iterationAssignedAt: datetime('iteration_assigned_at', { mode: 'date', fsp: 3 }),
});

/** 0306's `projects.points_enabled`, as a narrow mirror. Not in `TABLES`. */
export const projectPlanning = mysqlTable('projects', {
  id: char('id', { length: 36 }).primaryKey(),
  organizationId: char('organization_id', { length: 36 }).notNull(),
  pointsEnabled: boolean('points_enabled').notNull().default(false),
});

export type IterationRow = typeof iterations.$inferSelect;
export type WorkItemPlanningRow = typeof workItemPlanning.$inferSelect;

Object.assign(TABLES, {
  iterations,
});

// ---- R19-c · 53-07 milestones and phases on the timeline (0305) ----
/**
 * 53-07 (0305). The published client copy of one milestone: only the allowlisted columns (client
 * title, committed date, client status, phase name), copied at publish time. The portal timeline
 * reads this table and never the live `project_milestones` row. Unpublish deletes the copy. TENANT.
 */
export const milestoneClientProjections = mysqlTable(
  'milestone_client_projections',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    milestoneId: char('milestone_id', { length: 36 }).notNull(),
    clientTitle: varchar('client_title', { length: 300 }).notNull(),
    committedOn: date('committed_on', { mode: 'string' }),
    status: varchar('status', { length: 16 }).notNull(),
    phaseName: varchar('phase_name', { length: 200 }),
    publishedByUserId: char('published_by_user_id', { length: 36 }).notNull(),
    publishedAt: datetime('published_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_mcp_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_mcp_org_milestone').on(table.organizationId, table.milestoneId),
    index('ix_mcp_org_project').on(table.organizationId, table.projectId),
  ],
);

export type MilestoneClientProjectionRow = typeof milestoneClientProjections.$inferSelect;

Object.assign(TABLES, {
  milestone_client_projections: milestoneClientProjections,
});
