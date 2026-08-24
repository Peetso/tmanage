# TManage — Product & System Master Plan

> **Design authority update (14 August 2026):** The complete product direction is Limeframe — a neo-editorial black/paper/acid-lime system derived from the owner-supplied primary reference. Files 37–47 supersede older conservative visual guidance. Product behavior, security, and architecture in this master plan remain unchanged.

## 1. Executive decision

Build TManage as a **Work Operating System for service teams and knowledge-work organizations**. The first beachhead is agencies, software studios, consultancies, and professional-services teams of roughly 10–250 people that manage internal delivery and client approvals across disconnected chat, task, file, document, and meeting tools.

The wedge is not “all tools at once.” It is a complete delivery loop:

**Request → discussion → committed work → execution → review → client approval → delivery → evidence.**

The differentiator is a shared work graph, explicit visibility controls, and a purpose-built Client Portal. Every object can be traced to its source, owner, deadline, dependencies, decisions, files, discussion, and external visibility.

## 2. Vision, promise, and principles

**Vision:** One place where teams and clients talk, plan, execute, document, approve, and understand work.

**Product promise:** Nobody should have to reconstruct the story of work from five applications.

**Principles**

- Context is a product primitive, not an attachment.
- Work must have an owner, state, next action, and visibility boundary.
- Communication becomes durable when it produces a decision or commitment.
- The system should reduce reporting work, not create another reporting layer.
- External collaboration must be safe by default and simple for clients.
- AI may propose, summarize, retrieve, and automate; humans retain authority for consequential actions.
- Progressive disclosure beats a sidebar containing every feature.
- Start opinionated, then become configurable.

## 3. Research synthesis: needs and pain points

### Evidence-backed needs

- **Recover focus:** Microsoft’s 2023 Work Trend Index surveyed 31,000 people across 31 countries; 64% reported insufficient time and energy, 68% insufficient uninterrupted focus, and 62% excessive time spent searching for information.
- **Turn communication into action:** The same research reported an average split of 57% of Microsoft 365 time in communication versus 43% in creation.
- **Reduce “work about work”:** Asana’s Anatomy of Work research consistently frames coordination, searching, duplicated updates, and unnecessary meetings as major drains on knowledge work.
- **Preserve cross-tool context:** Slack’s own current work-operating-system argument describes fragmented conversations, apps, email, and dashboards forcing workers to stitch context together.
- **Make external access safe:** Existing products often model clients as generic guests. That limits visibility but does not give clients an intentional progress, approval, and deliverables experience.

### Core pain-point map

| Pain | Root cause | TManage response | Success signal |
|---|---|---|---|
| Tasks disappear in chat | Messages and tasks are separate objects | Convert message to linked work item; keep source and thread | Lower missed-commitment rate |
| Status reporting is manual | Execution data and communication differ | Auto-generated project pulse and client-safe update | Fewer status meetings |
| Nobody knows the latest decision | Decisions live in calls/threads | Decision object with owner, date, rationale, affected work | Faster onboarding and fewer reversals |
| Search returns documents, not answers | No connected work graph | Permission-aware universal search across objects and relationships | Shorter time-to-answer |
| Notifications become noise | Event-by-event notification model | Grouped actionable inbox with priority, snooze, digest | Higher action rate, fewer interruptions |
| Client approvals delay delivery | Feedback spread across email and chat | Client Portal queue with deadlines, versions, approve/change request | Shorter approval cycle time |
| Clients see too much or too little | Generic guest permissions | Object-level audience and client-organization roles | Zero cross-boundary leaks |
| Managers chase updates | Status is not derived from work | Health score, blockers, dependencies, stale-work detection | Reduced update chasing |
| Tool configuration becomes a job | Excess flexibility before conventions | Opinionated templates and gradual customization | Faster time-to-first-value |

## 4. Target market and positioning

### Beachhead ICP

- 10–250-person agencies, studios, consultancies, software companies, and professional-services firms.
- 3+ active client engagements or cross-functional projects.
- Currently uses at least three of chat, task management, docs, file storage, calendar, or reporting tools.
- Pain is visible in missed approvals, repeated status meetings, deadline slippage, or client confusion.
- Willing to centralize new projects before migrating historical data.

### Later segments

- Internal product and operations teams.
- Distributed SMBs needing one operating layer.
- Enterprise departments requiring SSO, SCIM, data residency, DLP, and audit exports.

