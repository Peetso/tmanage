# TManage — User Stories and Acceptance Criteria

## Epic A — Organization and access

### US-A01 Create organization

As an owner, I want to create an organization and first workspace so my team has a governed home.

Acceptance: verified identity required; unique slug handled without leaking other tenants; owner membership and audit event created transactionally; recovery if onboarding is interrupted; timezone/language captured.

### US-A02 Invite client organization

As a manager, I want to invite a client company with explicit roles so clients see only their work.

Acceptance: inviter requires policy permission; client organization is scoped to tenant/project; invitations expire and are single-use; preview shows exact access; every acceptance is audited; duplicate invitation is idempotent.

### US-A03 Offboard member

As an admin, I want to revoke and transfer access safely.

Acceptance: sessions and credentials revoked immediately; socket disconnected; owned items listed and transferred; outstanding approvals/shares reviewed; completion receipt and audit created.

## Epic B — Requests and work

### US-B01 Submit client request

As a client member, I want to submit a request with files and desired date.

Acceptance: visible acknowledgement that date is requested, not committed; valid files scanned; client can track status; only authorized project team can view internally; notification bundled.

### US-B02 Triage request

As a manager, I want to clarify, accept, defer, or decline a request.

Acceptance: transition rules enforced; client-safe reason required for decline/defer; acceptance records committed scope/date and linked work; actor/time/history immutable.

### US-B03 Convert message to task

As a team member, I want a message to become a task without copying context.

Acceptance: source link preserved; title/project/audience confirmed; permission checked; retry cannot create duplicates; inaccessible source is represented without leaking content.

### US-B04 Manage blocker

As an assignee, I want to mark a blocker and required owner.

Acceptance: blocker has reason, since date, owner/ask; dependency risk updates; relevant users notified once/bundled; resolution records outcome.

## Epic C — Delivery and approval

### US-C01 Upload deliverable version

As a member, I want to submit a version for internal review.

Acceptance: multipart retry; MIME/size/checksum/scan; quarantined until safe; version never overwrites prior; audience internal by default.

### US-C02 Publish to client

As an authorized manager, I want to publish the reviewed version safely.

Acceptance: readiness and permission checked; linked internal content detected; client-role preview uses real policy; reviewers/deadline selected; publication creates immutable projection and audit event.

### US-C03 Decide approval

As a client reviewer, I want to approve or request changes on the exact version.

Acceptance: reviewer authority current; version and criteria visible; approve records actor/time/hash; changes require feedback; duplicate submission idempotent; altered content invalidates pending decision.

### US-C04 Finalize delivery

As a manager, I want to release the approved final artifact.

Acceptance: approved governed version required or waiver permission+rationale; client receives final status/download; history preserved; file access scoped and short-lived.

## Epic D — Awareness

### US-D01 My Day

As a member, I want a calm ordered list of meaningful work.

Acceptance: ranking explains deadline/priority/blocker/dependency; dismissed recommendations learn only user preference; no hidden performance score; keyboard and mobile usable.

### US-D02 Actionable Inbox

As a user, I want related events grouped and actionable.

Acceptance: bundles never hide a required approval; inline actions authorize at execution time; quiet hours/digests honored; unread state consistent across devices.

### US-D03 Project pulse

As a manager, I want a draft update from current evidence.

Acceptance: sources linked; stale/missing data flagged; internal and client versions separate; manager edits and explicitly publishes; AI cannot invent or publish dates.

## Epic E — Search and trust

### US-E01 Permission-aware search

As a user, I want relevant answers without seeing hidden content.

Acceptance: tenant filter mandatory; authorization before result/snippet/AI summary; deleted/retention states respected; queries audited only at safe metadata level.

### US-E02 View audit event

As an authorized admin, I want to understand sensitive changes.

Acceptance: filter by actor/action/object/time; immutable event; export is itself audited; client admins see only allowed client-side events.

## Global acceptance rules

All mutations include idempotency strategy, authorization, audit classification, error/retry state, analytics event, accessibility, localization/RTL, responsive behavior, performance expectation, and automated test coverage appropriate to risk.
