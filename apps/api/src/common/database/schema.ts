import {
  bigint,
  boolean,
  char,
  date,
  datetime,
  index,
  json,
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
    agendaNote: text('agenda_note'),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_meetings_org_id').on(table.organizationId, table.id),
    index('ix_meetings_org_project').on(table.organizationId, table.projectId, table.startsAt),
  ],
);

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
    body: text('body').notNull(),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_documents_org_id').on(table.organizationId, table.id),
    index('ix_documents_org_project').on(table.organizationId, table.projectId, table.id),
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
    dueOn: date('due_on', { mode: 'string' }),
    status: mysqlEnum('status', PROJECT_MILESTONE_STATUSES).notNull().default('planned'),
    published: boolean('published').notNull().default(false),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
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

export const MEETING_ATTENDEE_RSVPS = ['invited', 'accepted', 'declined'] as const;

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
    body: text('body').notNull(),
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
    bodySnapshot: text('body_snapshot').notNull(),
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
  },
  (table) => [
    uniqueIndex('uq_document_comments_org_id').on(table.organizationId, table.id),
    index('ix_document_comments_org_document').on(table.organizationId, table.documentId, table.id),
  ],
);

/**
 * DEC-01 (x113). The statuses a decision on the register may hold. Set at creation this slice; the
 * transitions between them are the deferred lifecycle (NEXT-SCOPES-9). `0037_decisions.sql` is the
 * source of truth; this mirrors its `ENUM`.
 */
