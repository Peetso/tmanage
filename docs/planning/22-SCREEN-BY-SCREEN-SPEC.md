# TManage — Screen-by-Screen Design Specification

## 1. Global shell rules

Internal desktop: global rail (Home, Inbox, Chat, Work, Calendar, Docs, People, Insights), contextual sidebar, canvas, optional detail pane. Client desktop: TManage/client brand, project selector if authorized, Overview, My Actions, Deliverables, Timeline, Updates, Files, People. Mobile: bottom navigation with no hover dependency. All screens expose current organization/project and audience context.

Global states: loading skeleton preserving layout; useful empty state; recoverable inline error; full failure with retry/correlation ID; offline banner and queued-draft status; permission-denied response that does not name hidden content; optimistic conflict with compare/reload; suspended/expired state. Every dialog traps focus, returns focus, closes with Escape unless destructive confirmation is incomplete, and uses logical-direction spacing for RTL.

## 2. Screen contract format

Each screen specifies purpose, visible content, primary/secondary actions, roles, data, states, responsive behavior, and instrumentation. The designer may improve composition but cannot change behavior or authorization.

## 3. Identity and onboarding

### ID-01 Sign in

- Purpose: authenticate with email/passkey/SSO.
- Content: product mark, organization-aware SSO when known, privacy/support links.
- Actions: continue, use passkey, enterprise SSO, recovery.
- States: invalid/expired method, rate limited, MFA required, suspicious-login reauth.
- Mobile/RTL: single column; email direction remains LTR.
- Events: `sign_in_started/succeeded/failed` without credential content.

### ID-02 MFA / passkey challenge

- Show method, device context, fallback policy, trust-device duration.
- Never expose whether an unrelated account exists.

### ID-03 Invitation acceptance

- Show inviter, organization, project, role, exact access summary, expiry, account-switch option.
- Client invitation prominently states “client portal access,” not team membership.

### ID-04 Organization selector

- Searchable organizations with internal/client badge and last opened.
- No cross-organization aggregated content in MVP.

### ID-05 Session and recovery

- Active devices, last activity, revoke one/all, recovery codes, security event receipt.

### ON-01 Create organization

- Fields: organization name, timezone, default locale, work type.
- Primary: Create organization. Result is transactional owner membership.

### ON-02 Choose operating template

- Options: Agency delivery, Software studio, Consulting engagement, Blank later.
- Explain included states/milestones; template remains editable by authorized admin.

### ON-03 Create first project

- Fields: name, client/internal, project owner, target date, timezone, template.
- Date is marked target until milestone plan confirmed.

### ON-04 Invite internal team

- Email list, role, project access; preview each role; invalid domains and duplicates inline.

### ON-05 Create client organization

- Company name, sponsor/point of contact, approval authority policy, portal branding choice.
- New external users default Viewer until explicit higher role.

### ON-06 Invitation preview and send

- “View as role” preview, recipients, access scope, expiry, notification copy, confirmation.

## 4. Internal home, inbox, and collaboration

### TM-01 Home / My Day

- Content: greeting, recommended next with explanation, overdue/due/blocked/waiting, meeting strip, client actions waiting.
- Primary: open recommended work. Secondary: complete, snooze, reprioritize, dismiss reason.
- Roles: all internal; cards only from accessible scope.
- Empty: “No urgent work” plus upcoming commitments.
- Mobile: stacked action cards; swipe is optional, never sole control.

### TM-02 Portfolio health

- Content: projects by health, forecast/committed date, stale-data marker, approval age, blockers.
- Roles: Owner/Admin/Manager by scope. No personal ranking.
- Drill-down preserves filters.

### TM-03 Project overview

- Header: project, client/internal badge, health explanation, owner, committed/forecast dates.
- Sections: milestones, next actions, blockers, latest internal pulse, client-publication state.
- Primary: update work; Manager primary: draft/publish pulse.

### TM-04 Inbox

- Tabs: Important, All, Waiting on me, Client actions. Bundles show count, latest time, required action.
- Inline actions reauthorize at execution.
- Unread state synchronizes across devices; bulk mark read reversible for short interval.

### TM-05 Inbox bundle detail

- Chronological events, current object state, participants, action bar, “why important.”

### TM-06 Project channel

- Channel header, messages, thread affordance, composer, presence, pinned context.
- Message actions: reply, react, save, create work, quote to decision, edit history.
- Client-shared channels use persistent external audience banner.

### TM-07 Direct/group messages

- Same message model; organization boundary visible. External DM not in MVP.

### TM-08 Thread pane

- Source message pinned, replies, linked work/decision; maintains keyboard reading order.

### TM-09 Convert message dialog

- Type, title, project, owner, due date, audience. Source preview and access warning.
- Defaults: internal audience; no owner/date invented. Duplicate conversion shows existing link.

## 5. Work and project delivery

### TM-10 Work list

- Columns: type, title, state, owner, priority, due, blocker, audience. Saved views and filters.
- Table supports keyboard row navigation, selection, sorting, bulk actions with policy preview.
- Client-sensitive bulk audience change requires separate confirmation.

### TM-11 Work board

- Columns are states; drag is enhanced interaction with keyboard move alternative.
- Invalid transition explains required information; optimistic move rolls back safely.

