# TManage — Product & System Planning Pack

**Status:** Whole-product design-and-development-ready planning baseline v3.2  
**Date:** 16 August 2026  
**Purpose:** The execution blueprint for an integrated work operating system combining communication, work management, knowledge, client collaboration, meetings, automation, and intelligence in one first-party product.

## How to use this pack

1. Start with `01-MASTER-PLAN.md` for the product thesis, users, scope, experience, business model, and roadmap.
2. Use `37-ORIGINAL-VISION-GAP-AUDIT.md` to understand the corrected design scope, then files 38–47 as the whole-product design authority. The Limeframe visual north star is `assets/references/TManage-primary-visual-reference.webp`.
3. Use `03-TECHNICAL-ARCHITECTURE.md` for platform, codebase, data, real-time, search, files, AI, desktop, and infrastructure decisions.
4. Use `04-SECURITY-PRIVACY.md` for the security program, tenant isolation, permissions, audit, privacy, and compliance path.
5. Use `05-DELIVERY-ROADMAP.md` to staff, estimate, sequence, and govern delivery.
6. Use `06-RESEARCH-EVIDENCE.md` for evidence, competitor patterns, assumptions, and the validation plan.
7. Use `07-DATA-MODEL.md` as the conceptual data model and permission reference.
8. Use `08-ROLE-BASED-DESK-RESEARCH.md` for online evidence by role and the product changes it produced.
9. Use `09-MVP-PRD.md` through `14-BACKLOG-AND-ALPHA-PLAN.md` as the execution-ready product, UX, permission, engineering, and delivery specification.
10. Claude Code already has filesystem access to this folder. Start it with `16-AI-DESIGNER-FIRST-PROMPT.md` and **upload only the clear primary reference image in the same first message**; do not upload the pack again. Start the coding phase with file 17 only after design handoff.
11. Use `18-REPOSITORY-STRUCTURE.md`, `19-SEED-DATA-AND-COPY.md`, and `20-EXECUTION-CHECKLIST.md` to keep design and implementation deterministic and verifiable.
12. Use files 21–36 for the execution layer. Use files 37–47 for the original-vision audit, complete scope, Limeframe Design Bible, tokens/components, whole-app screen matrix, interaction/responsive/RTL, Claude operation, phased continuation, quality gate, current reference research, and the supplied-image analysis.
13. Use `48-CLAUDE-CODE-IMPLEMENTATION-START-PROMPT.md` to start the coding phase against the completed design export. `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY.md` is the implementation authority for billable internal seats, included client users, active-project allowances, workspace storage quotas, and usage metering. `50-BOOTSTRAP-DEPLOYMENT-ON-ONE-PAID-PLAN.md` is the funded deployment authority: Hostinger Cloud is the only paid service and its included MySQL-compatible MariaDB is the system of record until an upgrade gate is reached. Exact currency prices and the payment provider remain paid-beta gates.

## Product decision in one paragraph

TManage is not a collection of Slack, Asana, Notion, Calendar, and Drive clones. It is one work graph where a conversation, task, decision, document, file, approval, objective, and meeting action remain linked to the same context. The product launches web-first as a modular monolith, with strong multi-tenant isolation and a dedicated Client Portal. Desktop follows after web product-market evidence, using Tauri 2 around the shared web interface. Native integrations are optional accelerators—not foundational dependencies.

## Readiness

The planning layer is complete for whole-product UI design and phased software implementation. Claude Code reads the pack directly from the workspace; send file 16 and upload only the primary reference image. The prompt requires Claude to design the actual complete application, not stop at a plan or an MVP dashboard. Start the coding phase with file 17 after the completed design handoff. File 36 is the final handoff. `TManage` remains a provisional commercial brand until file 32 passes.

## Definition of “complete” for planning

This pack covers problem evidence, target segments, role-based desk research, jobs-to-be-done, journeys, MVP requirements, complete product horizon, feature rules, information architecture, 172 named whole-app screens/states, UX principles, owner-supplied visual north star, Limeframe tokens and components, signature patterns, accessibility, light/dark/mobile/desktop/RTL, roles, client access, detailed permissions, data model, API/events, real time, search, files, AI boundaries, security, privacy, testing, observability, deployment, desktop path, governance, KPIs, risks, the locked seat/client/project/storage packaging model, pricing hypotheses still requiring evidence, backlog, alpha plan, Claude/Codex prompts, repository structure, seed data, copy, and execution checklists. Online research replaces unavailable interviews at the current discovery stage; actual alpha usage becomes the next primary evidence source.
