# TManage — Cost Model and Unit Economics Framework

## 1. Scope and caution

This is a planning model updated 16 August 2026, not a cloud quote. Region, discounts, traffic, retention, file types, logs, support, and AI change costs materially. Recalculate in the official provider calculator before purchase and monthly after launch. Labor, legal, security audits, design, and development are shown separately from runtime.

## 2. Monthly cost equation

`Total = fixed platform + compute hours + database instance/storage/IO/backups + Redis + object GB-month + requests + CDN/egress GB + email recipients + observability ingest/retention + scanning/preview compute + DNS/WAF/NAT/public IP + support + optional AI tokens/vector storage`.

Key unit metrics: cost per weekly active internal member, active client reviewer, organization, GB stored, 1,000 notifications, approval loop, and gross margin by plan.

## 3. Planning bands

| Stage | Workload assumption | Runtime planning range/month | Notes |
|---|---|---:|---|
| Local/CI | development only | $0–$150 | CI usage and artifact storage vary |
| Shared staging | always-on small services/DB | $150–$600 | keep synthetic; schedule nonessential preview shutdown |
| Private alpha | 3–5 orgs, <100 internal users, moderate files | $500–$1,500 | secure multi-AZ production core can dominate |
| Paid beta | 20–100 orgs, 1k–5k users | $2,000–$8,000 | depends heavily on file egress/logging/realtime |
| Early GA | 100–500 orgs, 5k–25k users | $8,000–$30,000+ | support, redundancy, observability, search and egress drive spread |

These are deliberately broad architecture envelopes, not vendor commitments.

### Owner-funded bootstrap override

Until the first upgrade gate, the only fixed paid service is the owner's smallest Hostinger Cloud plan. Its included MySQL-compatible MariaDB, the R2 free allowance, and Upstash Redis Free are used within the strict limits in file 50. Target incremental infrastructure cash cost is `$0`, excluding domain/tax/payment-method requirements and the already purchased Hostinger plan. This is suitable only for development, demos, and an invitation-only 3–5 organization alpha. Do not compare this temporary profile to the production bands above or claim a production SLA.

## 4. Alpha reference allocation

- Web/API/realtime/worker Fargate tasks: 20–35%.
- RDS MySQL Multi-AZ + storage/backups: 30–45%.
- Redis: 5–15%.
- S3/CDN/egress/preview: 5–20%.
- WAF/NAT/DNS/load balancer/public IPv4: 5–15%.
- Logs/traces/error monitoring: 5–20%.
- Email: usually low at alpha, but deliverability setup matters more than raw send charge.

Budgets must alert at 50/75/90/100% and on abnormal daily change.

## 5. Cost drivers and controls

### Compute/realtime

Right-size tasks from telemetry, use ARM where dependencies allow, autoscale API/realtime separately, use Spot only for interrupt-tolerant workers, cap runaway jobs, avoid Kubernetes baseline.

### Database

Index/query review before scaling; bounded connection pooling; archive old activity; partition audit/event tables when evidence demands; stay on a supported MySQL/MariaDB version to avoid extended-support charges. Do not compromise Multi-AZ/backup for production client data merely to hit a low estimate.

### Files/egress

Quotas by plan, lifecycle old internal versions/previews, CDN safe downloads, compress previews, show large download impact, prevent duplicate uploads by hash where privacy-safe. Files and egress are expected long-run margin risks.

The implementation baseline is one elastic private object-storage pool with per-workspace logical quotas, not purchased disk space per customer and not Hostinger VPS disk. Cloudflare R2 Standard is the initial recommendation through a provider-neutral S3 adapter. At the 16 August 2026 decision point, the official R2 page lists `$0.015/GB-month`, 10 GB-month Standard free, metered operations, and free direct R2 egress. Illustrative storage-only cost before operations, scanning, previews, backups, support, and taxes: 25 GB ≈ $0.38/month, 100 GB ≈ $1.50/month, 500 GB ≈ $7.50/month, and 1 TB ≈ $15/month (free tier ignored for conservative per-tenant examples). Reverify before purchase.

### Observability

Sample high-volume successful traces, retain security/audit separately, exclude content, use structured fields and lifecycle. Never disable security visibility to reduce cost.

### Email

Bundle notifications and digests, suppress invalid/bounced addresses, measure action value. Official SES pricing is volume/plan-based and can change; verify current tier.

### AI

AI is post-MVP. Apply per-tenant quota, model routing, prompt/result cache where safe, document truncation/retrieval, cost attribution, budget circuit breaker. Pricing plans must not promise unlimited expensive generation.

## 6. Commercial packaging and capacity policy

The billing unit is locked in file 49:

- workspace subscription with included internal seats;
- additional full internal users consume paid seats;
- Client Admin/Reviewer/Viewer and limited external collaborators are included and consume no internal paid seat;
- active projects and pooled storage are plan allowances, not separately purchased projects;
- archived projects release active-project capacity but retained bytes still count;
- storage add-ons use predictable blocks rather than silent overage;
- exact currency prices and payment provider remain paid-beta evidence gates.

Initial configurable storage defaults are 2 GB Trial/Free, 25 GB Starter, 100 GB Studio, 500 GB Business, and 1 TB+ Enterprise/contract. Do not book the full allowance as provider cost: object storage bills actual aggregate use. Forecast with utilization cohorts (p50/p75/p95), retained-version factor, preview multiplier, operation volume, scan minutes, and download traffic.

Minimum storage gross-margin model per plan:

`storage COGS = actual GB-month + object operations + scan/preview compute + attributable logs + support + backup/replication where applicable`.

Set alerts on total provider spend and tenant-level abnormal change. Enforce quota atomically at upload reservation; never delete data automatically on overage/downgrade.

## 7. People and one-time readiness costs

Largest cost is team: Product, Design/Research, frontend/backend/platform, QA/SDET, SRE, security/privacy, support. One-time/periodic external costs: trademark/legal review, contracts/privacy, accessibility audit, penetration test, SOC 2 readiness/audit, incident exercise, domain purchase, email deliverability, customer onboarding/migration.

## 8. Unit-economics gates

- Target gross margin after stable beta: ≥75% software runtime before high-touch services, revisited by segment.
- Storage/egress-heavy tenants get fair-use/usage tier, not hidden subsidy.
- Client viewers/reviewers can remain free/included if their incremental cost and purchase influence justify it.
- Alert if infrastructure cost per completed work loop rises 25% month-over-month without product explanation.
- Pricing experiment must cover support and compliance cost, not only compute.

## 9. Cost worksheet inputs

For each environment record region; task count/vCPU/GB/hours; DB class/AZ/storage/IO/backups; Redis nodes; monthly active users; peak sockets/messages; file uploads/storage/download egress; email recipients; log/trace GB and retention; search documents/queries; scan minutes; AI input/output/cache tokens; support plan and taxes.

## 10. Official pricing references

- AWS Fargate pricing and calculator: https://aws.amazon.com/fargate/pricing/
- Amazon RDS for MySQL pricing: https://aws.amazon.com/rds/mysql/pricing/
- Amazon S3 pricing: https://aws.amazon.com/s3/pricing/
- Amazon SES pricing: https://aws.amazon.com/ses/pricing/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Teamwork pricing and included client users: https://www.teamwork.com/pricing/ and https://www.teamwork.com/product/client-users/
- Asana pricing and guest treatment: https://asana.com/pricing
- Basecamp workspace/client pricing alternative: https://basecamp.com/pricing

Always save a dated calculator export with the architecture decision before purchase.
