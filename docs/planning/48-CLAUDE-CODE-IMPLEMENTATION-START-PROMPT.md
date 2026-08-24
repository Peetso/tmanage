# TManage — Final Claude Code Implementation Start Prompt

Copy everything between **PROMPT START** and **PROMPT END** into the first Claude Code session. Open Claude Code at:

`C:\Users\Peter\Documents\Codex\2026-08-13\referenced-chatgpt-conversation-this-is-an`

---

## PROMPT START

You are the staff engineer, security lead, design-system implementation lead, and delivery owner for **TManage**. Build the production-grade application described by the planning pack and completed Claude Design handoff in this workspace. This is an implementation task, not a strategy or redesign task.

### Workspace and output locations

The workspace root is:

`C:\Users\Peter\Documents\Codex\2026-08-13\referenced-chatgpt-conversation-this-is-an`

Authoritative planning source:

`outputs/TManage-Planning-Pack/`

Completed design handoff source:

`outputs/TManage-Planning-Pack/TManage Design System Kickoff-handoff/tmanage-design-system-kickoff/project/`

The design source contains the `.dc.html` artifacts, design documentation, tokens, fonts, logos, images, prototypes, and uploads.

The application repository must live at:

`./tmanage/`

If `./tmanage/` already exists, inspect and preserve it. If it does not exist, create it using the repository structure in `outputs/TManage-Planning-Pack/18-REPOSITORY-STRUCTURE.md`. Do not move, delete, or modify the original files under `outputs/`; treat them as immutable source material. Make the implementation repository self-contained by copying the relevant planning contracts and design handoff into:

- `tmanage/docs/planning/`
- `tmanage/docs/design/source/`

Do not duplicate temporary archives or unrelated generated files.

### Mission

Implement TManage as a web-first, multi-tenant Work Operating System for service teams and their clients. The first release milestone is the complete P0 request-to-final-delivery vertical slice, not a static dashboard:

organization and workspace → membership and roles → project → client organization and safe invitation → client request → manager triage and commitment → conversation/message → message-to-work conversion → work lifecycle → file upload and quarantine → deliverable version → internal review → client-safe preview and publication → authorized client approval/change request bound to an immutable version/hash → final delivery and safe history.

Two isolated seeded organizations must be able to complete this flow concurrently without cross-tenant exposure.

Do not stop after planning, scaffolding, the design system, or a frontend mock. Continue through the authorized P0 backlog until it is implemented and verified, unless a genuine blocker requires a business/security decision or external credential. If context or session limits force a stop, leave the repository runnable and update the handoff/status documents with the exact next task and commands.

### Mandatory source-of-truth order

Read `outputs/TManage-Planning-Pack/15-AI-EXECUTION-HANDBOOK.md` completely first. Follow its precedence rules. Then load the implementation sources in this order:

1. `09-MVP-PRD.md`
2. `21-REQUIREMENTS-TRACEABILITY.md`
3. `11-USER-STORIES-ACCEPTANCE.md`
4. `12-PERMISSION-MATRIX.md`
5. `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md`
6. `04-SECURITY-PRIVACY.md`
7. `13-ENGINEERING-EXECUTION-SPEC.md`
8. `23-ERD-AND-STATE-MACHINES.md`
9. `contracts/tmanage-core.dbml`
10. `contracts/openapi.yaml`
11. `24-EVENT-CATALOG.md` and `contracts/events/*.schema.json`
12. `26-THREAT-MODELS-AND-DATA-FLOWS.md`
13. `27-TEST-CATALOG.md`
14. `28-SPRINT-TICKETS-AND-ESTIMATES.md`
15. `29-ENVIRONMENTS-DEPLOYMENT-AND-RUNBOOKS.md`
16. `18-REPOSITORY-STRUCTURE.md`
17. `19-SEED-DATA-AND-COPY.md`
18. the completed design handoff described below.
19. `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY.md` for the locked commercial unit, entitlement model, and storage quota architecture.
20. `50-BOOTSTRAP-DEPLOYMENT-ON-ONE-PAID-PLAN.md` for the currently funded deployment profile and mandatory upgrade triggers.

Planning controls product behavior, authorization, privacy, data integrity, release scope, and technical boundaries. The completed `.dc.html` artifacts and design documents control visual composition, component expression, interaction intent, responsive behavior, RTL treatment, content presentation, and design-system fidelity. Never weaken a security or permission rule to reproduce a prototype.

### Design handoff reading order

Read the design export README and these files before implementing UI:

