import { createHash } from 'node:crypto';

/**
 * Tenant query guard — **ADR-0001 layer 3, the row-level-security replacement.**
 *
 * ## Why this file exists
 *
 * On PostgreSQL with RLS, a forgotten `WHERE organization_id = $1` returns zero rows. On
 * MySQL the identical omission returns **every tenant's rows**, and nothing in the engine
 * objects. The failure mode inverts from safe to catastrophic, and it is silent: the
 * endpoint works, happy-path tests pass, and the leak is invisible until a customer sees
 * another customer's data.
 *
 * Spec section 6 requires that "development/test query instrumentation rejects access to
 * tenant tables when a tenant predicate is missing". This is that instrumentation. Every
 * statement issued through the tenant connection wrapper passes through
 * {@link assertTenantScoped} first.
 *
 * ## What it checks
 *
 * For each statement it identifies the tenant-owned tables referenced, then requires that
 * every one of them is constrained — directly or through a chain of join equalities — to
 * a tenant key bound to the **active** `TenantContext`. Both halves matter:
 *
 * - A missing predicate is a leak.
 * - A predicate bound to *some other* organization id is also a leak, so the guard
 *   inspects the bound parameter values, not only the SQL text.
 *
 * ## Deliberate design choices
 *
 * **Fail closed.** Anything the analyser cannot confidently interpret is a violation, not
 * a pass. A false positive costs a developer one explicit escape hatch; a false negative
 * costs a cross-tenant disclosure. The asymmetry is not close.
 *
 * **Bound parameters only.** A tenant predicate written as a string literal is rejected
 * even when the literal is correct, because spec section 5 requires parameterized queries
 * and because a literal cannot be checked against the active context at all.
 *
 * **The escape hatch is explicit and audited.** Some statements are legitimately
 * cross-tenant — the outbox relay claiming the oldest unpublished events is the canonical
 * one. Those pass `allowUnscoped` with a mandatory reason string, which is recorded. The
 * guard is never loosened to accommodate them (ADR-0001, Consequences).
 *
 * ## What it is not
 *
 * It is not a SQL parser, and it is not a substitute for layers 1, 2, 4 and 5. It runs
 * inside the application, so it does nothing for a direct SQL session or a compromised
 * credential — ADR-0001 states that limitation plainly and layers 1 and 2 are what cover
 * those cases.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every tenant-owned table, mapped to the column that carries its tenant key.
 *
 * `organizations` is the exception: it *is* the tenant, so its tenant key is `id`. A read
 * of `organizations` is still required to be scoped — otherwise listing the customer base
 * would be one forgotten predicate away.
 *
 * Kept in step with the migrations by `tenant-isolation.db.test.ts`, which reads
 * `information_schema` and fails if any table with an `organization_id` column is missing
 * from this map. A new module migration cannot quietly opt out of the guard.
 */
