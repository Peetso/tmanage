---
part: api/work
kind: api-module
context: work-management
owner: implementation-lead
lifecycle: production
depends_on:
  [
    api-common/database,
    api-common/http,
    api/audit,
    api/platform,
    api/projects,
    api/tenancy,
    api/files,
    api/working-calendar,
    package/domain,
  ]
provides_api:
  [
    '/v1/organizations/:orgSlug/work-items',
    '/v1/organizations/:orgSlug/work-items/:workItemId',
    '/v1/organizations/:orgSlug/work-items/:workItemId/{transitions,dependencies,blockers,health,client-audience,activity,estimate,files,links,relations,time-logs,stage,stage-set,watchers,checklist,comments,people,reminder,schedule}',
    '/v1/organizations/:orgSlug/work-items/{bulk-transition,reminders/due,project-health/:projectId}',
    '/v1/organizations/:orgSlug/work/quick-add/resolve',
    '/v1/organizations/:orgSlug/work-forms/*',
    '/v1/organizations/:orgSlug/projects/:projectId/schedule/*',
    '/v1/organizations/:orgSlug/{work-stage-sets,work-labels,board-columns,checklist-templates,custom-fields,work-keys,recurrence}/* (org-prefixed controllers)',
  ]
consumes_api: []
tables_owned:
  [
    work_items,
    work_item_dependencies,
    work_blockers,
    work_item_checklist_items,
    work_forms,
    work_item_comments,
    work_item_links,
    work_item_files,
    work_item_time_logs,
    work_item_watchers,
    work_item_labels,
    work_item_reminders,
    work_item_recurrence,
    work_item_recurrence_instances,
    work_item_estimates,
    work_checklist_templates,
    work_item_custom_fields,
    work_item_subtasks,
    work_board_columns,
    work_stage_sets,
    work_stages,
    work_stage_set_projects,
    work_item_code_links,
    work_item_schedule_stats,
    work_item_client_audience,
    work_item_assignees,
  ]
rules:
  [
    AR-4,
    AR-5,
    AR-6,
    AR-7,
    AR-8,
    AR-9,
    AR-10,
    HT-1,
    HT-4,
    DA-1,
    DA-2,
    DA-3,
    DA-10,
    DA-11,
    DA-12,
    AS-1,
    AS-2,
    AS-3,
    AS-4,
    RT-2,
    RT-3,
    SE-1,
    PR-3,
    IP-3,
    IP-5,
    IP-7,
    IP-17,
  ]
ux_rules: []
last_verified_commit: 3b7e4fa70eb6facff3f1dccc65c0867f0707a0a6
last_verified_date: 2026-11-20
last_verified_by: Claude Opus 5.5 (lane H)
---

# api/work

Read this before changing any file under `apps/api/src/modules/work/**`. Rule IDs refer to
`docs/architecture/ENGINEERING-STANDARD.md` (AR, HT, DA, AS, RT, SE, PR),
`IMPLEMENTATION-PATTERNS.md` (IP) and `UI-UX-DESIGN-STANDARD.md` (UX). Every `file:line` was
checked at `3b7e4fa7`. Paths are relative to this folder unless they start with `apps/`, `e2e/`,
`packages/` or `docs/`.

## Purpose and bounded context

**What it is for.** Work items (tasks, deliverable work, client actions) and everything attached
to one item: state machine transitions, dependencies and blockers, assignees (doers,
supervisors), steps (the checklist; the one steps model since `0414`, with a person, a day,
reorder, delete and convert-to-work), renamable stages in stage sets (`stages/`, `0413`), comments with @mentions, links, files, time logs,
estimates, watchers, labels, reminders, recurrence (rules + a spawner), custom fields, board
columns, checklist templates, work keys (`TM-482`), intake forms, quick-add resolution, schedule
cascade and schedule statistics, the client audience of an item, and the per-item activity log.
108 files, 25 controllers.