### Positioning

**For delivery teams that manage both internal work and client outcomes, TManage is the work operating system that keeps conversation, execution, knowledge, and approval in one connected context—unlike separate chat and project tools or generic all-in-one suites.**

## 5. Personas and Jobs-to-be-Done

### Organization Owner / Executive

Needs portfolio health, capacity, risk, governance, billing control, and evidence without surveillance. Hires TManage to know where intervention is needed and whether the operating system is improving delivery.

### Workspace Admin / Operations

Needs identity lifecycle, roles, templates, fields, automation, retention, audit, and integrations. Hires TManage to standardize how work moves without blocking teams.

### Manager / Project Lead

Needs planning, assignment, dependencies, approvals, workload, risk, and stakeholder updates. Hires TManage to deliver predictably with less chasing.

### Team Member / Specialist

Needs a clear “what next,” uninterrupted focus, context, quick updates, and safe collaboration. Hires TManage to spend less time reconstructing work.

### Client Admin

Needs project-wide progress, stakeholders, approvals, deliverables, and deadlines for their company. Hires TManage to understand delivery without joining the internal team’s tools.

### Client Reviewer / Member / Viewer

Needs an extremely simple queue of what requires attention, the correct file version, rationale, deadlines, and a trustworthy record of approval.

## 6. Product model

The durable hierarchy is:

**Organization → Workspace → Team → Project → Work Item**

Shared objects include Channel, Message, Thread, Document, File Asset, Meeting, Decision, Approval, Objective, Automation, Notification, Client Organization, and Audit Event.

`Work Item` is a typed core object: Task, Milestone, Bug, Request, Approval, Issue, Idea, Decision follow-up, Meeting action, or Objective action. Types share identity, permissions, discussion, attachments, activity, fields, relations, and lifecycle; specialized fields extend rather than fork the model.

## 7. Information architecture

### Team application navigation

- **Home:** My Day, focus recommendation, due work, blockers, meetings, waiting approvals.
- **Inbox:** mentions, assignments, approvals, deadlines, client actions, grouped project updates.
- **Chat:** channels, DMs, threads, voice notes, huddles later, message-to-object actions.
- **Work:** list, board, timeline, calendar, workload, portfolio, forms.
- **Calendar:** personal, project, milestones, meetings, focus blocks.
- **Docs:** collaborative knowledge, briefs, decisions, meeting notes, templates.
- **People:** directory, teams, roles, availability, workload—not hidden performance scoring.
- **Insights:** project health, flow, delivery predictability, bottlenecks, adoption.
- **Search / AI / Settings:** global utilities reachable everywhere.

### Client Portal navigation

- **Overview:** progress, milestones, upcoming dates, latest update, risks shared externally.
- **My Actions:** feedback, approvals, uploads, questions, tasks assigned to the client.
- **Deliverables:** versioned assets, status, review history, final downloads.
- **Timeline:** client-visible tasks, milestones, dates, and dependencies.
- **Updates:** formal status posts and decisions shared with the client.
- **Files:** explicitly shared assets only.
- **People:** approved project contacts only.

## 8. Feature specification by domain

### Home / My Day

- Shows overdue, due today, blocked, waiting, mentions, meetings, and focus recommendation.
- Ranking uses deadline, priority, dependency impact, stale state, and explicit user pinning.
- Every recommendation explains “why this now.” Users can dismiss and tune signals.
- No employee productivity score; insights describe system flow, not personal worth.

### Universal Inbox

- One normalized notification model with grouped bundles.
- Inline actions: reply, complete, approve, delegate, snooze, mark read.
- Modes: Important, All, Waiting on me, Client actions.
- User-controlled quiet hours and daily/weekly digests.
- Guaranteed notification delivery is separate from transient real-time presence.

### Chat

- Public/private channels, DMs, group DMs, threads, reactions, mentions, files, drafts, bookmarks, scheduled messages, edit history, pins.
- Message actions: create task/request/decision/approval, link to project, quote into document.
- Converting never duplicates context: new object stores source message and channel access semantics.
- Retention and export are policy-controlled. External client channels are visibly distinct.

### Work management

- List, board, timeline/Gantt, calendar, workload, portfolio, saved views.
- Assignees, collaborators, dates, priority, estimates, dependencies, recurrence, subtasks, checklists, custom fields, forms, templates.
- Clear state machine per type; admins can configure allowed transitions without arbitrary workflow code.
- Baseline versus actual dates and change log for delivery learning.
- Project health is explainable: deadline risk, blockers, dependency lateness, stale critical work, unowned work.

