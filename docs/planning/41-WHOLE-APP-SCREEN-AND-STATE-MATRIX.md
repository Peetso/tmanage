# TManage — Whole-App Screen and State Matrix

## 1. Purpose

This is the complete product-design inventory. It extends the detailed MVP behavior in file 22. Claude designs every family below; engineering still follows the phased PRD and roadmap.

Every completed screen must have desktop, responsive transformation, light/dark decision, English/Arabic behavior, realistic populated content, and relevant empty/loading/error/permission/conflict states.

## 2. Shared screen templates

| Template | Composition | Limeframe expression |
|---|---|---|
| Editorial overview | Hero title, Pulse Track, 1–3 meaningful figures, focused content zones | Largest type, asymmetric grid, lime focal region |
| Operational collection | Canvas header, view/filter capsules, open list/board/timeline, optional Lens | Compact geometry, ink selection, lime current marker |
| Object detail | Identity, Focus Capsule, working body, Work Story, Context Lens | One dominant action, clear audience/version/date |
| Split workspace | Collection/list leading, active detail center, optional context trailing | Selection stays visible; panels are rounded only when layered |
| Narrative sheet | Paper reading surface, live objects, edge comments, Lens | Editorial typography without sacrificing reading |
| Action portal | Plain context, governed artifact, Pulse Track, one decision | Larger controls, lime forward action, minimal navigation |
| Control plane | Category rail, structured editor, impact/validation panel | Ink hierarchy, circular steps, lime validated/current state |

## 3. Public, trust, identity, onboarding

| ID | Screen | Primary composition / special states |
|---|---|---|
| PUB-01 | Landing | Editorial promise, animated work story, internal/client split; no generic hero dashboard |
| PUB-02 | Product overview | Connected request-to-delivery narrative |
| PUB-03 | Client Portal product page | Portal progress/action story |
| PUB-04 | Pricing | Plan comparison, usage explanation, no dark patterns |
| PUB-05 | Security & trust | Architecture/trust summary, documents, status |
| PUB-06 | Accessibility | Commitments, supported interaction modes |
| PUB-07 | Status | Current/incidents/history |
| ID-01 | Sign in | Focused paper panel, SSO/passkey/email states |
| ID-02 | MFA/passkey | Challenge, fallback, rate limit, recovery |
| ID-03 | Invitation acceptance | Inviter, organization, role, exact access, expiry |
| ID-04 | Organization selector | Internal/client identity cards, search, recent |
| ID-05 | Recovery | Request, sent, expired, completed |
| ID-06 | Sessions/devices | Current session, revoke, suspicious event |
| ON-01 | Welcome / outcome choice | “What do you deliver?” visual selection |
| ON-02 | Create organization | Progressive setup, timezone/locale |
| ON-03 | Choose operating template | Visual workflow preview, not template card soup |
| ON-04 | Create first project | Client/internal, owner, dates, Pulse Track preview |
| ON-05 | Configure milestones | Editable track with accessible list alternative |
| ON-06 | Invite team | Role/access preview and duplicate/domain states |
| ON-07 | Create client organization | Sponsor, reviewers, authority, portal identity |
| ON-08 | Client preview/send | True portal projection before invitations |
| ON-09 | Import/migration | Source mapping, validation, progress, partial failure |
| ON-10 | Sample-data guided tour | Dismissible contextual tour, never blocks keyboard |

## 4. Personal focus and inbox

| ID | Screen | Primary composition / special states |
|---|---|---|
| HOME-01 | My Day | Editorial hero, schedule Pulse Track, Focus Capsule, actions/work cards |
| HOME-02 | Focus plan | Time blocks, ranking reasons, tune/dismiss, conflict |
| HOME-03 | Personal work | Assigned/created/following across projects |
| HOME-04 | Waiting | Delegated, approvals, client wait, stale follow-up |
| HOME-05 | Saved/pinned context | Messages, docs, work, files grouped by project |
| IN-01 | Important inbox | Bundled action rows, why important, inline action |
| IN-02 | All inbox | Filtered event stream with grouping |
| IN-03 | Waiting on me | Review/approval/reply/action queue |
| IN-04 | Client actions | External requests, approvals, uploads, questions |
| IN-05 | Bundle detail | Source → current object → required action |
| IN-06 | Notification history | Delivered/read/actioned and channel status |
| IN-07 | Digest preview | Daily/weekly content and delivery schedule |

