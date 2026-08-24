# TManage — Conceptual Data Model and Permission Reference

## 1. Modeling rules

- Tenant root is Organization. Every tenant-owned row carries `organization_id`.
- IDs are UUIDv7; timestamps are UTC; display timezone is retained where intent matters.
- Common objects use typed extension tables instead of one unbounded JSON object.
- Visibility and authorization are explicit fields/relations, not inferred from UI location.
- Activity feed and security audit log are separate.
- Client-facing records are projections of approved fields and versions.

## 2. Core entities

### Identity and tenancy

`User`, `Identity`, `Session`, `Organization`, `Workspace`, `Membership`, `RoleAssignment`, `Team`, `TeamMembership`, `ClientOrganization`, `ClientMembership`, `Invitation`, `Policy`.

### Work graph

`Project`, `ProjectMembership`, `WorkItem`, `WorkItemType`, `WorkState`, `Assignment`, `Dependency`, `Relation`, `CustomFieldDefinition`, `CustomFieldValue`, `Tag`, `ChecklistItem`, `TimeEntry` (later), `Objective`, `KeyResult`.

### Collaboration and knowledge

`Conversation`, `Channel`, `ConversationMembership`, `Message`, `Thread`, `Reaction`, `Document`, `DocumentVersion`, `Comment`, `Mention`, `Decision`, `Meeting`, `MeetingParticipant`, `MeetingAction`.

### Delivery

`FileAsset`, `FileVersion`, `UploadSession`, `Deliverable`, `DeliverableVersion`, `Approval`, `ApprovalReviewer`, `ApprovalDecision`, `ClientRequest`, `StatusUpdate`.

### Platform

`Notification`, `NotificationBundle`, `Preference`, `Automation`, `AutomationRun`, `OutboxEvent`, `WebhookEndpoint`, `WebhookDelivery`, `AuditEvent`, `FeatureFlag`, `ApiCredential`, `Plan`, `PlanVersion`, `Subscription`, `Entitlement`, `SeatAssignment`, `UsageCounter`, `UsageLedgerEntry`, `StorageReservation`, `BillingEvent`.

Billing and capacity rules are in file 49. Membership role/classification determines whether a principal consumes an internal paid seat; client memberships never do. Workspace storage is a logical entitlement over shared object storage. Upload sessions reserve bytes atomically before presigning, and an append-only usage ledger reconciles physical object bytes.

## 3. Critical WorkItem fields

`id`, `organization_id`, `workspace_id`, `project_id`, `type_id`, `title`, `description_doc_id`, `state_id`, `priority`, `creator_id`, `owner_id`, `start_at`, `due_at`, `completed_at`, `estimate`, `audience`, `client_action_required`, `source_message_id`, `version`, `created_at`, `updated_at`, `deleted_at`.

Audience enum: `internal`, `client_visible`, `client_action_required`. A policy may narrow visibility further; it cannot widen access across tenants.

## 4. Approval invariants

- Approval references an immutable `subject_version_id` and content hash.
- Reviewer must have current access and correct client/internal relation.
- Outcomes: pending, approved, changes_requested, cancelled, expired, invalidated.
- Updating governed content creates a new version and invalidates or preserves prior decision as historical according to policy.
- Approval event includes actor, decision, timestamp, version hash, optional criteria responses, and comment.

## 5. Deliverable state machine

`draft → internal_review → ready_for_client → client_review → changes_requested → client_review → approved → final → archived`

Transitions are permissioned and audited. `final` requires an approved governed version unless project policy explicitly allows waiver by Project Admin with recorded rationale.

## 6. Client request state machine

`submitted → triage → needs_clarification → accepted | declined | deferred → planned → delivered`

Acceptance links or creates work items and records scope/estimate decision. Submission alone never commits team capacity or deadline.

## 7. Permission evaluation order

1. Validate authenticated principal and active session.
2. Resolve organization and active membership.
3. Deny cross-tenant mismatch.
4. Apply organization policy and suspended/offboarded state.
5. Evaluate action against role capabilities.
6. Evaluate object relation: workspace/team/project/direct share/client organization.
7. Apply object audience and sensitive-field projection.
8. Apply explicit deny/retention/legal constraints.
9. Record audit when action is security-relevant.

## 8. Simplified permission matrix

| Action | Org Admin | Manager/Project Admin | Member | Guest | Client Admin | Client Reviewer | Client Viewer |
|---|---:|---:|---:|---:|---:|---:|---:|
| Manage org security | Yes | No | No | No | No | No | No |
| Manage project workflow | Policy | Yes | No | No | No | No | No |
| View internal project content | Scope | Yes | Yes if member | Explicit only | No | No | No |
| Publish client-visible content | Policy | Yes | Optional | No | No | No | No |
| View client-visible project | Scope | Scope | Scope | Explicit | Yes for client org | Yes for assigned/shared | Yes for shared |
| Approve deliverable | Optional | Optional | If reviewer | If reviewer | Policy | Yes if reviewer | No |
| Request changes | Optional | Optional | If reviewer | If reviewer | Policy | Yes if reviewer | No |
| Create client request | No | No | No | No | Yes | Yes | Optional |
| Invite client users | Policy | Policy | No | No | Within client org/policy | No | No |

Every “Yes” remains tenant-, scope-, object-, and policy-dependent.

## 9. Index and constraint priorities

- Unique active membership per user/organization and user/client organization.
- Composite indexes begin with `organization_id` for tenant queries.
- Work indexes: organization/project/state/due, assignee/state/due, updated cursor.
- Message indexes: organization/conversation/sequence; unique client-generated id for retry dedupe.
- Audit indexes: organization/time, actor/time, object/time, action/time.
- Partial indexes for active/non-deleted objects.
- Foreign keys for relational integrity; check constraints for audience/action consistency.
- Unique active byte reservation/idempotency identity; non-negative used/reserved counters; reservation-expiry index; usage-ledger source-event uniqueness.
- Immutable plan versions and one effective subscription/entitlement set per organization and effective period.
- Client membership cannot be classified as a billable internal seat without an explicit role-conversion command and impact preview.

## 10. Data lifecycle

Active → archived → retention hold or purge queue → cryptographic/logical deletion workflow → backup expiry. User deletion separates identity erasure from business-record retention obligations. Tenant export includes documented schemas and signed file manifest. Purges are idempotent, auditable, and propagate to search/cache/object storage/AI indexes.
