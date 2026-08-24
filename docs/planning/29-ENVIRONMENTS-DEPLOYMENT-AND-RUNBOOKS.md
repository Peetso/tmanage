# TManage — Environments, Deployment, Secrets, Backup, and Operations

## 0. Funded bootstrap profile

The currently funded environment is defined in file 50: the smallest Hostinger Cloud plan is the only paid service; its included MySQL-compatible MariaDB is the relational database, while object storage and Redis use guarded free tiers for development/demo/private alpha. This profile is not GA or SLA-backed. Its quotas, feature flags, usage dashboard, invitation-only scope, and mandatory upgrade triggers apply before the reference topology below. Security, tenant isolation, idempotency, audit, and data-integrity rules are unchanged.

## 1. Reference topology

Funded-scale AWS reference implementation: Route 53 (after domain clearance), CloudFront + WAF, Application Load Balancer, ECS Fargate services for web/API/realtime/worker, RDS MySQL Multi-AZ, ElastiCache Redis, private S3 buckets for quarantine/ready/previews/backups, SES for transactional email, KMS, Secrets Manager, CloudWatch/OpenTelemetry collector, ECR, and Terraform. Use one cloud first; avoid multi-cloud complexity before enterprise demand.

The architecture remains portable through containers, standard MySQL/Redis/S3 contracts, OpenTelemetry, and Terraform modules.

## 2. Environment matrix

| Environment | Data | Availability | Access | Purpose |
|---|---|---|---|---|
| Local | deterministic synthetic | developer machine | localhost/private | feature development and tests |
| CI | generated per run | ephemeral | CI identity only | unit/integration/contract/security |
| Preview | synthetic seed | ephemeral per PR | authenticated team link | UI/product review; never production copy |
| Staging | synthetic + approved test accounts | single region, reduced size | VPN/SSO or allowlist | E2E, migration, load, release candidate |
| Production alpha | real approved alpha data | multi-AZ core data; ≥2 app tasks | users + controlled support | real project pilot |
| Restore drill | restored encrypted copy with access lockdown | isolated/no outbound email | SRE/security only | prove RPO/RTO and runbook |

Environment credentials/resources are isolated. No production secrets or unrestricted production data in lower environments.

## 3. Network layout

- Public subnets: load balancer/NAT only as needed.
- Private application subnets: Fargate tasks without public IP.
- Isolated data subnets: RDS/Redis; security groups allow only required service identities/ports.
- S3 uses private access/VPC endpoints where practical; block public access account-wide.
- Worker preview/scan sandbox has minimal egress; link fetch uses controlled egress proxy/allowlist.
- Admin database access is just-in-time through audited session/bastion mechanism, not permanent public endpoint.

## 4. Configuration and secrets

`.env.example` lists names and safe descriptions only. Runtime secrets live in Secrets Manager/KMS; CI uses workload identity/OIDC, not long-lived cloud keys. Categories: database URL/cert, Redis, session signing/rotation keys, object storage role, email signing/domain, encryption keys, telemetry endpoint, optional AI provider key, webhook signing keys.

Rotation: session/signing keys support overlap and key IDs; DB credentials automated where possible; provider/webhook secrets at least quarterly or immediately on suspicion; audit rotation. Secrets never enter logs, error reports, client bundles, preview artifacts, or chat prompts.

## 5. CI pipeline

1. Validate planning/design traceability references.
2. Format, typecheck, lint.
3. Unit and contract schema validation.
4. Start ephemeral MySQL/Redis/S3-compatible services; apply migrations; integration, migration, constraint, and tenant-isolation tests.
5. Build web/API/worker images and SBOM.
6. SAST, dependency, secret, container, IaC, license checks.
7. Component accessibility/visual tests.
8. Deploy preview/staging; E2E smoke/full suite by branch.
9. Sign/provenance record and store immutable artifact.

Production deploys the exact tested digest.

## 6. Deployment method

- Trunk-based, feature flags separate deploy/release.
- Terraform plan reviewed; production apply protected.
- Expand/contract migrations: add compatible schema → deploy dual-compatible code → backfill → switch reads → later remove old schema.
- Rolling or blue/green ECS deployment with health/readiness checks.
- Canary internal organizations before client traffic for high-risk changes.
- Automatic rollback for health/error/SLO breach; database rollback is forward-fix unless a pretested reversible migration exists.

## 7. Health checks

Liveness only confirms process. Readiness confirms configuration and ability to serve without performing expensive downstream writes. Separate dependency health dashboard shows database, Redis, queue lag, storage, email, scan, search index. Do not mark API unhealthy solely because optional email/AI is down; degrade and queue safely.

## 8. Backup and recovery

- RDS automated backups/PITR target RPO ≤15 minutes; encrypted snapshot copy to separate failure domain/account according to policy.
- Object versioning and lifecycle; client deletion still follows purge policy.
- Terraform/state protected and replicated; event schemas/migrations in repository.
- Redis is not system of record; rebuild queues/search state from MySQL/outbox where designed.
- Monthly automated restore validation; quarterly operator restore rehearsal; annual disaster exercise.

Restore procedure: declare incident → freeze risky writes → create isolated environment → restore DB to target → verify migrations/integrity/tenant counts/hash samples → restore/reconcile object inventory → replay outbox/index → security review → controlled cutover → communicate → postmortem.

## 9. Rollback runbook

Trigger: release-specific error/SLO/security regression. Owner stops rollout, disables feature flag, routes to previous known-good task definition, preserves logs/traces, verifies schema compatibility, runs smoke/isolation/approval checks, monitors, records incident. Never rollback a migration blindly if new writes used new schema.

## 10. Incident runbook

Severity: SEV0 confirmed cross-tenant/client data exposure or total critical compromise; SEV1 broad outage/security with major impact; SEV2 degraded feature; SEV3 localized issue. Roles: Incident Commander, Operations, Security/Privacy, Communications, Scribe. Preserve evidence; avoid destructive “cleanup.” Legal/privacy notification clock begins when applicable facts are known. Customer communication states known impact, mitigation, next update; postmortem tracks owners/dates.

## 11. Observability and SLOs

SLIs: API availability/latency, portal LCP, websocket delivery/gaps, queue age/dead letters, file scan latency/failure, notification success, search latency/index freshness, approval decision errors, DB saturation, authorization denies/anomalies. Use error budgets; freeze risky launches when burned. Alerts require action and a runbook; remove noisy alerts.

## 12. Support access

No routine direct database access. Support views client-safe/admin-safe diagnostics. Impersonation, if later allowed, requires customer policy, reason/ticket, reauth, time limit, visible banner, and full audit; sensitive actions remain blocked or require customer co-approval.

## 13. Data residency and region decision

Choose primary region only after target customers/legal entity are confirmed. Store tenant region as policy metadata; do not promise residency before architecture and subprocessors support it. Arabic support does not itself determine hosting jurisdiction.

## 14. Pre-alpha operations gate

Infrastructure review, threat model, isolated accounts, production access list, on-call coverage, restore evidence, key rotation test, email domain authentication (SPF/DKIM/DMARC), status/support channel, incident contacts, monitoring, and cost budgets/alerts must pass.