## 5. Chat and collaboration

| ID | Screen | Primary composition / special states |
|---|---|---|
| CH-01 | Channel browser | Teams/projects/channels, discover/request access |
| CH-02 | Project channel | Quiet conversation, pinned context, audience seam |
| CH-03 | Public/private channel | Membership/access states |
| CH-04 | Direct/group message | Organization boundary, participant state |
| CH-05 | Thread | Source pinned, linked work/decision, unread position |
| CH-06 | Composer | Mentions, files, voice, schedule, audience context |
| CH-07 | Message actions | Save, convert, quote, pin, edit history |
| CH-08 | Convert message | Focused composer with source and inherited-access warning |
| CH-09 | Channel details | Members, canvas/brief, files, retention, settings |
| CH-10 | Search in conversation | Matches, filters, permission-safe snippets |
| CH-11 | Voice note | Record/review/transcript state |
| CH-12 | Huddle/call | Later: compact call overlay + dark summary panel inspired by reference |
| CH-13 | Call summary | Transcript reference, decisions, actions, files, Work Story |

## 6. Work, projects, portfolio, objectives

| ID | Screen | Primary composition / special states |
|---|---|---|
| WK-01 | Work hub | Saved views, recent projects, requests, templates |
| WK-02 | Work list | Open table, inline edit, selection, bulk action, Lens |
| WK-03 | Work board | State columns, accessible move, WIP/conflict |
| WK-04 | Timeline/Gantt | Milestones/dependencies, baseline/forecast, accessible list |
| WK-05 | Work calendar | Due/start/milestone/meeting overlays |
| WK-06 | Workload | Commitment/capacity lanes, availability, no scoring |
| WK-07 | Forms/request intake | Form builder and submission/confirmation |
| WK-08 | Saved view editor | Filters, grouping, columns, sharing |
| WK-09 | Work item detail | Object DNA, Focus Capsule, Work Story, Lens |
| WK-10 | Create/edit work | Quick capsule vs full editor |
| WK-11 | Subtasks/checklist | Nested work, progress meaning, reorder alternative |
| WK-12 | Dependencies | Graph/list, blocker impact, cycle warning |
| WK-13 | Recurrence | Pattern, exceptions, next instance preview |
| WK-14 | Bulk edit review | Scope, permission conflicts, undo/receipt |
| REQ-01 | Request inbox | New/clarifying/accepted/deferred/declined |
| REQ-02 | Request detail/triage | Desired date, impact, clarify/commit/defer |
| REQ-03 | Commitment review | Scope, owner, committed date, linked milestone |
| PRJ-01 | Project overview | Large identity, editorial figures, Project Pulse Track |
| PRJ-02 | Project plan | Milestones, dependencies, scope, baseline |
| PRJ-03 | Project activity / Work Story | Meaningful chapters rather than raw audit |
| PRJ-04 | Project team | Roles, workload/availability, client contacts |
| PRJ-05 | Project settings | Workflow, visibility, client projection, archive |
| POR-01 | Portfolio overview | Exception-first project rows + commitment/forecast fields |
| POR-02 | Portfolio timeline | Cross-project initiatives/milestones/dependencies |
| POR-03 | Portfolio capacity | Team constraints and unstaffed commitments |
| OBJ-01 | Objectives hub | Objective → outcome → project links |
| OBJ-02 | Objective detail | Direction, evidence, progress, confidence, updates |

## 7. Calendar and meetings

| ID | Screen | Primary composition / special states |
|---|---|---|
| CAL-01 | Calendar hub | Day/week/month/agenda, work + meetings + milestones |
| CAL-02 | Day schedule | Full Pulse Track interpretation of the reference |
| CAL-03 | Event detail | Participants, linked work/project, provider state |
| CAL-04 | Focus block | Protect/move/conflict/recommendation |
| MTG-01 | Meeting detail | Agenda, notes, participants, linked context |
| MTG-02 | Live meeting companion | Compact call/media + dark layered summary/action panel |
| MTG-03 | Meeting summary | Decisions, actions, files, transcript evidence |
| MTG-04 | Meeting template | Agenda sections, automation, recurring setup |