Saved views live in `api/work-views`; the time-tracking timer in `api/time`; client requests in
`api/requests`.

**Who uses it.** `web/org/work` (list, board, detail, timeline, calendar, workload),
`web/org/projects` (overview blocks), the portal via `api/clients`, the worker (automation,
webhooks, notices, realtime fan-out consume its outbox events), the MCP server and AI tools
(SE-8: they must call `WorkItemsService`), and 41 non-test files in other modules that import
`work-items.repository.js` directly (§11).

**Context map (VIEWS §4).** Work Management; upstream of Portal, Finance, Collaboration.

| Direction | Partner | How | Evidence |
| --- | --- | --- | --- |
| upstream of | 18 modules (time 6, insights 5, import 5, projects 4, …) | **direct import of `WorkItemsRepository`** — 41 non-test files | `grep -rl "work/work-items.repository.js'" apps/api/src` |
| upstream of | worker consumers, realtime | 9 outbox event types (§3) | `apps/worker/src/consumers/registry.ts:176,190,269` |
| downstream of | projects (same context) | `new ProjectsRepository()` injected into `WorkItemsService` | `work.module.ts:132-138` |
| downstream of | tenancy | reads `memberships`, `custom_roles`, `organizations`, `client_memberships` | `work-item-assignees.repository.ts:5`, `recurrence-spawner.repository.ts:26-28`, `work-item-client-audience.repository.ts:5` |
| downstream of | audit | **imports `AuditEventsRepository`** to build the activity log | `activity-log.service.ts:15` |
| downstream of | files | joins `file_assets` | `item-files.repository.ts:5,97` |
| downstream of | finance | reads `org_finance_profiles.digits` for quick-add | `quick-add.repository.ts:6,98-99` |
| downstream of | working-calendar | `workingCalendarSource(new WorkingCalendarRepository())` for the spawner | `work.module.ts:367` |

## Domain model and invariants

**Entities.** `WorkItem` (`work_items`: project, type, title, description, `state`, owner,
`audience`, start/due, `completed_at`, `version` BIGINT, `deleted_at`), `Dependency`, `Blocker`
(reason, ask, optional owner, since; resolution on leave), `Assignee` (role doer | supervisor),
`ChecklistItem`, `Subtask`, `Comment`, `Link`, `ItemFile` (→ `file_assets`), `TimeLog`,
`Estimate`, `Watcher`, `Label`, `Reminder` (per member), `Recurrence` + `RecurrenceInstance`
(claimed occurrence), `CustomField`, `BoardColumn`, `ChecklistTemplate`, `WorkForm`, `CodeLink`,
`ScheduleStats`, `ClientAudience`.

**State machine** (`packages/domain/src/state-machines/work-item.ts:4-12,26-80`): states
`backlog, ready, in_progress, blocked, internal_review, done, archived`; initial `backlog`; no
terminal state (archive restores to backlog). Required facts: → `blocked` needs `blockerReason`
and `blockerAsk`; `blocked` → `in_progress` needs `blockerResolution`; → `done` only from
`internal_review` with `ownerId` + `completedAt`; reopening `done` needs `reopenReason`. The API
writes `state` only through this machine (`work-items.service.ts:136`).

**Invariants (checkable)**