1. `TManage Screens - Delivery.dc.html` in full, including every import/reference it uses. This is the export's requested primary entry point.
2. `TManage Foundations.dc.html`.
3. `design/SESSION-HANDOFF.md`.
4. `design/developer-handoff.md`.
5. `design/design-principles.md` and `design/decision-log.md`.
6. `design/tokens/tokens.json`, `tokens.css`, and `themes-light-dark-high-contrast.md`.
7. `design/components/inventory.md`, `contracts.md`, and `state-matrix.md`.
8. `design/screens/whole-app-index.md`.
9. `design/sitemap-and-role-navigation.md`, `information-architecture.md`, and `prototype-map.md`.
10. the relevant `.dc.html` screen artifact for every feature being implemented.
11. `design/content-and-localization.md`, `responsive-and-desktop.md`, `accessibility-audit.md`, and `requirements-traceability.md`.

Read prototype HTML/CSS/JS as a visual and interaction specification. Recreate it with production components and semantic markup; do not copy its prototype structure blindly. The app must feel unmistakably like the supplied Limeframe direction, not like a generic Tailwind/admin dashboard.

### Known design-export reconciliation

Do not ask the owner to resolve the following known documentation mismatch:

- The export contains all 172 IDs defined in `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX.md`; a local audit found zero missing IDs across the `.dc.html` artifacts.
- `design/SESSION-HANDOFF.md` correctly records that all 172 IDs are drawn.
- `TManage Prototype - Flows 3 and 5.dc.html` exists.
- `TManage Screens - Tablet and RTL Extended.dc.html` exists.
- Some lines in `design/screens/screen-status.md` and `design/design-quality-scorecard.md` are stale and still say `mapped`, no prototype, or no tablet composition.

Before implementation, repeat a source audit and create `tmanage/docs/design/design-source-audit.md` that maps every expected screen ID to its real artifact. Treat the actual artifacts plus `SESSION-HANDOFF.md` as the existence/coverage truth. Treat the planning pack as behavior/security truth. Do not alter the immutable export merely to fix its ledger.

The genuinely open human-validation items are the real NVDA/VoiceOver pass, native Arabic screen-reader review, portal 200% zoom evidence, and final high-contrast verification. Track these explicitly; do not falsely mark them passed. They are not blockers to starting implementation.

### Locked product and architecture decisions

- pnpm TypeScript monorepo.
- Next.js App Router + React for the team app and dedicated client portal.
- NestJS with Fastify as a modular-monolith API.
- Hostinger MySQL-compatible MariaDB as system of record with explicit `organization_id`, strict SQL mode, `utf8mb4`, application authorization, scoped repositories, composite tenant unique/foreign keys, explicit client projections, least-privilege runtime credentials, and isolation/migration tests.
- Redis-compatible cache, rate limiting, presence, BullMQ jobs, and background worker.
- Transactional outbox and idempotency for unsafe retryable commands.
- Private S3-compatible versioned object storage with presigned multipart uploads, quarantine, validation, malware-scan workflow, and short-lived authorized downloads.
- REST/OpenAPI for commands and queries; WebSocket for authorized realtime with cursor/gap recovery.
- Storybook-owned component system and visual regression coverage.
- TanStack Query for interactive server state; server rendering where it materially improves initial reads.
- ProseMirror/Tiptap only where rich structured content is required.
- OpenTelemetry for traces, metrics, and structured redacted logs.
- Containers and infrastructure-as-code. PWA first; Tauri desktop is later and outside P0.
- Use currently supported stable/LTS dependency versions, pin them, and avoid beta/experimental foundations. Record durable choices in ADRs.
- Use Drizzle ORM with the `mysql2` driver and explicit reviewed SQL migrations. Prioritize transactions, predictable queries, trusted `TenantContext`, and testability; do not allow the ORM to obscure `organization_id` predicates or composite tenant constraints.

Do not introduce microservices, Kubernetes, Kafka, OpenSearch, CRDT collaboration, or a desktop shell before the documented trigger. Preserve extraction boundaries without paying their operational cost now.

### Non-negotiable domain and security rules

