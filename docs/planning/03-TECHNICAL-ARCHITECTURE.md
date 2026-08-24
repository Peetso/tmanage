# TManage — Technical Architecture and Engineering Plan

## 1. Architecture decision

Start with a **modular monolith plus event-driven workers**, not microservices. This gives one deployable backend, transactional integrity across the work graph, simpler authorization, and faster product iteration. Maintain strict module boundaries so high-scale domains—realtime, notifications, search indexing, files, AI—can be extracted when evidence demands it.

## 2. Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Web | Next.js App Router + React + TypeScript | Mature ecosystem, server/client composition, streaming, accessibility and shared desktop UI |
| UI | Tailwind CSS or token-generated CSS + Radix primitives + Storybook | Fast consistent system with accessible behavior; product components remain owned |
| Client data | TanStack Query; lightweight local store only where needed | Explicit server-state caching without a global-state monolith |
| Backend | NestJS with Fastify adapter, TypeScript | Structured domain modules, guards, validation, WebSocket support, shared language |
| API | REST/JSON for public and product APIs; WebSocket for realtime; OpenAPI contract | Predictable integrations, caching, generated clients, debuggability |
| Primary DB | Hostinger MySQL-compatible MariaDB (InnoDB, strict mode, `utf8mb4`) | Included in the funded Cloud plan; transactions, relational integrity, JSON columns, and composite tenant constraints |
| Database access | Drizzle ORM + `mysql2` + explicit SQL migrations | Typed queries without hiding organization predicates, constraints, transactions, or migration SQL |
| Cache/jobs | Redis-compatible service + BullMQ initially | presence, rate limits, short cache, job queues, delayed notifications |
| Search | MySQL `FULLTEXT` plus indexed filters for MVP; OpenSearch when relevance/scale requires | Uses the included database while preserving an indexing abstraction |
| Files | S3-compatible object storage + CDN | Durable multipart uploads, lifecycle, versioning, presigned access |
| Realtime | WebSocket gateway + Redis pub/sub/streams; durable event log in MySQL | Live UX with reconnection and recoverability |
| Rich text | ProseMirror/Tiptap with structured JSON schema | Extensible collaborative documents and embedded work objects |
| Observability | OpenTelemetry + metrics/logs/traces + error tracking | Vendor-neutral correlation and SLO visibility |
| Infrastructure | Containers; managed MySQL/Redis/object storage; Terraform | Operational reliability without premature Kubernetes |
| Desktop later | Tauri 2 | Shared web UI, smaller native shell, explicit capability security |

## 3. Repository design

Use a pnpm monorepo:

```text
apps/
  web/              Next.js team app + client portal
  api/              NestJS modular backend
  worker/           background jobs and indexing
  desktop/          Tauri shell (later)
packages/
  ui/               design system and Storybook
  contracts/        OpenAPI-generated clients and event schemas
  domain/           shared value objects and pure rules only
  config/           lint, TypeScript, test configuration
  observability/    tracing, logging, metrics helpers
  test-kit/         factories, fixtures, auth contexts
infra/              Terraform and deployment configuration
docs/               ADRs, runbooks, API and product specs
```

Avoid sharing server entities directly with UI. Contracts are versioned DTOs; domain invariants remain server-owned.

## 4. Backend modules

Identity, Organizations, Memberships, Teams, Projects, Work Items, Conversations, Documents, Files, Deliverables, Approvals, Decisions, Calendar/Meetings, Notifications, Search, Automation, Clients, Billing, Audit, Analytics, AI Gateway, Admin.

Each module owns schema/migrations, application services, policies, events, API controllers, and tests. Cross-module writes use application services and an outbox event; direct cross-module table writes are prohibited.

## 5. Request and event flows

### Synchronous mutation

Client → API gateway/controller → authentication → tenant context → authorization policy → validation → domain transaction → business tables + outbox event → response. Worker later dispatches notifications, search updates, analytics, and webhooks idempotently.

### Realtime

Authenticate socket with short-lived token; join authorized tenant/object channels; mutation remains through normal command service; committed event broadcasts sequence number; clients detect gaps and refetch from cursor. Presence and typing are ephemeral and never used as durable truth.

### Notification

Domain event → preference/audience resolver → bundle/dedupe → in-app record → realtime push → optional email/push digest. Every channel observes quiet hours, priority, rate, and user preference.

## 6. Multi-tenancy

- Every tenant-owned row contains `organization_id`; child access never relies only on guessed parent IDs.
- Tenant context is derived from authenticated membership, not arbitrary request input.
- Repository/query APIs require a trusted tenant context. MySQL has no PostgreSQL-style RLS, so composite `(organization_id, id)` keys/foreign keys, scoped query builders, least-privilege database users, lint boundaries, and adversarial isolation tests provide database/application defense in depth.
- Background jobs carry signed tenant and actor context; cross-tenant batch jobs use a privileged, audited service role.
- Object storage keys begin with non-guessable tenant namespace; downloads use short-lived authorization-checked URLs.
- Cache and search keys include tenant ID; authorization filters occur before results are returned.

## 7. Data and consistency

- UUIDv7 identifiers for time-sortable globally unique IDs.
- `created_at`, `updated_at`, `version` on mutable records; optimistic concurrency on collaborative changes.
- UTC storage; IANA timezone retained for display and schedule intent.
- Transactional outbox prevents database/event inconsistency.
- Idempotency keys for client retries, automation actions, payments, uploads, and webhooks.
- Soft deletion only where recovery/policy needs it; explicit purge lifecycle for privacy deletion.
- Audit log is append-only and logically separate from product activity feed.

