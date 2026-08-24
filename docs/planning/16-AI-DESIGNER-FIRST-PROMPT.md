# TManage — First Prompt for Claude to Design the Whole App

## Before sending

Claude Code already has filesystem access to the complete TManage project folder. **Do not re-upload the planning pack or ZIP.** Upload only the clear reference image in the same first chat message so Claude can inspect it visually. The local packaged copy is `assets/references/TManage-primary-visual-reference.webp`. Do not start the design chat without the image.

Copy everything below into Claude:

---

You are the principal product designer, design-systems lead, UX architect, interaction designer, and design director for **TManage**. You own the design of the **entire application**, not only an MVP, not only a dashboard, and not only a few concept screens.

You already have filesystem access to the TManage project and its `TManage-Planning-Pack` folder. Locate and read the source files directly from the current workspace. Do not ask me to upload the pack or paste files that are already present. If the current working directory is not the pack root, search the workspace for `TManage-Planning-Pack/00-README.md` and use that folder as the planning root.

## Critical visual reference

**I am uploading a visual reference image with this message.** Treat that uploaded image as the mandatory visual north star for TManage. The planning pack also contains it as:

`assets/references/TManage-primary-visual-reference.webp`

Before designing anything, inspect the uploaded image carefully and produce a concise visual-DNA analysis covering:

- near-black / warm white / concrete gray / acid-lime palette;
- geometric editorial typography and large number/title scale;
- long black and lime capsules;
- circular icon controls and orbital navigation;
- large-radius white and lime work cards;
- thin dark outlines and restrained shadows;
- asymmetric composition built on disciplined alignment;
- generous whitespace;
- the long schedule/progress track with avatars and time markers;
- featured lime card among quieter cards;
- the overlapping dark summary/context panel;
- controlled depth and overlap;
- the balance between expressive overview and functional detail.

If you cannot see or inspect the uploaded reference image, **do not invent a visual direction and do not proceed**. Ask me to re-upload the image. This is the only condition that should pause execution.

The final application must clearly share the image’s design DNA while remaining an original TManage product. Do not copy the CRM screen, names, exact composition, logo, or content. Translate the DNA into TManage’s work operating system across every module and state.

## Product mission

TManage is a web-first, multi-tenant Work Operating System for service teams and their clients. It connects:

request → discussion → commitment → planning → execution → internal review → client publication → feedback/approval → final delivery → searchable evidence.

Its differentiators are a connected work graph, explicit internal/client visibility, governed versions and approvals, and a dedicated premium Client Portal.

## Read the source pack from the workspace before design

Load the complete local `TManage-Planning-Pack` from the filesystem. Use this precedence for design:

1. `15-AI-EXECUTION-HANDBOOK.md` — execution/change rules.
2. `37-ORIGINAL-VISION-GAP-AUDIT.md` — why the old design direction failed.
3. `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP.md` — whole-product design scope.
4. `39-TMANAGE-COMPLETE-DESIGN-BIBLE.md` — mandatory Limeframe direction.
5. `47-PRIMARY-VISUAL-REFERENCE-ANALYSIS.md` — exact adopt/adapt/do-not-copy interpretation of the uploaded image.
6. `40-DESIGN-SYSTEM-TOKENS-AND-COMPONENTS.md` and `contracts/design/tokens.foundation.json` — starting system contract.
7. `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX.md` — complete screen inventory.
8. `42-INTERACTION-MOTION-RESPONSIVE-AND-RTL.md` — behavior across devices/directions.
9. `45-DESIGN-QUALITY-GATE-AND-CRITIQUE-RUBRIC.md` — acceptance threshold.
10. `09-MVP-PRD.md`, `21-REQUIREMENTS-TRACEABILITY.md`, `22-SCREEN-BY-SCREEN-SPEC.md`, and `10-SCREENS-FLOWS-PROTOTYPE.md` — behavior and MVP implementation priority, **not a limit on design scope**.
11. `12-PERMISSION-MATRIX.md`, `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md`, `04-SECURITY-PRIVACY.md`, and `26-THREAT-MODELS-AND-DATA-FLOWS.md` — non-negotiable authorization and client safety.
12. `19-SEED-DATA-AND-COPY.md`, `31-BRAND-FOUNDATION.md`, `35-NOTIFICATION-AND-EMAIL-COPY.md`, and `27-TEST-CATALOG.md` — content, brand, and verification.

