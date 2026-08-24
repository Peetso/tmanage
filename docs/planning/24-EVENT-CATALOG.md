# TManage — Event Catalog and Compatibility Rules

## 1. Event envelope

Every durable event follows `contracts/events/event-envelope.schema.json`: globally unique ID, schema version, type, occurrence time, organization, actor/effective actor, aggregate, correlation/causation, and payload. Events describe committed facts in past tense. Secrets, full message bodies, raw file content, and unnecessary personal data are forbidden.

## 2. Delivery semantics

- At-least-once delivery; consumers deduplicate by event ID.
- Producer writes state and outbox event atomically.
- Ordering is guaranteed only per aggregate by aggregate version/sequence.
- Consumer persists checkpoint after side effect succeeds.
- Retry uses exponential backoff; poison events reach dead-letter queue with alert and replay tooling.
- Realtime messages are safe projections of durable events, not the durable bus itself.

## 3. Compatibility

Additive optional fields are backward compatible. Removing/renaming fields, changing meaning/type, or making optional fields required needs a new schema version and dual-read/dual-publish migration. Consumers ignore unknown optional fields. Contract tests validate all registered examples.

## 4. MVP events

| Type | Aggregate | Trigger | Primary consumers | Audit |
|---|---|---|---|---|
| `organization.created.v1` | organization | organization transaction committed | analytics, onboarding | yes |
| `membership.invited.v1` | membership | invitation issued | email notification | yes |
| `membership.suspended.v1` | membership | offboarding begins | session revocation, realtime disconnect, search | yes-critical |
| `ownership.transferred.v1` | membership | object transfer batch committed | notifications, audit summary | yes |
| `client_request.submitted.v1` | client_request | client request created | manager inbox, notification, analytics | yes |
| `client_request.transitioned.v1` | client_request | valid state transition | client/team notifications, search | yes |
| `message.created.v1` | conversation | message committed | realtime, mentions, search | product activity |
| `message.converted.v1` | message | linked work created | realtime, inbox, analytics | yes |
| `work_item.created.v1` | work_item | work created | search, activity, notification | product activity |
| `work_item.updated.v1` | work_item | fields/state changed | search, realtime, health | conditional |
| `work_item.blocked.v1` | work_item | blocker activated | health, inbox, notification | yes |
| `upload.completed.v1` | upload | object upload completed | verification/scan worker | security log |
| `usage.storage_reserved.v1` | storage_reservation | upload bytes reserved atomically | usage UI, cost telemetry | conditional |
| `usage.storage_committed.v1` | storage_reservation | provider object verified and reservation converted to used bytes | usage UI, reconciliation, threshold evaluator | conditional |
| `usage.storage_released.v1` | storage_reservation/file_version | reservation expired/aborted or retained object physically deleted | usage UI, reconciliation | conditional |
| `usage.threshold_reached.v1` | organization_usage | 70/85/95/100 threshold crossed with hysteresis | authorized owner/admin notification, billing UI | yes at 100% |
| `file.ready.v1` | file_asset | validation/scan passed | preview, requester notification | security metadata |
| `file.rejected.v1` | file_asset | validation/scan failed | owner notification, security detection | yes |
| `deliverable.version_created.v1` | deliverable | immutable version created | activity, internal reviewer | yes |
| `deliverable.published.v1` | deliverable | client projection/approval committed | notification, search, analytics | yes-critical |
| `approval.requested.v1` | approval | reviewers activated | client action queue, reminders | yes |
| `approval.viewed.v1` | approval | reviewer first opens governed version | analytics, optional manager signal | privacy-limited |
| `approval.decided.v1` | approval | reviewer decision committed | workflow, client/team notifications | yes-critical |
| `approval.invalidated.v1` | approval | content/version no longer matches | action queue, reminders, notification | yes-critical |
| `notification.requested.v1` | notification | domain event needs communication | bundler/preferences | no duplicate audit |
| `notification.acted.v1` | notification | inline action completed | analytics, unread sync | product activity |
| `audit.export_requested.v1` | export | admin requests audit export | export worker, security alert | yes-critical |
| `entitlement.changed.v1` | organization_entitlement | versioned plan/add-on/override becomes effective | authorization/usage caches, billing UI | yes-critical |
| `seat.assigned.v1` | seat_assignment | full internal membership begins consuming a seat | billing usage, notification | yes |
| `seat.released.v1` | seat_assignment | billable internal membership ends | billing usage | yes |
| `subscription.changed.v1` | subscription | provider/manual subscription state or plan version changes | entitlement projector, billing UI | yes-critical |

## 5. Payload minimums

- Client request transition: request ID, project ID, from/to, version, optional accepted work ID; client-safe reason reference—not internal notes.
- Message converted: source message ID, work item ID, project ID, resulting audience; no message body.
- Deliverable published: deliverable/version IDs, content hash, client organization ID, reviewer IDs, approval ID, policy fingerprint; no internal metadata.
- Approval decided: approval/reviewer/version IDs, content hash, decision, decided time; feedback object IDs rather than full text for general consumers.
- Membership suspended: membership/user IDs, suspension reason category, session-revocation cutoff; no HR detail.
- Storage usage: reservation/file version ID, byte delta, metric key, reason, usage-ledger entry, effective quota, and threshold band; never filename or content.
- Entitlement changed: immutable plan version, changed entitlement keys, effective time, source/add-on references, actor/provider event, and impact-preview reference.
- Seat assigned/released: membership and classification only; client memberships are never emitted as billable internal seat assignments.

## 6. Event ownership

Only the owning module publishes its event. Consumers cannot infer authorization from event receipt; before user-facing side effects they resolve current permissions. Delayed notifications must not reveal an object after access was revoked.

## 7. Machine-readable schemas

The `contracts/events/` directory contains the envelope and highest-risk MVP event schemas. Implementation expands the same pattern for the remaining catalog and registers examples in contract tests.