## 8. API standards

- Resource-oriented routes under `/v1`; cursor pagination; stable error envelope with code, message, field details, correlation ID.
- OpenAPI is reviewed and used to generate typed clients.
- ETags/version fields for conflict detection; `Idempotency-Key` on unsafe retryable operations.
- Webhooks are signed, replay-protected, retryable, filterable, and have delivery logs.
- Rate limits apply by IP before authentication and by user/tenant after authentication.
- API deprecation policy and minimum 12-month enterprise notice after GA.

## 9. Search

MVP uses a materialized search-document table with MySQL `FULLTEXT` indexes plus indexed organization, project, type, audience, client-organization, state, and date columns. The indexer consumes outbox events and materializes a normalized title/content excerpt. Every query starts with organization and authorization filters; client results use client-safe projections. MySQL full-text language behavior must be measured for English and Arabic; extract to OpenSearch when relevance, faceting, corpus size, or latency breaches the defined SLO.

## 10. Collaborative docs

Start with durable document blocks, comments, version snapshots, and optimistic editing. Add CRDT/Yjs collaboration only when simultaneous-edit evidence warrants its operational complexity. If adopted, persist periodic snapshots plus ordered updates and compact safely; permissions remain enforced at document connection and operation boundaries.

## 11. Files

Browser requests upload session → API authorizes and returns multipart presigned parts → direct upload to object storage → client completes → worker verifies checksum, MIME, size, malware scan, and preview → asset becomes available. Unscanned uploads are quarantined. Downloads always reauthorize or use very short-lived scoped URLs.

Customer files never live on the application VPS disk. Production uses a provider-neutral S3-compatible adapter; Cloudflare R2 Standard is the initial recommendation, subject to a provider/data-residency ADR before purchase. Use private buckets separated by environment and trust state (quarantine, ready/private, derived), with non-guessable tenant/project/asset/version key prefixes. Do not create one physical bucket or disk per customer.

Each workspace receives a logical pooled byte entitlement. The upload-session transaction atomically reserves declared bytes against `used + reserved + requested <= effective quota`; completion reconciles actual object bytes and abort/expiry releases the reservation. Every retained immutable version counts until physical lifecycle deletion is confirmed. Client uploads count against the owning service workspace. Maintain an append-only usage ledger, reconciled counters, threshold events, and provider-inventory drift checks. At quota, block new storage-producing operations while preserving authorized reads, downloads, cleanup, export, billing, and plan change. Full rules are in file 49.

## 12. AI architecture

Use an internal AI Gateway, never provider calls scattered across modules. It handles provider choice, regional policy, prompt templates, redaction, quotas, evaluation, grounding, citations, caching, latency, cost, and audit metadata. Retrieval uses only objects the user can access. Tool calls run through the same command/authorization layer as humans. Consequential writes require a preview and explicit confirmation.

## 13. Desktop strategy

Phase 0: responsive web + PWA. Phase 1 after product evidence: Tauri shell for notifications, tray, deep links, launch-at-login, file integration, and updater. The desktop shell calls the same hosted API and renders the shared product UI. Capabilities are allowlisted; no generic shell execution or broad file access. Offline starts with drafts and cached reads, not full conflict-prone project replication.

## 14. Deployment topology

Bootstrap topology: CDN/WAF → Hostinger web/API/realtime → Hostinger MySQL-compatible database + Redis-compatible service + object storage; worker deployment separately scalable. A funded production topology uses managed regional equivalents, multi-zone database capability, encrypted backups in a separate failure domain, and a tested restore environment. Begin with blue/green or rolling deployments and backward-compatible MySQL migrations.

Kubernetes is deferred until multi-service scheduling, workload isolation, or scale makes it economically justified.

## 15. Engineering quality gates

- Type checking, linting, unit, integration, migration, contract, security, and end-to-end tests in CI.
- Preview environment per pull request with sanitized seed data.
- Trunk-based development, short-lived branches, mandatory review and CODEOWNERS for auth/security/migrations.
- Feature flags separate deploy from release; stale flags expire.
- ADR required for durable cross-cutting decisions.
- Performance budgets and bundle checks for web; load tests for inbox, search, project view, realtime fan-out.

## 16. Test strategy

- Unit: domain transitions, permission predicates, ranking logic.
- Integration: database constraints, scoped repositories, tenant-isolation corpus, outbox, queues, object storage, search materialization.
- Contract: OpenAPI compatibility and event schema compatibility.
- End-to-end: eight product journeys, especially client visibility and approval versioning.
- Security: tenant-isolation matrix, IDOR/BOLA, privilege changes, upload, XSS, CSRF, session, rate limits.
- Reliability: queue retry, duplicate events, network reconnect, failover, backup restore.
- Accessibility: automated checks plus manual assistive-technology journeys.
- Visual regression: design system and critical screens.

## 17. Scale triggers, not guesses

- Extract realtime when connections/fan-out need independent scaling.
- Extract files/preview when CPU-heavy processing affects API SLO.
- Adopt OpenSearch after MySQL search SLO/relevance threshold fails.
- Introduce Kafka/managed log when outbox-to-queue throughput, replay, or multiple consumers exceed Redis/DB design.
- Consider services per bounded context only when team ownership and release independence outweigh transaction/operational cost.