export const TENANT_TABLES: Readonly<Record<string, 'organization_id' | 'id'>> = Object.freeze({
  organizations: 'id',
  memberships: 'organization_id',
  workspaces: 'organization_id',
  projects: 'organization_id',
  project_memberships: 'organization_id',
  client_organizations: 'organization_id',
  client_memberships: 'organization_id',
  project_clients: 'organization_id',
  // TEN-003. Tenant-owned like every other grant: an invitation names one organization, and
  // the acceptance path reaches it through `bootstrapRead` rather than by being global.
  invitations: 'organization_id',
  work_items: 'organization_id',
  // WORK-003. Both tenant-owned: an edge names two tenant rows, and a blocker's reason and
  // ask are internal prose about a studio's work.
  work_item_dependencies: 'organization_id',
  work_blockers: 'organization_id',
  // x145 (0051). Tenant-owned: a checklist item belongs to one work item of one studio, and an
  // unscoped `SELECT ... FROM work_item_checklist_items` would be every studio's sub-task lists on
  // the server. `organization_id` is NOT NULL and it carries the `(organization_id, id)` key every
  // tenant table has, so the guard scopes its reads and its writes.
  work_item_checklist_items: 'organization_id',
  // x147. A work item's comments: internal prose about a studio's work, tenant-scoped like every
  // sibling — an unscoped read of it would be every studio's activity trail at once.
  work_item_comments: 'organization_id',
  // x204 (0085). A typed link joins two work items of one studio; an unscoped read would be every
  // studio's dependency graph at once. Tenant-owned, `organization_id` NOT NULL, `(organization_id,
  // id)` keyed like every sibling — the guard scopes its reads, its inserts and its deletes.
  work_item_links: 'organization_id',
  // x205. The work-item ↔ file join. Tenant-owned: a link names two tenant rows (a work item and
  // a file asset), and an unscoped read of it would be every studio's attachments at once.
  work_item_files: 'organization_id',
  // x231 (0103). Logged effort per work item: tenant-owned, and an unscoped read would be every
  // studio's effort ledger at once. `organization_id` is NOT NULL and carries the
  // `(organization_id, id)` key, so the guard scopes its reads and its writes.
  work_item_time_logs: 'organization_id',
  // x232. A work item's watchers/subscribers: a self-service watch list tenant-scoped like every
  // sibling — an unscoped read would be every studio's subscriptions (and who watches what) at once.
  work_item_watchers: 'organization_id',
  work_item_labels: 'organization_id',
  // REQ-001. Tenant-owned and, unusually, also client-owned: `client_organization_id` is
  // NOT NULL, so every row belongs both to a studio and to one of its clients.
  client_requests: 'organization_id',
  // FR-05 (0027). Both tenant-owned: a deliverable version and the approval bound to it belong to
  // one studio, and an unscoped read of either would leak another studio's governed content or
  // decisions.
  deliverable_versions: 'organization_id',
  approvals: 'organization_id',
  // FR-05 (0031, x97). Tenant-owned: a client projection is one studio's immutable client-facing
  // view of a governed version, and an unscoped read would leak another studio's — or another
  // client's — published content. The application already scopes its queries, but the guard is the
  // layer that catches a forgotten predicate, so the table must be registered here.
  client_projections: 'organization_id',
  // CHAT-001. All three are tenant-owned, and `messages` is the table in this system whose
  // content is most obviously somebody else's: an unscoped `SELECT ... FROM messages` is a
  // transcript of every studio on the server.
  conversations: 'organization_id',
  conversation_memberships: 'organization_id',
  messages: 'organization_id',
  // CHAT-002. Tenant-owned for the reason `messages` is — a revision is a message body that
  // was superseded, which is exactly as much somebody else's transcript as the current one.
  // The application never writes this table (the 0008 trigger does, with definer
  // privileges); registering it here scopes the READS.
  message_revisions: 'organization_id',
  // CHAT-003. Tenant-owned: the link names a message and a work item, both tenant rows, and
  // an unscoped read of it would be a map of which studio converted what.
  message_work_links: 'organization_id',
  outbox_events: 'organization_id',
  idempotency_records: 'organization_id',
  audit_events: 'organization_id',
  // NOTIF-001. Tenant-owned: a notification names a tenant object, and an unscoped read of
  // it would be a feed of what is happening inside every studio on the server.
  notifications: 'organization_id',
  // NOTIF-001 preferences. Tenant-owned: a person's channel, digest and quiet-hours settings
  // are per studio, and an unscoped read would be every person's settings in every studio.
  notification_preferences: 'organization_id',
  // FILE-001. All four are tenant-owned. The counter is a customer's bill in progress;
  // the asset, its versions and the session name a project and carry an object key, and
  // an unscoped read of any of them would be an inventory of every studio's files.
  usage_counters: 'organization_id',
  file_assets: 'organization_id',
  file_versions: 'organization_id',
  upload_sessions: 'organization_id',
  // USAGE-001 slice 2 (migration 0021). Tenant-owned like `usage_counters`, whose every
  // move it records: `organization_id` is NOT NULL and it carries the `(organization_id, id)`
  // key every tenant table has. An unscoped read would be a per-organization ledger of every
  // studio's storage spend, so the guard must scope its READS.
  usage_ledger_entries: 'organization_id',
  // ON-09 (migration 0028). Tenant-owned: an import attempt names one organization, and an
  // unscoped read would be every studio's onboarding-import history. `organization_id` is NOT
  // NULL and it carries the `(organization_id, id)` key every tenant table has, so the guard
  // scopes its reads and writes.
  import_jobs: 'organization_id',
  // CAL-01 / MTG-01 (x90). Tenant-owned: a meeting names a project, and an unscoped
  // `SELECT ... FROM meetings` would be every studio's calendar on the server. The guard must
  // scope its reads and its writes.
  meetings: 'organization_id',
  // DOC-01 (x91). Tenant-owned: a document names a project, and an unscoped
  // `SELECT ... FROM documents` would be every studio's knowledge base on the server. The guard
  // must scope its reads and its writes.
  documents: 'organization_id',
  // DOC-02/DOC-03 (0036, x112). Tenant-owned: a version is the body a document held at a moment,
  // and an unscoped `SELECT ... FROM document_versions` would be every studio's document history on
  // the server. `organization_id` is NOT NULL and it carries the `(organization_id, id)` key every
  // tenant table has, so the guard scopes its reads and writes.
  document_versions: 'organization_id',
  // DOC revision history (0113, x241). Tenant-owned: a revision is the body a document held at a
  // moment, and an unscoped `SELECT ... FROM doc_revisions` would be every studio's document history
  // on the server. `organization_id` is NOT NULL and it carries the `(organization_id, id)` key every
  // tenant table has, so the guard scopes its reads and writes.
  doc_revisions: 'organization_id',
  // DOC bookmarks / favorites (0114, x242). Tenant-owned: a bookmark names a document and a
  // membership, and an unscoped `SELECT ... FROM doc_bookmarks` would be every studio's favorites on
  // the server. `organization_id` is NOT NULL and it carries the `(organization_id, id)` key every
  // tenant table has, so the guard scopes its reads and writes.
  doc_bookmarks: 'organization_id',
  // Docs "collaboration later" (0045, x132). Tenant-owned: a comment cites a document, and an
  // unscoped `SELECT ... FROM document_comments` would be every studio's document discussion on the
  // server. `organization_id` is NOT NULL and it carries the `(organization_id, id)` key every
  // tenant table has, so the guard scopes its reads and writes.
  document_comments: 'organization_id',
  // DOC-04/ADM-06 (0039, x119). Tenant-owned: an org-scoped document template, and an unscoped
  // `SELECT ... FROM document_templates` would be every studio's templates on the server.
  // `organization_id` is NOT NULL and it carries the `(organization_id, id)` key every tenant table
  // has, so the guard scopes its reads and writes.
  document_templates: 'organization_id',
  // DOC-04 (0044, x130). Tenant-owned: a template variable is a child of a `document_templates`
  // row, and an unscoped `SELECT ... FROM document_template_variables` would be every studio's
  // template variables on the server. `organization_id` is NOT NULL and it carries the
  // `(organization_id, id)` key every tenant table has, so the guard scopes its reads and writes.
  document_template_variables: 'organization_id',
  // ON-09 commit half (migration 0032). Tenant-owned: the per-row commit receipt (ADM-10)
  // names one organization and its parent job, and an unscoped read would be every studio's
  // import outcomes. `organization_id` is NOT NULL and it carries the `(organization_id, id)`
  // key every tenant table has, so the guard scopes its reads and writes.
  import_rows: 'organization_id',
  // CAL-01 / MTG-01 second slice (x105). Tenant-owned: a note cites a meeting, and an unscoped
  // `SELECT ... FROM meeting_notes` would be every studio's meeting record on the server. The
  // guard must scope its reads and its writes.
  meeting_notes: 'organization_id',
  // CAL-01 / MTG-01 attendees + RSVP (x126). Tenant-owned: an attendee row cites a meeting and a
  // membership, and an unscoped `SELECT ... FROM meeting_attendees` would be who is invited to
  // every studio's meetings on the server. The guard must scope its reads and its writes.
  meeting_attendees: 'organization_id',
  // A meeting RSVP is a member's own answer, tenant- and meeting-scoped by its composite keys, and an
  // unscoped `SELECT ... FROM meeting_rsvps` would be who is coming to every studio's meetings on the
  // server (x240).
  meeting_rsvps: 'organization_id',
  // CAL recurrence (x129). Tenant-owned and org-scoped (no project): a series is one studio's
  // recurrence rule, and an unscoped `SELECT ... FROM meeting_series` would be every studio's
  // calendar rules on the server. The guard must scope its reads and its writes.
  meeting_series: 'organization_id',
  // CAL per-occurrence override (x213). Tenant-owned and org-scoped: an override decorates one
  // studio's series occurrence, and an unscoped `SELECT ... FROM meeting_occurrence_overrides` would
  // be every studio's calendar exceptions on the server. The guard must scope its reads and writes.
  meeting_occurrence_overrides: 'organization_id',
  // WK-08 (x107). Tenant-owned: a saved view belongs to a studio and a person, and an unscoped
  // `SELECT ... FROM saved_views` would be every studio's saved Work views on the server. The
  // guard must scope its reads and its writes.
  saved_views: 'organization_id',
  // SRCH saved/recent (x214, migration 0092). Tenant-owned: a saved or recent search belongs to one
  // user in one studio, and an unscoped `SELECT ... FROM saved_searches` would be every member's
  // saved and recent queries across every studio on the server. The layer-3 guard fails OPEN on an
  // unregistered table, so registering it here is what scopes its reads, its delete and its recent
  // prune; tenant-isolation.db.test.ts enforces the entry.
  saved_searches: 'organization_id',
  // HOME-05 (0035). Tenant-owned: a pin names a tenant entity and belongs to one user in one
  // studio, and an unscoped read would be a map of what every person in every studio keeps at
  // hand. The layer-3 guard fails OPEN on an unregistered table, so registering it here is what
  // scopes the pin reads and writes; tenant-isolation.db.test.ts enforces the entry.
  saved_context: 'organization_id',
  // DEC-01 (x113, migration 0037). Tenant-owned: a decision names a project (and optionally a
  // meeting), and an unscoped `SELECT ... FROM decisions` would be every studio's decision
  // register on the server. `organization_id` is NOT NULL and it carries the `(organization_id,
  // id)` key every tenant table has, so the guard must scope its reads and its writes.
  decisions: 'organization_id',
  // DEC-01-b / DEC-02 (x117, migration 0038). Tenant-owned: an edge names two decisions of the
  // acting tenant, and an unscoped read would be every studio's supersede chain. `organization_id`
  // is NOT NULL and carries the `(organization_id, id)` key, so the guard scopes its reads/writes.
  decision_supersessions: 'organization_id',
  // DEC / module 12 (x149, migration 0055). Tenant-owned: the edge names a decision and a work item,
  // both tenant rows, and an unscoped `SELECT ... FROM decision_work_links` would be a map of which
  // studio linked what to which decision. `organization_id` is NOT NULL and it carries the
  // `(organization_id, id)` key every tenant table has, so the guard must scope its reads and its
  // writes. The layer-3 guard fails OPEN on an unregistered table, so this entry is what scopes the
  // link reads and writes.
  decision_work_links: 'organization_id',
  // SEC / Decisions (x150, migration 0056). Tenant-owned: a decision lock names a decision of the
  // acting tenant, and an unscoped `SELECT ... FROM decision_locks` would reveal which decisions every
  // studio has sealed. `organization_id` is NOT NULL and it carries the `(organization_id, id)` key
  // every tenant table has, so the guard must scope its reads and its writes. The layer-3 guard fails
  // OPEN on an unregistered table, so this entry is what scopes the lock reads and writes.
  decision_locks: 'organization_id',
  // PROJ / module 8 (x124, migration 0040). Tenant-owned: an objective names a project, and an
  // unscoped `SELECT ... FROM project_objectives` would be every studio's objectives on the server.
  // `organization_id` is NOT NULL and it carries the `(organization_id, id)` key every tenant table
  // has, so the guard must scope its reads and its writes. The layer-3 guard fails OPEN on an
  // unregistered table, so this entry is what scopes the objective reads and writes.
  project_objectives: 'organization_id',
  // CLIENT-003 (x125, 0041). Tenant-owned: a project update names a project, and an unscoped
  // `SELECT ... FROM project_updates` would be every studio's client timeline on the server —
  // and, because the client read filters `published = 1`, an unscoped read would also cross the
  // client-visibility boundary. The layer-3 guard fails OPEN on an unregistered table, so
  // registering it here is what scopes the reads and writes; tenant-isolation.db.test.ts
  // enforces the entry.
  project_updates: 'organization_id',
  // SEC / Portal update comments (x203, 0084). Tenant-owned: a comment belongs to one studio's
  // published update, and an unscoped `SELECT ... FROM project_update_comments` would be every
  // studio's client-visible discussion on the server. The layer-3 guard fails OPEN on an
  // unregistered table, so registering it here is what scopes the reads and the append;
  // tenant-isolation.db.test.ts enforces the entry.
  project_update_comments: 'organization_id',
  // PROJ / module 8 (x136, migration 0046). Tenant-owned: an org objective belongs to one studio,
  // and an unscoped `SELECT ... FROM org_objectives` would be every studio's OKRs on the server.
  // `organization_id` is NOT NULL and it carries the `(organization_id, id)` key every tenant table
  // has, so the guard must scope its reads and its writes. The layer-3 guard fails OPEN on an
  // unregistered table, so this entry is what scopes the objective reads and writes.
  org_objectives: 'organization_id',
  // PROJ / module 8 (x138, migration 0047). Tenant-owned: the edge names an objective and a work
  // item, both tenant rows, and an unscoped `SELECT ... FROM objective_work_links` would be a map of
  // which studio linked what to which objective. `organization_id` is NOT NULL and it carries the
  // `(organization_id, id)` key every tenant table has, so the guard must scope its reads and its
  // writes. The layer-3 guard fails OPEN on an unregistered table, so this entry is what scopes the
  // link reads and writes.
  objective_work_links: 'organization_id',
  // PROJ / module 8 (x207, migration 0087). Tenant-owned: a key result names an objective (itself a
  // tenant row), and an unscoped `SELECT ... FROM objective_key_results` would be every studio's
  // OKR progress on the server. `organization_id` is NOT NULL and it carries the `(organization_id,
  // id)` key every tenant table has, so the guard must scope its reads and its writes. The layer-3
  // guard fails OPEN on an unregistered table, so this entry is what scopes the key-result reads and
  // writes.
  objective_key_results: 'organization_id',
  // SEC / Portal milestones (x139, 0048). Tenant-owned: a project milestone names a project, and
  // an unscoped `SELECT ... FROM project_milestones` would be every studio's milestone timeline on
  // the server — and, because the client read filters `published = 1`, an unscoped read would also
  // cross the client-visibility boundary. The layer-3 guard fails OPEN on an unregistered table,
  // so registering it here is what scopes the reads and writes; tenant-isolation.db.test.ts
  // enforces the entry.
  project_milestones: 'organization_id',
  // SEC / Portal risks (x140, 0049). Tenant-owned: a project risk names a project, and an unscoped
  // `SELECT ... FROM project_risks` would be every studio's risk register on the server — and,
  // because the client read filters `published = 1` and the internal note is the substance, an
  // unscoped read would also cross the client-visibility boundary. The layer-3 guard fails OPEN on
  // an unregistered table, so registering it here is what scopes the reads and writes;
  // tenant-isolation.db.test.ts enforces the entry.
  project_risks: 'organization_id',
  // PROJ / module 8 internal risk register (x209, 0088). Tenant-owned: a risk names a project, and an
  // unscoped `SELECT ... FROM project_internal_risks` would be every studio's internal risk register
  // on the server. Distinct from `project_risks` (x140): internal-only, never projected to a client.
  // The layer-3 guard fails OPEN on an unregistered table, so registering it here is what scopes the
  // reads and writes; tenant-isolation.db.test.ts enforces the entry.
  project_internal_risks: 'organization_id',
  // HOME-05 follow-up (x144, migration 0050). Tenant-owned: a pin names a tenant target and belongs
  // to one membership in one studio, and an unscoped read would be a map of what every member in
  // every studio keeps on their Home. The layer-3 guard fails OPEN on an unregistered table, so
  // registering it here is what scopes the pin reads and writes; tenant-isolation.db.test.ts
  // enforces the entry.
  home_pinned_items: 'organization_id',
  // WORK intake forms (x146, migration 0052). Org-owned: a form belongs to the acting tenant, and
  // an unscoped `SELECT ... FROM work_forms` would be every studio's intake definitions on the
  // server. `organization_id` is NOT NULL and carries the `(organization_id, id)` key every tenant
  // table has, so the guard must scope its reads and its writes.
  work_forms: 'organization_id',
  // SRCH ranking (x148, migration 0054). Tenant-owned: the search index mirrors a studio's work
  // items and documents, and an unscoped `MATCH … AGAINST search_index` would rank another studio's
  // titles and bodies into this caller's results. `organization_id` is NOT NULL and it carries the
  // `(organization_id, id)` key every tenant table has, so the guard scopes the ranked read (and
  // the reindex writes) — the Known-trap anchor that keeps a cross-tenant row from ever ranking.
  search_index: 'organization_id',
  // Per-kind notification opt-out (x152, migration 0057). Tenant-owned: a row belongs to one
  // membership in one studio, and an unscoped read would be every member's opt-outs across every
  // studio. The layer-3 guard fails OPEN on an unregistered table, so this entry is what scopes the
  // per-kind reads and the upsert; tenant-isolation.db.test.ts enforces the entry.
  notification_kind_prefs: 'organization_id',
  // Organization settings / policy (x153, migration 0058). Org-owned: a settings row belongs to the
  // acting tenant, and an unscoped `SELECT ... FROM org_settings` would be every studio's policy on
  // the server. `organization_id` is NOT NULL and carries the `(organization_id, id)` key every
  // tenant table has, so the guard must scope its reads and its upserts; the layer-3 guard fails OPEN
  // on an unregistered table, so registering it here is what scopes them, and
  // tenant-isolation.db.test.ts enforces the entry.
  org_settings: 'organization_id',
  // Organization access policies (x174, migration 0072). Org-owned: the access-policy document belongs
  // to the acting tenant, and an unscoped `SELECT ... FROM org_policies` would be every studio's
  // session-lifetime, invite-domain and guest-access policy on the server. `organization_id` is NOT
  // NULL and carries the `(organization_id, id)` key every tenant table has, so the guard must scope
  // its reads and its upsert; the layer-3 guard fails OPEN on an unregistered table, so registering it
  // here is what scopes them, and tenant-isolation.db.test.ts enforces the entry.
  org_policies: 'organization_id',
  // Organization security settings (x176, migration 0073). Org-owned: the security posture (2FA
  // enforcement + IP allowlist) belongs to the acting tenant, and an unscoped read would be every
  // studio's security config on the server. `organization_id` is NOT NULL and carries the
  // `(organization_id, id)` key every tenant table has, so the guard must scope its read and its
  // upsert; the layer-3 guard fails OPEN on an unregistered table, so registering it here is what
  // scopes them, and tenant-isolation.db.test.ts enforces the entry.
  security_settings: 'organization_id',
  // ON-10 guided-tour progress (x155, migration 0059). Tenant-owned: a progress row belongs to one
  // membership in one studio, and an unscoped read would be a map of how far every member in every
  // studio has got through the tour. The layer-3 guard fails OPEN on an unregistered table, so
  // registering it here is what scopes the progress reads and the completion upsert; the
  // tenant-isolation suite enforces the entry.
  onboarding_progress: 'organization_id',
  // Automation workflow templates (x162, migration 0063). Org-owned: a template belongs to the acting
  // tenant, and an unscoped `SELECT ... FROM workflow_templates` would be every studio's automation
  // definitions on the server. `organization_id` is NOT NULL and carries the `(organization_id, id)`
  // key every tenant table has, so the guard must scope its reads and its writes.
  workflow_templates: 'organization_id',
  // Automation workflow runs (x163, migration 0064). Org-owned: a run belongs to the acting tenant,
  // and an unscoped `SELECT ... FROM workflow_runs` would be every studio's automation history on the
  // server. `organization_id` is NOT NULL and carries the `(organization_id, id)` key every tenant
  // table has, so the guard must scope its reads and its writes.
  workflow_runs: 'organization_id',
  // Automations app/integration connections (x165, migration 0065). Org-owned: a connection belongs
  // to the acting tenant, and an unscoped `SELECT ... FROM integration_connections` would be every
  // studio's connected apps on the server. `organization_id` is NOT NULL and carries the
  // `(organization_id, id)` key every tenant table has, so the guard must scope its reads and writes.
  integration_connections: 'organization_id',
  // Automations webhooks (x166, migration 0066). Org-owned: an endpoint belongs to the acting
  // tenant, and an unscoped `SELECT ... FROM webhook_endpoints` would be every studio's egress
  // targets on the server. `organization_id` is NOT NULL and carries the `(organization_id, id)`
  // key every tenant table has, so the guard must scope its reads and its writes.
  webhook_endpoints: 'organization_id',
  // Automations webhook delivery attempts (x221, migration 0097). Org-owned: a delivery record
  // belongs to the acting tenant and to one of its webhook endpoints, and an unscoped `SELECT ...
  // FROM webhook_deliveries` would be every studio's delivery history on the server.
  // `organization_id` is NOT NULL and carries the `(organization_id, id)` key every tenant table
  // has, so the guard must scope its reads and its writes.
  webhook_deliveries: 'organization_id',
  // Automations scheduled triggers (x167, migration 0067). Org-owned: a schedule belongs to the
  // acting tenant and to one of its workflow templates, and an unscoped `SELECT ... FROM
  // automation_schedules` would be every studio's schedules on the server. `organization_id` is NOT
  // NULL and carries the `(organization_id, id)` key every tenant table has, so the guard must scope
  // its reads and its writes.
  automation_schedules: 'organization_id',
  // A11Y-183 (x183, migration 0079). Tenant-owned: a row is one membership's accessibility
  // settings in one studio, and an unscoped `SELECT ... FROM a11y_preferences` would be every
  // member's preferences across every studio on the server. `organization_id` is NOT NULL and
  // carries the `(organization_id, id)` key every tenant table has, so the guard scopes its
  // reads and its writes; tenant-isolation.db.test.ts enforces the entry.
  a11y_preferences: 'organization_id',
  // Automation workflow conditions (x190, migration 0081). Org-owned: a condition gates a step of one
  // tenant's template, and an unscoped `SELECT ... FROM workflow_conditions` would be every studio's
  // branching rules on the server. The layer-3 guard fails OPEN on an unregistered table, so this
  // entry is what scopes the condition reads and writes; `organization_id` is NOT NULL and carries the
  // `(organization_id, id)` key every tenant table has.
  workflow_conditions: 'organization_id',
  // PEOPLE allocations (x171, migration 0069). Tenant-owned and project-owned: an allocation belongs
  // to the acting tenant, and an unscoped `SELECT ... FROM person_allocations` would be every studio's
  // capacity plan on the server. `organization_id` is NOT NULL and carries the `(organization_id, id)`
  // key every tenant table has, so the guard must scope its reads and its writes; the layer-3 guard
  // fails OPEN on an unregistered table, so registering it here is what scopes it. tenant-isolation.db.test.ts
  // enforces the entry.
  person_allocations: 'organization_id',
  // Per-member weekly capacity (x170, migration 0068). Tenant-owned: a capacity row belongs to a
  // membership in one studio, and an unscoped `SELECT ... FROM person_capacity` would be every
  // studio's staffing figures on the server. `organization_id` is NOT NULL and carries the
  // `(organization_id, id)` key every tenant table has, so the guard must scope its reads and its
  // (upsert) writes. The layer-3 guard fails OPEN on an unregistered table, so registering it here is
  // what scopes them; tenant-isolation.db.test.ts enforces the entry.
  person_capacity: 'organization_id',
  // Member reporting lines (x217, migration 0095). Tenant-owned: a reporting line belongs to a
  // membership in one studio, and an unscoped `SELECT ... FROM member_reporting_lines` would be every
  // studio's org chart on the server. `organization_id` is NOT NULL and carries the
  // `(organization_id, id)` key every tenant table has, so the guard must scope its reads and its
  // (upsert / delete) writes. The layer-3 guard fails OPEN on an unregistered table, so registering it
  // here is what scopes them; tenant-isolation.db.test.ts enforces the entry.
  member_reporting_lines: 'organization_id',
  // Member availability / out-of-office windows (x218, migration 0096). Tenant-owned: a window
  // belongs to a membership in one studio, and an unscoped `SELECT ... FROM member_availability`
  // would be every member's OOO windows across every studio on the server. `organization_id` is NOT
  // NULL and carries the `(organization_id, id)` key every tenant table has, so the guard must scope
  // its reads and its (insert/delete) writes; the layer-3 guard fails OPEN on an unregistered table,
  // so registering it here is what scopes them, and tenant-isolation.db.test.ts enforces the entry.
  member_availability: 'organization_id',
  // People member skills (x172, migration 0070). Membership-owned within a tenant: an unscoped
  // `SELECT ... FROM person_skills` would be every studio's members' declared skills on the server.
  // `organization_id` is NOT NULL and carries the `(organization_id, id)` key every tenant table
  // has, so the guard must scope its reads and its writes.
  person_skills: 'organization_id',
  // Custom roles (x173, migration 0071). Tenant-owned: a role belongs to one studio, and an unscoped
  // `SELECT ... FROM custom_roles` would be every studio's role/capability design on the server.
  // `organization_id` is NOT NULL and carries the `(organization_id, id)` key every tenant table has,
  // so the guard must scope its reads and its insert; the layer-3 guard fails OPEN on an unregistered
  // table, so registering it here is what scopes them, and tenant-isolation.db.test.ts enforces it.
  custom_roles: 'organization_id',
  // Billing subscription (x177, migration 0074). Tenant-owned: a subscription is one studio's plan
  // and status, and an unscoped `SELECT ... FROM subscriptions` would be every studio's plan on the
  // server. `organization_id` is NOT NULL and carries the `(organization_id, id)` key every tenant
  // table has, so the guard must scope its reads and its writes; the layer-3 guard fails OPEN on an
  // unregistered table, so this entry is what scopes them (tenant-isolation.db.test.ts enforces it).
  subscriptions: 'organization_id',
  // Billing profile (module 19, x180, migration 0077). Org-owned: exactly one billing profile per
  // organization, and an unscoped `SELECT ... FROM billing_profiles` would be every studio's billing
  // contact, tax id and address on the server. `organization_id` is NOT NULL and carries the
  // `(organization_id, id)` key every tenant table has, so the guard must scope its reads and its
  // writes; the layer-3 guard fails OPEN on an unregistered table, so this entry is what scopes them.
  billing_profiles: 'organization_id',
  // Billing contacts (module 19, x199, migration 0082). Org-owned: the people a studio nominates for
  // billing notices, and an unscoped `SELECT ... FROM billing_contacts` would be every studio's
  // contact names and emails on the server. `organization_id` is NOT NULL and carries the
  // `(organization_id, id)` key every tenant table has, so the guard must scope its reads and its
  // writes; the layer-3 guard fails OPEN on an unregistered table, so this entry is what scopes them.
  billing_contacts: 'organization_id',
  // Billing usage alerts (x200, migration 0083). Org-owned: a usage-alert rule belongs to the acting
  // tenant, and an unscoped `SELECT ... FROM billing_usage_alerts` would be every studio's alert
  // thresholds on the server. `organization_id` is NOT NULL and carries the `(organization_id, id)`
  // key every tenant table has, so the guard must scope its reads and its writes.
  billing_usage_alerts: 'organization_id',
  // Billing credits (x226, migration 0100). Org-owned: a manual credit / adjustment ledger entry
  // belongs to the acting tenant, and an unscoped `SELECT ... FROM billing_credits` would be every
  // studio's credit history and balance on the server. `organization_id` is NOT NULL and carries the
  // `(organization_id, id)` key every tenant table has, so the guard must scope its reads and its
  // writes; the layer-3 guard fails OPEN on an unregistered table, so this entry is what scopes them.
  billing_credits: 'organization_id',
  // INS saved views (x210, migration 0089). Tenant-owned: a saved insights view belongs to a studio
  // and a person, and an unscoped `SELECT ... FROM insight_saved_views` would be every studio's saved
  // views on the server. `organization_id` is NOT NULL and carries the `(organization_id, id)` key
  // every tenant table has, so the guard must scope its reads and its writes; the layer-3 guard fails
  // OPEN on an unregistered table, so this entry is what scopes the view reads and deletes.
  insight_saved_views: 'organization_id',
  // Insight snapshots (x211, migration 0090). Tenant-owned: a snapshot freezes one studio's
  // computed insights read, and an unscoped `SELECT ... FROM insight_snapshots` would be every
  // studio's stored metrics on the server. `organization_id` is NOT NULL and carries the
  // `(organization_id, id)` key every tenant table has, so the guard must scope its reads and its
  // writes; tenant-isolation.db.test.ts enforces the entry.
  insight_snapshots: 'organization_id',
  // PREF-QUIET (x215, migration 0093). Tenant-owned: a row is one membership's notification
  // quiet-hours window in one studio, and an unscoped `SELECT ... FROM pref_quiet_hours` would be
  // every member's window across every studio on the server. `organization_id` is NOT NULL and
  // carries the `(organization_id, id)` key every tenant table has, so the guard scopes its reads
  // and its writes; tenant-isolation.db.test.ts enforces the entry.
  pref_quiet_hours: 'organization_id',
  // Billing seats (x178, migration 0075). Tenant-owned: a seat belongs to the acting tenant and
  // names one of its memberships, and an unscoped `SELECT ... FROM billing_seats` would be every
  // studio's seat roster on the server. `organization_id` is NOT NULL and carries the
  // `(organization_id, id)` key, so the guard must scope its reads and its writes.
  billing_seats: 'organization_id',
  // x179 (0076) invoices. Billing history is per-tenant: an unscoped `SELECT ... FROM invoices`
  // would be every studio's billing on the server. `organization_id` is NOT NULL and carries the
  // `(organization_id, id)` key every tenant table has, so the guard must scope its reads.
  invoices: 'organization_id',
  // PREF-001 appearance & accessibility preferences (x182, migration 0078). Tenant + membership
  // owned: a row is one member's own appearance/locale settings, and an unscoped read would be every
  // member's preferences in every studio. The layer-3 guard fails OPEN on an unregistered table, so
  // registering it here is what scopes the read and the upsert; tenant-isolation.db.test.ts enforces
  // the entry.
  user_preferences: 'organization_id',
  // Home widget preferences (x243, migration 0115). Tenant-owned: a row is one membership's Home
  // widget layout in one studio, and an unscoped `SELECT ... FROM home_widget_prefs` would be every
  // member's layout across every studio on the server. `organization_id` is NOT NULL and carries the
  // `(organization_id, id)` key every tenant table has, so the guard scopes its reads and its
  // writes; the layer-3 guard fails OPEN on an unregistered table, so this entry is what scopes them,
  // and tenant-isolation.db.test.ts enforces the entry.
  home_widget_prefs: 'organization_id',
  // x216 (0094). Tenant-owned: a member's profile belongs to one membership of one studio, and an
  // unscoped `SELECT ... FROM member_profiles` would be every studio's people details on the server.
  // `organization_id` is NOT NULL and carries the `(organization_id, id)` key, so the guard scopes
  // both the profile read and the upsert.
  member_profiles: 'organization_id',
  // Admin data-export requests (x224, migration 0098). Tenant-owned: a request records that one studio
  // asked for a data export, and an unscoped `SELECT ... FROM admin_export_requests` would be every
  // studio's export requests on the server. `organization_id` is NOT NULL and carries the
  // `(organization_id, id)` key every tenant table has, so the guard scopes its reads and its writes;
  // the layer-3 guard fails OPEN on an unregistered table, so this entry is what scopes them.
  admin_export_requests: 'organization_id',
  // x225 (0099) invoice_line_items. Per-invoice line detail is per-tenant: an unscoped
  // `SELECT ... FROM invoice_line_items` would be every studio's billing detail on the server.
  // `organization_id` is NOT NULL and carries the `(organization_id, id)` key every tenant table
  // has, so the guard must scope its reads.
  invoice_line_items: 'organization_id',
});

