# TManage — Final Design and Development Readiness Handoff

## 1. Readiness statement

Planning and execution specifications are complete for handoff. The previous shallow/generic visual handoff was corrected on 14 August 2026 with a supplied visual reference and the Limeframe whole-product design system. The remaining work is actual UI design/prototyping and software implementation/verification. Product-market evidence still comes from the planned alpha; no planning document can substitute for real usage.

## 2. Designer input package

Claude Code already has filesystem access to the project folder. Upload only `assets/references/TManage-primary-visual-reference.webp` in the first Claude chat; do not upload the pack again. Claude reads the following locally in order: 15 handbook → 37 gap audit → 38 whole scope → 39 Design Bible → 47 visual-reference analysis → 40 tokens/components → 41 whole-app screens → 42 interactions/responsive/RTL → 45 quality gate → 09/21/22 MVP behavior → 12 permissions → 19 copy → 31 brand → 27 tests. Use prompt 16.

Designer outputs: actual visual-reference analysis, Limeframe library, complete whole-app screen system, traceability, sitemap/flows, tokens, components/states, desktop/mobile/LTR/RTL screens, connected prototypes, quality scorecard, accessibility audit, and developer specs/assets. Designer cannot alter permission, client projection, approval/version, or legal naming status without documented product/security decision.

## 3. Developer input package

Read in order: 15 handbook → 09 PRD → 21 traceability → 13 engineering → 23 ERD/state → `contracts/openapi.yaml` → 24 events/schemas → 25 authorization/MySQL tenant isolation → 26 threats → 27 tests → 28 sprint tickets → 29 environments → completed design handoff. Use prompt 17.

Developer outputs: repository structure, MySQL/Drizzle migrations and tenant-isolation guardrails, OpenAPI-generated clients, event registry, working product, tests, staging, runbooks, reports, seed demo, implementation status/ADRs.

## 4. Decisions already made

- Web-first PWA; Tauri desktop after evidence.
- Next.js/React/TypeScript + NestJS/Fastify modular monolith.
- Hostinger MySQL-compatible MariaDB system of record with application authorization, scoped repositories, composite tenant constraints, explicit client projections, and isolation tests.
- Redis-compatible queue/cache/presence; transactional outbox.
- S3-compatible private versioned storage and scan pipeline.
- Dedicated Client Portal with immutable allowlisted projections.
- Approval bound to reviewer authority, exact version/hash, actor/time.
- Workspace subscription with paid internal seats; Client Admin/Reviewer/Viewer and limited external collaborators included without consuming an internal seat.
- Active projects and pooled workspace storage are versioned plan entitlements, not project-by-project purchases; quota is enforced through atomic object-storage reservations.
- English/Arabic, WCAG 2.2 AA, privacy/security by design.
- AWS reference deployment; region/domain remain gated inputs.

## 5. Inputs that legitimately remain business decisions

These are not missing specifications and must be supplied by the owner before the named gate:

- Legal entity, launch jurisdictions, and counsel-approved contract/privacy documents.
- Trademark/domain clearance and acquisition budget.
- Final visual identity/logo from design.
- Exact currency pricing, annual discount, taxes, and payment provider before paid beta. The pricing unit and entitlement/storage policy are already locked in file 49.
- Alpha partner identities and real-project consent.
- Final cloud region and production budget.

The AI must not guess these or silently convert placeholders into public commitments.

## 6. Start sequence

1. Run name/legal gate in parallel; keep `.example` domains.
2. Owner uploads the clear primary reference image with prompt 16; Claude confirms it is visible, then designs the complete product and passes file 45.
3. Tech lead performs high-risk spikes: MySQL tenant isolation/client projection, outbox/idempotency, upload scan, approval concurrency.
4. Freeze API v0.1 and design component contracts.
5. AI Coder executes prompt 17 following tickets 28.
6. Release to staging, complete catalog 27, run restore/threat closure.
7. Private alpha using plan 14; feed evidence back through change control.

## 7. Handoff acceptance checklist

- All core requirements have screen/API/data/event/auth/test mapping.
- Every screen has role, content, actions, states, responsive/RTL/a11y requirements.
- Machine-readable OpenAPI, DBML, and event JSON Schemas exist and validate.
- Tenant-isolation, threat, test, deployment, cost, analytics, notification, legal, and name-risk specifications exist.
- AI prompts cite correct source order and prohibit scope/security drift.
- No unresolved planning placeholders or superseded product name remains in source files.

## 8. Final caution

“Ready for implementation” means decisions and acceptance evidence are defined. It does not mean implementation risk is zero. High-risk technical assumptions must be proven in early spikes, and security/usability findings may legitimately update the specifications through controlled ADR/change records.
