# TManage — Pricing, Entitlements, and Storage Policy

**Decision status:** Packaging model locked for implementation; exact currency prices and payment provider remain paid-beta gates.  
**Decision date:** 16 August 2026.  
**Applies to:** public pricing, workspace billing, seats, client access, active-project allowances, file storage, usage metering, plan enforcement, and cost attribution.

## 1. Commercial decision

TManage is sold as a **workspace subscription with included internal seats**. Additional full internal users consume paid seats. A project is not the primary billing unit.

- Paid/billable principals: Owner, Organization Admin, Workspace Admin, Manager, Member, and any collaborator granted full internal capabilities.
- Included/free principals: Client Admin, Client Reviewer, Client Viewer, and limited external collaborators.
- Client principals never become billable merely because they were invited, viewed progress, commented, uploaded a requested file, or completed an assigned approval.
- Active-project allowances package the plans and control abuse; they do not create a separate purchase for every project.
- Archived projects do not consume the active-project allowance. Their retained files still consume storage until lifecycle deletion.
- The exact monthly/annual prices, additional-seat price, taxes, currency localization, and payment provider require evidence and owner approval before paid beta.

This model protects the Client Portal network loop: service firms must be able to bring clients into progress, review, and approval without calculating a charge for every external participant.

## 2. Initial entitlement defaults

These are implementation defaults for entitlement logic and alpha testing, not published price promises. They must be configurable in plan/version records rather than hard-coded throughout the application.

| Plan | Included internal seats | Active projects | Pooled workspace storage | Client users | Positioning |
|---|---:|---:|---:|---:|---|
| Trial / Free | 2 | 3 | 2 GB | Included under fair use | Evaluation and very small teams |
| Starter | 5 | 15 | 25 GB | Included under fair use | Small service team |
| Studio | 10 | 50 | 100 GB | Included under fair use | Growing agency/studio |
| Business | 25 | 250 | 500 GB | Included under fair use | Multi-team operation |
| Enterprise | Contract | Configurable/unlimited | 1 TB+ or contract | Included | Security, residency, support, and negotiated capacity |

Rules:

- Starter, Studio, and Business can add internal seats without changing plan when the plan supports the required features.
- Offer storage add-ons in predictable blocks (proposed default: 100 GB), never silent variable overage.
- Project allowances count projects in an active execution state. Draft templates, archived projects, and deleted projects outside their recovery window do not count.
- A client organization can participate in multiple authorized projects; client membership does not consume an internal seat.
- Fair use controls abuse, automated scraping, public distribution, and extraordinary operation volume. Fair use must not be used as an undisclosed substitute for a published limit.

## 3. Why projects are not the primary billing unit

- TManage provides persistent value outside projects: Home, Inbox, Chat, Docs, People, Search, Admin, security, audit, and client relationships.
- Per-project billing penalizes agencies with many small engagements and undercharges organizations that place a large operation inside one project.
- It creates ambiguous billing around paused, duplicated, template, archived, and reopened projects.
- It encourages customers to combine unrelated work to avoid charges, damaging permissions, reporting, and product quality.
- Internal seat growth is easier for buyers to forecast and more closely follows organization-wide adoption.

## 4. Storage acquisition model

TManage does not reserve or purchase a physical disk for every account. It buys elastic object storage as one provider-level pool and gives each workspace a logically isolated, metered quota.

Recommended initial production provider: **Cloudflare R2 Standard**, accessed through the S3-compatible adapter already required by the architecture. This choice is motivated by predictable object pricing and no direct R2 egress fee at the decision date. Keep the adapter provider-neutral so S3, Backblaze B2, or a residency-specific provider can replace it through an ADR.

Do not store customer files on the Hostinger VPS disk. The VPS disk is for application runtime, caches, and replaceable operational data only. Customer files, versions, previews, and exports belong in durable private object storage.

Provider-level layout:

