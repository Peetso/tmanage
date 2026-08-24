# TManage — Screen Inventory, Flows, and Prototype Specification

> **Scope note (14 August 2026):** This file remains the MVP prototype and golden-flow contract. It does not limit whole-product design. File 41 is the complete screen/state inventory; files 39–40 and 47 control the Limeframe visual direction.

## 1. Prototype goal

Produce a high-fidelity clickable prototype proving comprehension and end-to-end flow before production implementation. Prototype at desktop 1440px and mobile 390px; include English LTR and representative Arabic RTL screens.

## 2. Screen inventory

### Public and identity

Landing, sign in, passkey/MFA, invitation acceptance, select organization, account recovery, session management.

### Onboarding

Create organization, choose company type, create workspace, select service-team template, create first project, invite team, create/invite client organization, configure client point of contact and approval authority, sample-data tour.

### Home and Inbox

My Day, Focus item, due/blocked/waiting sections, project health cards, Inbox Important/All/Waiting/Client Actions, bundle detail, notification preferences.

### Chat

Channel list, project channel, DM, thread drawer, compose/upload/mention, message actions, convert-to-work modal, channel details and members.

### Work

Project overview, list, board, timeline, task detail, milestone detail, client request triage, saved filters, dependencies, activity.

### Delivery

Deliverables list, deliverable detail, version upload/preview, internal review, publish-to-client safety check, client projection preview, approval history, change-request resolution, final delivery.

### Client Portal

Overview, My Actions, approval review, request changes, request submission, deliverables, timeline, updates, files, people, client member management.

### Docs / decisions / updates

Project brief, decision detail/register, update editor, client-safe pulse preview.

### Search and command

Command palette, universal results, filters, no-access state, search details.

### Administration

Members/roles, client organizations, invitation policy, access expiry, offboarding wizard, project templates, audit log, export, security settings.

## 3. Golden flow A — First project

Sign up → organization → service team template → project → scope/milestones → invite 3 team members → create client organization → set client sponsor/reviewers → portal preview → send invitations → land on project overview.

## 4. Golden flow B — Request to commitment

Client My Actions → New Request → submit → Manager Inbox → clarify → client response → accept with agreed scope/date → create task/milestone link → client sees “Accepted and planned,” not internal task detail.

## 5. Golden flow C — Chat to task

Project channel → message → Create task → prefilled fields → confirm audience internal → assign → linked badge → task detail retains source thread → assignee receives bundled notification.

## 6. Golden flow D — Delivery approval

Task complete → deliverable version → internal reviewer → ready → publisher opens safety check → preview as Client Reviewer → publish → reviewer deep link → preview/compare → Approve or Request changes → immutable history → new version if changed → final delivery.

## 7. Golden flow E — Client progress

Client opens portal → sees next milestone and forecast → sees 2 required actions → completes upload and approval → reads latest update → downloads approved final. Target: first action visible without navigation.

## 8. Golden flow F — Offboarding

Admin selects member → impact summary → choose transfer owner → revoke sessions/shares/API → transfer work → confirm → audit receipt. Client offboarding additionally lists active approvals and shared files.

## 9. Required prototype states

- First-use empty, populated, loading, permission denied without information leak, network retry, optimistic conflict, overdue, blocked, archived, suspended user, expired invitation, invalidated approval, changed file scan failure.
- Internal/client-visible/client-action-required badges in every relevant surface.
- “View as client” must be visually and behaviorally distinct.

## 10. Prototype test script

Participants use scenario cards without feature explanation. Measure success, time, wrong turns, audience interpretation, confidence, and expectation. Critical pass conditions: reviewer acts on correct version; team user does not accidentally publish internal content; manager understands client-delay schedule impact; admin completes offboarding safely.

## 11. Design deliverables

User-flow map, sitemap, low-fidelity wireframes, content model, high-fidelity component library, desktop/mobile/RTL screens, clickable prototype, usability findings, change log, and signed UX acceptance checklist.