/**
 * Tables that are intentionally global, listed so the omission is a decision rather than
 * an oversight. `users`, `sessions` and `session_refresh_tokens` are cross-tenant identity:
 * one person, one account, memberships in many organizations — forking identity per tenant
 * would break revocation across them. `schema_migrations` belongs to the migrator.
 *
 * This list is not merely documentation. `TenantDatabase.identityRead()` and
 * `.identityTransaction()` require every table they are declared over to appear here, so a
 * table cannot be reached from the no-tenant-context path unless it is registered as global
 * in this file. `tenant-isolation.db.test.ts` holds it to `information_schema`: every table
 * in the database is in exactly one of the two registries.
 */
export const NON_TENANT_TABLES: readonly string[] = Object.freeze([
  'users',
  'sessions',
  'session_refresh_tokens',
  'schema_migrations',
  // ID-002. A person is one account holding memberships in many organizations, so their
  // credentials cannot be forked per tenant: doing so would mean revoking a password in one
  // organization left it working in the rest. `authentication_events` is non-tenant for a
  // sharper reason still — it records attempts made before any tenant has been resolved, and
  // some of them name no user at all.
  'user_passwords',
  'user_mfa_factors',
  'user_recovery_codes',
  'authentication_events',
  // D05d. The notice queue that tells an account holder their credentials changed. Global
  // for the same reason the credentials are: the change it describes is not a fact about
  // one tenant, and it is written on the identity path, before any tenant exists. It is
  // deliberately NOT `outbox_events` — that table's `organization_id` is NOT NULL and this
  // path has no organization to put in it. `0020_credential_change_notices.sql` explains.
  'credential_change_notices',
  // Public & trust site (x159, migration 0060). The status-page incidents are GLOBAL: a status
  // page is read by anyone before any organization is named and describes the service as a whole,
  // so `incidents` carries no `organization_id` (0060 explains). Registered here — NOT in
  // TENANT_TABLES — so the layer-3 guard treats the public, org-less read as legitimate rather
  // than a leak, and the identity read path (`makeIdentityRunner`) may reach it. The public read
  // still filters `published = 1` in SQL; the guard's job here is only to allow the unscoped read.
  'incidents',
  // x160. The public product changelog (0061). Global for the reason the identity tables are —
  // it carries no `organization_id` at all: a changelog is one public record for the product,
  // not a per-tenant one. The public `GET /v1/public/site/changelog` read reaches it through
  // `TenantDatabase.identityRead(['changelog_entries'])`, which is why it must be declared here.
  'changelog_entries',
  // x161. The public site's contact / lead intake. GLOBAL for the reason the credentials are:
  // a lead is submitted by a member of the public with no session and belonging to no
  // organization, so there is no `organization_id` to scope it by and it is written on a
  // public, no-tenant path. Registering it here is what lets the repository reach it through
  // `identityTransaction`; it is deliberately NOT in `TENANT_TABLES`. `0062_marketing_leads.sql`.
  'marketing_leads',
  // Platform states (x185, migration 0080). The platform maintenance / degraded-mode window is
  // GLOBAL: it announces the state of the whole service and is read by the app shell before and
  // independently of any organization, so `maintenance_windows` carries no `organization_id` (0080
  // explains). Registered here — NOT in TENANT_TABLES — so the layer-3 guard treats the org-less
  // public read (and the admin write, which is authorized against a tenant but persists globally) as
  // legitimate, and the identity path (`makeIdentityRunner`) may reach it. The public read still
  // filters `published = 1` in SQL; the guard's job here is only to allow the unscoped access.
  'maintenance_windows',
]);