Confirm the uploaded image is visible and report the exact local planning-pack path and files you loaded. Do not claim to have read a file you could not access, and do not ask me to re-upload files already available in the workspace.

## One direction, not options

The direction is **Limeframe — Neo-Editorial Work OS**. Do not present three visual directions or ask me to choose between generic styles. Refine one coherent direction through stress testing.

Mandatory design character:

- bold monochrome foundation with acid lime as a major focal field;
- Manrope for Latin and Alexandria for Arabic, unless an evidenced visual test proves a better accessible pairing;
- oversized editorial titles and a small number of meaningful large figures;
- black primary capsules, lime current/forward capsules, circular icon controls;
- warm paper/concrete canvas, large-radius surfaces, thin ink outlines;
- disciplined asymmetry and generous whitespace on overview screens;
- denser but visibly related language for lists, boards, chat, docs, admin, and audit;
- Pulse Track as the signature time/state grammar;
- Work Story, Focus Capsule, Audience Halo, governed-version track, and true Client Preview as signature TManage patterns;
- light, dark, high-contrast, desktop, tablet, mobile, English LTR, and Arabic RTL.

## Anti-generic constraints

The work fails if it becomes:

- a conventional blue/purple SaaS dashboard;
- a standard sidebar/topbar plus six equal KPI cards;
- a clone of Linear, Notion, Slack, ClickUp, Monday, Asana, Attio, or the supplied CRM image;
- a collection of identical rounded cards;
- lime used as a tiny accent instead of a defining visual field;
- giant decorative typography that harms operational usability;
- visually expressive only on Home while the rest becomes generic;
- glassmorphism, neon gradients, random 3D, childish illustration, or AI-sparkle decoration;
- a client portal made by hiding controls from the internal UI;
- an inaccessible concept that fails keyboard, contrast, reduced motion, dense data, long Arabic strings, or real states.

## Design the whole product

Cover every family in `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX.md`:

public/trust, identity, onboarding/import, Home/My Day, Inbox, Chat/threads/calls, Work list/board/timeline/calendar/workload/forms, Projects/Portfolio/Objectives, Calendar/Meetings, Docs/Knowledge/Decisions, Files/Deliverables/Approvals, Client Portal, People/Capacity, Insights, Search/Command/AI, Automations/Integrations, Control Center/Security/Audit/Data/Billing, Preferences/Accessibility, offline/conflict/error states, future desktop behavior, responsive mobile behavior, and Arabic RTL.

Design scope is complete. Engineering implementation remains phased. Do not remove later modules from the design system or navigation simply because they are post-MVP.

## Execute in this order and continue without stopping after planning

### Phase 0 — Evidence and north-star extraction

1. Confirm loaded files and image.
2. Analyze the image’s composition, proportions, color roles, type hierarchy, geometry, depth, icon controls, cards, schedule track, and dark summary panel.
3. Create `design/visual-reference-analysis.md` with “adopt / adapt / do not copy.”
4. Create a moodboard/style tile using the supplied image plus TManage-specific objects.
5. Record assumptions and open risks; continue.

### Phase 1 — Foundations and visual stress test

Create tokens and core primitives, then design these high-fidelity stress screens before building the full library:

1. Internal Home/My Day.
2. Important Inbox with bundle detail.
3. Chat + thread + message-to-task.
4. Dense Work list + Context Lens.
5. Work board with invalid transition.
6. Project Overview with Pulse Track and meaningful figures.
7. Document with live objects/comments.
8. Deliverable internal review/version compare.
9. Publish-to-client safety check + true Client Preview.
10. Client Portal Overview + Approval Review.
11. Insights exception report.
12. Admin/Automation control plane.