export const DECISION_STATUSES = ['proposed', 'accepted', 'superseded'] as const;

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
    decidedBy: char('decided_by', { length: 36 }).notNull(),
    decidedAt: datetime('decided_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
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
    createdBy: char('created_by', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_project_templates_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_project_templates_org_name').on(table.organizationId, table.name),
    index('ix_project_templates_org_created').on(table.organizationId, table.createdAt),
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
 * is resolving an open entry, exactly once (0011's trigger). `active_item` is a stored
 * generated column — the work item id while unresolved, NULL after — so
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
    /** Engine-computed; never written by the application. See the migration. */
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
 * rather than a leak. `organization_id` and `work_item_id` are pinned immutable by the migration's
 * `BEFORE UPDATE` trigger; there is no edit path this slice.
 */
export const workItemTimeLogs = mysqlTable(
  'work_item_time_logs',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    workItemId: char('work_item_id', { length: 36 }).notNull(),
    loggedBy: char('logged_by', { length: 36 }).notNull(),
    minutes: int('minutes', { unsigned: true }).notNull(),
    spentOn: date('spent_on', { mode: 'string' }).notNull(),
    note: varchar('note', { length: 500 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_work_item_time_logs_org_id').on(table.organizationId, table.id),
    index('ix_work_item_time_logs_item').on(
      table.organizationId,
      table.workItemId,
      table.spentOn,
      table.id,
    ),
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
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Approvals — FR-05 (0027)
// ─────────────────────────────────────────────────────────────────────────────

/** `23-ERD-AND-STATE-MACHINES` §8: how multiple reviewers combine (domain `ApprovalPolicy`). */
export const APPROVAL_POLICIES = ['all_required', 'any_one', 'ordered_sequence'] as const;

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
    /** A lowercase hex SHA-256 digest (`content-hash.ts`). */
    contentHash: char('content_hash', { length: 64 }).notNull(),
    createdByUserId: char('created_by_user_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_deliverable_versions_org_id').on(table.organizationId, table.id),
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

// ─────────────────────────────────────────────────────────────────────────────
// Files — FILE-001 (0015)
// ─────────────────────────────────────────────────────────────────────────────

/** `openapi.yaml` `CreateUploadSessionRequest.purpose`, and the ENUM on both file tables. */
export const UPLOAD_PURPOSES = [
  'message_attachment',
  'request_attachment',
  'deliverable',
  'document',
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
  },
  (table) => [
    uniqueIndex('uq_work_forms_org_id').on(table.organizationId, table.id),
    index('ix_work_forms_org_name').on(table.organizationId, table.name, table.id),
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
  },
  (table) => [
    uniqueIndex('uq_webhook_deliveries_org_id').on(table.organizationId, table.id),
    index('ix_webhook_deliveries_org_endpoint').on(
      table.organizationId,
      table.endpointId,
      table.id,
    ),
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
export const conversations = mysqlTable(
  'conversations',
  {
    id: char('id', { length: 36 }).primaryKey(),
    organizationId: char('organization_id', { length: 36 }).notNull(),
    projectId: char('project_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    nextSequenceNo: bigint('next_sequence_no', { mode: 'number', unsigned: true })
      .notNull()
      .default(1),
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
    body: text('body').notNull(),
    /**
     * The sanitised rich-text document, exactly as `sanitizeRichText` admitted it, or NULL
     * for a plain-text message (every CHAT-001 row, and every plain post since). `body` is
     * derived from it by `richTextToPlainText`, so the two cannot disagree about what was
     * said. See `0008_message_rich_text.sql`.
     */
    bodyRich: json('body_rich').$type<unknown>(),
    clientGeneratedId: char('client_generated_id', { length: 36 }),
    editedAt: datetime('edited_at', { mode: 'date', fsp: 3 }),
    deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
    deletedByUserId: char('deleted_by_user_id', { length: 36 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
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
export const NOTIFICATION_KINDS = ['client_request', 'work_item', 'message', 'file'] as const;
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
  },
  (table) => [
    uniqueIndex('uq_audit_events_org_id').on(table.organizationId, table.id),
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
  },
  (table) => [
    index('ix_authentication_events_user').on(table.userId, table.occurredAt),
    index('ix_authentication_events_occurred').on(table.occurredAt),
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
    bodyText: text('body_text').notNull(),
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
    membershipId: char('membership_id', { length: 36 }).notNull(),
    lastReadMessageId: char('last_read_message_id', { length: 36 }).notNull(),
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
  ],
);

export type ConversationReadStateRow = typeof conversationReadState.$inferSelect;

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
  },
  (table) => [
    uniqueIndex('uq_work_item_recurrence_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_work_item_recurrence_item').on(table.organizationId, table.workItemId),
  ],
);

export type WorkItemRecurrenceRow = typeof workItemRecurrence.$inferSelect;
export type NewWorkItemRecurrenceRow = typeof workItemRecurrence.$inferInsert;

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

export const TABLES = {
  focus_blocks: focusBlocks,
  inbox_flags: inboxFlags,
  home_widget_prefs: homeWidgetPrefs,
  inbox_saved_filters: inboxSavedFilters,
  doc_bookmarks: docBookmarks,
  work_item_recurrence: workItemRecurrence,
  work_item_labels: workItemLabels,
  work_item_watchers: workItemWatchers,
  conversation_read_state: conversationReadState,
  users,
  sessions,
  session_refresh_tokens: sessionRefreshTokens,
  organizations,
  memberships,
  workspaces,
  projects,
  project_memberships: projectMemberships,
  client_organizations: clientOrganizations,
  client_memberships: clientMemberships,
  invitations: invitations,
  project_clients: projectClients,
  work_items: workItems,
  work_item_dependencies: workItemDependencies,
  work_item_checklist_items: workItemChecklistItems,
  work_item_comments: workItemComments,
  work_item_time_logs: workItemTimeLogs,
  work_item_estimates: workItemEstimates,
  work_item_links: workItemLinks,
  work_blockers: workBlockers,
  client_requests: clientRequests,
  deliverable_versions: deliverableVersions,
  approvals,
  client_projections: clientProjections,
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
  outbox_events: outboxEvents,
  idempotency_records: idempotencyRecords,
  audit_events: auditEvents,
  notifications,
  notification_preferences: notificationPreferences,
  a11y_preferences: a11yPreferences,
  pref_quiet_hours: quietHours,
  pref_digest: digestPreferences,
  usage_counters: usageCounters,
  usage_ledger_entries: usageLedgerEntries,
  file_assets: fileAssets,
  file_versions: fileVersions,
  upload_sessions: uploadSessions,
  user_passwords: userPasswords,
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
  decisions,
  decision_supersessions: decisionSupersessions,
  decision_work_links: decisionWorkLinks,
  decision_locks: decisionLocks,
  document_templates: documentTemplates,
  project_objectives: projectObjectives,
  project_internal_risks: projectInternalRisks,
  project_templates: projectTemplates,
  project_status_updates: projectStatusUpdates,
  document_template_variables: documentTemplateVariables,
  org_objectives: orgObjectives,
  objective_work_links: objectiveWorkLinks,
  objective_key_results: objectiveKeyResults,
  import_rows: importRows,
  meeting_notes: meetingNotes,
  meeting_attendees: meetingAttendees,
  meeting_rsvps: meetingRsvps,
  meeting_series: meetingSeries,
  meeting_occurrence_overrides: meetingOccurrenceOverrides,
  saved_views: savedViews,
  saved_searches: savedSearches,
  saved_context: savedContext,
  project_updates: projectUpdates,
  project_update_comments: projectUpdateComments,
  project_milestones: projectMilestones,
  milestone_links: milestoneLinks,
  project_risks: projectRisks,
  portal_access_log: portalAccessLog,
  home_pinned_items: homePinnedItems,
  inbox_snoozes: inboxSnoozes,
  work_forms: workForms,
  search_index: searchIndex,
  notification_kind_prefs: notificationKindPrefs,
  org_settings: orgSettings,
  org_policies: orgPolicies,
  security_settings: securitySettings,
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
  person_allocations: personAllocations,
  person_capacity: personCapacity,
  member_reporting_lines: memberReportingLines,
  member_availability: memberAvailability,
  person_skills: personSkills,
  custom_roles: customRoles,
  subscriptions,
  billing_profiles: billingProfiles,
  billing_contacts: billingContacts,
  billing_usage_alerts: billingUsageAlerts,
  billing_credits: billingCredits,
  work_item_files: workItemFiles,
  work_item_reminders: workItemReminders,
  insight_saved_views: insightSavedViews,
  insight_snapshots: insightSnapshots,
  insight_report_schedules: insightReportSchedules,
  billing_seats: billingSeats,
  invoices: invoices,
  user_preferences: userPreferences,
  member_profiles: memberProfiles,
  admin_export_requests: adminExportRequests,
  invoice_line_items: invoiceLineItems,
  insight_targets: insightTargets,
  portal_settings: portalSettings,
} as const;

export type SessionRow = typeof sessions.$inferSelect;
export type SessionRefreshTokenRow = typeof sessionRefreshTokens.$inferSelect;
export type OrganizationRow = typeof organizations.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type WorkItemRow = typeof workItems.$inferSelect;
export type NewWorkItemRow = typeof workItems.$inferInsert;
export type WorkItemChecklistItemRow = typeof workItemChecklistItems.$inferSelect;
export type NewWorkItemChecklistItemRow = typeof workItemChecklistItems.$inferInsert;
export type WorkItemTimeLogRow = typeof workItemTimeLogs.$inferSelect;
export type NewWorkItemTimeLogRow = typeof workItemTimeLogs.$inferInsert;
export type WorkItemEstimateRow = typeof workItemEstimates.$inferSelect;
export type NewWorkItemEstimateRow = typeof workItemEstimates.$inferInsert;
export type WorkItemCommentRow = typeof workItemComments.$inferSelect;
export type NewWorkItemCommentRow = typeof workItemComments.$inferInsert;
export type WorkItemLinkRow = typeof workItemLinks.$inferSelect;
export type NewWorkItemLinkRow = typeof workItemLinks.$inferInsert;
export type WorkItemFileRow = typeof workItemFiles.$inferSelect;
export type NewWorkItemFileRow = typeof workItemFiles.$inferInsert;
export type ClientRequestRow = typeof clientRequests.$inferSelect;
export type DeliverableVersionRow = typeof deliverableVersions.$inferSelect;
export type NewDeliverableVersionRow = typeof deliverableVersions.$inferInsert;
export type ApprovalRow = typeof approvals.$inferSelect;
export type NewApprovalRow = typeof approvals.$inferInsert;
export type ClientProjectionRow = typeof clientProjections.$inferSelect;
export type NewClientProjectionRow = typeof clientProjections.$inferInsert;
export type ConversationRow = typeof conversations.$inferSelect;
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
export type ProjectMilestoneRow = typeof projectMilestones.$inferSelect;
export type ProjectRiskRow = typeof projectRisks.$inferSelect;
export type PortalAccessLogRow = typeof portalAccessLog.$inferSelect;
export type MeetingNoteRow = typeof meetingNotes.$inferSelect;
export type MeetingAttendeeRow = typeof meetingAttendees.$inferSelect;
export type MeetingRsvpRow = typeof meetingRsvps.$inferSelect;
export type MeetingSeriesRow = typeof meetingSeries.$inferSelect;
export type MeetingOccurrenceOverrideRow = typeof meetingOccurrenceOverrides.$inferSelect;
export type SavedViewRow = typeof savedViews.$inferSelect;
export type SavedSearchRow = typeof savedSearches.$inferSelect;
export type DocumentVersionRow = typeof documentVersions.$inferSelect;
export type NewDocumentVersionRow = typeof documentVersions.$inferInsert;
export type DocRevisionRow = typeof docRevisions.$inferSelect;
export type NewDocRevisionRow = typeof docRevisions.$inferInsert;
export type DocumentCommentRow = typeof documentComments.$inferSelect;
export type NewDocumentCommentRow = typeof documentComments.$inferInsert;
export type DecisionRow = typeof decisions.$inferSelect;
export type WorkFormRow = typeof workForms.$inferSelect;
export type WorkflowTemplateRow = typeof workflowTemplates.$inferSelect;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type IntegrationConnectionRow = typeof integrationConnections.$inferSelect;
export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;
export type WorkflowConditionRow = typeof workflowConditions.$inferSelect;
export type PersonCapacityRow = typeof personCapacity.$inferSelect;
export type MemberReportingLineRow = typeof memberReportingLines.$inferSelect;
export type MemberAvailabilityRow = typeof memberAvailability.$inferSelect;
export type PersonSkillRow = typeof personSkills.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type BillingProfileRow = typeof billingProfiles.$inferSelect;
export type BillingContactRow = typeof billingContacts.$inferSelect;
export type InvoiceRow = typeof invoices.$inferSelect;
export type InvoiceLineItemRow = typeof invoiceLineItems.$inferSelect;
export type DecisionSupersessionRow = typeof decisionSupersessions.$inferSelect;
export type DecisionWorkLinkRow = typeof decisionWorkLinks.$inferSelect;
export type DecisionLockRow = typeof decisionLocks.$inferSelect;
export type DocumentTemplateRow = typeof documentTemplates.$inferSelect;
export type AutomationScheduleRow = typeof automationSchedules.$inferSelect;
export type BillingUsageAlertRow = typeof billingUsageAlerts.$inferSelect;
export type BillingCreditRow = typeof billingCredits.$inferSelect;
export type NewDocumentTemplateRow = typeof documentTemplates.$inferInsert;
export type ProjectObjectiveRow = typeof projectObjectives.$inferSelect;
export type ProjectInternalRiskRow = typeof projectInternalRisks.$inferSelect;
export type ProjectTemplateRow = typeof projectTemplates.$inferSelect;
export type ProjectStatusUpdateRow = typeof projectStatusUpdates.$inferSelect;
export type DocumentTemplateVariableRow = typeof documentTemplateVariables.$inferSelect;
export type NewDocumentTemplateVariableRow = typeof documentTemplateVariables.$inferInsert;
export type OrgObjectiveRow = typeof orgObjectives.$inferSelect;
export type ObjectiveWorkLinkRow = typeof objectiveWorkLinks.$inferSelect;
export type MilestoneLinkRow = typeof milestoneLinks.$inferSelect;
export type ObjectiveKeyResultRow = typeof objectiveKeyResults.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationPreferenceRow = typeof notificationPreferences.$inferSelect;
export type NotificationKindPrefRow = typeof notificationKindPrefs.$inferSelect;
export type A11yPreferenceRow = typeof a11yPreferences.$inferSelect;
export type QuietHoursRow = typeof quietHours.$inferSelect;
export type UserPreferenceRow = typeof userPreferences.$inferSelect;
export type DigestPreferenceRow = typeof digestPreferences.$inferSelect;
export type ConversationMuteRow = typeof conversationMutes.$inferSelect;
export type SavedContextRow = typeof savedContext.$inferSelect;
export type HomePinnedItemRow = typeof homePinnedItems.$inferSelect;
export type InboxSnoozeRow = typeof inboxSnoozes.$inferSelect;
export type OrgSettingRow = typeof orgSettings.$inferSelect;
export type OrgPolicyRow = typeof orgPolicies.$inferSelect;
export type SecuritySettingsRow = typeof securitySettings.$inferSelect;
export type OnboardingProgressRow = typeof onboardingProgress.$inferSelect;
export type PersonAllocationRow = typeof personAllocations.$inferSelect;
export type CustomRoleRow = typeof customRoles.$inferSelect;
export type MemberProfileRow = typeof memberProfiles.$inferSelect;
export type UsageCounterRow = typeof usageCounters.$inferSelect;
export type UsageLedgerEntryRow = typeof usageLedgerEntries.$inferSelect;
export type FileAssetRow = typeof fileAssets.$inferSelect;
export type FileVersionRow = typeof fileVersions.$inferSelect;
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
export type InsightSavedViewRow = typeof insightSavedViews.$inferSelect;
export type InsightSnapshotRow = typeof insightSnapshots.$inferSelect;
export type InsightSnapshotKind = (typeof INSIGHT_SNAPSHOT_KINDS)[number];
export type InsightReportScheduleRow = typeof insightReportSchedules.$inferSelect;
export type BillingSeatRow = typeof billingSeats.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type AdminExportRequestRow = typeof adminExportRequests.$inferSelect;
export type AdminExportScope = (typeof ADMIN_EXPORT_SCOPES)[number];
export type AdminExportStatus = (typeof ADMIN_EXPORT_STATUSES)[number];
export type InsightTargetRow = typeof insightTargets.$inferSelect;
export type InsightTargetMetric = (typeof INSIGHT_TARGET_METRICS)[number];
export type InsightTargetPeriod = (typeof INSIGHT_TARGET_PERIODS)[number];
export type PortalSettingsRow = typeof portalSettings.$inferSelect;
export type NewPortalSettingsRow = typeof portalSettings.$inferInsert;
