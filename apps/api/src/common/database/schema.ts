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

export const MEETING_SERIES_FREQ = ['daily', 'weekly', 'monthly'] as const;

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

/**
 * Every table this schema describes, keyed by its SQL name.
 *
 * `schema.db.test.ts` walks this to compare the description against `information_schema`,
 * so a table added to the file without being added here is itself a drift failure.
 */
export const TABLES = {
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
  work_blockers: workBlockers,
  client_requests: clientRequests,
  deliverable_versions: deliverableVersions,
  approvals,
  client_projections: clientProjections,
  conversations,
  conversation_memberships: conversationMemberships,
  messages,
  message_revisions: messageRevisions,
  message_work_links: messageWorkLinks,
  outbox_events: outboxEvents,
  idempotency_records: idempotencyRecords,
  audit_events: auditEvents,
  notifications,
  notification_preferences: notificationPreferences,
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
  document_comments: documentComments,
  decisions,
  decision_supersessions: decisionSupersessions,
  document_templates: documentTemplates,
  project_objectives: projectObjectives,
  document_template_variables: documentTemplateVariables,
  org_objectives: orgObjectives,
  objective_work_links: objectiveWorkLinks,
  import_rows: importRows,
  meeting_notes: meetingNotes,
  meeting_attendees: meetingAttendees,
  meeting_series: meetingSeries,
  saved_views: savedViews,
  saved_context: savedContext,
  project_updates: projectUpdates,
  project_milestones: projectMilestones,
  project_risks: projectRisks,
  home_pinned_items: homePinnedItems,
  work_forms: workForms,
  integration_connections: integrationConnections,
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
export type ClientRequestRow = typeof clientRequests.$inferSelect;
export type DeliverableVersionRow = typeof deliverableVersions.$inferSelect;
export type NewDeliverableVersionRow = typeof deliverableVersions.$inferInsert;
export type ApprovalRow = typeof approvals.$inferSelect;
export type NewApprovalRow = typeof approvals.$inferInsert;
export type ClientProjectionRow = typeof clientProjections.$inferSelect;
export type NewClientProjectionRow = typeof clientProjections.$inferInsert;
export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationMembershipRow = typeof conversationMemberships.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type MessageRevisionRow = typeof messageRevisions.$inferSelect;
export type MessageWorkLinkRow = typeof messageWorkLinks.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;
export type ClientOrganizationRow = typeof clientOrganizations.$inferSelect;
export type ClientMembershipRow = typeof clientMemberships.$inferSelect;
export type ProjectClientRow = typeof projectClients.$inferSelect;
export type InvitationRow = typeof invitations.$inferSelect;
export type ProjectMembershipRow = typeof projectMemberships.$inferSelect;
export type MeetingRow = typeof meetings.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type ProjectUpdateRow = typeof projectUpdates.$inferSelect;
export type ProjectMilestoneRow = typeof projectMilestones.$inferSelect;
export type ProjectRiskRow = typeof projectRisks.$inferSelect;
export type MeetingNoteRow = typeof meetingNotes.$inferSelect;
export type MeetingAttendeeRow = typeof meetingAttendees.$inferSelect;
export type MeetingSeriesRow = typeof meetingSeries.$inferSelect;
export type SavedViewRow = typeof savedViews.$inferSelect;
export type DocumentVersionRow = typeof documentVersions.$inferSelect;
export type NewDocumentVersionRow = typeof documentVersions.$inferInsert;
export type DocumentCommentRow = typeof documentComments.$inferSelect;
export type NewDocumentCommentRow = typeof documentComments.$inferInsert;
export type DecisionRow = typeof decisions.$inferSelect;
export type WorkFormRow = typeof workForms.$inferSelect;
export type IntegrationConnectionRow = typeof integrationConnections.$inferSelect;
export type DecisionSupersessionRow = typeof decisionSupersessions.$inferSelect;
export type DocumentTemplateRow = typeof documentTemplates.$inferSelect;
export type NewDocumentTemplateRow = typeof documentTemplates.$inferInsert;
export type ProjectObjectiveRow = typeof projectObjectives.$inferSelect;
export type DocumentTemplateVariableRow = typeof documentTemplateVariables.$inferSelect;
export type NewDocumentTemplateVariableRow = typeof documentTemplateVariables.$inferInsert;
export type OrgObjectiveRow = typeof orgObjectives.$inferSelect;
export type ObjectiveWorkLinkRow = typeof objectiveWorkLinks.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationPreferenceRow = typeof notificationPreferences.$inferSelect;
export type SavedContextRow = typeof savedContext.$inferSelect;
export type HomePinnedItemRow = typeof homePinnedItems.$inferSelect;
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
