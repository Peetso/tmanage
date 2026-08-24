# TManage — Complete Test Catalog and Release Gates

## 1. Test data contract

Use deterministic tenants from `19-SEED-DATA-AND-COPY.md`: Northstar/Atlas and isolated BrightOps. Factories require `organization_id`; creating an unscoped tenant-owned fixture fails. No production data in tests or previews.

## 2. Unit tests

| ID | Subject | Required assertions |
|---|---|---|
| UNIT-01 | Client request state machine | only documented transitions; acceptance fields; withdrawal limits |
| UNIT-02 | Work state machine | blocker/internal review/done/reopen invariants |
| UNIT-03 | Deliverable state machine | internal review and approval prerequisites |
| UNIT-04 | Approval aggregate | reviewer policies, terminal decision, invalidation, hash match |
| UNIT-05 | Invitation | expiry, single use, revoke, role/scope fingerprint |
| UNIT-06 | Audience policy | internal default; external cannot widen; projection allowlist |
| UNIT-07 | Idempotency | same fingerprint replays; different fingerprint conflicts |
| UNIT-08 | Work transition requirements | owner/date/reason requirements by state |
| UNIT-09 | Notification bundling | required actions retained; dedupe; quiet-hour classification |
| UNIT-10 | Client progress | milestone-based calculation; no raw task-percent claim |
| UNIT-11 | Offboarding impact | all ownership/credential/share types included |
| UNIT-12 | Project health | explainable signals, freshness, no personal ranking |

## 3. Database/integration tests

| ID | Scenario |
|---|---|
| INT-01 | Organization creation writes owner membership, audit, outbox atomically |
| INT-02 | Transaction rollback leaves neither domain row nor outbox event |
| INT-03 | Repository/query guard rejects unset or incorrect trusted tenant context; no tenant row is returned or changed |
| INT-04 | Runtime DB user cannot alter schema/grants or mutate protected audit/outbox history outside approved append flows |
| INT-05 | Composite tenant relationships reject cross-tenant reference |
| INT-06 | Cursor pagination stable under concurrent inserts |
| INT-07 | Message conversion creates one linked work item on retry |
| INT-08 | Message sequence monotonic per conversation |
| INT-09 | Work optimistic version conflict preserves both user intents for resolution |
| INT-10 | Client request transition and accepted work commit together |
| INT-11 | Client request projection excludes internal triage notes |
| INT-12 | Upload completion checks ETags/hash/declared size |
| INT-13 | Rejected file cannot receive download URL |
| INT-14 | Deliverable version files must all be ready and same tenant |
| INT-15 | Publish writes immutable projection, approval, audit, outbox atomically |
| INT-16 | Approval decision locks/rechecks reviewer/hash/state and is append-only |
| INT-17 | Version change invalidates pending approval and actions |
| INT-18 | Notification preferences/bundles persist and inline action reauthorizes |
| INT-19 | Search index deletion/permission update propagates within SLO |
| INT-20 | Audit filters and exports redact by scope |
| INT-21 | Every mutation has correlation, actor/effective actor, result |

## 4. Authorization and tenant isolation

| ID | Attack/condition | Expected |
|---|---|---|
| AUTH-01 | Org ID swapped in path | 404/deny without metadata |
| AUTH-02 | Direct object ID from BrightOps used by Northstar | deny before lookup or through organization-scoped lookup; zero side effects |
| AUTH-03 | Search for exact hidden title | no result/count/timing oracle beyond tolerance |
| AUTH-04 | Member converts message in inaccessible conversation | deny, no source leak |
| AUTH-05 | Member changes project/audience without capability | deny and audit if sensitive |
| AUTH-06 | Atlas client queries another client request | deny |
| AUTH-07 | Client downloads internal/unpublished file | deny; no URL issued |
| AUTH-08 | Viewer/non-assigned reviewer decides approval | deny |
| AUTH-09 | Manager publishes outside managed project | deny |
| AUTH-10 | Client Admin elevates user beyond organization policy | deny |
| AUTH-11 | Stale session after role downgrade | current policy denies |
| AUTH-12 | Suspended member uses HTTP/socket/old URL | all denied/disconnected |
| AUTH-13 | Cache key collision internal/client | projections remain separated |
| AUTH-14 | Delayed notification after access revocation | suppressed/safe generic notice |
| AUTH-15 | Worker payload forged with another tenant | signed service-context validation + scoped repository/constraint deny |