### TM-12 Client request triage

- Request content, desired date disclaimer, files, discussion, client history, duplicate suggestion.
- Actions: ask clarification, accept, defer, decline. Acceptance requires committed scope/owner/date.
- Schedule-impact preview before accept.

### TM-13 Work item detail

- Header: type/title/state/audience; fields; description; checklist; dependencies/blocker; source; discussion; files; decisions; activity.
- Transition presents only fields required for next state.
- Internal notes are separate objects, never hidden client comments.

### TM-14 Milestone / timeline

- Milestone status, committed/forecast dates, dependencies, affected client actions.
- Visual timeline plus accessible list. Progress reflects weighted milestone state, not task count.

### TM-15 File upload center

- Queue, progress, pause/resume/cancel, scan status, rejection reason, retry.
- “Uploaded” is not “available” until ready.

### TM-16 Deliverables list

- Deliverable, current governed version, internal/client status, reviewer, due, decision.

### TM-17 Deliverable detail

- Version selector, preview/download, metadata, review state, feedback, approval history.
- Clear distinction between latest internal version and client-governed version.

### TM-18 Internal review

- Checklist/criteria, review comments, Ready for client / Return to draft.
- Reviewer cannot approve own artifact if project policy requires separation.

### TM-19 Publish-to-client safety check

- Selected version/hash, allowlisted client fields, linked-content warnings, recipients/roles, deadline, reminder schedule.
- Required real-policy preview before Publish; consequence copy names recipient count.

### TM-20 Approval history / invalidation

- Timeline of requests, views, decisions, versions, invalidations. Immutable records visually distinct from discussion.

## 6. Client Portal

### CL-01 Overview

- First viewport: current milestone/forecast, latest update, required actions, next date, shared risk.
- Freshness timestamp and project contact. No internal task percentage.

### CL-02 My Actions

- Ordered cards: approval, feedback, upload, answer, client task. Each shows why, due, consequence, estimated review time.
- Empty state confirms notification behavior.

### CL-03 Approval review

- Exact version, preview/download, criteria, context, due, authority, prior feedback/version comparison.
- Primary: Approve. Secondary: Request changes. No ambiguous generic comment as decision.

### CL-04 Request changes

- Structured feedback: affected area, required change, optional annotation/attachment. At least one actionable item required.

### CL-05 Deliverables

- Client-governed versions only; status, decision, final download, history permitted by policy.

### CL-06 New request / request detail

- Title, category, description, urgency reason, desired date, files. Confirmation states date is uncommitted.
- Detail shows submitted/clarifying/accepted/deferred/declined/planned/delivered with client-safe reason.

### CL-07 Files

- Explicitly shared, scanned files only. Filters by deliverable/milestone; short-lived download.

### CL-08 Updates

- Published status updates and decisions; each shows author, published time, reporting period, freshness.

### CL-09 Timeline

- Client-visible milestones and client dependencies/actions. Accessible list companion.

### CL-10 People

- Approved project contacts; role and contact route. No discovery of unrelated team/client users.

### CL-11 Client member management

- Client Admin only: invite/revoke, assign Viewer/Member/Reviewer within allowed policy, approval authority warning, access expiry.

## 7. Search, preferences, and administration

### TM-21 Command palette

- Navigation and creation commands filtered by capability. Keyboard-first, recent commands device-local only.

### TM-22 Project pulse editor

- Evidence sections: achieved, next, risks, decisions, dates, asks. Source links and stale markers.
- Toggle internal/client draft; explicit publish; AI-generated text labeled until edited/published.

### TM-23 Decision register

- Statement, owner, effective date, rationale, alternatives, affected work; filters and status.

### TM-24 Document/brief

- Structured project brief in MVP-lite: title, blocks, comments, links, version history; no simultaneous CRDT promise.

### TM-25 Universal search

- Query, type/project/date/owner/audience filters, results with safe snippets and reason for match.

### TM-26 Search no-access/empty

- Empty copy does not confirm hidden objects. Suggest accessible filters/content.

### TM-27 Preferences

- Locale, timezone, theme, notification channels, quiet hours, digest, accessibility/motion.

### AD-01 Members and roles

- Internal/client tabs; scope, role, status, last access, expiry; invite and review access.

### AD-02 Client organizations

- Projects, contacts, pending actions, users, access policy, expiry; never mix client tenants.

### AD-03 Invitation policy

- Who may invite, allowed domains, default expiry/role, magic-link policy, preview.

### AD-04 Security settings

- MFA enforcement, SSO placeholder/plan tier, session policy, API/webhook policy, retention summary.

### AD-05 Offboarding impact preview

- Sessions, owned work, approvals, channels/docs, client shares, API keys, transfer target.

### AD-06 Offboarding execution/receipt

- Step status, failure/retry, final revoked/transferred summary, audit ID.

### AD-07 Audit log

- Actor/effective actor, action, object, time, source, result; authorized filters/export; sensitive details redacted by role.

## 8. Designer completion checklist per screen

Anatomy, grid, tokens, role visibility, content hierarchy, primary/secondary actions, validation, all global states, keyboard map, focus order, accessible names/live regions, desktop/mobile, LTR/RTL, analytics IDs, and mapping back to requirement/story IDs.
