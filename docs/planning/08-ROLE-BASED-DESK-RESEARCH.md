# TManage — Role-Based Desk Research

## 1. Method and limitations

This is an online qualitative research substitute, not a claim that browsing equals interviews. Evidence was triangulated from workplace studies, official product documentation, practitioner discussions in project-management, agency, freelance, sysadmin, Slack, and Notion communities, and competitor workflows. Vendor and self-promotional comments were down-weighted. Repeated pain across independent threads was treated as a stronger signal than a single popular comment.

Limitations: online participants are self-selecting; identity and company context cannot always be verified; negative experiences are overrepresented; posts may contain product promotion. Therefore findings produce product hypotheses and usability risks—not universal market prevalence.

## 2. Executive / Owner role

### Repeated jobs

- Understand portfolio health without reading every task.
- Identify risks, delayed approvals, capacity constraints, and client dissatisfaction early.
- Reduce the cost of manual coordination and duplicated tools.
- Maintain client confidence and a defensible record of scope, delivery, and approval.

### Repeated pain

- Status information arrives late and is manually translated by account/project managers.
- High-level dashboards are untrusted when task data is stale.
- Too much detail encourages micromanagement; too little hides risk.
- Tool adoption fails when the system requires constant configuration expertise.

### TManage decision

Provide evidence-backed portfolio health with drill-down, freshness indicators, and explanations. Never rank employees. Show flow risks: unowned critical work, blocked duration, dependency delay, approval age, scope change, and milestone confidence.

## 3. Admin / Operations / IT role

### Repeated jobs

- Onboard and offboard safely, manage guests, standardize templates, and prove access history.
- Reduce configuration and support load while preserving governance.
- Integrate identity and automate repetitive lifecycle work.

### Repeated pain

- Offboarding reveals forgotten SaaS access and ownership gaps.
- Flexible systems need a dedicated maintainer.
- Guest permissions can be confusing; external users wander into irrelevant UI.
- Security and audit requirements arrive after adoption, making remediation costly.

### TManage decision

Ship opinionated templates, access review, ownership transfer, session revocation, invitation policy, guest/client inventory, “last access” and expiry, audit export, SSO/SCIM path, and a dedicated client surface. Configuration changes include preview, validation, and rollback where feasible.

## 4. Manager / Project Lead role

### Repeated jobs

- Turn ambiguous requests into clear commitments.
- Coordinate owner, date, dependencies, scope, review, and client expectations.
- Produce updates without spending hours reconstructing reality.

### Repeated pain

- Requests arrive in chat but fail to reach the PM system.
- Managers chase owners and clients for updates or approvals.
- Approval feedback must be manually translated to fulfillment teams.
- Multiple client reviewers create conflicting feedback and unclear authority.
- Client delay causes schedule compression without visible consequence.

### TManage decision

Use a triage inbox, message-to-work conversion, single accountable owner, dependency and blocker state, client point-of-contact policy, approval authority, consolidated feedback, SLA/reminder rules, and automatic schedule-impact warnings.

## 5. Team Member / Specialist role

### Repeated jobs

- Know the next meaningful action and its complete context.
- Ask questions and provide updates without administrative overhead.
- Protect focus while remaining responsive to urgent work.

### Repeated pain

- Constant chat interruptions and notification volume damage focus.
- Duplicate task entry and fragmented files/comments waste time.
- Excess custom fields and process steps feel like work for the tool.
- Ambiguous priority causes every request to appear urgent.

### TManage decision

My Day ranks explainably; Inbox bundles events; required fields depend on lifecycle stage; focus/quiet modes are first-class; source discussion and approved artifact appear inside the work item; urgency requires a reason and expires.

## 6. Client Admin / Sponsor role

### Repeated jobs

- Know overall progress, key dates, risks, decisions, and what their organization must provide.
- Control who may review and approve on the client side.
- Demonstrate internally what was delivered and accepted.

### Repeated pain

- Clients ask for updates because internal systems are invisible or too technical.
- Generic guest access exposes confusing navigation.
- Scope and expectations agreed in sales are rediscovered during onboarding.
- Client teams lack a single responsible point of contact.

### TManage decision