## 5. Golden-path E2E

| ID | Journey | Exit assertion |
|---|---|---|
| E2E-01 | Client request → clarification → accepted work | client sees committed scope/date; no internal notes |
| E2E-02 | Message → task | source and linked badge; no duplicate on retry |
| E2E-03 | Work → blocker → resolution → internal review | health/inbox update correctly |
| E2E-04 | Upload → internal review → real-policy preview → publish | only selected safe version/fields visible |
| E2E-05 | Client deep link → exact version → request changes/approve | immutable correct actor/hash/time |
| E2E-06 | Manager pulse draft → client-safe publish | sources/freshness; no auto publish |
| E2E-07 | Notification bundle → inline action | action current-authorized and devices sync |
| E2E-08 | Admin impact → offboard → transfer | live access revoked; ownership complete |
| E2E-09 | First organization/project/client onboarding | role previews and invitations correct |
| E2E-10 | Search across work/message/deliverable | accessible results only |
| E2E-11 | Audit filter/export | scope/redaction/export audit correct |
| E2E-12 | Interrupted multipart upload → resume → scan → download | no public/quarantine access |

## 6. Security tests

- SEC-01 BOLA/IDOR automated corpus across every ID endpoint.
- SEC-02 session fixation, rotation, refresh reuse, logout, global cutoff, MFA reauth.
- SEC-03 CSRF for cookie-auth mutations; CORS and origin policy.
- SEC-04 search enumeration, snippets, counts, filters, timing, stale permissions.
- SEC-05 cache poisoning/key isolation and CDN private-cache headers.
- SEC-06 MIME spoof, SVG/HTML, polyglot, archive bomb, oversized part, malware test file, path/key injection.
- SEC-07 linked internal reference in client publication blocks or redacts.
- SEC-08 stored/reflected DOM XSS in messages, comments, filenames, rich text, previews; CSP checks.
- SEC-09 rate limits: login, invitations, search, upload, approval link, export.
- SEC-10 mass download/export detection and reauthentication.
- SEC-11 offboarding race and token/socket revocation.
- SEC-12 SSRF in link/file preview and webhook later.
- SEC-13 SQL/filter injection; unsafe sort/field selection.
- SEC-14 secrets/log/analytics scan.
- SEC-15 dependency/IaC/container/SBOM/provenance gates.

## 7. Concurrency and reliability

- CONC-01 duplicate client requests with same idempotency key.
- CONC-02 reviewer decides while publisher invalidates version: only one valid terminal path.
- CONC-03 two managers transition same work version: one conflict, no lost update.
- CONC-04 duplicate/out-of-order outbox delivery: consumer idempotent.
- CONC-05 retry after timeout returns original committed result.
- REL-01 socket reconnect receives missed sequence once.
- REL-02 realtime node restart; client gap recovery.
- REL-03 queue delay/retry/dead-letter and notification access recheck.
- REL-04 Redis unavailable: core writes persist; realtime/presence degrades gracefully.
- REL-05 scan worker failure: file remains quarantined and retryable.
- REL-06 API instance loss; load balancer removes unhealthy task.
- REL-07 database failover behavior and retry boundaries.
- REL-08 migration rollback/forward compatibility.
- REL-09 backup restore to isolated environment.
- REL-10 full disaster runbook meets measured RPO/RTO target.

## 8. Accessibility and localization

- A11Y-01 landmarks/headings/skip link.
- A11Y-02 keyboard entire golden journeys.
- A11Y-03 visible focus and focus restoration.
- A11Y-04 dialogs/menus/people/date pickers with correct roles/names.
- A11Y-05 board drag alternative and accessible status announcements.
- A11Y-06 async/realtime live-region restraint.
- A11Y-07 contrast, zoom 200/400%, reflow, touch targets.
- A11Y-08 NVDA/Chrome internal request-to-delivery.
- A11Y-09 VoiceOver/Safari client approval.
- A11Y-10 reduced motion and high contrast.
- I18N-01 locale/timezone/date/number pluralization.
- I18N-02 Arabic navigation and logical layout mirror.
- I18N-03 mixed Arabic/English names/emails/IDs.
- I18N-04 timeline direction and charts remain semantically correct.
- I18N-05 truncation/expansion and long translated errors.
- I18N-06 email/deep-link Arabic templates.
- I18N-07 search behavior for Arabic normalization.
- I18N-08 export/audit timestamps with unambiguous UTC plus display zone.