| # | Invariant | Where enforced | Proof |
| --- | --- | --- | --- |
| I-1 | Every field edit and transition is a compare-and-swap on `version`; a stale version answers **409**, never 500. | repo `work-items.repository.ts:402-440,466-520`; mapping `work-items.service.ts:1504-1517` | `work-items.controller.test.ts`, `apps/api/test/work-001-work-items.db.test.ts` |
| I-2 | A transition outside the machine is refused, naming the missing fact. | `workItemStateMachine` (domain), `work-items.service.ts:842-910` | `packages/domain/src/state-machines/state-machines.test.ts` |
| I-3 | A task with supervisors reaches `done` only by a supervisor, checked inside the transaction. | `work-items.service.ts:885-899` | `work-item-people.test.ts` |
| I-4 | Creating into a non-internal audience needs `deliverable.publish` (F26). | `work-items.service.ts:530-533,1602-1605` | `work-item-client-audience.test.ts` |
| I-5 | An item whose project is missing, archived or unrelated answers **404** (no enumeration). | `work-items.service.ts:519-529` | `work-items.controller.test.ts` |
| I-6 | Owner and blocker owner must be active internal members (422). | `work-items.service.ts:856-866,1394-1403` | `apps/api/test/work-011-owner-due-delete.db.test.ts` |
| I-7 | Create, transition, people and audience changes write state + audit row + outbox event in one transaction (DA-11, AS-1). | `work-items.service.ts:536-563,912-966` | `work-items.projection.test.ts` |
| I-8 | A list page walks at most 25 repository pages (`LIST_PAGE_BUDGET`, `:288`) filtering by `authorize()`; past it the page is returned short with a valid cursor. | `work-items.service.ts:400-430` | `work-008-saved-views.db.test.ts` (paging) |
| I-9 | A client principal only lists client audiences and never sees doer ids. | `work-items.service.ts:405-406,433-452` | `apps/api/test/sec-001-client-projection.db.test.ts` |
| I-10 | A recurrence occurrence is created at most once: `UNIQUE (organization_id, recurrence_id, occurrence_key)` claimed before the item. | `apps/api/migrations/0300_recurrence_v2.sql:89`; `recurrence-spawner.service.ts:271-279` | `recurrence-spawner.test.ts`, `apps/api/test/work-053-recurrence-spawner.db.test.ts` |
| I-11 | Two parallel dependency inserts cannot create a cycle. | `work-graph.repository.ts` | `apps/api/test/work-053-dependency-race.db.test.ts` |

## Public API and contracts

Prefix `/v1/organizations/:orgSlug`. 200 read/transition, 201 create, 204 delete, 400/422
`validation_failed`, 403 capability, 404 hidden, 409 version.

| Method path | Capability | Success | File:line |
| --- | --- | --- | --- |
| GET `/work-items` (`projectId`, `state`, `after`, `limit`) | `work.read` + relation | 200 | `work-items.controller.ts:114-155` |
| GET `/work-items/:id` | `work.read` | 200/404 | `work-items.controller.ts:157-165` |
| POST `/work-items` | `work.create` (+ `deliverable.publish` for client audience) | 201 | `work-items.controller.ts:167-169` |
| PATCH `/work-items/:id` (`version` required) | `work.update` | 200/409 | `work-items.controller.ts:219-230` |
| POST `/work-items/:id/transitions` (`to`, `version`, facts) | `work.transition` | 200/409 | `work-items.controller.ts:297-312` |
| DELETE `/work-items/:id` (soft) | `work.delete` (service also checks `work.update`) | 204 | `work-items.controller.ts:336-338`, `work-items.service.ts:1461-1466` |
| POST/DELETE `/work-items/:id/dependencies[/:dependencyId]`, GET `/blockers` | `work.update` / `work.read` | 201/204 | `work-items.controller.ts:354-399` |
| GET `/work-items/:id/health`, `/project-health/:projectId`, `/client-audience` | `work.read` | 200 | `work-items.controller.ts:280,412,428` |
| POST `/work-items/bulk-transition` | `work.transition` | 200 | `bulk-transition.controller.ts:35` |
| `/:id/schedule/cascade-preview` · `cascade-apply`, PATCH dependency lag | `work.update` | 200 | `schedule-cascade.controller.ts:94,112,124` |
| `/:id/{checklist,comments,links,files,time-logs,estimate,people}` | `work.read` / `work.update` | 200/201 | controllers `@Controller` lines in §1 file list |
| PUT/DELETE `/work-items/:id/reminder`, PUT/DELETE `/:id/watchers` | `work.read` (personal, acts on the caller only) | 200/204 | `item-reminders.controller.ts:56-57,74-75`, `watchers.controller.ts:36-47` |
| GET `/work/quick-add/resolve` | `work.read` | 200 | `quick-add.controller.ts:37-38` |
| GET/POST `/work-forms`, POST `/work-forms/:formId/submissions` | `work.read` / `work.create` | 200/201 | `work-forms.controller.ts:101,129,158` |
| labels (5), board columns (4), checklist templates (4), custom fields (5), work keys (3), recurrence (10) | `work.*`, `org.manage` (board columns, field definitions), `project.manage` (work-key prefix) | 200/201 | `work-labels.controller.ts:29`, `board-columns.controller.ts:23`, `item-recurrence.controller.ts:38` |
| GET `/projects/:projectId/schedule/*` | `work.read` / `project.manage` | 200 | `schedule-stats.controller.ts:19` |

