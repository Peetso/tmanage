# TManage — MVP Product Requirements Document

## 1. Objective

Enable a service team and its client to complete one trustworthy delivery loop in one system:

`Client request → triage → commitment → team execution → internal review → client review → approval → final delivery`.

## 2. Target outcome

For design-partner projects, reduce missed requests, manual status chasing, and approval ambiguity while keeping internal discussion private.

## 3. MVP actors

Organization Owner, Admin, Project Manager, Member, Client Admin, Client Reviewer, Client Viewer. Moderator and generic Guest remain supported at policy level but are not primary onboarding personas.

## 4. In-scope capabilities

### Foundation

Authentication, organization, workspace, team, project, invitations, membership lifecycle, roles, audit, preferences, English/Arabic shell.

### Collaboration

Project channels, DMs, threads, mentions, attachments, reactions, message-to-task/request/decision, edit history.

### Work

Client Request, Task, Milestone, Approval; list and board; owner, collaborators, status, priority, start/due, dependencies, checklist, comments, files, audience, activity.

### Delivery

Deliverables, versions, internal review, client publication preview, approval or change request, audit record, reminders, final delivery.

### Client Portal

Overview, My Actions, Deliverables, Timeline, Updates, Files, People. Magic/deep-link review under tenant policy. Client Admin manages client-side members within allowed scope.

### Focus and awareness

Home/My Day, actionable Inbox, bundled notifications, quiet hours, keyword search, project pulse draft without autonomous publish.

### Administration

Role and invitation policy, ownership transfer, offboarding, client access expiry, audit viewer, export basics, project templates.

## 5. Explicitly out of MVP

Video meetings, full collaborative CRDT docs, advanced workload forecasting, time billing, CRM, payroll, marketplace, native mobile/desktop, full offline, advanced AI agents, enterprise legal hold, arbitrary custom workflow builder, public API marketplace.

## 6. Functional requirements

### FR-01 Client request intake

Client submits title, description, urgency reason, desired date, attachments, and category. Request enters `submitted`; no team deadline is promised. Manager can clarify, accept, defer, or decline with client-visible reason. Acceptance creates linked committed work and records agreed date/scope.

### FR-02 Message to work

Authorized user converts a message into a task/request/decision. Source link is immutable; title/project/owner/date/audience are confirmed. External sharing never inherits internal visibility automatically.

### FR-03 Work execution

Member updates status, checklist, comments, files, and blockers. Required fields appear at transition time. Dependencies prevent “on track” claim when a critical predecessor is late unless manager records override rationale.

### FR-04 Deliverable review

Team creates deliverable version; internal reviewer approves readiness; publisher previews client projection; selected client reviewers receive actionable notification and deadline.

### FR-05 Client decision

Reviewer sees governed version, criteria, context, and prior feedback. Approve creates immutable decision. Request changes requires feedback. Changed governed content creates new version and invalidates pending approval.

### FR-06 Progress communication

Client sees milestone state, latest published update, forecast, shared risks, and actions. Team sees internal details. Pulse draft derives evidence but manager controls publication.

### FR-07 Notification safety

Events are bundled by object/project; due/approval reminders follow policy; quiet hours and digest are honored except explicitly classified critical security events.

### FR-08 Offboarding

Admin suspends membership, revokes sessions/API tokens, removes realtime access, transfers owned work/channels/docs, reviews external shares, and records completion.

## 7. Success criteria

- ≥80% of invited client reviewers complete an action without training.
- ≥95% of usability participants correctly identify client visibility.
- Zero cross-tenant/client-boundary failures in automated isolation suite.
- ≥70% of alpha requests reach a recorded accepted/declined outcome.
- Median approval request-to-decision improves against partner baseline.
- Managers report fewer manual status follow-ups in opt-in pulse survey.

## 8. Analytics events

`org_created`, `project_created`, `client_org_invited`, `request_submitted`, `request_triaged`, `message_converted`, `work_started`, `blocker_added`, `deliverable_version_created`, `client_preview_opened`, `deliverable_published`, `approval_opened`, `approval_decided`, `pulse_published`, `search_succeeded`, `notification_acted`, `member_offboarded`.

Analytics never captures message/document body by default.

## 9. Release acceptance

Every main flow has loading, empty, permission, offline/retry, conflict, audit, notification, accessibility, Arabic RTL, and responsive behavior. Security, restore, and client-view suites pass before real client data.