### Docs and knowledge

- Rich blocks, comments, mentions, tasks, decisions, tables, embeds, templates, version history.
- Documents can be project briefs, specs, meeting notes, SOPs, or client updates.
- A decision register and glossary prevent knowledge from disappearing in prose.
- Search indexes permissions and relationships; archived content remains discoverable according to policy.

### Calendar and meetings

- Unified work calendar, milestones, due dates, project dates, personal focus blocks.
- Meeting object connects agenda, attendees, notes, transcript reference, decisions, actions, and follow-ups.
- Calendar-provider integrations are optional adapters; core scheduling and work deadlines remain first-party.

### Files and deliverables

- Multipart upload, versioning, preview, metadata, malware scan, checksums, retention, access log.
- Deliverable is a governed object around one or more file versions: draft, internal review, client review, changes requested, approved, final.
- A client always sees the declared review version, not an arbitrary latest upload.

### Client Portal and external collaboration

- Client Organization contains its own people and roles.
- Roles: Client Admin, Client Reviewer, Client Member, Client Viewer.
- Client actions: comment, approve, request changes, upload, answer request, create request, accept delivery, assign within their organization where permitted.
- A client-created request enters triage; it does not silently become committed scope.
- Visibility values: `internal`, `client_visible`, `client_action_required`. Default is internal.
- “View as client” preview is mandatory before publishing updates or deliverables.
- External share expires optionally, may require authentication, and is revocable.
- Client activity is fully audited; internal chat, notes, rates, margins, reviews, and other clients are inaccessible.

### Approvals and decisions

- Approval includes subject, reviewers, sequence or parallel mode, due date, version, criteria, outcome, comments, and immutable decision event.
- Material changes after approval invalidate the approval or create a new version.
- Decision includes statement, owner, participants, rationale, alternatives, effective date, and linked affected objects.

### Automations

- Trigger → conditions → actions, with dry-run, test data, permissions of executing principal, history, retries, and idempotency.
- Examples: when deliverable enters Client Review, notify reviewers and set due date; when approval is late, escalate; when message becomes task, link project context.
- Automation never bypasses authorization or visibility.

### Search and command layer

- Global search covers work items, messages, documents, people, projects, files, decisions, and meetings.
- Filters: workspace, project, author, owner, type, date, status, client visibility.
- Command palette provides navigation and creation without mouse dependence.
- Search results are permission-filtered before ranking and summarization.

### AI assistant

- Phase 1: summaries, project pulse drafts, action extraction, semantic retrieval, natural-language filter creation.
- Phase 2: planning assistant, risk explanation, meeting recap, workflow suggestions.
- AI output labels evidence and links to source objects. It cannot approve, change permissions, invite external users, delete, or publish externally without explicit confirmation.
- Tenant data is not used for model training by default; provider retention and regional processing are configurable for enterprise.

## 9. Permission model

Use RBAC for coarse responsibility plus relationship- and attribute-based rules for actual object access.

Internal roles: Organization Owner, Organization Admin, Workspace Admin, Manager, Project Admin, Moderator, Member, Guest.

External roles: Client Admin, Client Reviewer, Client Member, Client Viewer.

Permission decision inputs: tenant, membership state, role, project membership, object audience, direct share, team relation, client organization relation, field sensitivity, action, and policy. Authorization is evaluated server-side and reinforced by mandatory MySQL tenant-scoped repositories, composite tenant constraints, least-privilege credentials, client-safe projections, and isolation tests. “Hidden in UI” is never treated as security.

## 10. UX journeys that must be prototyped

1. Create organization → workspace → first project from template → invite team.
2. Receive a client request → triage → accept into scope → plan → execute.
3. Convert a chat commitment into a task without losing thread context.
4. Prepare deliverable → internal review → publish to client → changes → approval → final.
5. Client login → understand progress in 30 seconds → complete assigned approval.
6. Manager identifies a blocked milestone and resolves dependency.
7. New member reconstructs why a decision was made.
8. Admin offboards user and verifies access revocation and transfer.

## 11. Non-functional requirements