```text
tmanage-{environment}-quarantine/
  tenant/{organization_uuid}/project/{project_uuid}/upload/{upload_uuid}/part-or-object

tmanage-{environment}-private/
  tenant/{organization_uuid}/project/{project_uuid}/asset/{asset_uuid}/version/{version_uuid}/{safe_name}

tmanage-{environment}-derived/
  tenant/{organization_uuid}/asset/{asset_uuid}/version/{version_uuid}/preview/{preview_uuid}
```

- Use buckets by environment and trust state, not one bucket per customer.
- Buckets are private; no public ACL and no guessable customer-facing keys.
- The API authorizes object scope before issuing a short-lived, single-purpose presigned URL.
- Quarantine and preview workers have separate least-privilege identities.
- Cross-tenant key access, list operations, copy operations, and presigning are covered by isolation tests.
- Backups, database snapshots, logs, and internal service artifacts are platform costs and never count against customer file quota.

## 5. Storage accounting

Workspace storage is pooled across its projects and client activity. A client upload counts against the service company's owning workspace, not against a separate client bill.

Count toward the customer quota:

- uploaded source objects after the upload reservation is accepted;
- every retained immutable file/deliverable version;
- customer-generated exports retained beyond the short download window;
- generated previews when their cost is material and attributable;
- recoverable trash until its documented expiry.

Do not count:

- incomplete multipart parts after reservation expiry/abort cleanup;
- platform backups and disaster-recovery replicas;
- short-lived scan scratch files and temporary transformations;
- provider metadata not represented as stored object bytes.

Maintain an append-only usage ledger plus reconciled counters. At minimum record: organization, project when applicable, asset/version, storage class, byte delta, reason, source event, occurred time, and idempotency key. A scheduled reconciliation compares the ledger/counter with provider inventory and alerts on drift.

## 6. Atomic quota enforcement

Quota is enforced before upload, not after the bill arrives.

1. Client requests an upload session with declared size and file metadata.
2. API authorizes the project/object and checks plan entitlement.
3. In one transaction, reserve declared bytes if `used_bytes + reserved_bytes + declared_bytes <= effective_quota_bytes`.
4. Reservation receives an expiry and idempotency key.
5. Multipart upload goes directly to object storage.
6. Completion verifies actual provider size/checksum; the reservation is converted to used bytes.
7. Failure, abort, or expiry releases reserved bytes and removes abandoned parts.
8. A physical version deletion reduces usage only after provider deletion is confirmed and retention/hold rules allow it.

Threshold behavior:

| Usage | Product behavior |
|---:|---|
| 70% | Usage insight in Billing; no interruption |
| 85% | Owner/admin warning and cleanup guidance |
| 95% | Persistent owner/admin warning; offer plan/storage change |
| 100% | Block new upload reservations and storage-producing jobs; keep reads, downloads, deletion, export, billing, and plan change available |
| Above quota after downgrade | Grace window; no destructive deletion; block net-new storage after grace until usage or entitlement is corrected |

Never delete customer data automatically because a plan changed or payment failed. Apply the documented dunning, read-only, retention, export, and eventual deletion policy with notices and audit evidence.

## 7. Entitlement architecture

Entitlements are server-owned and versioned. UI checks are explanatory only.

Minimum records:

- `plans` and `plan_versions`;
- `subscriptions` and `subscription_items`;
- `entitlement_definitions` and `organization_entitlements`;
- `seat_assignments` or billable membership classification;
- `usage_counters` and `usage_ledger_entries`;
- `storage_reservations`;
- `billing_events` and provider webhook receipts;
- `plan_change_previews`.

Minimum entitlement keys:

```text
internal_seats.included
internal_seats.additional_allowed
client_users.included
projects.active_limit
storage.bytes_limit
storage.addon_bytes
automations.monthly_runs
ai.monthly_credits
audit.retention_days
features.sso
features.custom_branding
features.advanced_permissions
```

The effective entitlement is derived from the immutable plan version plus explicit add-ons/overrides. Every consequential plan or seat change produces an impact preview, audit event, and idempotent billing command. Webhooks are verified, replay-protected, stored, and processed asynchronously.

## 8. Required product behavior

Public pricing (`PUB-04`) must explain internal seats, included client users, active-project allowances, pooled storage, add-ons, annual billing, downgrade behavior, and fair use without dark patterns.