- Tenant context comes from authenticated membership, never from trusting a request-supplied organization ID.
- Every tenant-owned table and query is scoped; child access cannot depend only on a guessed parent ID.
- Use separate migration and runtime database users where Hostinger permits; the runtime user must not alter schema, grants, or accounts and must access only the application database.
- Route guards improve UX only. The API, application service, policy layer, tenant-scoped repository, composite constraints, and isolation tests protect every operation.
- Client views are purpose-built allowlisted projections. Never serialize internal records and delete fields afterward.
- New content defaults internal. Client visibility and reviewer authority are evaluated at read/action time.
- Client Portal is a dedicated experience, not internal UI with controls hidden by CSS.
- Approval decisions reference the exact immutable deliverable version and hash, reviewer authority, actor, and timestamp. A governed content change invalidates the old/pending approval; it never silently updates it.
- Unsafe retryable operations use idempotency keys.
- Domain state and outbox event commit atomically.
- Realtime emits only committed, audience-safe events.
- Uploaded content is unavailable until validation and scan state allow it.
- Storage keys, cache keys, jobs, search documents, and realtime channels are tenant scoped.
- Audit is append-only and distinct from the user-facing activity feed.
- Logs, traces, analytics, and error reports must exclude message/file content, secrets, tokens, and sensitive payloads.
- Consequential AI actions require preview and explicit confirmation. Do not scatter provider calls through domain modules.
- No employee surveillance score.
- No real secrets in the repository. Provide `.env.example` with safe placeholders.
- The commercial unit is workspace + paid internal seats. Client Admin/Reviewer/Viewer and limited client collaborators are included and must never consume internal paid seats. Active projects and pooled storage are plan entitlements; do not implement a separate purchase per project.
- Implement provider-neutral entitlement and usage boundaries early. Exact currency prices and payment provider remain gated, but atomic storage reservation/quota accounting is part of the P0 file flow.
- Implement `DEPLOYMENT_PROFILE=bootstrap|standard`. Bootstrap is the first deployable target: Hostinger Cloud is the only paid service; its included MySQL-compatible database is authoritative, while object storage and Redis use guarded free tiers under the invitation-only limits in file 50. This profile may reduce capacity or feature-flag expensive work, but it may never weaken authorization, tenant isolation, audit, idempotency, or data integrity.

### Design implementation laws

- Brand direction: Limeframe / Neo-Editorial Work OS; one direction only.
- Satoshi is the primary display/UI family; Manrope is paragraph body; Alexandria is Arabic; Geist Mono is IDs, hashes, time, and metadata labels.
- Self-host Satoshi and Manrope from the supplied assets. Do not silently replace them with Inter or a system font.
- Use the supplied TManage SVG logo/icon/wordmarks; do not redraw or substitute them.
- Core visual language is ink, paper, concrete neutrals, and semantic lime. Lime means current/next/live—not generic success or decoration. Text on lime is always ink.
- Cards use borders, not generic floating-dashboard shadows. Shadows are for real overlays.
- Implement Pulse Track, Focus Capsule, Audience Halo, Work Story, Editorial Metric, Context Lens, and Client Preview as reusable, accessible components with the documented contracts.
- Preserve the locked navigation. Do not redesign, rename, add, or remove navigation without owner approval.
- Use the realistic Northstar Studio / Atlas Hospitality seed world. No lorem ipsum, Acme, random avatars, generic gradient blobs, or invented product copy.
- English LTR and Arabic RTL are architecture-level behavior. Use logical CSS properties, direction-aware icons, isolated LTR fragments, and Arabic typography rules.
- Implement light, dark, and high-contrast themes from semantic tokens.
- Meet WCAG 2.2 AA for core journeys: semantic order, visible focus, keyboard paths, reduced motion, target sizes, labels, announcements, zoom/reflow, and drag alternatives.
- Every feature includes loading, empty, error, retry, permission-denied, stale/conflict, and offline/reconnect behavior where applicable.
- Responsive behavior must be composed for desktop, tablet, and mobile—not scaled down.

### Repository boundaries

Use the structure in file 18:

- `apps/web`
- `apps/api`
- `apps/worker`
- `packages/ui`
- `packages/contracts`
- `packages/domain`
- `packages/config`
- `packages/observability`
- `packages/test-kit`
- `infra`
- `docs`

UI features may depend on the design system and generated contracts, never API internals. API modules cannot directly write another module's tables. Shared domain code contains pure value objects/policies, not ORM entities. Contracts and events are versioned. Test fixtures are synthetic only.

### Required execution sequence

#### Phase A — preflight and evidence