## 8. Docs, decisions, files, deliverables, approvals

| ID | Screen | Primary composition / special states |
|---|---|---|
| DOC-01 | Docs hub | Recent, project knowledge, templates, favorites |
| DOC-02 | Document editor | Paper sheet, live objects, comments, collaborators |
| DOC-03 | Document view/history | Compare/restore, published/client projection |
| DOC-04 | Template gallery/editor | Purpose-led previews, variables, permissions |
| DEC-01 | Decision register | Statement, status, owner, effective date, affected work |
| DEC-02 | Decision detail | Rationale, alternatives, evidence, Work Story |
| FIL-01 | Files hub | Recent/shared/project/deliverable, scan status |
| FIL-02 | Upload center | Queue, progress, scan, retry/cancel |
| FIL-03 | File preview | Metadata, relations, access, history |
| FIL-04 | Version compare | Side-by-side/overlay, annotation, accessible diff summary |
| DEL-01 | Deliverables | Governed versions, review status, due, reviewer |
| DEL-02 | Deliverable detail | Artifact hero, version track, review/approval history |
| DEL-03 | Internal review | Criteria, comments, separation-of-duty warning |
| DEL-04 | Publish safety check | Recipients, projection, sensitive links, consequence |
| DEL-05 | Client projection preview | Exact role preview, freshness, no locked ghosts |
| APP-01 | Approval queue | Team/client review actions |
| APP-02 | Approval review | Exact version, criteria, authority, approve/change |
| APP-03 | Request changes | Structured actionable feedback |
| APP-04 | Approval history | Immutable decisions, invalidation, version changes |

## 9. Client Portal

| ID | Screen | Primary composition / special states |
|---|---|---|
| CL-01 | Portal Overview | Expressive paper canvas, lime Pulse Track, status, My Actions |
| CL-02 | My Actions | Ordered premium action cards, time/consequence/estimate |
| CL-03 | Project detail | Milestones, forecast, updates, contacts |
| CL-04 | Timeline | Client-visible track + accessible list |
| CL-05 | Approval review | Governed artifact owns the page; simple decision |
| CL-06 | Request changes | Structured feedback and confirmation |
| CL-07 | Deliverables | Client-governed versions/final downloads only |
| CL-08 | Deliverable detail | Version, decision, files, history allowed by policy |
| CL-09 | New request | Desired date clearly uncommitted |
| CL-10 | Request detail | Client-safe state/reason/timing |
| CL-11 | Updates | Formal posts/decisions with freshness |
| CL-12 | Files | Explicit shares and safe download |
| CL-13 | People | Approved contacts only |
| CL-14 | Client members/access | Client Admin invite/revoke/role/expiry |
| CL-15 | Client organization portfolio | Multi-project overview for Client Admin |
| CL-16 | Portal notification preferences | Actions/updates/digest/quiet hours |

## 10. People, insights, search, AI

| ID | Screen | Primary composition / special states |
|---|---|---|
| PEO-01 | Directory | Search, teams, role, availability |
| PEO-02 | Profile | Current work, teams, availability, contact; no score |
| PEO-03 | Team detail | Members, active work, capacity, contacts |
| PEO-04 | Availability | Working hours, leave, focus constraints |
| INS-01 | Insights overview | Editorial report, three figures max, exception evidence |
| INS-02 | Project health | Commitment/forecast, blockers, staleness, client waits |
| INS-03 | Delivery flow | Cycle time/distribution/bottlenecks |
| INS-04 | Approval flow | Time by stage/reviewer group/project |
| INS-05 | Workload/capacity | Aggregate commitments, not productivity surveillance |
| INS-06 | Adoption/system quality | Workflow use, missing ownership, automation health |
| SR-01 | Command surface | Go to / Find / Create / Act groups |
| SR-02 | Universal search | Results with safe snippets, filters, evidence |
| SR-03 | Search answer | Synthesized answer, citations, scope, follow-up actions |
| SR-04 | Saved search | Alert/digest and sharing |
| AI-01 | AI workspace | Context-aware conversation, evidence panel, scope |
| AI-02 | Draft review | Compare AI draft/source, edit, approve/discard |
| AI-03 | Action confirmation | Exact changes, permissions, external consequence |
| AI-04 | AI settings/history | Providers/policies/retention/activity |