Billing (`BIL-01`–`BIL-03`) must show:

- current plan/version and renewal state;
- included and occupied internal seats;
- client users labelled Included / not billed;
- active projects versus allowance;
- storage used/reserved/available, version-history contribution, and threshold warnings;
- automation/AI usage where applicable;
- next invoice estimate and price-change effective date;
- plan-change preview with lost entitlements, over-limit consequences, and grace dates;
- invoices/payment method once the provider is selected.

Admins need a clear classification preview before converting a free client/collaborator into a full internal member that consumes a seat.

## 9. Events, APIs, audit, and analytics

Required events:

```text
entitlement.changed
seat.assigned
seat.released
usage.storage_reserved
usage.storage_committed
usage.storage_released
usage.threshold_reached
project.allowance_reached
subscription.created
subscription.changed
subscription.payment_state_changed
```

Required API surface before paid beta:

```text
GET  /v1/plans
GET  /v1/billing/subscription
GET  /v1/billing/usage
POST /v1/billing/plan-change-previews
POST /v1/billing/plan-changes
POST /v1/billing/seat-change-previews
POST /v1/billing/seat-changes
POST /v1/billing/portal-sessions
POST /v1/billing/webhooks/{provider}
```

All plan/seat mutations require owner/admin capability, reauthentication where risk requires, idempotency, audit, and webhook reconciliation. Analytics may record plan/usage bands and conversion events but must not include filenames or content.

## 10. Required tests

- A client/admin/reviewer/viewer never consumes an internal paid seat.
- Converting a client or limited collaborator to a full internal role shows impact and consumes exactly one seat after confirmation.
- Concurrent upload reservations cannot oversubscribe the organization quota.
- Duplicate completion/release/provider events do not double-count bytes.
- A tenant cannot presign, list, copy, download, or delete another tenant's object.
- A downgrade never deletes content and applies the correct grace/read-only behavior.
- Archived projects release the active-project allowance but retained versions continue to count toward storage.
- Storage reconciliation detects and safely repairs counter drift with audit evidence.
- Threshold notifications are deduplicated and sent only to authorized billing/admin recipients.
- Client Portal remains usable when the internal-seat allowance is full.
- Payment-provider webhook signatures, replay, ordering, retry, and duplicate delivery are tested before paid beta.

## 11. Cost and margin policy

Track cost per active organization, internal seat, active project, GB-month, upload/scan minute, preview, download, and completed approval loop. Gross-margin reporting must include object operations, scan/preview compute, support, observability, backups, and compliance overhead—not storage price alone.

At the decision date, Cloudflare R2 Standard lists storage at `$0.015/GB-month`, a 10 GB-month free tier, metered Class A/Class B operations, and free direct R2 egress. Re-check official pricing immediately before purchase and record a dated calculator/export in the provider ADR. Do not promise unlimited storage or unlimited costly AI/automation work.

## 12. Implementation sequence

1. Sprint 0/Files foundation: provider-neutral adapter, private buckets, usage ledger schema, quota reservation primitive, metrics, and tests.
2. P0 file workflow: enforce workspace quota through upload/scan/version/delete lifecycle.
3. Alpha: display usage and thresholds; entitlements may use a local/manual subscription provider.
4. Paid-beta gate: select payment provider, finalize currency prices/taxes/dunning, implement webhooks/invoices/plan changes, and pass billing security/reliability tests.
5. After evidence: adjust plan numbers and allowances through new immutable plan versions; do not rewrite historical subscriptions.

## 13. External evidence used for this decision

- Teamwork.com charges standard/internal users while offering client users without subscription cost, aligning with service businesses and client collaboration.
- Asana charges organization members while external guests do not consume billed seats.
- Basecamp demonstrates fixed workspace pricing and free clients/contractors as a viable alternative, while its free entry point uses a project allowance.
- Cloudflare R2 provides S3-compatible elastic object storage and, at the decision date, lists no direct egress charge.

Revalidate market packaging and provider economics during paid-alpha conversion. The model above is the implementation baseline; exact price points remain an evidence-based business decision.
