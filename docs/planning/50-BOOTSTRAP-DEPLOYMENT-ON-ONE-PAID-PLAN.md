# TManage — Bootstrap Deployment on One Paid Hostinger Cloud Plan

**Owner constraint:** the available launch budget covers only the smallest Hostinger Cloud plan.  
**Decision date:** 16 August 2026.  
**Purpose:** make development, demonstration, and a small invitation-only alpha possible without purchasing a VPS or additional fixed-price infrastructure.

## 1. Scope and truth-in-advertising gate

This profile is approved for development, demos, and a private alpha of up to 3–5 organizations with synthetic or explicitly consented low-risk data. It is not the GA/high-availability topology and must not be marketed as unlimited, enterprise-grade, or SLA-backed.

Do not open public self-service signup or onboard a paying production customer until the upgrade gate in section 8 is funded and passed. The product architecture remains portable; this profile deliberately uses the MySQL-compatible database included with Hostinger plus replaceable object-storage/Redis boundaries.

## 2. Cash-cost target

Required paid service:

- The owner's existing/smallest Hostinger Cloud plan.

Use included/zero-cost services initially:

- Relational database: the MySQL-compatible MariaDB database included with the owner's Hostinger Cloud plan; no Neon/Supabase subscription.
- Object storage: Cloudflare R2 Standard free allowance.
- Redis-compatible cache/rate-limit/low-volume queue: Upstash Redis Free.
- Email: development capture locally; an approved free transactional-email allowance for invitation testing, or owner-mediated invitation links until a provider/domain is configured.
- Monitoring: structured logs plus free allowances/local dashboards; no paid observability subscription required for bootstrap.

External free tiers have no production SLA. They must be replaceable through configuration/adapters and guarded by usage alerts. The exact Hostinger database/storage/connection/backup limits shown in hPanel must be captured in the environment runbook before deployment because plan limits can change.

## 3. Hostinger deployment

Hostinger Cloud runs the Node.js applications and supplies the MySQL-compatible database. It does not supply a standalone Redis service. Deploy:

- `apps/web` as one Node.js web application;
- `apps/api` as a second Node.js application;
- `apps/worker` as a third application only if the plan/runtime supports the required persistent process reliably; otherwise run controlled worker batches and document the limitation.

Do not store authoritative customer files on Hostinger application disk. The plan's disk is for deployments, build artifacts, and replaceable temporary/cache data. Customer objects go to R2; relational truth goes to the Hostinger MySQL-compatible database.

Keep application concurrency, connection pools, build memory, and log retention within the plan limits. Heavy previews, malware scanning, exports, and AI jobs are feature-flagged or processed conservatively during private alpha.

## 4. Included/free-tier assignments

### MySQL-compatible MariaDB — included with Hostinger Cloud

Use one database per environment, not one database per TManage customer. All organizations share the application database and are logically isolated through mandatory `organization_id`, trusted application policy, tenant-scoped repositories, composite tenant foreign keys, explicit client projections, and the isolation test corpus in file 25. MySQL/MariaDB does not provide PostgreSQL-style RLS.

Controls:

- Files/binaries never enter MySQL.
- Use the `mysql2` driver with a small bounded pool, TLS when Hostinger exposes it, keepalive/timeouts, and strict connection budgets matched to the plan.
- Use InnoDB, strict SQL mode, `utf8mb4`, UTC, `DATETIME(3)`, application-generated UUIDv7 stored as `CHAR(36)`, and MySQL `JSON` only for non-relational structured content.
- Use separate migration and runtime credentials where the Hostinger plan permits; the runtime user must not receive schema/grant privileges.
- Enable automated Hostinger backups available to the plan, add an encrypted logical export schedule to separately controlled storage, and prove restore into a disposable database before alpha data is accepted.
- Keep audit/event retention appropriate for the tiny alpha and export/purge test data after exercises.
- Alert at 60/75/85% of database storage, connections, slow-query rate, and resource allowance exposed by Hostinger.
- At 80% sustained capacity or before requirements exceed the included service's backup, recovery, region, availability, or support guarantees, move to a funded managed MySQL service or MySQL on a properly operated VPS.

### Object storage — Cloudflare R2 Standard

At the decision date the free allowance includes 10 GB-month Standard storage, 1 million Class A operations, 10 million Class B operations, and free direct egress.

Bootstrap policy:

- Total R2 warning at 5 GB, freeze review at 8 GB, and no new alpha organization past the hard safety gate without owner approval.
- Default private-alpha workspace quota is 500 MB; a manually approved high-file workspace may receive 1 GB if aggregate headroom remains.
- These are alpha overrides, not the future Starter/Studio/Business entitlements in file 49.
- Lifecycle-delete abandoned multipart uploads, expired previews, and synthetic test artefacts.
- Do not enable Infrequent Access merely to save cents; its retrieval/minimum-duration rules add complexity at this scale.

### Redis — Upstash Free

