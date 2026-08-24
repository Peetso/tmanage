# Source map — which file governs what

Required by `15-AI-EXECUTION-HANDBOOK.md` §5. Records the exact sources used and the
precedence applied.

**Pack revision used:** 2026-08-16 (files revised 09:26–10:59). Copied immutably to
`docs/planning/`; the design export to `docs/design/source/`. Neither is edited.

> **Revision hazard.** This pack has been revised mid-implementation at least once — the
> 16 August change from PostgreSQL to MySQL/MariaDB, which invalidated a day's data-layer
> work. Before resuming, re-check `docs/planning/` against
> `outputs/TManage-Planning-Pack/` and diff modification times.

## Precedence (handbook §2, current revision)

1. `15-AI-EXECUTION-HANDBOOK.md` — execution rules
2. Product design — 37, 38, 39, 47, 40, 41, 42, 45
3. `09-MVP-PRD.md`, `21-REQUIREMENTS-TRACEABILITY.md` — MVP scope
4. `12-PERMISSION-MATRIX.md`, `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md`, `04-SECURITY-PRIVACY.md` — authorization/trust
5. `13-ENGINEERING-EXECUTION-SPEC.md`, `23-ERD-AND-STATE-MACHINES.md`, `contracts/openapi.yaml`, `24-EVENT-CATALOG.md` — technical contracts
6. `22`, `10`, `02` — MVP experience behaviour
7. `11-USER-STORIES-ACCEPTANCE.md`, `27-TEST-CATALOG.md` — acceptance
8. `28`, `14`, `29` — sequence and operations
9. `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY.md` — billing unit, entitlements
10. `50-BOOTSTRAP-DEPLOYMENT-ON-ONE-PAID-PLAN.md` — budget constraint, deployment profile
11. Brand, copy, analytics, legal, cost, research

Planning governs behaviour, authorization, privacy, integrity, scope, and technical
boundaries. The `.dc.html` artifacts and `design/` docs govern visual composition,
component expression, interaction intent, responsive behaviour, RTL, and content
presentation. **A security or permission rule is never weakened to reproduce a prototype.**

## What each implemented artifact traces to

| Artifact                                            | Governing source                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/config/src/env.ts`                        | 03 §2 (MySQL), 50 §4 (pool/quotas), 50 §9 (`DEPLOYMENT_PROFILE`), 25 §5 (user separation), 25 §9 (5-min download TTL), ADR-0002 (substitute guardrails) |
| `packages/domain/src/policies/capabilities.ts`      | 25 §4 (capability list), 12 §1–§2 (roles, ceilings)                                                                                                     |
| `packages/domain/src/policies/audience.ts`          | 12 §3–§4, 04 §5, 25 §7 (forbidden client fields)                                                                                                        |
| `packages/domain/src/policies/authorize.ts`         | 25 §1, §3, §11; 12 §2, §5; 04 §4                                                                                                                        |
| `packages/domain/src/state-machines/*`              | 23 §5 work · §6 client request · §7 deliverable · §8 approval · §9 invitation · §10 upload · §11 offboarding                                            |
| `packages/domain/src/value-objects/uuid-v7.ts`      | 03 §7, 25 §5 (`CHAR(36)` canonical lowercase)                                                                                                           |
| `packages/domain/src/value-objects/content-hash.ts` | 23 §4, 25 §8, US-C03                                                                                                                                    |
| `compose.yaml`, `scripts/db/users.sql`              | 28 PLAT-002, 25 §5, 50 §3–§4                                                                                                                            |
| `apps/api/test/seed-two-tenants.ts`                 | 19 §1–§2 (seed world), 25 §11 (isolation corpus)                                                                                                        |
| `scripts/audit-design-source.mjs`                   | 41 (172 IDs), `design/SESSION-HANDOFF.md`                                                                                                               |
| `eslint.config.js`                                  | 18 (boundaries), 25 §6 (repository guardrails), 15 §8 (no localStorage)                                                                                 |

## Design sources read

`TManage Screens - Delivery.dc.html` (requested entry point) · `TManage Foundations.dc.html`
· `SESSION-HANDOFF.md` · `developer-handoff.md` · `tokens/tokens.css` — plus the full
29-artifact sweep performed programmatically by `scripts/audit-design-source.mjs`.

Not yet read in depth, required before UI work: `design-principles.md`, `decision-log.md`,
`components/{inventory,contracts,state-matrix}.md`, `screens/whole-app-index.md`,
`sitemap-and-role-navigation.md`, `information-architecture.md`, `prototype-map.md`,
`content-and-localization.md`, `responsive-and-desktop.md`, `accessibility-audit.md`,
`requirements-traceability.md`, and the per-screen artifacts.

## Known documentation mismatch, reconciled

The export's `screens/screen-status.md` and `design-quality-scorecard.md` contain stale
rows. `docs/design/design-source-audit.md` is the reconciled coverage truth: **172/172 IDs
present, 0 missing**. The export is immutable and was not edited to fix its own ledger.