**Contracts (AR-10).** `e2e/contracts/api-web-shapes.ts` pairs `WorkItemView` ↔
`WorkItemSummary` (`:2020`), checklist (`:2034`), stage views (`work-stages.ts`), comment (`:2052`),
link (`:2062`), relations graph (`:2072`), estimate (`:2097`), reminder (`:2114`), activity entry
(`:2124`), label (`:2133`), custom fields (`:2144-2147`), recurrence (`:2156`).

**Exported services.** `WORK_ITEMS_SERVICE` and `RECURRENCE_SPAWNER` only (`work.module.ts:416`);
`RECURRENCE_SPAWNER` is re-exported for the Hostinger host (`apps/api/src/hostinger-exports.ts:55`).

**Events published (outbox, all `*.v1`)**

| Type | Producer | Consumers |
| --- | --- | --- |
| `work_item.created.v1` | `work-items.service.ts:554-558` | automation runs, webhooks (`registry.ts:190`), realtime fan-out |
| `work_item.changed.v1` | `work-items.service.ts:777-784` | realtime fan-out (`apps/worker/src/realtime/work-fan-out.ts:37`) |
| `work_item.updated.v1` (state change) | `work-items.service.ts:937-945` | automation, notices, webhooks, realtime (`registry.ts:176`) |
| `work_item.blocked.v1` | `work-items.service.ts:961-962` | `workItemBlockedConsumer` (`registry.ts:269`) |
| `work_item.people_assigned.v1` | `work-items.service.ts:679-680` | collaboration notices, realtime |
| `work_item.client_action_requested.v1` | `work-items.service.ts:767-768` | collaboration notices |
| `work_item.commented.v1`, `work_item.comment_created.v1` | `work-comments.service.ts:180,198` | realtime; mention notices |

## Data: tables and migrations

| Table | Created (`apps/api/migrations`) | Keys / notes | Retention |
| --- | --- | --- | --- |
| `work_items` | `0001_tenancy.sql:249` (`version` `:262`) | tenant-first keys; soft delete `deleted_at` | soft delete; purge not found |
| `work_item_dependencies`, `work_blockers` | `0011_work_dependencies_blockers.sql` | blocker row per entry into `blocked` | item lifetime |
| `work_item_checklist_items`, `work_forms`, `work_item_comments` | `0051`, `0052`, `0053` | comments carry mentions | item lifetime |
| `work_item_links`, `work_item_files` | `0085`, `0086` | files reference `file_assets` | item lifetime |
| `work_item_time_logs`, `work_item_watchers`, `work_item_labels` | `0103`, `0104`, `0105` | **time logs also written/read by `api/time`, `finance`, `people`** | money record |
| `work_item_reminders`, `work_item_recurrence`, `work_item_estimates` | `0126`, `0127`, `0128` | | item lifetime |
| `work_checklist_templates`, `work_item_custom_fields`, `work_item_subtasks`, `work_board_columns` | `0159`, `0174`, `0175`, `0176` | subtasks retired: rows copied into steps by `0414`, table kept until a contract migration; board columns copied into the default stage set by `0413` | org lifetime |
| `work_item_code_links`, `work_item_schedule_stats` | `0294`, `0297` | | item lifetime |
| `work_item_recurrence_instances` | `0300_recurrence_v2.sql` | `uq_wiri_occurrence` (`:89`) is the idempotency key | grows per occurrence (ST-6) |
| `work_item_client_audience`, `work_item_assignees` | `0317`, `0318` | assignees is the single source of doers and supervisors since `0412` | item lifetime |
| `work_stage_sets`, `work_stages`, `work_stage_set_projects` | `0413_work_stage_sets.sql` | one default set per org (`default_marker`); work items carry `stage_set_id`, `stage_id` | org lifetime |