export function isTenantTable(name: string): boolean {
  return Object.hasOwn(TENANT_TABLES, name.toLowerCase());
}

export function isNonTenantTable(name: string): boolean {
  return NON_TENANT_TABLES.includes(name.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer
// ─────────────────────────────────────────────────────────────────────────────

type TokenKind = 'word' | 'punct' | 'param' | 'literal' | 'number';

interface Token {
  readonly kind: TokenKind;
  /** Lower-cased for words and punctuation; the raw text for literals and numbers. */
  readonly value: string;
  /** Paren nesting depth at which the token appears. */
  readonly depth: number;
  /** Ordinal position among `?` placeholders, so a token can be matched to its parameter. */
  readonly paramIndex?: number;
}

const OPERATORS = ['<=>', '<>', '!=', '<=', '>=', ':=', '&&', '||', '=', '<', '>'] as const;

/**
 * Reduce a statement to tokens, discarding comments and collapsing string literals.
 *
 * Collapsing literals is a correctness requirement, not a tidiness one: without it the
 * text `'... organization_id = ...'` inside a string would register as a tenant predicate,
 * which is precisely the injection an attacker would reach for.
 */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let depth = 0;
  let paramCount = 0;

  while (i < sql.length) {
    const ch = sql[i] as string;
    const rest = sql.slice(i);

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === '#' || (ch === '-' && /^--[\s]/.test(rest))) {
      const eol = sql.indexOf('\n', i);
      i = eol === -1 ? sql.length : eol + 1;
      continue;
    }

    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }

    // Backtick-quoted identifiers become ordinary words, so `organization_id` and
    // organization_id are the same token to the analyser.
    if (ch === '`') {
      let j = i + 1;
      let name = '';
      while (j < sql.length) {
        if (sql[j] === '`') {
          if (sql[j + 1] === '`') {
            name += '`';
            j += 2;
            continue;
          }
          break;
        }
        name += sql[j];
        j += 1;
      }
      tokens.push({ kind: 'word', value: name.toLowerCase(), depth });
      i = j + 1;
      continue;
    }

    // MySQL's default mode treats double quotes as string delimiters; the migrations never
    // enable ANSI_QUOTES, and the connection factory does not set it either.
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < sql.length) {
        const c = sql[j] as string;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      tokens.push({ kind: 'literal', value: sql.slice(i + 1, j), depth });
      i = j + 1;
      continue;
    }

    if (ch === '?') {
      tokens.push({ kind: 'param', value: '?', depth, paramIndex: paramCount });
      paramCount += 1;
      i += 1;
      continue;
    }

    if (/[A-Za-z_@$]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_@$]/.test(sql[j] as string)) j += 1;
      tokens.push({ kind: 'word', value: sql.slice(i, j).toLowerCase(), depth });
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[0-9.eE+-]/.test(sql[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: sql.slice(i, j), depth });
      i = j;
      continue;
    }

    if (ch === '(') {
      depth += 1;
      tokens.push({ kind: 'punct', value: '(', depth });
      i += 1;
      continue;
    }

    if (ch === ')') {
      tokens.push({ kind: 'punct', value: ')', depth });
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }

    const operator = OPERATORS.find((op) => rest.startsWith(op));
    if (operator) {
      tokens.push({ kind: 'punct', value: operator, depth });
      i += operator.length;
      continue;
    }

    tokens.push({ kind: 'punct', value: ch, depth });
    i += 1;
  }

  return tokens;
}

