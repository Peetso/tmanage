# TManage — AI Execution Handbook

## 1. Purpose

This is the operating contract for any AI designer or AI coding agent. Planning is complete enough to start execution. The agent must not restart strategy, silently alter scope, or substitute a generic dashboard.

## 2. Source-of-truth order

When files conflict, use this precedence:

1. `15-AI-EXECUTION-HANDBOOK.md` — execution rules.
2. For product design: `37-ORIGINAL-VISION-GAP-AUDIT.md`, `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP.md`, `39-TMANAGE-COMPLETE-DESIGN-BIBLE.md`, `47-PRIMARY-VISUAL-REFERENCE-ANALYSIS.md`, `40-DESIGN-SYSTEM-TOKENS-AND-COMPONENTS.md`, `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX.md`, `42-INTERACTION-MOTION-RESPONSIVE-AND-RTL.md`, and `45-DESIGN-QUALITY-GATE-AND-CRITIQUE-RUBRIC.md` — whole-app design authority.
3. `09-MVP-PRD.md` and `21-REQUIREMENTS-TRACEABILITY.md` — MVP engineering scope and requirement mapping; this is implementation priority, not a limit on whole-app design.
4. `12-PERMISSION-MATRIX.md`, `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md`, and `04-SECURITY-PRIVACY.md` — authorization/trust.
5. `13-ENGINEERING-EXECUTION-SPEC.md`, `23-ERD-AND-STATE-MACHINES.md`, `contracts/openapi.yaml`, and `24-EVENT-CATALOG.md` — technical contracts.
6. `22-SCREEN-BY-SCREEN-SPEC.md`, `10-SCREENS-FLOWS-PROTOTYPE.md`, and `02-UX-UI-SYSTEM.md` — detailed MVP experience behavior.
7. `11-USER-STORIES-ACCEPTANCE.md` and `27-TEST-CATALOG.md` — acceptance and verification.
8. `28-SPRINT-TICKETS-AND-ESTIMATES.md`, `14-BACKLOG-AND-ALPHA-PLAN.md`, and `29-ENVIRONMENTS-DEPLOYMENT-AND-RUNBOOKS.md` — sequence and operations.
9. `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY.md` — locked billing unit, free client roles, active-project packaging, workspace quota enforcement, and paid-beta entitlement behavior. Exact price numbers/provider remain gated.
10. `50-BOOTSTRAP-DEPLOYMENT-ON-ONE-PAID-PLAN.md` — current budget constraint and deployment profile. It controls capacity/provider tiering for bootstrap without weakening authorization, integrity, or the standard upgrade architecture.
11. Brand, copy, analytics, legal/name, cost, strategy, and research files — language, constraints, rationale, and later scope.

If a conflict affects security, privacy, external visibility, data loss, or irreversible architecture, stop and create an ADR/question. For ordinary implementation detail, make the smallest consistent assumption and record it.

## 3. Non-negotiables

- Product name is **TManage**.
- Web-first; PWA before Tauri desktop.
- Modular monolith plus event-driven workers; no premature microservices.
- Multi-tenant isolation and client safety are part of the first schema and tests.
- New content defaults internal. Client projection is allowlisted and previewed.
- Approval is bound to immutable version/hash and actor/time.
- Client Portal is a dedicated experience, not internal UI with hidden controls.
- English LTR and Arabic RTL are architecture requirements.
- WCAG 2.2 AA for core journeys.
- AI may draft but cannot publish externally or perform consequential actions without confirmation.
- No employee surveillance score.
- Billing is workspace + internal seats. Client principals are included and do not consume internal paid seats. Active projects and pooled storage are plan entitlements, not separate project purchases.
- The product designer designs the complete product horizon in file 41. The coding agent implements only the currently authorized release scope.
- Limeframe and the uploaded primary visual reference control the design aesthetic; generic enterprise UI is not an acceptable interpretation.

## 4. Required execution loop

For each epic:

1. Read only the relevant source-of-truth sections plus global security rules.
2. Write a short implementation plan mapped to acceptance criteria.
3. Inspect current repo and preserve existing conventions.
4. Implement the smallest coherent vertical behavior, including states and errors.
5. Add/update unit, integration, authorization, E2E, accessibility, and visual tests as applicable.
6. Run validation; fix failures rather than suppressing them.
7. Update `docs/implementation-status.md`, API schema, ADRs, and runbooks.
8. Hand off with completed criteria, evidence, open risks, and exact next task.

## 5. Required project documentation during build

```text
docs/
  product/source-map.md
  implementation-status.md
  adr/ADR-xxxx-title.md
  api/openapi.yaml
  events/catalog.md
  security/threat-models/
  security/permission-test-map.md
  design/component-inventory.md
  design/screen-status.md
  runbooks/deploy.md
  runbooks/rollback.md
  runbooks/restore.md
  runbooks/incident.md
```

## 6. Status vocabulary

`not_started`, `designed`, `design_validated`, `contract_defined`, `implemented`, `tested`, `release_ready`, `released`. Never call a feature complete when only its happy-path UI exists.

## 7. Change control

- Product change: update PRD/story/flow and note research basis.
- Architecture change: ADR with context, options, decision, consequences, revisit trigger.
- Permission change: update matrix, threat model, API policy, scoped repository/constraint rules, and isolation tests together.
- Schema/event change: migration and backward-compatibility analysis.
- Design-system change: component contract, accessibility, stories, visual regression.

## 8. AI behavior constraints

The agent must not:

- Invent API integrations or paid providers as foundational dependencies.
- Replace MySQL/tenant-isolation architecture or the client projection without an ADR.
- use localStorage as authoritative business persistence.
- authorize by UI route alone.
- log content, secrets, tokens, or full sensitive payloads.
- ship placeholder lorem ipsum or generic “Acme” data in final product surfaces.
- implement features outside the authorized engineering phase while P0 acceptance remains incomplete. This restriction does not prevent the designer from designing the complete product horizon.
- mark tests passed without running them.
- delete user work or rewrite unrelated files.

## 9. Completion package

Before implementation is considered ready for alpha, provide: deployed staging URL, seeded demo tenants, design system, architecture diagram, OpenAPI, event catalog, migrations, threat models, test reports, accessibility report, performance report, SBOM, backup-restore evidence, admin/client guides, known issues, and release/rollback runbooks.