**Read but not owned:** `projects`, `project_memberships` (projects), `memberships`,
`custom_roles`, `organizations`, `client_memberships` (tenancy), `users`, `file_assets` (files),
`org_finance_profiles` (finance), `audit_events` (audit, via its repository). Grants:
`scripts/db/users.sql` (DA-9).

## Permissions and tenant rules

**Guard chain (SE-1)** global; one `@RequireCapability` per route. The service then applies the
**relation** check per row with `authorize()` from `@tmanage/domain` (`work-items.service.ts:1520-1605`):
`readForWrite` loads the row, checks it is not deleted and the principal may act on its project.

| Decision | Single owner | Note |
| --- | --- | --- |
| Capability ceiling per role | `packages/domain` `authorize()` | AR-8 |
| Legal state change + required facts | `workItemStateMachine` (domain) | web must not re-encode it (DC-2) |
| Supervisor approval for done | `mayCompleteSupervised` in the transaction (`:885-899`) | |
| Publish to client audience | `requirePublish` → `deliverable.publish` (`:1602-1605`) | |
| Owner is a member | `requireOwnerIsMember` (`:1394-1403`) | `api/projects` lacks the same check (PRJ-3) |
| Tenant scope | `TenantDatabase` + repositories bind `organization_id` (DA-12) | |

Trust zones: staff and client principals share these routes; a client is scoped to
`CLIENT_AUDIENCES` (`:405-406`). The response carries **no decision fields** (`canEdit`,
`canTransition`): `WorkItemView` (`work-items.service.ts:100-125`) — AR-9 gap, see WRK-5.

## Runtime, background work and failure modes

**Owned background work.** Recurrence spawner (`recurrence-spawner.service.ts`): run in the
single Hostinger app from the minute tick as job `recurrence-spawner`
(`apps/server/scheduled-sweeps.mjs:179-194`) under the per-job named lock
(`apps/server/server.mjs:514-518`); not in the standalone worker (API-only job, not a DC-7 gap,
because the worker does not build the API). Outbox events are relayed by `api/platform` + worker.

| Failure | Behaviour today | Rule | Verdict |
| --- | --- | --- | --- |
| Concurrent edit | conditional `UPDATE … WHERE version = ?` → 409 | DA-1 | correct |
| Deadlock / 1213 on transition | no local retry; relies on `tenant-context.ts` retry for write conflicts | DA-2 | verify in a db test (not found here) |
| Lost response on POST `/work-items`, transition | **no idempotency replay**; a retry creates a duplicate item (transition retry is safe: 409 on version) | HT-4 | gap (WRK-3) |
| DB down | errors propagate → 5xx | HT-3 | correct |
| Spawner throttle | "last ran" kept **in memory** (`recurrence-spawner.service.ts:94,118-121`) | AS-4, RT-2 | harmless when duplicated: unique claim (I-10) |
| Spawner rule fails | logged with `console.error`, rule skipped (`work.module.ts:369-370`) | RT-7 | plain-text log, not JSON (WRK-8) |
| List of a reader who may see little | page returned short after 25 pages; web pages with `fetchNextPage` (`apps/web/src/components/screens/WorkListScreen.tsx:226-233,1005`) | HT-3 | acceptable, documented |
| Audit/outbox provider missing | optional `outbox?` (`work-items.service.ts:351`) → silently no event | AS-1, DA-11 | risk (WRK-6) |
| Row times | 40 `current_timestamp` writes in non-test files (e.g. `work-items.repository.ts:278,392-393,411,500`) | DA-10 | gap (WRK-7) |

