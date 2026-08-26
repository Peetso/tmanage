import {
  bigint,
  boolean,
  char,
  datetime,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  smallint,
  int,
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
    version: bigint('version', { mode: 'number', unsigned: true }).notNull().default(1),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_memberships_org_id').on(table.organizationId, table.id),
    uniqueIndex('uq_memberships_org_user').on(table.organizationId, table.userId),
    index('ix_memberships_user').on(table.userId),
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
    committedAt: datetime('committed_at', { mode: 'date', fsp: 3 }),
    forecastAt: datetime('forecast_at', { mode: 'date', fsp: 3 }),
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
     * The base32 shared secret, stored recoverably because TOTP verification needs the
     * secret itself. That is a property of the algorithm and the reason a passkey is the
     * better credential: a WebAuthn public key is useless to whoever steals the database.
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
  project_clients: projectClients,
  work_items: workItems,
  outbox_events: outboxEvents,
  idempotency_records: idempotencyRecords,
  audit_events: auditEvents,
  user_passwords: userPasswords,
  user_mfa_factors: userMfaFactors,
  user_recovery_codes: userRecoveryCodes,
  authentication_events: authenticationEvents,
} as const;

export type SessionRow = typeof sessions.$inferSelect;
export type SessionRefreshTokenRow = typeof sessionRefreshTokens.$inferSelect;
export type OrganizationRow = typeof organizations.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type WorkItemRow = typeof workItems.$inferSelect;
export type NewWorkItemRow = typeof workItems.$inferInsert;
export type MembershipRow = typeof memberships.$inferSelect;
export type ClientOrganizationRow = typeof clientOrganizations.$inferSelect;
export type ClientMembershipRow = typeof clientMemberships.$inferSelect;
export type ProjectClientRow = typeof projectClients.$inferSelect;
export type ProjectMembershipRow = typeof projectMemberships.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type UserPasswordRow = typeof userPasswords.$inferSelect;
export type UserMfaFactorRow = typeof userMfaFactors.$inferSelect;
export type UserRecoveryCodeRow = typeof userRecoveryCodes.$inferSelect;
export type AuthenticationEventRow = typeof authenticationEvents.$inferSelect;
