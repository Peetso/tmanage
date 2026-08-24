# TManage — Implementation Tickets, Estimates, and Dependencies

## 1. Estimation model

Story points represent complexity/risk, not hours: 1 trivial, 2 small, 3 moderate, 5 substantial, 8 large/high-risk, 13 must split. A balanced 8–10-person build team may plan 35–50 points per two-week sprint only after two calibration sprints. Estimates exclude final brand/UI production and code work itself; they guide sequencing.

## 2. Definition of Ready

Requirement/story IDs, user outcome, design reference, API/data/event contract, permission rule, failure states, analytics/audit, accessibility/RTL, test IDs, dependencies, rollout/flag.

## 3. Sprint 0 — Decisions and foundations

| Ticket | Scope | SP | Depends | Acceptance evidence |
|---|---|---:|---|---|
| PLAT-001 | pnpm monorepo, shared config, ownership boundaries | 5 | — | build/test workspace |
| PLAT-002 | local compose and environment validation | 5 | 001 | one-command local stack |
| PLAT-003 | CI gates, artifact signing baseline, secret/dependency scans | 8 | 001 | protected workflow |
| OBS-001 | OpenTelemetry correlation/log redaction | 5 | 001 | trace web→API→DB |
| DATA-001 | migration framework, UUIDv7, app/migration DB roles | 5 | 002 | role audit |
| AUTHZ-001 | trusted tenant context, scoped repository, composite tenant-constraint foundation | 8 | DATA-001 | INT-03/04/05 |
| PLAT-004 | transactional outbox and idempotency middleware | 8 | DATA-001 | INT-01/02, UNIT-07 |
| UI-001 | token package, accessible primitives, Storybook/test harness | 8 | 001, design handoff | component baseline |

## 4. Sprint 1 — Identity and tenancy

| Ticket | Scope | SP | Depends |
|---|---|---:|---|
| ID-001 | session cookie, refresh rotation/reuse detection | 8 | AUTHZ-001 |
| ID-002 | MFA/passkey/recovery architecture | 8 | ID-001 |
| TEN-001 | organization/workspace/membership aggregates | 8 | AUTHZ-001, PLAT-004 |
| TEN-002 | roles/capabilities and policy evaluator | 8 | TEN-001 |
| TEN-003 | invitation issue/accept/revoke/expiry | 5 | ID-001, TEN-002 |
| AUD-001 | append-only audit service/view model | 5 | PLAT-004 |
| WEB-001 | identity/onboarding screens ID-01–ON-04 | 8 | UI-001, contracts |
| TEST-001 | tenant/role matrix harness and two-tenant seed | 8 | TEN-002 |

## 5. Sprint 2 — Projects and work core

| Ticket | Scope | SP | Depends |
|---|---|---:|---|
| PROJ-001 | project/project membership/client link schema/service | 8 | TEN-001/002 |
| WORK-001 | work aggregate and state machine | 8 | PROJ-001 |
| WORK-002 | list/read/create/update endpoints + cursor/version | 8 | WORK-001 |
| WORK-003 | blockers/dependencies and health signals | 8 | WORK-001 |
| WEB-002 | project overview, work list, detail | 13→split | UI-001, WORK APIs |
| TEST-002 | work unit/integration/auth/performance fixtures | 8 | WORK-001/002 |

## 6. Sprint 3 — Conversations and Inbox base

| Ticket | Scope | SP | Depends |
|---|---|---:|---|
| CHAT-001 | conversations/messages/thread sequence model | 8 | PROJ-001 |
| CHAT-002 | create/read messages and sanitized rich-text | 8 | CHAT-001 |
| CHAT-003 | message-to-work idempotent command/relation | 8 | CHAT-002, WORK-001 |
| RT-001 | socket tickets, authorized subscriptions, cursor/gap | 13→split | ID-001, PLAT-004 |
| NOTIF-001 | notification record, preferences, bundle foundation | 8 | PLAT-004 |
| WEB-003 | channel/thread/convert dialog | 13→split | design, CHAT APIs |
| TEST-003 | E2E-02, AUTH-04, REL-01/02 | 8 | above |

## 7. Sprint 4 — Client organizations and requests

| Ticket | Scope | SP | Depends |
|---|---|---:|---|
| CLIENT-001 | client org/membership/role/expiry | 8 | TEN-002, PROJ-001 |
| CLIENT-002 | client invitation and dedicated route/session context | 8 | CLIENT-001, TEN-003 |
| REQ-001 | client request aggregate/API/projection | 8 | CLIENT-001 |
| REQ-002 | triage/clarify/accept linked work transaction | 8 | REQ-001, WORK-001 |
| WEB-004 | Client Overview/My Actions/request screens | 13→split | design, CLIENT/REQ |
| WEB-005 | manager triage screen and schedule impact | 8 | REQ-002 |
| SEC-001 | client projection/query policies and cross-tenant isolation corpus | 8 | CLIENT-001 |

## 8. Sprint 5 — Files