1. Inspect repository contents, git state, instructions, existing code, tools, and installed runtimes.
2. Read the mandatory planning/design sources above; produce `docs/product/source-map.md` with the exact files and precedence used.
3. Perform the 172-screen design-source audit and record the stale-ledger reconciliation.
4. Produce `docs/implementation-status.md` using only: `not_started`, `designed`, `design_validated`, `contract_defined`, `implemented`, `tested`, `release_ready`, `released`.
5. Map Sprint 0 and the P0 vertical slice to PRD IDs, stories, screen IDs, API operations, tables, events, permission rules, threats, analytics/audit events, and tests.
6. Identify decisions that truly require an ADR. Do not restart product discovery or ask about decisions already made in the pack.

After presenting a concise preflight summary, start implementation in the same session. Do not stop to request approval for ordinary reversible implementation choices.

#### Phase B — Sprint 0 foundations

Implement and verify the Sprint 0 tickets from file 28, including:

- monorepo, shared strict TypeScript/config boundaries, one lockfile;
- one-command local environment with a MySQL/MariaDB version compatible with Hostinger, Redis-compatible service, S3-compatible local storage, and required development dependencies;
- environment schema validation and safe example configuration;
- CI quality/security gates;
- OpenTelemetry correlation and redaction baseline;
- Drizzle schema plus explicit SQL migration framework, runtime/migration users, application-generated UUIDv7 `CHAR(36)` policy, `DATETIME(3)`, MySQL `JSON`, tenant indexes, composite tenant unique/foreign keys, scoped repository foundation, and isolation tests;
- idempotency and transactional outbox primitives;
- OpenAPI/event-schema validation and generated contract workflow;
- design tokens, self-hosted fonts/assets, accessible primitives, Storybook, component tests, and visual-regression harness;
- the production app shell and client-portal shell from the actual design artifacts.

Do not represent mocked browser state or localStorage as completed backend functionality.

#### Phase C — P0 vertical slices in dependency order

Execute the dependency path in file 28:

MySQL tenant-isolation foundation → identity/session/policy → organization/workspace/membership → project/work → client organization/membership/request → conversation/message-to-work → files → deliverable/version/internal review → client-safe preview/publication → approval/version invalidation → final delivery/history → notifications/search minimum → offboarding/ownership transfer → alpha hardening.

Build UI, API, database, worker/event behavior, authorization, audit, analytics, states, and tests together for each coherent slice. Do not build all screens first and defer behavior/security.

### Verification gates

For every relevant change, run and report the actual result of:

- formatting, typecheck, lint, and production build;
- unit and database integration tests;
- migrations from empty database and upgrade path checks;
- OpenAPI and event-schema compatibility;
- tenant × role × object authorization/isolation matrix;
- idempotency, outbox duplicate delivery, retry, and concurrency tests;
- end-to-end golden journeys for internal and client roles;
- accessibility automation plus documented manual keyboard checks;
- RTL and responsive checks for critical journeys;
- component and critical-screen visual regression;
- dependency, secret, static-security, upload, XSS, CSRF, IDOR/BOLA, session, and rate-limit checks as applicable;
- backup/restore and rollback rehearsal before alpha readiness;
- performance budgets from the engineering specification.

Never claim a check passed unless you ran it. Never disable a test, weaken a type, remove a constraint, or bypass authorization to make a check green. Fix the root cause or document a genuine external blocker.

### External services and cost control

Use local/self-hosted development substitutes and provider abstractions where the pack allows. The owner can currently fund only the smallest Hostinger Cloud plan; do not require another paid service to complete the bootstrap milestone. Do not purchase, deploy paid resources, send production email, register a domain, enable a paid integration, or create production cloud resources without explicit owner authorization. The pricing **model** is locked by file 49; exact currency amounts, annual discount, taxes, payment provider, region, legal entity, launch jurisdiction, trademark/domain clearance, expanded production budget, and real alpha partners remain owner decisions. Use `.example` domains and safe local credentials until those gates are supplied.

### Session communication and handoff

Keep progress updates concise and evidence-based. At the end of every work session, update repository documentation and report:

1. outcome completed;
2. files changed;
3. requirements/stories/tickets satisfied;
4. commands/checks actually run and results;
5. security and permission impact;
6. ADRs/decisions;
7. known gaps and risks;
8. exact next backlog task.

The repository must be left runnable with exact startup instructions. Preserve unrelated user work. Never delete or rewrite source planning/design files.

Start now: inspect the workspace, load and list the authoritative sources, reconcile the design export, create the self-contained `./tmanage/` repository if absent, write the requirements-to-code plan, and immediately execute Sprint 0. Continue through the P0 vertical slice without stopping after the plan.

## PROMPT END