- Availability target after GA: 99.9%; define stricter enterprise option later.
- API p95: <300 ms for common reads excluding large search/file operations.
- Real-time delivery: typically <1 second within region; graceful reconnect and gap recovery.
- First meaningful dashboard content: <2.5 seconds on target broadband hardware.
- WCAG 2.2 AA; full keyboard operation for core work.
- RPO ≤15 minutes and RTO ≤4 hours at GA; rehearse restores.
- Every mutation has actor, tenant, correlation ID, timestamp, and audit classification.
- Data export and deletion are product capabilities, not support-only procedures.

## 12. Business model hypotheses

- **Commercial unit:** workspace subscription with included internal seats; additional full internal users consume paid seats. Projects are not purchased one by one.
- **Client network:** Client Admin, Client Reviewer, Client Viewer, and limited external collaborators are included and do not consume internal paid seats. This keeps progress, review, and approval adoption frictionless.
- **Plan packaging:** active-project allowances, pooled workspace storage, automation/AI allowances, retention, security, and support differentiate plans. Archived projects do not consume the active-project allowance; retained files still consume storage.
- **Trial/Free:** 2 internal seats, 3 active projects, 2 GB pooled storage as configurable implementation defaults.
- **Starter:** 5 included internal seats, 15 active projects, 25 GB pooled storage.
- **Studio:** 10 included internal seats, 50 active projects, 100 GB pooled storage.
- **Business:** 25 included internal seats, 250 active projects, 500 GB pooled storage, portfolios, workload, advanced permissions, approvals, retention, and custom branding.
- **Enterprise:** configurable seats/projects, 1 TB+ or contracted storage, SSO/SAML, SCIM, audit export, DLP hooks, data residency, legal hold, and advanced support.
- Storage add-ons use predictable blocks; no silent variable overage and no destructive deletion when a customer exceeds quota or downgrades.
- Exact currency prices, annual discount, additional-seat price, taxes, and payment provider remain paid-beta decisions. Validate them through competitor/package research, public buyer discussions, landing-page/preorder experiments where lawful, and paid-alpha conversion evidence.
- Implementation details, quota behavior, metering, and billing tests are authoritative in `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY.md`.

## 13. Product metrics

### North-star candidate

**Weekly Completed Work Loops:** work items that move from commitment to accepted outcome with linked context and no unresolved blocker.

### Activation

- Organization creates first project, invites 3 members, creates 10 work items, links one conversation, and completes one workflow within 7 days.
- For service teams: invite a client and complete one approval within 14 days.

### Outcome metrics

- Median commitment-to-completion time.
- Client review turnaround time.
- Percentage of committed work with owner and due date.
- Search success without follow-up request.
- Blocked time as share of cycle time.
- Status meetings reduced or shortened.
- Weekly retained teams and retained client reviewers.

### Guardrails

- Notification opt-out/mute rate.
- Permission incidents and near misses.
- AI correction/rejection rate.
- Time spent maintaining the tool.
- Perceived surveillance score in research.

## 14. What not to build first

- Full video conferencing, payroll/HRIS, accounting, CRM, email replacement, source-code hosting, whiteboard, advanced BI, marketplace, mobile-native apps, or arbitrary no-code database.
- Deep customization before standard workflows prove value.
- Microservices before scaling boundaries are observed.
- “AI manager” that ranks employees or autonomously changes commitments.

## 15. Definition of MVP

MVP is a coherent end-to-end work loop, not a feature count:

- Identity, organizations, workspaces, teams, projects, roles.
- Chat channels/DMs/threads and message-to-task.
- Work list/board, assignment, dates, status, dependencies, comments, files.
- Home and actionable Inbox.
- Client Organization, Client Portal, deliverable versions, approval/change request.
- Basic docs/briefs and decision records.
- Universal keyword search.
- Notifications, audit trail, export basics, admin console.
- Responsive web and installable PWA; desktop packaging deferred.

## 16. Decision gates

- **Gate A — Problem:** structured desk-research corpus across every role shows repeated independent evidence for the target pains; assumptions and confidence are documented in `08-ROLE-BASED-DESK-RESEARCH.md`.
- **Gate B — Concept:** prototype tests; ≥80% complete the main client approval journey without help.
- **Gate C — MVP:** 5–10 design partners run real projects; evidence of reduced approval/status friction.
- **Gate D — Paid beta:** retention and willingness to pay; security and restore tests pass.
- **Gate E — Desktop:** web retention and notification/background-use data justify native shell.