## UX rules for its screens

n/a — API module; screens belong to `web/org/work` (`apps/web/src/app/[orgSlug]/work/PART.md`)
and `web/org/projects`. Obligations (AR-9): expose the next legal states and the facts each needs
as data (today the web imports the domain machine), and per-item `can*` decisions.

## Standards that apply

| Rule | Today | Target |
| --- | --- | --- |
| AR-4 | SQL only in repositories (no non-repository file imports `drizzle.js`) | keep |
| AR-5 / AR-7 | **breach**: 41 outside files import `WorkItemsRepository`; this module reads 8 foreign tables and imports `AuditEventsRepository`; `work_item_time_logs` written by three contexts | `WorkItemsReadService`; activity log via `AuditService` read API; one owner for time logs |
| AR-6 | controllers import types only from repositories; no DB handle in work controllers (grep) | keep |
| AR-8 | state rules single-sourced in `packages/domain` | keep |
| AR-9 | no `can*` fields on `WorkItemView` | add required decisions |
| AR-10 | 15 pairs (§3) | keep |
| HT-1 | 409 version conflict, 404 hidden; **400 and 422 both used for `validation_failed`** (`work-items.controller.ts:144` vs `work-items.service.ts:1399`) | one status per meaning |
| HT-4 | replay interceptor only on comments and time logs (`work-comments.controller.ts:93-94`, `time-logs.controller.ts:71`) | add to POST `/work-items`, forms submissions, bulk transition |
| DA-1 | version CAS on every field write; soft delete idempotent | keep |
| DA-10 | `current_timestamp` row times | bound `Date` |
| DA-11 | audit in the same transaction | required injection |
| AS-1 – AS-3 | events from the unit of work; consumers keyed (see worker part) | add `dedupe_key` where a sweep may re-emit |
| AS-4 / RT-3 | spawner under the named sweep lock; throttle in memory | `job_runs` row when AS-4 lands |
| SE-1 | `@RequireCapability` on every route; personal routes deliberately `work.read` | route census |
| IP-3 | pure state machine and `mayCompleteSupervised` (functional core) | keep |
| IP-17 | spawner pass bounded per org (`capped`), idempotent | keep |
| PR-3 | short-page class handled here, still open in projects (PRJ-2) | same fix there |

## How to change this part

- **New per-item feature:** `<feature>.controller.ts` under `…/work-items/:workItemId/<feature>`,
  `<feature>.service.ts` that calls `WorkItemsService`/`readForWrite`-style relation checks,
  `<feature>.repository.ts`; register the provider and controller in `work.module.ts`
  (`:375-430`). Add the contract pair (AR-10).
- **New state or transition:** change `packages/domain/src/state-machines/work-item.ts` and its
  test first; the API and web follow (AR-8).
- **A change other parts react to:** add an outbox `type` (`*.v1`) in the same transaction and a
  consumer in `apps/worker/src/consumers/registry.ts`; consumers must be idempotent (AS-2).
- **Writes:** always take `version` and map `WorkItemVersionConflictError` to 409 via `writing()`.
- **New table:** migration in `apps/api/migrations/` (DA-4/DA-5), grant in `scripts/db/users.sql`.
- Checks: `pnpm --filter @tmanage/api typecheck`, co-located tests, db suites in §10.

## Tests and fitness checks