Client Overview uses milestones and plain language; Client Admin manages approved contacts; onboarding includes scope, responsibilities, requested assets, and “what happens next”; formal updates separate committed dates from forecasts.

## 7. Client Reviewer role

### Repeated jobs

- Review the correct version quickly, understand criteria, leave actionable feedback, and approve with confidence.

### Repeated pain

- Approval requests disappear in email.
- Feedback exists across email, WhatsApp, documents, chat, and calls.
- A casual “looks good” becomes disputed later.
- Reviewers forget portals that are not part of their daily routine.
- New version overwrites the context of an earlier approval.

### TManage decision

One-click magic-link option under policy, action queue, binary Approve/Request changes, required structured feedback for changes, immutable actor/time/version record, reminders, email deep links, version comparison, and automatic invalidation after governed changes.

## 8. Client Viewer role

### Repeated jobs

- Observe progress and download approved deliverables without changing work.

### TManage decision

Read-only, client-safe view with explicit freshness and contact route. No internal navigation, no implicit comment/approval authority, no discovery of other client users unless shared policy permits.

## 9. Cross-role themes and confidence

| Theme | Confidence | Product consequence |
|---|---|---|
| Approval fragmentation and weak audit trail | High | Version-bound approval is MVP-critical |
| Client portals fail when they require habitual browsing | High | Email/deep-link action path plus portal queue |
| Flexible tools create setup and maintenance burden | High | Opinionated workflows, staged customization |
| Status reporting is translation work | High | Derived pulse with human review |
| Notification overload damages focus | High | Bundling, priority, digest, quiet hours |
| Offboarding and guest lifecycle are risk points | Medium-high | Access expiry, transfer, revocation, review |
| Executives want visibility without task detail | Medium-high | Explainable portfolio health and freshness |
| Clients will actively use a portal | Conditional | Must be low-friction and action-oriented; validate in alpha |

## 10. Research-backed product changes

1. Make Client Action Queue the portal home when actions exist.
2. Support portal-less action through authenticated deep links while preserving the same audit model.
3. Add approval authority and client point-of-contact configuration.
4. Add client-delay schedule-impact event and policy-based “approval by silence” only as an explicit contractual configuration—not a default.
5. Add onboarding intake, requested-assets checklist, and scope acknowledgment.
6. Keep client-visible progress milestone-based; never expose raw task percentage as truth.
7. Add workspace health/freshness signals and lightweight governance for stale pages/templates.
8. Treat offboarding, ownership transfer, and guest expiry as core admin workflows.

## 11. Evidence sources

- Microsoft Work Trend Index: https://www.microsoft.com/en-us/worklab/we-can-not-keep-up-with-work-but-ai-can-help
- Asana Anatomy of Work: https://asana.com/resources/anatomy-of-work-hub
- Asana guest/permission model: https://help.asana.com/s/article/permissions-overview
- Agency approval experiences: https://www.reddit.com/r/agency/comments/1k9iiz9/how_are_you_all_managing_client_approvals/
- Agency approval workflow need: https://www.reddit.com/r/agency/comments/tnzhx1/how_does_your_agency_handle_client_approvals/
- Software agency portal experience: https://www.reddit.com/r/agency/comments/1i5ad6o/software_development_agencies_how_do_you_do/
- Client feedback and approval practice: https://www.reddit.com/r/SocialMediaMarketing/comments/1pgdpcf/how_do_you_handle_client_feedbackapproval/
- Notion team flexibility/maintenance discussion: https://www.reddit.com/r/Notion/comments/1vf7wx7/notion_and_project_management/
- Notion engineering PM experience: https://www.reddit.com/r/Notion/comments/1g607c9/those_who_have_used_notion_for_engineeringrelated/
- Sysadmin onboarding/offboarding experience: https://www.reddit.com/r/sysadmin/comments/1udfuqi/affordable_onboardingoffboarding_automation_tools/

## 12. Ongoing no-interview validation

Monthly: sample new practitioner threads; code pain statements; compare frequency and context; update hypothesis confidence. Before building a major domain, run a structured review of 30+ recent relevant posts and official competitor flows. During private alpha, product telemetry, support tickets, observed sessions, and opt-in surveys become primary evidence.