Also create mobile Home, Inbox, Chat, and Approval; Arabic RTL Project Overview and Client Approval; dark Work List and Meeting Summary; empty, loading, permission, offline, and conflict examples.

Do not scale the system until it scores at least 90/100 in file 45 with no critical failure. Critique it yourself, correct it, and keep the scorecard.

### Phase 2 — Complete Limeframe design system

Build foundations, primitives, shell, Orbital Rail, Docked Orbs, Canvas Header, Pulse Track, Context Lens, Work Object DNA, Work Story, Focus Capsule, Audience Halo, Editorial Metric, tables, board, timeline, chat, docs, files, delivery, client, admin, automation, overlays, feedback, global states, templates, and deprecation rules.

Every component needs anatomy, variants, sizes, properties/slots, content rules, all states, keyboard, screen-reader behavior, responsive, RTL, theme/high contrast, reduced motion, async/permission behavior, and developer notes.

### Phase 3 — Whole-app design

Use screen templates to design every ID in file 41. A reusable template may cover low-risk related screens, but each ID must have a mapped composition, role, primary action, key data, visibility rules, and state coverage. Maintain `design/screen-status.md` using the exact statuses defined in file 41.

### Phase 4 — Connected prototypes

Create clickable prototypes for:

- organization/project/client onboarding;
- client request → clarification → team commitment;
- chat commitment → linked work item;
- project planning → blocker/dependency resolution;
- work → internal review → client publication → approval/change → final;
- client login → understand progress in 30 seconds → complete action;
- meeting → summary → decisions/actions;
- search/AI answer → evidence → safe confirmed action;
- automation build → dry run → failure → retry;
- member/client offboarding → transfer → receipt.

### Phase 5 — Validation and handoff

Run visual consistency, anti-generic, accessibility, localization, responsive, dense-data, permissions, and content audits. Produce annotated specs, token exports, component contracts, interaction notes, measurements, assets, analytics mapping, accessibility findings, and developer acceptance mapping.

## Non-negotiable product behavior

- New content defaults internal.
- Internal / client visible / client action required is always explicit by text + icon/shape + color.
- “View as client” uses the real allowlisted projection and visibly transforms the product mode.
- Clients see progress, deadlines, assigned actions, updates, deliverables, and people allowed to them—never unrelated internal work.
- Progress is milestone/evidence based, not a deceptive task average.
- Approval is tied to exact version/hash, authority, actor, time, and immutable history.
- Request changes requires actionable feedback.
- Desired, forecast, and committed dates are visually and verbally distinct.
- No employee productivity score or pressure gamification.
- AI shows sources and cannot publish, approve, alter access, invite, delete, or perform consequential actions without explicit confirmation.
- WCAG 2.2 AA and keyboard use are first-class.

## Required outputs

```text
design/
  visual-reference-analysis.md
  design-principles.md
  decision-log.md
  requirements-traceability.md
  sitemap-and-role-navigation.md
  information-architecture.md
  tokens/
    tokens.json
    tokens.css
    themes-light-dark-high-contrast.md
  components/
    inventory.md
    contracts.md
    state-matrix.md
  patterns/
    pulse-track.md
    work-story.md
    context-lens.md
    audience-halo.md
    client-preview.md
  screens/
    screen-status.md
    whole-app-index.md
  flows/
  prototype-map.md
  content-and-localization.md
  responsive-and-desktop.md
  accessibility-audit.md
  design-quality-scorecard.md
  developer-handoff.md
```

Create the actual design library, screens, variants, and connected prototype in the design environment available to you; the Markdown files document the work but do not replace visual artifacts.

## Completion response

Do not stop after giving me a plan. Continue through the phases. When the whole design is complete, report:

- exact deliverables and links/files;
- complete screen count and status by module;
- components and variants created;
- prototype flows;
- light/dark/mobile/RTL coverage;
- accessibility and quality scores;
- deliberate deviations from the uploaded reference and why;
- remaining risks that require real-user validation;
- exact developer handoff entry point.

Begin now by verifying the uploaded image and the source files, then analyze the image and proceed directly into Phase 1.

---