## 9. Performance tests

- PERF-01 Home p95 <300 ms API at alpha target; query count budget.
- PERF-02 Work list p95 <300 ms for 10k project items with cursor.
- PERF-03 Search p95 target <500 ms for MVP corpus; relevance fixtures.
- PERF-04 Inbox p95 <300 ms and bundle creation throughput.
- PERF-05 client approval LCP <2.5 s target profile; JS/asset budget.
- PERF-06 realtime fan-out target connections and <1 s typical delivery.
- PERF-07 upload resume and large-file memory ceiling.
- PERF-08 audit export isolated from interactive workload.

## 10. Privacy and data lifecycle

- PRIV-01 user export contains documented allowed data.
- PRIV-02 tenant export manifest/checksums complete.
- PRIV-03 user deletion anonymizes identity while lawful business record remains.
- PRIV-04 tenant purge propagates search/cache/storage/AI index.
- PRIV-05 retention/hold prevents premature purge.
- PRIV-06 analytics contains no message/document/file body.
- PRIV-07 AI provider request/retention policy and opt-out enforced.

## 11. Release gates

Pull request: unit/relevant integration/contract/a11y static/security scans. Main/staging: full integration, authorization matrix, golden E2E, migration, visual regression. Alpha gate: zero open Critical/High tenant or external-boundary finding; restore test; A11Y critical journeys; performance budget; offboarding; pen-test scope complete. GA adds load/failover/incident exercise/SLO evidence.

Flaky tests are defects: quarantine only with owner, issue, reason, expiry ≤7 days, and never for security/authorization/approval tests.

## 12. Billing, entitlement, and quota tests

- BILL-01 Owner/Admin/Manager/Member/full internal collaborator classification consumes the correct number of seats; Client Admin/Reviewer/Viewer and limited collaborator consume zero.
- BILL-02 Converting a free external principal to a full internal role requires an impact preview, capacity check, confirmation, idempotency, and audit; the inverse releases exactly one seat.
- BILL-03 Active project allowance counts only defined active states; archive releases project capacity while retained file versions continue to consume storage.
- BILL-04 Plan downgrade never deletes data; grace, blocked net-new usage, reads/downloads/export/cleanup, notices, and audit behave as specified.
- BILL-05 Subscription/entitlement webhook signature, replay, duplicate, out-of-order, retry, and reconciliation behavior.
- BILL-06 Client Portal progress/review/approval remains usable when internal seat capacity is full.
- AUTH-16 Billing/plan/seat usage is visible only to authorized owner/admin scope; client and ordinary member access is denied without leaking plan data.
- QUOTA-01 Concurrent reservations cannot exceed effective workspace quota.
- QUOTA-02 Duplicate upload completion, abort, expiry, and provider events never double-count or double-release bytes.
- QUOTA-03 Client upload is charged to the correct owning service workspace and cannot affect another tenant.
- QUOTA-04 Every retained immutable version and recoverable trash object is counted; confirmed lifecycle deletion releases the exact bytes.
- QUOTA-05 Quarantine/derived/private bucket and key isolation prevents cross-tenant presign/list/copy/get/delete.
- QUOTA-06 Threshold notifications at 70/85/95/100 are deduplicated, authorized, and reset only after documented hysteresis/recovery.
- QUOTA-07 Provider inventory reconciliation detects drift, repairs safely/idempotently, and records audit evidence.
- QUOTA-08 At 100%, storage-producing commands are blocked while authorized reads, downloads, cleanup, export, billing, and plan change remain available.
- CONC-06 Storage reservation, completion, deletion, downgrade, and add-on change races preserve a non-negative, non-oversubscribed counter.
