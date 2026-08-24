# TManage — Requirements Traceability Matrix

## 1. Contract

Every implementation item must reference at least one requirement ID below. A requirement is not release-ready until its screen, API, persistence, authorization, events, audit, analytics, and tests are complete where applicable.

## 2. Functional traceability

| ID | Requirement | Primary screens | API operations | Data | Events | Authorization | Tests |
|---|---|---|---|---|---|---|---|
| FR-01 | Client request intake and triage | CL-06, TM-12 | create request; get request; transition request | client_requests, files, work_items | request.submitted, request.transitioned | client member submits; project manager triages | E2E-01, AUTH-06, INT-11 |
| FR-02 | Message to work with source context | TM-06, TM-09 | create message; convert message | messages, work_items, relations, idempotency_records | message.created, message.converted, work.created | project member; internal audience default | E2E-02, AUTH-04, INT-07 |
| FR-03 | Work execution, blockers, dependencies | TM-10, TM-11, TM-13 | create/update/transition work; manage dependency/blocker | work_items, dependencies, blockers, activity_events | work.updated, work.blocked, blocker.resolved | project-scoped capability and field rules | E2E-03, UNIT-08, AUTH-05 |
| FR-04 | Versioned deliverable review and publish | TM-16–TM-19 | create deliverable/version; internal review; preview; publish | files, file_versions, deliverables, deliverable_versions, client_projections | file.ready, deliverable.version_created, deliverable.published | internal reviewer/publisher; allowlisted projection | E2E-04, SEC-07, INT-15 |
| FR-05 | Client approval/change request | CL-03, CL-04, TM-20 | open approval; decide; invalidate | approvals, reviewers, decisions, deliverable_versions | approval.requested, decided, invalidated | assigned current reviewer only | E2E-05, AUTH-08, CONC-02 |
| FR-06 | Progress and published pulse | TM-03, TM-14, CL-01, CL-08 | get project health; draft/publish update | milestones, status_updates, client_projections | update.drafted, update.published | internal draft; publisher external | E2E-06, AUTH-09, UNIT-12 |
| FR-07 | Bundled notifications and preferences | TM-04, TM-05, TM-27 | inbox; act; preferences | notifications, bundles, preferences | notification.requested, bundled, delivered, acted | recipient only; action reauthorized | E2E-07, INT-18, REL-03 |
| FR-08 | Safe offboarding and ownership transfer | AD-05, AD-06 | impact preview; suspend; transfer; finalize | memberships, sessions, role_assignments, ownership transfers, audit | member.suspended, ownership.transferred, offboarding.completed | owner/admin; reauthentication | E2E-08, AUTH-12, SEC-11 |
| FR-09 | Organization/workspace/project onboarding | ID-01–ID-05, ON-01–ON-06 | org/workspace/project/invitation CRUD | organizations, workspaces, projects, memberships, invitations | org.created, invitation.created/accepted | verified principal and inviter policy | E2E-09, AUTH-01, INT-01 |
| FR-10 | Permission-aware search | TM-25, TM-26 | search with cursor/filters | search_documents, permission principals | search.queried (safe metadata) | authorization before result/snippet | E2E-10, SEC-04, PERF-03 |
| FR-11 | Audit viewer/export | AD-07 | list/filter/export audit | audit_events, export_jobs | audit.export_requested/completed | authorized scope; export reauth | E2E-11, SEC-10, INT-20 |
| FR-12 | File upload, scan, preview, download | TM-15, TM-17, CL-07 | upload session, parts, complete, status, download | file_assets, file_versions, upload_sessions | upload.completed, file.ready/rejected | object scope; short-lived URL | E2E-12, SEC-06, REL-05 |
| FR-13 | Workspace subscription, seat classification, plan/usage visibility, and safe plan change | PUB-04, BIL-01–BIL-03, ADM-02 | plans; subscription/usage; plan/seat change preview and commit; billing portal/webhook | plans, plan_versions, subscriptions, subscription_items, entitlements, seat_assignments, usage counters/ledger, billing events | entitlement.changed, seat.assigned/released, subscription.changed, usage.threshold_reached | owner/admin; reauth for consequential change; client roles never billed seats | BILL-01–BILL-06, AUTH-16 |
| FR-14 | Atomic pooled workspace storage quota | FIL-01–FIL-04, BIL-01 | reserve upload bytes; complete/abort; usage; cleanup | storage_reservations, usage_counters, usage_ledger_entries, file_versions | storage.reserved/committed/released, usage.threshold_reached | tenant/object policy before reservation/presign; service workspace owns client-upload usage | QUOTA-01–QUOTA-08, SEC-06, CONC-06 |

## 3. Non-functional traceability

| ID | Requirement | Design/implementation evidence | Verification |
|---|---|---|---|
| NFR-01 | WCAG 2.2 AA core journeys | semantic components, focus, keyboard, contrast, announcements | A11Y-01–A11Y-10 manual + automated |
| NFR-02 | English LTR and Arabic RTL | locale routing, logical CSS properties, translated copy, mirrored navigation | I18N-01–I18N-08 |
| NFR-03 | Multi-tenant default deny | trusted tenant context, app policies, scoped repositories, composite tenant constraints, scoped cache/search/storage | AUTH-01–AUTH-15, SEC-01–SEC-05 |
| NFR-04 | Common read API p95 <300 ms | indexes, query budgets, traces | PERF-01–PERF-04 |
| NFR-05 | Portal LCP <2.5 s at target profile | server-rendered shell, route budgets, CDN | PERF-05 |
| NFR-06 | Typical realtime <1 s and gap recovery | sequence cursor, reconnect/refetch | REL-01–REL-04 |
| NFR-07 | RPO ≤15 min, RTO ≤4 h at GA | PITR, cross-failure-domain backups, runbook | DR-01–DR-04 |
| NFR-08 | Security baseline OWASP ASVS 5.0 L2 | secure SDLC, controls, threat models | security gate and pen test |
| NFR-09 | Privacy rights/export/deletion | data inventory, lifecycle, export/purge workflow | PRIV-01–PRIV-07 |
| NFR-10 | Complete mutation auditability | actor/effective actor, tenant, correlation, result | INT-21, SEC-10 |
| NFR-11 | Idempotent unsafe retries | idempotency record and replay result | CONC-01–CONC-05 |
| NFR-12 | Availability target 99.9% after GA | SLOs, health checks, multi-AZ, rollback | REL-06–REL-10 |
| NFR-13 | Predictable entitlement enforcement and cost attribution | versioned plan entitlements, append-only usage ledger, atomic reservations, provider reconciliation, no destructive overage | BILL-01–BILL-06, QUOTA-01–QUOTA-08, CONC-06 |

## 4. Role-to-journey coverage

| Role | Required journeys | Critical success |
|---|---|---|
| Owner | onboarding, portfolio pulse, admin security, export | understands risk without employee scoring |
| Org/Workspace Admin | invite, permissions, client policy, offboarding, audit | revokes access and transfers ownership completely |
| Manager | triage, plan, blocker, publish, approval | keeps internal/external states separated |
| Member | My Day, chat-to-task, execution, internal review | complete context with minimal administration |
| Client Admin | overview, members, requests, progress | understands status and manages authorized reviewers |
| Client Reviewer | action queue, exact version, decision | decision recorded with authority and version |
| Client Viewer | overview, updates, approved files | read-only, no accidental action authority |

## 5. Change rule

New requirements receive the next stable ID and must update this matrix, PRD, relevant screen specification, OpenAPI/event contracts, permission matrix, and test catalog in the same change.