At the decision date the free plan lists 256 MB, 10 GB monthly bandwidth, and 500,000 commands monthly. Upstash documents BullMQ support but warns that polling can generate commands even when queues are idle.

Controls:

- Use Redis only for ephemeral cache, rate limits, presence, and low-volume queue coordination; MySQL/outbox remains durable truth.
- Tune BullMQ/worker polling for bootstrap, pause nonessential recurring jobs, and expose command usage.
- Alert at 50/70/85% commands and bandwidth.
- If idle polling threatens the free limit, feature-flag the continuous worker and use controlled scheduled processing for alpha; record an ADR and do not lose durable outbox work.
- Upgrade only after usage/revenue evidence; never allow an unbounded pay-as-you-go bill without a configured cap.

## 5. Bootstrap feature profile

Must work:

- identity/session and two isolated organizations;
- core project/work/client request flow;
- client-safe progress and approval;
- small file upload/version/approval loop within quota;
- audit, idempotency, outbox durability, permission and tenant-isolation tests;
- English and critical Arabic RTL screens;
- backup/export exercise and exact restore limitations documented.

Restricted or feature-flagged:

- large files and video;
- CPU-heavy rich previews;
- high-frequency presence/typing and large realtime fan-out;
- broad automation schedules;
- AI generation/embedding;
- public links, mass exports, bulk imports, and unlimited history;
- paid billing/webhooks until the provider decision.

Restrictions must be explicit in the alpha agreement/UI and must not silently corrupt or discard work.

## 6. Bootstrap entitlements

The public paid plans from file 49 remain implementation/configuration targets, but are not promised during private alpha.

Private-alpha override:

| Dimension | Bootstrap limit |
|---|---:|
| Organizations | 3 target; 5 absolute maximum after capacity review |
| Internal users | 15 total target; 25 hard review |
| Client users | Included, invitation-only, low-volume |
| Active projects | 3 per organization; 15 total |
| Storage | 500 MB per organization default; 5 GB aggregate warning; 8 GB freeze review |
| Max single upload | 100 MB default |
| Automations | Essential system jobs only |
| AI | Disabled |

Quota enforcement remains the production-grade mechanism from file 49; only entitlement values differ.

## 7. Cost and usage dashboard

The owner/admin bootstrap dashboard must show:

- Hostinger MySQL storage, connections, slow queries, backup status, and database resource health where exposed;
- R2 stored bytes and Class A/B operations;
- Upstash commands, data size, and bandwidth;
- Hostinger CPU/RAM/disk/build/log health where available;
- number of organizations, internal users, client users, active projects, uploads, and completed work loops;
- distance to every warning/freeze/upgrade threshold.

Send alerts to the owner before a limit stops the app. There is no automatic paid upgrade and no uncapped pay-as-you-go activation.

## 8. Mandatory upgrade gate

Upgrade before the first paying production customer or when any of these occurs first:

- more than 5 organizations or 25 internal users;
- Hostinger MySQL storage/connections/resources repeatedly exceed 80% of the plan limit;
- R2 exceeds 8 GB or operation volume approaches the free tier;
- Upstash command/bandwidth usage repeatedly exceeds 70%, or queues require continuous reliable workers;
- client data requires SLA, point-in-time recovery beyond the free window, dedicated support, data residency, or stronger operational controls;
- Hostinger process/build/concurrency limits impair API/worker reliability;
- restore, scanning, preview, realtime, or notification SLO cannot be met.

Minimum funded next step is not necessarily a large stack: keep Hostinger for web/API if healthy, enable pay-as-you-go R2 only for actual usage, move the database to the smallest reliable managed MySQL tier when telemetry or recovery requirements demand it, and fund the smallest reliable Redis/queue option justified by telemetry.

## 9. Implementation requirements

- Add `DEPLOYMENT_PROFILE=bootstrap|standard` with schema validation. It changes capacity/features, never authorization or data-integrity rules.
- Keep storage, database, queue, email, and telemetry behind documented adapters/configuration.
- Seed bootstrap entitlements separately from sellable plan versions.
- CI and local development use containers/mocks without contacting production free-tier accounts.
- Record free-tier terms, region, credentials owner, usage URL, backup/restore limitation, and migration procedure in the environment runbook.
- Never encode provider credentials or real endpoints in source control.
- Claude Code must implement the bootstrap profile first because it matches the owner's funded environment, while preserving the standard target architecture and upgrade path.

## 10. Evidence and revalidation

Official sources checked 16 August 2026:

- Hostinger Cloud supports Node.js applications and Hostinger Web/Cloud hosting uses a MySQL-compatible MariaDB database; PostgreSQL and standalone Redis are not included in Web/Cloud hosting.
- Cloudflare R2 Standard lists a 10 GB-month free tier plus included operations and free direct egress.
- Upstash Redis Free lists 256 MB, 10 GB bandwidth, and 500,000 commands/month; its BullMQ guide warns polling can consume commands.

Re-check every limit before account creation/deployment because free-tier terms can change.