## 11. Automations, integrations, administration, billing

| ID | Screen | Primary composition / special states |
|---|---|---|
| AUT-01 | Automation gallery | Outcome-led templates, not colorful app cards |
| AUT-02 | Workflow builder | Node canvas + configuration/validation Lens |
| AUT-03 | Test/dry run | Sample input, effective actor, diff, warnings |
| AUT-04 | Run history | Runs, retries, errors, correlation |
| AUT-05 | Run detail | Step timeline, payload redaction, retry/cancel |
| INT-01 | App directory | Categories/search/security/permissions |
| INT-02 | Connection setup | OAuth/key, scopes, test, owner |
| INT-03 | Connection detail | Health, usage, sync, rotate/revoke |
| ADM-01 | Control Center home | Setup/security/automation exceptions |
| ADM-02 | Members and roles | Internal/client tabs, scope/status/access |
| ADM-03 | Role editor | Capability matrix, preview, affected users |
| ADM-04 | Client organizations | Projects/users/actions/access policy |
| ADM-05 | Invitation policy | Domains/default role/expiry/authority |
| ADM-06 | Templates/workflows | Project/work item/document templates |
| ADM-07 | Fields/types/statuses | Schema editor, migration/impact preview |
| ADM-08 | Security | MFA/SSO/session/API/retention summary |
| ADM-09 | Audit log | Open dense list, filters, event detail/export |
| ADM-10 | Data import/export | Scope, validation, progress, receipt |
| ADM-11 | Retention/deletion | Policies, legal hold later, impact |
| ADM-12 | Offboarding impact | Ownership, sessions, shares, approvals, transfer |
| ADM-13 | Offboarding execution | Step progress, retry, immutable receipt |
| ADM-14 | Organization settings | Name/locale/timezone/branding |
| BIL-01 | Plan and usage | Seats/storage/automation/limits |
| BIL-02 | Invoices/payment | Billing identity, method, invoice history |
| BIL-03 | Change plan | Proration/impact/confirmation, no dark patterns |

## 12. Preferences and system states

| ID | Screen | Primary composition / special states |
|---|---|---|
| PREF-01 | Profile/account | Identity, locale, timezone |
| PREF-02 | Appearance | Light/dark/system, density, contrast, preview |
| PREF-03 | Notifications | Channel/event/digest/quiet hours |
| PREF-04 | Accessibility | Motion, contrast, shortcuts, assistive preferences |
| PREF-05 | Keyboard/commands | Searchable map and customization later |
| SYS-01 | Offline/reconnecting | Persistent recovery strip and queued work |
| SYS-02 | Sync conflict | Side-by-side resolution, preserve both versions |
| SYS-03 | Access changed | Explain loss/change without hidden data leak |
| SYS-04 | Partial outage | Affected function, fallback, status link |
| SYS-05 | Maintenance/update | Time, consequence, desktop updater later |
| SYS-06 | Global 404/empty/error | Contextual recovery, not marketing illustration only |

## 13. Minimum high-fidelity set before scale-out

The 12 stress screens in file 39 plus mobile Home/Inbox/Chat/Approval, Arabic Project Overview and Client Approval, dark Work List and Meeting Companion, and system conflict/permission states. These prove the system before Claude extrapolates templates to the remaining matrix.

## 14. Screen status ledger

For every ID track: `mapped`, `wireframed`, `visual_system_applied`, `states_complete`, `responsive_complete`, `rtl_complete`, `a11y_reviewed`, `prototype_linked`, `dev_ready`. “Complete” is not an allowed vague status.