| Ticket | Scope | SP | Depends |
|---|---|---:|---|
| FILE-001 | upload session/multipart/presigned/quota | 8 | AUTHZ-001 |
| FILE-002 | verification/hash/MIME/scan state worker | 13→split | FILE-001, queue |
| FILE-003 | immutable version/short download/retention hooks | 8 | FILE-002 |
| FILE-004 | safe preview sandbox pipeline | 8 | FILE-002 |
| WEB-006 | upload center/file states/client files | 8 | design, FILE APIs |
| TEST-004 | SEC-06, E2E-12, REL-05 | 8 | FILE stack |
| USAGE-001 | append-only storage ledger, reconciled counters, atomic byte reservation, threshold events | 8 | FILE-001, AUTHZ-001 |

## 9. Sprint 6 — Deliverables and publication

| Ticket | Scope | SP | Depends |
|---|---|---:|---|
| DEL-001 | deliverable/version aggregate | 8 | FILE-003, PROJ-001 |
| DEL-002 | internal review state/criteria | 5 | DEL-001 |
| PUB-001 | allowlisted client projection builder | 8 | DEL-001, CLIENT-001 |
| PUB-002 | real-policy preview/warning scanner/fingerprint | 8 | PUB-001 |
| WEB-007 | deliverable list/detail/internal review | 13→split | design, DEL |
| WEB-008 | publish safety check/view-as-client | 8 | design, PUB |
| TEST-005 | SEC-07, INT-14/15, E2E-04 | 8 | above |

## 10. Sprint 7 — Approvals and final delivery

| Ticket | Scope | SP | Depends |
|---|---|---:|---|
| APPR-001 | approval/reviewer/policy aggregate | 8 | PUB-001 |
| APPR-002 | decide/hash/locking/idempotency | 8 | APPR-001 |
| APPR-003 | invalidation/new version/reminders | 8 | APPR-002, NOTIF-001 |
| APPR-004 | finalization/waiver policy | 5 | APPR-002 |
| WEB-009 | client review/request changes/history/final | 13→split | design, APPR |
| TEST-006 | E2E-05, AUTH-08, CONC-02 | 8 | above |

## 11. Sprint 8 — Awareness, search, admin

| Ticket | Scope | SP | Depends |
|---|---|---:|---|
| HOME-001 | My Day ranking/explanation | 8 | WORK, NOTIF |
| INBOX-001 | modes/bundles/inline action/quiet hours | 8 | NOTIF-001 |
| SEARCH-001 | MySQL FULLTEXT search document/indexer with authorization filters | 8 | outbox |
| SEARCH-002 | permission-filtered query/snippet | 8 | SEARCH-001, AUTHZ |
| ADMIN-001 | offboarding impact/suspend/transfer job | 13→split | identity, modules |
| ADMIN-002 | audit viewer/export job | 8 | AUD-001 |
| WEB-010 | Home/Inbox/Search/Admin screens | 13→split | design/APIs |

## 12. Sprint 9 — Alpha hardening

| Ticket | Scope | SP | Depends |
|---|---|---:|---|
| I18N-001 | English/Arabic locale, RTL, emails, search normalization | 13→split | all UI |
| A11Y-001 | manual assistive-tech closure | 8 | all golden UI |
| PERF-001 | query/index/web bundle/load tuning | 8 | complete slice |
| REL-001 | retry/DLQ/failover/backup restore rehearsal | 13→split | infra |
| SEC-002 | threat-model closure and external pen-test fixes | variable | complete slice |
| OPS-001 | deploy/rollback/restore/incident runbooks | 8 | infra |
| ALPHA-001 | seeded demo, guides, support/metrics | 8 | complete slice |

## 12A. Paid-beta billing and entitlement gate

Exact price points and payment provider require owner approval before this gate. The entitlement and quota model is already locked by file 49 and must not be redesigned during implementation.

| Ticket | Scope | SP | Depends |
|---|---|---:|---|
| ENT-001 | versioned plans/entitlements, internal-seat classifier, active-project and storage allowances | 8 | membership, USAGE-001 |
| BILL-001 | subscription aggregate, add-ons, billing events, provider abstraction | 8 | ENT-001, owner provider decision |
| BILL-002 | plan/seat change impact previews, grace and non-destructive downgrade policy | 8 | BILL-001 |
| BILL-003 | verified/replay-safe webhook inbox and reconciliation worker | 8 | BILL-001, outbox |
| WEB-011 | PUB-04 and BIL-01–03 real plan/seat/project/storage usage UI | 13→split | design, ENT/BILL APIs |
| TEST-007 | BILL-01–06, AUTH-16, QUOTA-01–08, CONC-06 | 8 | above |

## 13. Dependency critical path

MySQL tenant-isolation foundation → identity/policy → project/work → client membership/request → files → deliverable projection → approval → awareness/admin → alpha hardening. Chat may advance parallel to client requests after project/work foundation. UI follows approved contracts and design, not database entities.

## 14. Schedule range

With the recommended 10–14-person team and parallel design/platform/product streams: roughly 9–12 two-week engineering sprints after design foundations, plus discovery/design overlap and alpha hardening. This is a planning range, not a commitment; recalibrate after Sprint 1 velocity and high-risk spikes.