/**
 * Every tenant-owned table named anywhere in a statement, however it is used.
 *
 * Deliberately cruder than {@link analyzeStatement}'s `tenantTables`, and that is the point.
 * `tenantTables` reports the tables the reference scanner *understood* — the ones introduced
 * by `FROM`, `JOIN`, `UPDATE`, `INTO`. This reports every tenant table name that survives
 * tokenization, including one sitting somewhere the scanner could not interpret.
 *
 * Used by the bootstrap read path (`TenantDatabase.bootstrapRead`), where the question is
 * not "is this statement scoped" — nothing there can be — but "does this statement stay
 * inside the small set of tables the caller declared". For that question the conservative
 * answer is the correct one: a name the analyser could not place must still count against
 * the allowlist, or an unanalysable statement would slip past the very check that exists
 * because the tenant predicate has been waived.
 *
 * String literals are collapsed by the tokenizer before this runs, so `'projects'` inside a
 * value does not register as a reference to `projects`.
 */
export function tenantTablesMentioned(sql: string): readonly string[] {
  const names = new Set<string>();
  for (const token of tokenize(sql)) {
    if (token.kind === 'word' && isTenantTable(token.value)) names.add(token.value);
  }
  return [...names].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis
// ─────────────────────────────────────────────────────────────────────────────

/** Words that can never be a table alias, so `from projects where …` is not read as an alias. */
const NON_ALIAS_WORDS = new Set([
  'where',
  'on',
  'using',
  'join',
  'inner',
  'left',
  'right',
  'outer',
  'cross',
  'natural',
  'straight_join',
  'set',
  'group',
  'order',
  'limit',
  'offset',
  'having',
  'union',
  'intersect',
  'except',
  'for',
  'values',
  'value',
  'select',
  'insert',
  'update',
  'delete',
  'replace',
  'into',
  'as',
  'partition',
  'force',
  'use',
  'ignore',
  'index',
  'key',
  'lock',
  'procedure',
  'when',
  'then',
  'else',
  'end',
  'and',
  'or',
  'not',
  'is',
  'null',
  'window',
  'with',
  'duplicate',
  'share',
  'mode',
  'returning',
  'default',
  'from',
  'distinct',
]);

const TABLE_INTRODUCERS = new Set(['from', 'join', 'update', 'into', 'table']);

interface TableRef {
  readonly table: string;
  readonly alias: string;
  readonly tenantColumn: 'organization_id' | 'id';
  /** Paren depth of the declaration, used to resolve unqualified columns to the right scope. */
  readonly depth: number;
}

export interface GuardAnalysis {
  readonly kind: string;
  readonly tenantTables: readonly string[];
  readonly violations: readonly string[];
  /** Literal-free rendering, safe to log. Parameters appear as `?`, never as their values. */
  readonly fingerprint: string;
  readonly shape: string;
}

/** Union-find over aliases, so `a.organization_id = b.organization_id` propagates scoping. */
class Groups {
  private readonly parent = new Map<string, string>();

  find(a: string): string {
    const p = this.parent.get(a);
    if (p === undefined || p === a) {
      this.parent.set(a, a);
      return a;
    }
    const root = this.find(p);
    this.parent.set(a, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function renderShape(tokens: readonly Token[]): string {
  return tokens
    .map((t) => (t.kind === 'literal' ? "'…'" : t.kind === 'number' ? 'N' : t.value))
    .join(' ')
    .slice(0, 500);
}

/**
 * Statically analyse one statement against one organization id.
 *
 * Exported separately from {@link assertTenantScoped} so the isolation corpus can assert
 * the analyser's verdicts directly, without needing a server for every case.
 */
export function analyzeStatement(
  sql: string,
  params: readonly unknown[],
  organizationId: string,
): GuardAnalysis {
  const tokens = tokenize(sql);
  const shape = renderShape(tokens);
  const fingerprint = createHash('sha256').update(shape).digest('hex').slice(0, 16);
  const violations: string[] = [];
  const kind = tokens[0]?.value ?? 'empty';

  const base = { kind, fingerprint, shape };

  if (tokens.length === 0) return { ...base, tenantTables: [], violations: [] };

  // `multipleStatements` is off on every pool this guard protects. If a second statement
  // ever appears, the analyser has only inspected the first — refuse rather than approve.
  const trailingSemicolon = tokens.findIndex(
    (t, index) => t.kind === 'punct' && t.value === ';' && index < tokens.length - 1,
  );
  if (trailingSemicolon !== -1) {
    return {
      ...base,
      tenantTables: [],
      violations: ['statement contains more than one SQL statement; only the first was analysed'],
    };
  }

  // ── Table references ───────────────────────────────────────────────────────
  const refs: TableRef[] = [];
  const consumedAsTable = new Set<number>();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;
    if (token.kind !== 'word' || !TABLE_INTRODUCERS.has(token.value)) continue;

    let j = i + 1;
    for (;;) {
      // `from (select …) t` — a derived table, whose inner FROM is scanned on its own.
      const head = tokens[j];
      if (!head || head.kind !== 'word' || NON_ALIAS_WORDS.has(head.value)) break;

      let table = head.value;
      let end = j;
      // `schema.table`
      if (tokens[j + 1]?.value === '.' && tokens[j + 2]?.kind === 'word') {
        table = (tokens[j + 2] as Token).value;
        end = j + 2;
      }
      consumedAsTable.add(end);

      let alias = table;
      let next = end + 1;
      if (tokens[next]?.kind === 'word' && tokens[next]?.value === 'as') next += 1;
      const aliasToken = tokens[next];
      if (aliasToken?.kind === 'word' && !NON_ALIAS_WORDS.has(aliasToken.value)) {
        alias = aliasToken.value;
        end = next;
      }

      const tenantColumn = TENANT_TABLES[table];
      if (tenantColumn !== undefined) {
        refs.push({ table, alias, tenantColumn, depth: head.depth });
      }

      // Comma-joined table lists: `from projects p, work_items w`.
      if (tokens[end + 1]?.kind === 'punct' && tokens[end + 1]?.value === ',') {
        j = end + 2;
        continue;
      }
      break;
    }
  }

  const tenantTables = [...new Set(refs.map((r) => r.table))].sort();
  const declaredNames = new Set<string>(refs.flatMap((r) => [r.table, r.alias]));

  // Fail-closed safety net: a tenant table name that appears somewhere the reference
  // scanner did not understand means the statement's shape is beyond this analyser.
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;
    if (token.kind !== 'word' || !isTenantTable(token.value)) continue;
    if (consumedAsTable.has(i)) continue;
    if (tokens[i - 1]?.value === '.') continue; // a column named like a table
    if (declaredNames.has(token.value)) continue; // used as its own implicit alias
    violations.push(
      `tenant table '${token.value}' appears in a position this guard cannot analyse; ` +
        `rewrite the statement or use an audited allowUnscoped escape`,
    );
  }

  if (refs.length === 0) {
    return { ...base, tenantTables, violations };
  }

  // ── Statement kinds that cannot carry a predicate ──────────────────────────
  const SCOPEABLE = new Set(['select', 'insert', 'replace', 'update', 'delete', 'with']);
  if (!SCOPEABLE.has(kind)) {
    violations.push(
      `'${kind}' cannot be tenant-scoped but touches ${tenantTables.join(', ')}; ` +
        `schema and bulk operations belong in a migration, not in application code`,
    );
    return { ...base, tenantTables, violations };
  }

  // ── Regions excluded from predicate scanning ───────────────────────────────
  // Anchors are only meaningful in predicates. A projected expression or an assignment
  // that happens to read `organization_id = ?` must never be mistaken for scoping.
  const excluded = new Set<number>();
  const excludeRange = (from: number, to: number): void => {
    for (let i = from; i <= to && i < tokens.length; i += 1) excluded.add(i);
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;
    if (token.kind !== 'word' || token.value !== 'select') continue;
    let j = i + 1;
    while (j < tokens.length) {
      const t = tokens[j] as Token;
      if (t.kind === 'word' && t.value === 'from' && t.depth === token.depth) break;
      j += 1;
    }
    excludeRange(i + 1, j - 1);
  }

  // UPDATE … SET … : assignments are excluded, and assigning the tenant column is a
  // violation in its own right. The database enforces this too (immutability trigger);
  // catching it here turns a runtime SIGNAL into a developer-time failure.
  if (kind === 'update') {
    const setIndex = tokens.findIndex(
      (t) => t.kind === 'word' && t.value === 'set' && t.depth === 0,
    );
    if (setIndex !== -1) {
      let end = tokens.length - 1;
      for (let i = setIndex + 1; i < tokens.length; i += 1) {
        const t = tokens[i] as Token;
        if (
          t.kind === 'word' &&
          t.depth === 0 &&
          (t.value === 'where' || t.value === 'order' || t.value === 'limit')
        ) {
          end = i - 1;
          break;
        }
      }
      for (let i = setIndex; i <= end; i += 1) {
        const t = tokens[i] as Token;
        if (t.kind === 'word' && (t.value === 'organization_id' || t.value === 'id')) {
          const owner = resolveOwner(refs, tokens, i);
          if (owner && owner.tenantColumn === t.value) {
            violations.push(
              `UPDATE assigns ${owner.table}.${t.value}; the tenant key is immutable ` +
                `(spec section 5) — move data between organizations through the audited workflow`,
            );
          }
        }
      }
      excludeRange(setIndex, end);
    }
  }

  // ON DUPLICATE KEY UPDATE is an assignment region with the same hazard.
  for (let i = 0; i < tokens.length - 2; i += 1) {
    if (
      tokens[i]?.value === 'on' &&
      tokens[i + 1]?.value === 'duplicate' &&
      tokens[i + 2]?.value === 'key'
    ) {
      for (let j = i + 3; j < tokens.length; j += 1) {
        const t = tokens[j] as Token;
        if (t.kind === 'word' && (t.value === 'organization_id' || t.value === 'id')) {
          const owner = resolveOwner(refs, tokens, j);
          if (owner && owner.tenantColumn === t.value) {
            violations.push(
              `ON DUPLICATE KEY UPDATE assigns ${owner.table}.${t.value}; the tenant key is immutable`,
            );
          }
        }
      }
      excludeRange(i + 3, tokens.length - 1);
      break;
    }
  }

  // ── INSERT / REPLACE ───────────────────────────────────────────────────────
  if (kind === 'insert' || kind === 'replace') {
    violations.push(...analyzeInsert(tokens, refs, params, organizationId, excluded));
  }

  // ── Predicate anchoring for everything that reads or narrows rows ──────────
  // An INSERT … SELECT still needs its SELECT half scoped, so this runs for inserts too.
  const hasReadHalf =
    kind !== 'insert' && kind !== 'replace'
      ? true
      : tokens.some((t) => t.kind === 'word' && t.value === 'select');

  if (hasReadHalf) {
    // The INSERT target has no predicate by nature — its scoping was checked above by
    // inspecting the written tenant key. Only the SELECT half is anchor-checked.
    const readRefs = kind === 'insert' || kind === 'replace' ? refs.slice(1) : refs;
    if (readRefs.length > 0) {
      violations.push(...analyzeAnchors(tokens, readRefs, params, organizationId, excluded));
    }
  }

  return { ...base, tenantTables, violations: [...new Set(violations)] };
}

/**
 * Which table a column reference belongs to.
 *
 * A qualified `p.organization_id` names its alias outright. An unqualified
 * `organization_id` resolves the way MySQL resolves it: to the tables declared in the
 * innermost enclosing scope, which is approximated here by paren depth. When more than one
 * candidate remains the reference is genuinely ambiguous — MySQL would reject it too — so
 * it anchors nothing.
 */
function resolveOwner(
  refs: readonly TableRef[],
  tokens: readonly Token[],
  index: number,
): TableRef | undefined {
  const qualifier =
    tokens[index - 1]?.value === '.' && tokens[index - 2]?.kind === 'word'
      ? tokens[index - 2]?.value
      : undefined;

  if (qualifier !== undefined) {
    return refs.find((r) => r.alias === qualifier || r.table === qualifier);
  }

  const depth = (tokens[index] as Token).depth;
  const sameDepth = refs.filter((r) => r.depth === depth);
  if (sameDepth.length === 1) return sameDepth[0];
  if (sameDepth.length > 1) return undefined;

  // No table declared at this depth: fall back to the nearest enclosing scope.
  const enclosing = refs.filter((r) => r.depth < depth);
  if (enclosing.length === 0) return undefined;
  const nearest = Math.max(...enclosing.map((r) => r.depth));
  const candidates = enclosing.filter((r) => r.depth === nearest);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function analyzeAnchors(
  tokens: readonly Token[],
  refs: readonly TableRef[],
  params: readonly unknown[],
  organizationId: string,
  excluded: ReadonlySet<number>,
): string[] {
  const violations: string[] = [];
  const groups = new Groups();
  const anchored = new Set<string>();

  for (let i = 0; i < tokens.length; i += 1) {
    if (excluded.has(i)) continue;
    const token = tokens[i] as Token;
    if (token.kind !== 'word') continue;
    if (token.value !== 'organization_id' && token.value !== 'id') continue;

    const owner = resolveOwner(refs, tokens, i);
    if (!owner || owner.tenantColumn !== token.value) continue;

    const operator = tokens[i + 1];
    if (!operator || operator.kind !== 'punct') {
      // `IN (?, ?)` — every listed value must belong to the active organization.
      if (operator?.kind === 'word' && operator.value === 'in' && tokens[i + 2]?.value === '(') {
        const listed: Token[] = [];
        for (let j = i + 3; j < tokens.length; j += 1) {
          const t = tokens[j] as Token;
          if (t.kind === 'punct' && t.value === ')') break;
          if (t.kind === 'punct' && t.value === ',') continue;
          listed.push(t);
        }
        const allParams = listed.length > 0 && listed.every((t) => t.kind === 'param');
        if (!allParams) {
          violations.push(
            `${owner.table}.${owner.tenantColumn} IN (…) must list bound parameters only`,
          );
          continue;
        }
        const allMatch = listed.every((t) => params[t.paramIndex as number] === organizationId);
        if (!allMatch) {
          violations.push(
            `${owner.table}.${owner.tenantColumn} IN (…) includes an organization other than ` +
              `the active tenant context`,
          );
          continue;
        }
        anchored.add(groups.find(owner.alias));
      }
      continue;
    }

    if (operator.value !== '=' && operator.value !== '<=>') continue;

    const rhs = tokens[i + 2];
    if (!rhs) continue;

    if (rhs.kind === 'param') {
      const bound = params[rhs.paramIndex as number];
      if (bound === organizationId) {
        anchored.add(groups.find(owner.alias));
      } else {
        violations.push(
          `${owner.table}.${owner.tenantColumn} is bound to a value that is not the active ` +
            `tenant context; a repository must derive the organization from TenantContext`,
        );
      }
      continue;
    }

    if (rhs.kind === 'literal' || rhs.kind === 'number') {
      violations.push(
        `${owner.table}.${owner.tenantColumn} is compared to an inline literal; tenant ` +
          `predicates must be bound parameters (spec section 5)`,
      );
      continue;
    }

    if (rhs.kind === 'word') {
      // Join equality: `a.organization_id = b.organization_id` (or `= o.id`). The right
      // side is either a bare column at i+2 or a qualified one whose column sits at i+4.
      const rhsIndex = tokens[i + 3]?.value === '.' ? i + 4 : i + 2;
      const rhsToken = tokens[rhsIndex];
      if (!rhsToken || rhsToken.kind !== 'word') continue;
      const other = resolveOwner(refs, tokens, rhsIndex);
      if (other && other.tenantColumn === rhsToken.value && other.alias !== owner.alias) {
        groups.union(owner.alias, other.alias);
      }
    }
  }

  // Re-resolve roots after all unions, then require every referenced tenant table to sit
  // in a group that is anchored to the active organization.
  const anchoredRoots = new Set([...anchored].map((a) => groups.find(a)));
  const unscoped = refs.filter((r) => !anchoredRoots.has(groups.find(r.alias)));
  for (const ref of [...new Map(unscoped.map((r) => [r.alias, r])).values()]) {
    violations.push(
      `no organization_id predicate binds ${ref.table}` +
        (ref.alias === ref.table ? '' : ` (alias ${ref.alias})`) +
        ` to the active tenant context`,
    );
  }

  return violations;
}

/**
 * An INSERT has no WHERE to inspect, so scoping means something different: the row being
 * written must *carry* the active organization id. Spec section 6 — "Mutation repositories
 * derive organization_id from TenantContext, never from the DTO" — is what this enforces
 * mechanically.
 */
function analyzeInsert(
  tokens: readonly Token[],
  refs: readonly TableRef[],
  params: readonly unknown[],
  organizationId: string,
  excluded: Set<number>,
): string[] {
  const violations: string[] = [];
  const target = refs[0];
  if (!target) return violations;

  const intoIndex = tokens.findIndex((t) => t.kind === 'word' && t.value === 'into');
  const setIndex = tokens.findIndex((t) => t.kind === 'word' && t.value === 'set' && t.depth === 0);

  // `INSERT … SET col = value` form.
  if (setIndex !== -1) {
    let matched = false;
    for (let i = setIndex + 1; i < tokens.length; i += 1) {
      const t = tokens[i] as Token;
      if (t.kind !== 'word' || t.value !== target.tenantColumn) continue;
      if (tokens[i + 1]?.value !== '=') continue;
      const rhs = tokens[i + 2];
      if (rhs?.kind !== 'param') {
        violations.push(
          `INSERT … SET ${target.table}.${target.tenantColumn} must be a bound parameter`,
        );
      } else if (params[rhs.paramIndex as number] !== organizationId) {
        violations.push(
          `INSERT into ${target.table} writes an organization other than the active ` +
            `tenant context`,
        );
      } else {
        matched = true;
      }
      excluded.add(i);
    }
    if (!matched && violations.length === 0) {
      violations.push(`INSERT into ${target.table} does not set ${target.tenantColumn}`);
    }
    return violations;
  }

  // `INSERT … (cols) VALUES (…)` / `INSERT … (cols) SELECT …`
  const openParen = tokens.findIndex(
    (t, index) => index > intoIndex && t.kind === 'punct' && t.value === '(',
  );
  if (openParen === -1) {
    violations.push(
      `INSERT into ${target.table} has no explicit column list; positional inserts into ` +
        `tenant tables are not reviewable`,
    );
    return violations;
  }

  const columns: string[] = [];
  let closeParen = -1;
  for (let i = openParen + 1; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind === 'punct' && t.value === ')') {
      closeParen = i;
      break;
    }
    if (t.kind === 'word') columns.push(t.value);
  }

  const columnIndex = columns.indexOf(target.tenantColumn);
  if (columnIndex === -1) {
    violations.push(
      `INSERT into ${target.table} omits ${target.tenantColumn}; the tenant key is never ` +
        `optional on a tenant-owned table`,
    );
    return violations;
  }

  // The column list is not a predicate region.
  for (let i = openParen; i <= closeParen; i += 1) excluded.add(i);

  const valuesIndex = tokens.findIndex(
    (t, index) =>
      index > closeParen && t.kind === 'word' && (t.value === 'values' || t.value === 'value'),
  );

  if (valuesIndex === -1) {
    // `INSERT … SELECT …`: the value cannot be read statically, so the SELECT half must be
    // tenant-scoped and is checked by analyzeAnchors. Recorded here so the limitation is
    // visible rather than implied.
    const selectIndex = tokens.findIndex(
      (t, index) => index > closeParen && t.kind === 'word' && t.value === 'select',
    );
    if (selectIndex === -1) {
      violations.push(`INSERT into ${target.table} has neither VALUES nor SELECT`);
    }
    return violations;
  }

  // Walk each `( … )` tuple and check the value sitting at the tenant column's position.
  //
  // Only the *first* token of the value at that position is inspected: a value can be a
  // multi-token expression such as `uuid()` or `? + 1`, and re-entering the check for each
  // of its tokens would report the same problem repeatedly and, worse, read a later
  // column's parameter. Tuple boundaries are matched by paren depth, so nested calls do
  // not shift the column count.
  let tupleStart = -1;
  let tupleDepth = 0;
  let position = 0;
  let valueChecked = false;
  let tupleCount = 0;

  for (let i = valuesIndex + 1; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind === 'punct' && t.value === '(' && tupleStart === -1) {
      tupleStart = i;
      tupleDepth = t.depth;
      position = 0;
      valueChecked = false;
      tupleCount += 1;
      continue;
    }
    if (tupleStart === -1) continue;
    if (t.kind === 'punct' && t.value === ')' && t.depth === tupleDepth) {
      tupleStart = -1;
      continue;
    }
    if (t.kind === 'punct' && t.value === ',' && t.depth === tupleDepth) {
      position += 1;
      valueChecked = false;
      continue;
    }
    if (position !== columnIndex || valueChecked) continue;
    valueChecked = true;

    if (t.kind === 'param') {
      if (params[t.paramIndex as number] !== organizationId) {
        violations.push(
          `INSERT into ${target.table} writes an organization other than the active ` +
            `tenant context`,
        );
      }
    } else if (t.kind === 'literal') {
      violations.push(
        `INSERT into ${target.table} supplies ${target.tenantColumn} as an inline literal; ` +
          `it must be a bound parameter derived from TenantContext`,
      );
    } else if (t.kind === 'word') {
      violations.push(
        `INSERT into ${target.table} supplies ${target.tenantColumn} from expression ` +
          `'${t.value}', which the guard cannot verify against the active tenant context`,
      );
    }
  }

  if (tupleCount === 0) {
    violations.push(`INSERT into ${target.table} has a VALUES keyword but no value tuple`);
  }

  return violations;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enforcement
// ─────────────────────────────────────────────────────────────────────────────

export type TenantGuardMode = 'enforce' | 'observe';

/**
 * Safe metadata only. `shape` has every string literal collapsed and every parameter left
 * as `?`, so a guard event can be logged in production without carrying tenant data into
 * the log pipeline.
 */
export interface TenantGuardEvent {
  readonly organizationId: string;
  readonly correlationId: string;
  readonly mode: TenantGuardMode;
  readonly statementKind: string;
  readonly tenantTables: readonly string[];
  readonly violations: readonly string[];
  readonly fingerprint: string;
  readonly shape: string;
  /** Present only for an audited `allowUnscoped` escape. */
  readonly allowedReason?: string;
}

export class TenantGuardViolation extends Error {
  constructor(
    readonly event: TenantGuardEvent,
    readonly sql: string,
  ) {
    super(
      `Tenant guard rejected a statement touching ` +
        `${event.tenantTables.join(', ') || '(no tenant table)'}:\n` +
        event.violations.map((v) => `  - ${v}`).join('\n') +
        `\n  statement: ${event.shape}` +
        `\n  MySQL has no row-level security: without an organization_id predicate this ` +
        `statement would read or write every tenant's rows (ADR-0001 layer 3).`,
    );
    this.name = 'TenantGuardViolation';
  }
}

export interface TenantGuardOptions {
  readonly mode: TenantGuardMode;
  /** Security-event sink. Called for every violation, in both modes. */
  readonly onEvent?: (event: TenantGuardEvent) => void;
  /**
   * A deliberate, reviewed cross-tenant statement — the outbox relay, a migration-time
   * repair, an owner support command. The reason is mandatory and is recorded, so an
   * escape is visible in the audit trail rather than being a silent bypass.
   */
  readonly allowUnscoped?: { readonly reason: string };
}

export interface GuardedContext {
  readonly organizationId: string;
  readonly correlationId: string;
}

/**
 * Throw (or, in `observe`, record) when a statement is not bound to the active tenant.
 *
 * Production defaults to `enforce`. ADR-0001 argues why: logging and serving means the
 * first occurrence of the bug is also a live data leak, and a 500 is recoverable where a
 * cross-tenant disclosure is not. `observe` exists for a documented incident and is set
 * through `TENANT_GUARD_MODE`, never by code.
 */
export function assertTenantScoped(
  sql: string,
  params: readonly unknown[],
  context: GuardedContext,
  options: TenantGuardOptions,
): GuardAnalysis {
  const analysis = analyzeStatement(sql, params, context.organizationId);

  if (options.allowUnscoped) {
    const reason = options.allowUnscoped.reason.trim();
    if (reason.length < 10) {
      throw new TypeError(
        'allowUnscoped requires a substantive reason string; it is recorded as a security event',
      );
    }
    if (analysis.tenantTables.length > 0) {
      options.onEvent?.({
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        mode: options.mode,
        statementKind: analysis.kind,
        tenantTables: analysis.tenantTables,
        violations: analysis.violations,
        fingerprint: analysis.fingerprint,
        shape: analysis.shape,
        allowedReason: reason,
      });
    }
    return analysis;
  }

  if (analysis.violations.length === 0) return analysis;

  const event: TenantGuardEvent = {
    organizationId: context.organizationId,
    correlationId: context.correlationId,
    mode: options.mode,
    statementKind: analysis.kind,
    tenantTables: analysis.tenantTables,
    violations: analysis.violations,
    fingerprint: analysis.fingerprint,
    shape: analysis.shape,
  };

  options.onEvent?.(event);

  if (options.mode === 'enforce') throw new TenantGuardViolation(event, sql);
  return analysis;
}
