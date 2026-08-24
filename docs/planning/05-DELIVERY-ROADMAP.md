# TManage — Delivery Roadmap, Team, and Governance

## 1. Delivery philosophy

The plan funds learning before scale. Dates are ranges until discovery and design-partner evidence exist. Each phase has a measurable exit gate; features do not count as progress unless users complete the intended work loop.

## 2. Phase plan

### Phase 0 — Desk discovery and product definition (completed baseline; refresh during design)

- Structured online evidence across internal and client roles, workplace studies, product documentation, practitioner communities, and competitor workflows.
- Competitor teardown and permission/client journey matrix.
- Service blueprint, domain glossary, journey maps, clickable prototype specification, and technical-spike plan.
- Threat models, data model, design brief, analytics plan, cost and naming risk research.
- Exit: planning pack complete; design execution may start. Actual alpha evidence remains the validation gate.

### Phase 1 — Foundations and vertical slice (8–10 weeks)

- Identity, organization/workspace/project, memberships, roles, tenant isolation.
- Design system foundation, Home shell, audit, telemetry, CI/CD, environments.
- One vertical loop: message → task → deliverable → client review → approval.
- Exit: internal production-like environment; tenant and client visibility tests pass.

### Phase 2 — Private alpha (12–16 weeks)

- Chat/threads, work list/board, comments, files, deliverables, Inbox, basic docs, Client Portal.
- Notifications, keyword search, admin basics, import templates, responsive/mobile triage.
- 3–5 design partners use real low-risk projects with weekly research.
- Exit: reliable end-to-end usage; major usability and security blockers resolved.

### Phase 3 — Private beta (12–16 weeks)

- Dependencies, timeline, project pulse, decisions, approvals, automation basics, richer search.
- Billing foundation, export, retention basics, performance and resilience hardening.
- 10–20 customers; first paid pilots.
- Exit: retention, willingness-to-pay, approval/status outcome evidence, restore and pen tests pass.

### Phase 4 — Public beta / GA readiness (12–20 weeks)

- Onboarding/templates, migrations, support/admin operations, accessibility closure.
- SSO/SAML, SCIM, audit exports, uptime/SLO program, legal/privacy packaging.
- AI summaries and action extraction behind evaluation and confirmation controls.
- Exit: GA scorecard, security review, support capacity, unit economics acceptable.

### Phase 5 — Desktop and ecosystem (after evidence)

- Tauri app, native notifications, tray, deep links, updater, file-open integration.
- Public API, webhooks, curated integrations, marketplace later.
- Offline drafts and read cache; deeper offline only if validated.

## 3. Recommended team

Discovery core: Product Lead, Staff Product Designer/Researcher, Tech Lead/Architect, Security advisor, part-time GTM/industry expert.

Build core (roughly 10–14 people): 1 Product Lead, 1 Product Manager, 2 Product Designers including research, 1 Engineering Manager/Tech Lead, 3–4 backend/platform engineers, 3 frontend/full-stack engineers, 1 QA/SDET, 1 DevOps/SRE, fractional Security/Privacy and Data/Analytics. Add customer success before private beta.

Do not organize a separate team per feature early. Use three durable streams: Core Work Graph, Collaboration & Client Experience, Platform & Trust.

## 4. Governance cadence

- Weekly product trio: evidence, risks, decisions, next experiments.
- Weekly architecture/security review for cross-cutting changes.
- Fortnightly customer research playback and roadmap adjustment.
- Monthly KPI and reliability review.
- Quarterly strategy, pricing, risk, and staffing review.
- Decision log with owner, date, rationale, alternatives, and revisit condition.

## 5. Work item definition of ready

Problem and target user identified; expected outcome/metric; UX state and copy; permission/audience rules; analytics; accessibility; security/privacy considerations; failure/loading/empty states; dependencies; acceptance examples.

## 6. Definition of done

Code reviewed; tests at appropriate layers; authorization/tenant tests; telemetry and audit; documentation/runbook; accessibility and responsive review; performance budget; migration rollback/forward plan; feature flag; support note; product acceptance.

## 7. Risk register

| Risk | Early signal | Mitigation |
|---|---|---|
| Scope becomes seven mediocre products | Roadmap driven by competitor checklists | Enforce vertical-loop MVP and explicit non-goals |
| Client data leak | Ambiguous visibility or shared-query shortcuts | Default internal, real policy preview, scoped repositories, composite tenant constraints, isolation tests |
| Users resist replacing tools | Low activation/migration anxiety | Start with new projects, templates, import/export, focused wedge |
| Notification overload returns | High mute rate, low action rate | Bundling, priority, digest, quiet hours, measure usefulness |
| Chat scale destabilizes core | queue lag/socket failures | Durable event cursor, independent gateway scaling trigger |
| Customization creates complexity | setup time rises | opinionated defaults and staged admin capabilities |
| AI hallucinates or leaks | correction rate/source mismatch | grounded retrieval, citations, policy filtering, confirmation |
| Managers use analytics for surveillance | research concern, misuse requests | team-flow metrics, privacy guardrails, governance |
| Modular monolith erodes | cross-module writes/import cycles | module tests, ADRs, ownership, outbox contracts |
| Costs outrun revenue | file/realtime/AI cost per tenant rises | quotas, tiering, cost telemetry, lifecycle policies |

## 8. Budget model categories

Estimate by phase after discovery. Track people, cloud baseline, environments, file/storage/egress, realtime, search, email/push, AI usage, observability, security tooling, penetration testing, legal/privacy, accessibility audit, customer support, and migration assistance. Maintain cost-per-active-organization and cost-per-completed-work-loop.

## 9. Launch scorecard

- Product: activation, task/approval completion, retained teams, client engagement.
- Quality: crash/error rate, p95 latency, realtime delivery, search success.
- Trust: tenant tests, security findings, restore result, privacy operations.
- Support: ticket volume, response time, known-issue coverage.
- Business: paid conversion, gross margin, expansion signal, churn reasons.
- Learning: validated/invalidated hypotheses and next strategic constraint.

## 10. First 30 days of action

1. Maintain and refresh the role-based online evidence repository.
2. Execute the complete UI/prototype specification and accessibility review.
3. Prototype client approval and message-to-work loops.
4. Run remote tests/cognitive walkthroughs where direct sessions remain unavailable.
5. Validate modular architecture with spikes: MySQL tenant isolation, outbox, realtime recovery, upload scan, approval concurrency.
6. Freeze implementation contracts after design and spike evidence; validate product assumptions in private alpha.
