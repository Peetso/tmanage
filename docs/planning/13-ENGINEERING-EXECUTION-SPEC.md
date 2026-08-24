# TManage — Engineering Execution Specification

## 1. System boundary

Web-first multi-tenant SaaS. Next.js team app and portal call a NestJS/Fastify API. Hostinger's MySQL-compatible MariaDB is the system of record; Drizzle ORM with `mysql2` provides typed access; Redis supports queues/presence/rate limits; object storage holds files; a worker processes outbox events. Desktop later uses Tauri around shared UI and hosted APIs.

## 2. First deployable modules

Identity, Tenancy, Membership, Projects, Work, Conversations, Files, Deliverables, Approvals, Clients, Notifications, Search, Audit. Docs, Automation, Billing, Analytics, and AI are introduced behind module contracts after the vertical slice.

## 3. API slice

- `POST /v1/organizations`, `/workspaces`, `/projects`
- `POST /v1/projects/{id}/client-organizations`
- `POST /v1/invitations`; `POST /v1/invitations/{token}/accept`
- `POST /v1/client-requests`; `POST /v1/client-requests/{id}/transitions`
- `POST /v1/conversations/{id}/messages`; `POST /v1/messages/{id}/convert`
- `POST /v1/work-items`; `PATCH /v1/work-items/{id}` with version
- `POST /v1/upload-sessions`; complete/cancel endpoints
- `GET /v1/billing/usage` for authorized workspace seat/project/storage entitlements; payment fields may remain unavailable before paid beta
- `POST /v1/deliverables`; `POST /v1/deliverables/{id}/versions`
- `POST /v1/deliverable-versions/{id}/publish`
- `POST /v1/approvals/{id}/decisions`
- `GET /v1/home`, `/inbox`, `/search`, `/audit-events`

All unsafe retryable endpoints support `Idempotency-Key`. Errors include stable code and correlation ID. Cursor pagination only.

## 4. Event contracts

Initial durable events: `membership.created/suspended`, `project.created`, `client_request.submitted/transitioned`, `message.created/converted`, `work_item.created/updated/blocked`, `file.ready/rejected`, `deliverable.version_created/published`, `approval.requested/decided/invalidated`, `notification.requested`, `audit.recorded`.

Envelope: event ID, schema version, type, occurred time, organization, actor/effective actor, correlation/causation IDs, object reference, payload. Consumer deduplicates by event ID.

## 5. Vertical-slice schema

Tables: users, sessions, organizations, workspaces, memberships, roles, teams, projects, project_memberships, client_organizations, client_memberships, invitations, conversations, conversation_memberships, messages, work_items, work_item_dependencies, files, file_versions, storage_reservations, usage_counters, usage_ledger_entries, deliverables, deliverable_versions, approvals, approval_reviewers, approval_decisions, notifications, audit_events, outbox_events, idempotency_records. Paid-beta adds versioned plans, subscriptions/items, organization entitlements, seat assignments/classification, billing events, and provider webhook receipts without changing the P0 storage-ledger contract.

Migrations establish strict SQL mode, `utf8mb4`, tenant indexes, `(organization_id, id)` unique keys, composite tenant foreign keys, and separate migration/runtime users before application data. Tenant repositories require trusted `TenantContext`; the runtime database user cannot alter schema or grants.

## 6. Realtime contract

Socket authenticates short-lived ticket; subscription request names authorized resource; server returns current cursor. Broadcast contains event type, object ID, sequence, minimal safe patch. Client detects gap and refetches. Reconnect uses exponential backoff with jitter. Presence/typing use ephemeral TTL and are excluded from audit.

## 7. Frontend routes

`/[org]/home`, `/inbox`, `/chat/[conversation]`, `/projects/[project]`, `/projects/[project]/work`, `/work/[item]`, `/deliverables/[id]`, `/client/[project]/*`, `/admin/members`, `/admin/clients`, `/admin/audit`, `/search`.

Server Components provide initial shells/reads where useful; interactive work surfaces use client components and TanStack Query. Route guards improve UX but API remains authority.

## 8. Quality budgets

- Common API p95 <300ms at target alpha load.
- Portal action page LCP <2.5s on target broadband/mobile hardware.
- Initial JS budgets per route defined before build; heavy board/timeline loaded on demand.
- Realtime typical delivery <1s; reconnect recovers without duplicate visible actions.
- Upload supports resume and never exposes unscanned file.

## 9. CI/CD

Pull request: formatting, typecheck, lint, unit, integration, migration, API compatibility, dependency/secret/IaC scans, component accessibility. Main: build signed images, deploy preview/staging, smoke/E2E, manual production approval, gradual rollout, automated health rollback. Production migrations are expand/contract and backward compatible.

## 10. Observability

OpenTelemetry traces from web request through API, database, outbox, worker, notification. RED metrics for HTTP, queue lag/retry/dead letters, socket connections/fanout, database saturation, upload scan latency, search latency, approval decision latency. Structured logs exclude message/file content and secrets.

## 11. Vertical-slice exit criteria

Two isolated tenants complete request-to-approval concurrently; cross-tenant tests pass; concurrent upload reservations cannot oversubscribe either workspace quota; client principals consume no internal paid seat; reconnect and retry produce no duplicate decisions; changed file invalidates approval; client preview matches actual policy; offboarding revokes live session; restore from backup succeeds; accessibility critical journeys pass.
