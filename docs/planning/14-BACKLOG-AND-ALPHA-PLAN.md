# TManage — Prioritized Backlog and Private Alpha Plan

## 1. Priority method

P0 is required for a safe request-to-approval loop. P1 improves usability and operational readiness. P2 waits for evidence. Sequence by risk: tenant isolation and external publishing before breadth.

## 2. Delivery backlog

### Sprint 0–1: platform and trust (P0)

- Monorepo, CI, environments, observability baseline.
- Identity/session/MFA foundation.
- Organization/workspace/membership and MySQL tenant-isolation foundation.
- Policy engine skeleton, audit event, idempotency, outbox.
- Design tokens, app shell, Storybook, accessibility harness.

### Sprint 2–3: project and work (P0)

- Project and project membership.
- Work item lifecycle, owner/date/status/audience/activity.
- List view and task detail.
- Tenant/role/object authorization test matrix.

### Sprint 4–5: conversation to work (P0)

- Project channel, messages, threads, mentions.
- Message-to-task with source relation and dedupe.
- Inbox records and basic realtime/reconnect.

### Sprint 6–7: client request and portal (P0)

- Client organization/members/invitations.
- Client Portal shell and Overview/My Actions.
- Client request submission/triage/acceptance.
- View-as-client using real policy.

### Sprint 8–9: files and deliverables (P0)

- Multipart upload, validation, quarantine, scan, preview.
- Deliverable/version state machine and internal review.
- Client-safe projection and publication checks.

### Sprint 10–11: approval and final delivery (P0)

- Reviewer assignment/authority/deadline/reminders.
- Approve/change request; version hash; invalidation.
- Approval history and final release.
- Golden-path E2E and reliability tests.

### Sprint 12: alpha hardening (P0/P1)

- My Day, bundling/quiet hours, keyword search.
- Offboarding and ownership transfer.
- Arabic RTL critical surfaces.
- Restore drill, penetration test fixes, accessibility review.

### Post-alpha candidates (P1/P2)

Timeline, dependencies UI, decision register, project pulse, templates, richer docs, automation, SSO/SCIM, billing, AI summaries, desktop.

## 3. Private alpha design

Recruit 3–5 service businesses representing agency/software/consulting workflows. Each nominates owner, manager, 2–5 team members, one client sponsor, and one reviewer. Use a real but non-regulated project; exclude highly sensitive data initially.

### Onboarding

Security/data agreement; current workflow baseline; configure one template; import only active project essentials; 45-minute team session; 15-minute client guide; named support contact.

### Weekly operation

Observe opt-in sessions; review funnel and errors; collect short role pulse; maintain incident and friction log; do not add bespoke features during week—classify requests against target problem.

### Metrics

Request acknowledgement/triage time, message-to-task conversion, work with owner/date, approval open/decision time, reminders required, client portal return, status requests outside TManage, permission errors, support time, retention.

### Exit/stop rules

Proceed if ≥3 partners complete repeated loops, clients act without heavy training, no unresolved boundary risk, and at least 2 partners commit to paid beta. Pause if cross-boundary defect occurs, support load makes workflow nonviable, or target users consistently prefer existing tool combination for the core loop.

## 4. No-interview continuous validation

Desk research remains a discovery input. During alpha, actual usage and opt-in feedback replace assumptions. Publish monthly evidence memo: observed, measured, inferred, decision, confidence, next test.

## 5. Immediate execution checklist

1. Approve MVP PRD and non-goals.
2. Produce Figma prototype from screen specification.
3. Run moderated/unmoderated remote tests if available; otherwise heuristic and cognitive walkthrough plus public-role evidence.
4. Freeze vertical-slice API/schema and threat model.
5. Initialize repository and implement Sprint 0–1.
