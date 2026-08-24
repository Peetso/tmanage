# TManage — Original Vision Gap Audit and Correction Decision

**Audit date:** 14 August 2026  
**Decision:** The planning pack is strong enough to begin MVP engineering, but the previous design handoff was **not** deep or directive enough to produce the whole, world-class application the owner originally requested. This file records that mismatch instead of hiding it.

## 1. Direct answer

No: the previous pack did not fully satisfy the original design ambition.

It correctly defined the product problem, target roles, client role, connected work model, permissions, security, architecture, web-first/desktop-later path, data contracts, MVP behavior, and delivery plan. It did **not** define a sufficiently distinctive visual concept, complete product design horizon, whole-app screen system, or a constrained enough Claude workflow. The old designer prompt explicitly said “Do not add out-of-MVP features” and asked for a “restrained enterprise direction.” That combination encouraged a safe, generic dashboard.

## 2. Request-to-deliverable audit

| Original expectation | Previous coverage | Verdict | Correction |
|---|---|---|---|
| Internet research because interviews are unavailable | Role-based desk research, workplace studies, product patterns, confidence limits, validation plan | Covered, with the declared limitation that desk research is not interview evidence | Keep files 06 and 08; add current interface-pattern research in file 46 |
| Deep user needs and pain points for every role | Owner, admin, manager, member, client admin/reviewer/member/viewer | Covered at product level | Feed each role need directly into navigation and screen priority in files 38 and 41 |
| Complete product, not a shallow task manager | Work graph, chat, work, docs, meetings, files, approvals, automation, AI, client portal | Covered in strategy, but later execution documents narrowed attention to MVP | Separate **complete design scope** from **phased engineering scope** |
| Client role that sees progress, deadlines, and assigned actions | Dedicated Client Portal, client roles, object visibility, approvals, files, timeline | Strongly covered | Preserve; redesign portal as a distinct, premium, low-learning-cost experience |
| Modern, memorable, clearly directed design | A few broad principles, neutral palette, component inventory | Not covered deeply enough | Files 39–42 now define one visual system, layout grammar, tokens, signature patterns, motion, responsive, and RTL |
| Design the whole app | Old prompt centered on MVP screens and six golden flows | Not covered | File 41 is the whole-product screen/state matrix; file 16 now instructs Claude to design the entire product |
| Professional system architecture, frontend/backend choices | Next.js/React/TypeScript, NestJS/Fastify, Hostinger MySQL/MariaDB with Drizzle and tenant constraints, queues, files, search, modular monolith | Covered | Keep as engineering authority; do not let visual exploration alter it silently |
| Security and privacy from every angle | Trusted tenant context, scoped repositories, composite tenant constraints, authorization, client projection, threat models, tests, audit, retention | Covered strongly | Security remains higher authority than visual convenience |
| Web first, desktop later | PWA then Tauri 2 around the shared web experience | Covered | File 42 adds desktop-window and compact/mobile behavior to the design contract |
| Ready for AI designer and AI coder | Coding prompt was actionable; designer prompt left aesthetic and product-horizon gaps | Partially covered | Replace file 16 and add files 43–45 |
| Nothing important left unplanned before design/development | MVP execution was close; complete design horizon was not | Not yet true before this correction | Completion criteria are redefined in section 5 |

## 3. Root causes of the weak design result

1. **The prompt defined behavior but not a design thesis.** “Modern, calm, enterprise” is not a visual direction.
2. **The scope conflicted with the ambition.** Strategy described a whole Work OS while the designer was told not to design beyond MVP.
3. **The screen inventory was a noun list.** It did not define screen families, information density, hierarchy, signature moments, or composition rules across the whole product.
4. **The design system was only an inventory.** It lacked executable tokens, component anatomy, density modes, responsive transformations, and theme behavior.
5. **No anti-generic quality gate existed.** Claude could produce card grids, predictable gradients, and template dashboards without technically violating the prompt.
6. **No design stress-test sequence existed.** A direction must be tested against list, board, chat, document, client approval, analytics, admin, mobile, RTL, light, and dark modes before it becomes the system.
7. **Design and engineering horizons were conflated.** Designing the whole product does not mean coding it all in the first release.

## 4. Corrected scope model

### Product design scope: complete

Claude designs the complete product horizon: public/identity, onboarding, Home, Inbox, Chat, Work, Projects/Portfolio, Calendar/Meetings, Docs/Knowledge, Files/Deliverables, Requests/Decisions/Approvals, Client Portal, People/Capacity, Insights, Search/Command/AI, Automations/Integrations, Administration/Security/Billing, preferences, mobile companion behavior, desktop window behavior, RTL, themes, and system states.

### Engineering scope: phased

The coding agent still implements the validated MVP loop first. Later modules are designed now so the shell, object model, components, navigation, and visual language do not have to be reinvented after launch. A later design is not permission to silently implement out-of-phase features.

## 5. New definition of design-ready

TManage is design-ready only when all of the following exist:

- One explicit visual/interaction north star, not a menu of styles.
- A full product sitemap and screen-family matrix with role ownership.
- Layout grammar for shell, canvas, object pages, inspectors, tables, boards, chat, docs, portal, and admin.
- Light and dark theme tokens, density modes, typography, icons, data visualization, motion, and elevation.
- Signature TManage patterns that are recognizable without the logo.
- Complete responsive transformations and representative Arabic RTL designs.
- Global state coverage: empty, loading, error, permission, offline, sync, conflict, stale, archived, invalidated, and destructive confirmation.
- High-fidelity stress tests across at least twelve radically different surfaces before scale-out.
- A connected prototype for the end-to-end internal and client delivery story.
- A developer-ready component contract and screen/state completion ledger.
- A quality score of at least 90/100 with no critical failure in file 45.

## 6. Files that close the gap

- `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP.md`
- `39-TMANAGE-COMPLETE-DESIGN-BIBLE.md`
- `40-DESIGN-SYSTEM-TOKENS-AND-COMPONENTS.md`
- `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX.md`
- `42-INTERACTION-MOTION-RESPONSIVE-AND-RTL.md`
- `43-CLAUDE-WHOLE-APP-DESIGN-OPERATING-GUIDE.md`
- `44-CLAUDE-DESIGN-PHASE-PROMPTS.md`
- `45-DESIGN-QUALITY-GATE-AND-CRITIQUE-RUBRIC.md`
- `46-DESIGN-REFERENCE-RESEARCH.md`
- `47-PRIMARY-VISUAL-REFERENCE-ANALYSIS.md`
- `contracts/design/tokens.foundation.json`

## 7. Honest residual uncertainty

No planning pack can prove desirability without real users. Desk research can establish plausible needs and expose recurring pain, but it cannot replace observed behavior in TManage. The design must therefore be complete yet testable: all major decisions receive a rationale, risk, validation method, and reversible implementation path. The alpha program remains the point where assumptions become product evidence.
