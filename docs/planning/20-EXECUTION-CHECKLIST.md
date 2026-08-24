# TManage — End-to-End Execution Checklist

## Planning completeness (completed)

- [x] Role-based online research and evidence limits documented.
- [x] MVP PRD, non-goals, journeys, user stories, and acceptance criteria complete.
- [x] Requirements traceability and detailed screen specification complete.
- [x] ERD/state machines and machine-readable DBML complete.
- [x] OpenAPI starter contract and critical event JSON Schemas complete.
- [x] Detailed authorization/MySQL tenant-isolation, threat models, and data flows complete.
- [x] Test catalog, sprint tickets, dependencies, environments, runbooks, and cost model complete.
- [x] Brand/content direction, preliminary name/domain risk, legal requirements, analytics, and notification copy complete.
- [x] AI Designer and AI Coder first prompts and source-order handbook complete.

## Design readiness

- [ ] Traceability map covers every MVP requirement and story.
- [ ] Sitemap and all six golden flows complete.
- [ ] Design tokens and component contracts complete.
- [ ] Desktop, mobile, English, and Arabic RTL critical screens complete.
- [ ] Loading/empty/error/permission/conflict/offline states complete.
- [ ] Client-view and approval version behavior unmistakable.
- [ ] WCAG 2.2 AA audit and developer handoff complete.

## Engineering foundations

- [ ] Monorepo and documentation structure created.
- [ ] CI, environments, feature flags, observability established.
- [ ] MySQL migrations, strict mode/`utf8mb4`, tenant scope, composite tenant constraints, least-privilege users, and isolation tests established.
- [ ] Authentication, session revocation, authorization policy, audit, idempotency, outbox complete.
- [ ] OpenAPI and event catalog versioned.
- [ ] File storage uses a private provider-neutral S3 adapter, atomic per-workspace byte reservations, usage ledger/reconciliation, and quota isolation tests from file 49.
- [ ] Versioned entitlement model distinguishes paid internal seats from included client principals and treats active projects/storage as plan allowances.

## Vertical slice

- [ ] Organization/workspace/project/members.
- [ ] Client organization and safe invitation.
- [ ] Client request and manager triage.
- [ ] Chat message and message-to-task.
- [ ] Work lifecycle and blocker.
- [ ] File quarantine/scan/version.
- [ ] Deliverable internal review and client publication preview.
- [ ] Approval/change request bound to version/hash.
- [ ] Final delivery and client-safe history.
- [ ] Home, Inbox, notifications, search minimum.
- [ ] Offboarding and ownership transfer.

## Verification

- [ ] Unit/integration/contract/E2E tests pass.
- [ ] Full role × tenant × object isolation matrix passes.
- [ ] Realtime reconnect and idempotent retries pass.
- [ ] Accessibility and visual regression pass.
- [ ] Performance budgets pass.
- [ ] Dependency, secret, SAST, upload, and authorization security checks pass.
- [ ] Backup restore and rollback rehearsed.
- [ ] Two-tenant seeded demo verified.
- [ ] BILL-01–06, AUTH-16, QUOTA-01–08, and CONC-06 pass before paid beta; exact prices/provider decision recorded separately.

## Alpha readiness

- [ ] Threat models and privacy assessment current.
- [ ] Data agreement, support flow, incident process ready.
- [ ] Admin/team/client quick guides ready.
- [ ] Known issues and stop rules approved.
- [ ] 3–5 alpha partners selected.
- [ ] Baseline and outcome metrics configured.

## Handoff format after every AI work session

1. Outcome completed.
2. Files changed.
3. Requirements/acceptance criteria satisfied.
4. Commands/checks actually run and results.
5. Security/permission impact.
6. Decisions and ADRs.
7. Known gaps/risks.
8. Exact next task from backlog.