- Unit (co-located, 40 files) incl. `work-items.controller.test.ts`, `work-items.health.test.ts`,
  `work-items.project-health.test.ts`, `work-items.projection.test.ts`, `work-keys.test.ts`,
  `quick-add.test.ts`, `recurrence-spawner.test.ts`, `schedule-cascade.test.ts`,
  `schedule-stats.test.ts`, `work-item-client-audience.test.ts`, `work-item-people.test.ts`,
  `work-comments.mentions.test.ts`, `item-files.availability.test.ts`, `activity-log.channel.test.ts`.
- Domain: `packages/domain/src/state-machines/state-machines.test.ts`.
- DB (`apps/api/test`): `work-001-work-items.db.test.ts`, `work-003-blockers-dependencies.db.test.ts`,
  `work-008-saved-views.db.test.ts`, `work-010-forms-checklist.db.test.ts`,
  `work-011-owner-due-delete.db.test.ts`, `work-053-critical-path.db.test.ts`,
  `work-053-dependency-race.db.test.ts`, `work-053-recurrence-spawner.db.test.ts`,
  `sec-001-client-projection.db.test.ts`, `chat-003-message-to-work.db.test.ts`.
- E2E: `e2e/tests/work-journeys.spec.ts`, `work-forms-journeys.spec.ts`; a11y
  `e2e/tests/a11y-audit.spec.ts:146-147,357-358`.
- Contract: `e2e/contracts/api-web-shapes.ts:2020-2156`.
- **Missing:** HT-4 replay test for POST `/work-items`; a concurrency db test for parallel
  transitions under deadlock (DA-2); an AR-5 import fence.

## Open defects, decisions and risks

| Id | Class | Finding (verified at 3b7e4fa7) | Pri | Exit |
| --- | --- | --- | --- | --- |
| WRK-1 | AR-5/AR-7 | 41 outside files import `WorkItemsRepository` (VIEWS §4 counted 42) | P1 | read service, then an import fence (AR-5 fitness) |
| WRK-2 | AR-7 | `work_item_time_logs` written/read by work, time, finance, people, projects | P1 | one owner (time or work) + service |
| WRK-3 | HT-4 | POST `/work-items`, form submissions and bulk transition have no idempotency replay | P1 | `IdempotencyReplayInterceptor` + web key |
| WRK-4 | AR-5 | `activity-log.service.ts:15` imports audit's repository | P2 | `AuditService` read method |
| WRK-5 | AR-9 / DC-2 | no `can*` decision fields; web shows actions the API then refuses | P2 | required decisions on `WorkItemView` |
| WRK-6 | DA-11/AS-1 | `outbox?`/`audit?` optional in `WorkItemsService` (`:351`) | P2 | required args + module wiring test |
| WRK-7 | DA-10 | 40 `current_timestamp` row-time writes | P2 | bound `Date` |
| WRK-8 | RT-7 | spawner failure logged with `console.error` text (`work.module.ts:369-370`) | P2 | structured logger |
| WRK-9 | HT-1 | `validation_failed` returned as 400 by controllers and 422 by service member checks | P2 | pick one (ENGINEERING-STANDARD §4) |

DC classes: DC-2 risk (WRK-5); DC-4 not present (spawner claims with INSERT + unique key);
DC-3 harmless (I-10); DC-1, DC-5, DC-6, DC-7 not present in this module.

## Glossary

| Term | Meaning (AR from `apps/web/src/lib/i18n/messages/ar.json`) |
| --- | --- |
| Work item | a task or deliverable unit — "مهمة" (`SearchScreen.kindWorkItem`) |
| Blocker | reason + ask recorded when an item enters `blocked` — state "متوقفة" (`WorkListScreen.stateBlocked`) |
| Internal review | the step before done where a supervisor approves — "مراجعة داخلية" (`WorkListScreen.stateInternalReview`) |
| Audience | who may see the item: internal or a client audience |
| Work key | human id `PREFIX-n` for an item when its project has a prefix |
| Occurrence | one spawned instance of a recurrence rule, keyed by `occurrence_key` |
