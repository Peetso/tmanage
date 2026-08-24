# TManage — Complete Product Design Bible

## 1. Visual north star

**Direction name:** Limeframe — Neo-Editorial Work OS  
**Primary reference authority:** `assets/references/TManage-primary-visual-reference.webp`  
**Secondary crop:** `assets/references/Design-System-3.webp`  
**Design feeling:** Bold, crisp, intelligent, optimistic, editorial, and unmistakably modern.  
**Product promise on screen:** Complex work looks clear, connected, and alive—not bureaucratic.

The supplied reference is the visual north star. TManage must share its design DNA without copying its exact screen, content, logo, or layout. This supersedes the earlier conservative graphite/indigo direction.

## 2. Reference DNA — what must survive

1. Near-monochrome foundation: ink black, warm whites, concrete gray.
2. Acid-lime as a confident focal signal, not a tiny conventional accent.
3. Large geometric typography with editorial scale changes.
4. Long capsules for active status, schedules, filters, and primary actions.
5. Circular icon controls and navigation markers.
6. Large soft rectangles with bold radius and thin dark outline where needed.
7. Asymmetrical composition with strong alignment underneath the apparent freedom.
8. Generous negative space that makes dense information feel intentional.
9. Floating tracks/timelines that make time, people, and progress tangible.
10. Small human avatars integrated into the information—not decorative face piles.
11. Black primary controls with white type; lime selected/active/forward motion.
12. A product canvas that feels designed as one composition, not a collection of SaaS cards.
13. A dark, layered summary/context panel that can overlap the light canvas without losing clarity.
14. Featured lime work cards that create a clear focal point among quieter white cards.
15. Controlled overlap between media, context, and action panels to create depth without glassmorphism.

## 3. TManage’s interpretation

The reference shows a single expressive dashboard. TManage needs that expressiveness across a large work operating system. The translation is:

- **Editorial at the overview level:** Home, Project, Portfolio, Client Portal, onboarding, and public pages use large type, whitespace, strong capsules, and decisive composition.
- **Precise at the operating level:** lists, boards, chat, docs, admin, and audit keep the same typography, ink/line/lime logic, and geometry while becoming denser.
- **Focused at the action level:** task, request, approval, deliverable, and decision pages make one next action dominant.

The design must not force giant cards into every dense workflow. It preserves the visual language through geometry, type, outline, selection, and rhythm.

## 4. Product shell

### 4.1 Desktop — Orbital Rail + Canvas

- **Orbital Rail:** 72 px leading rail with circular navigation controls. Active location is black; important attention may use lime with ink icon. Labels appear on hover/focus and in expanded mode.
- **Context Rail:** 224–288 px optional secondary navigation for channels, projects, views, and documents. It is flat, not a stack of cards.
- **Canvas Header:** editorial page title, compact context, and one black capsule primary action. On overview pages the title can reach 48–64 px; operational pages use 28–36 px.
- **Living Canvas:** warm concrete/paper plane. Content can break the strict grid visually but always aligns to a 12-column foundation.
- **Context Lens:** trailing 360 px inspector for relationships, source, access, and activity. It uses a white rounded sheet and can pin, overlay, or transform to mobile.

### 4.2 Top Pulse Track

The reference’s lime schedule strip becomes a TManage signature: **Pulse Track**. It is not a permanent decorative banner. It appears when the surface benefits from a linear story of time or state:

- Home: today’s focus blocks, meetings, and deadlines.
- Project: milestone progress from now to committed delivery.
- Deliverable: version → internal review → client review → approved → final.
- Request: received → clarified → committed → planned.
- Client Portal: current milestone, next action, and next date.

The active/current segment is lime. Completed history may be ink. Future/unknown is outlined paper. Avatars and time labels sit inside the track only when they add meaning.

### 4.3 Mobile — Docked Orbs

Use a five-item bottom dock with circular/orb buttons inside a soft capsule, plus a black/lime quick-action orb. Labels are always available; never depend on icon recognition. The Pulse Track becomes horizontally scrollable or a vertical step track depending on the task.

## 5. Signature TManage patterns

### Work Story

A connected visual narrative from source conversation/request through commitment, execution, decision, review, approval, and delivery. Chapters use black/lime track segments and expandable evidence. This is more meaningful than a generic activity log.

### Pulse Track

A time/state capsule system derived from the reference. It makes the next event, people, timing, and progress visible in one glance.

### Focus Capsule

The most important next action appears as a black capsule with a lime internal marker or lime completion movement. It answers “why now” beside or below the label.

### Audience Halo

Internal/client/action-required meaning appears as a compact outlined ring around the audience icon/label. Client publication adds a visible lime-to-violet seam only at the boundary; the main visual identity remains black/paper/lime.

### Project Number Field

Large editorial numerals are used for a few meaningful measures—days to milestone, approvals waiting, blocked commitments—not generic KPI counts. Each number is paired with plain-language meaning and source.

### Client Preview Shift

Internal black rail disappears and a simplified portal frame appears. The portal uses more paper white, a lime progress/action track, larger type, and fewer controls. A persistent black preview capsule names the client role and exit action.

## 6. Color system

### Core palette

- **Ink `#090A09`:** primary typography, active navigation, buttons, decisive states.
- **Paper `#F7F7F3`:** high-priority cards and client surfaces.
- **Canvas `#E9E9E5`:** main background.
- **Concrete `#D5D6D1`:** recessed zones and inactive tracks.
- **Acid Lime `#B7FF57`:** current, selected, focus, forward action, live progress.
- **Lime Strong `#9CEA3F`:** hover/pressed and small contrast detail.
- **White `#FFFFFF`:** controlled highlight, not the entire product.

Semantic colors are deliberately small accents inside the monochrome system:

- Success green `#1D8A63` for approved/delivered when lime would mean “current.”
- Warning orange `#E58A24` for risk/waiting.
- Danger red `#D9474F` for destructive/security/failed.
- Client violet `#7755C7` only for external boundary and client identity—not general decoration.

Lime never carries warning, success, and selection simultaneously. Its primary meaning is **active/current/forward**.

## 7. Typography

- Latin: **Manrope Variable**; fallback Geist, Inter, system sans.
- Arabic: **Alexandria Variable**; fallback IBM Plex Sans Arabic, Noto Sans Arabic.
- Technical: Geist Mono.
- Display: 56–72 px desktop, 40–48 tablet, 34–40 mobile.
- Overview titles: 40–56 px.
- Operational titles: 28–36 px.
- UI body: 14–16 px; dense metadata 12–13 px.
- Use weight contrast before using many colors.
- Large headings may use tight tracking; Arabic keeps natural letter behavior and increased line height.
- Oversized numerals use tabular forms when values update.

## 8. Geometry

- Capsule radius: `999 px`.
- Circle controls: 40, 48, 56, or 64 px.
- Operational control: 36–44 px high, radius 12–18 px.
- Small surface radius: 16 px.
- Standard card/panel: 24 px.
- Feature/client card: 32 px.
- Sheet/dialog: 28 px; full-screen mobile sheet: top corners 28 px.
- Border: 1 px quiet gray; 1.5–2 px ink for expressive outlines and current structure.
- Shadows: extremely restrained; use solid plane contrast and border first.

## 9. Layout and spacing

- 12-column desktop grid, 8 tablet, 4 mobile.
- Base unit 4 px; common rhythm 8/12/16/24/32/48/64.
- Overview screens reserve 25–40% of the first viewport for hierarchy and whitespace, not card content.
- Dense screens can use 32–40 px rows, but headers and actions still breathe.
- Asymmetry is controlled: large title or number may occupy an offset column while operational content aligns below.
- Do not center everything. The reference’s energy comes from contrast between strict alignment and intentional offset.

## 10. Component expression

### Buttons

- Primary: black capsule, white label, optional darker circular leading segment; lime hover/progress detail.
- Active/forward: lime capsule, black label.
- Secondary: paper/transparent capsule with ink border.
- Icon: circular; selected black or lime.
- Destructive remains red/ink with explicit consequence, never lime.

### Filters and tabs

Outlined capsules; selected filter becomes paper/black or lime/black depending on importance. Avoid dozens of pills—overflow moves into a filter builder.

### Cards

Large radius, generous internal space, clear name/title, one dominant status/action, and light metadata. Board/list density uses smaller radii and fewer nested containers.

### Tables

No spreadsheet-grid aesthetic. Use strong column rhythm, open rows, subtle horizontal lines, black current selection edge, lime focus/current marker, and a rounded container only when the whole table is a distinct object.

### Charts

Large editorial labels, thin ink lines, lime current period, direct annotations. Avoid rainbow dashboards, donut charts, and unexplained scores.

### Inputs

Soft paper/concrete field, strong ink label, 14–18 px radius, lime/ink focus treatment. Long forms use clear sections and progressive disclosure, not dozens of floating cards.

## 11. Screen family direction

### Home / My Day

Hero title + top Pulse Track + one Focus Capsule + asymmetric cluster of due/blocked/waiting work. A small number of large editorial measures replaces KPI card rows.

### Inbox

Split list/detail. Bundles are open rows with circular avatars and lime action markers. Important items can extend into a capsule track showing source → action → consequence.

### Chat

Conversation stays visually quiet. Threads and linked work use outlined soft surfaces; the message-to-task action opens a focused capsule composer. Client-shared channels show a persistent audience seam.

### Work list / board / timeline

The operational core is denser. Active views/filters are capsules; current selection uses ink/lime; cards retain large type at a smaller scale. Timeline uses Pulse Track grammar.

### Project overview

Large project name, commitment/forecast numbers, milestone Pulse Track, and a structured open canvas for work, risks, client wait, and updates. No row of six equal KPI cards.

### Docs

Paper sheet on concrete canvas, generous type, live-object capsules, circular comment markers, and Context Lens. Document content stays readable rather than overly stylized.

### Deliverable / approval

The governed artifact owns the canvas. Version status is a track; Approve is lime, Request changes is black/outlined; exact version and authority are impossible to miss.

### Client Portal

Most expressive customer-facing mode: paper surface, large status typography, lime Pulse Track, black action capsules, very few controls, human project contact. It should feel premium, not “guest access.”

### Insights

Editorial report composition: 2–3 large meaningful figures, direct trends, exception lists, and linked evidence. No generic analytics template.

### Admin / automation

More restrained but same geometry. Black section titles, circular step markers, lime validated/active state, clear impact preview. Complex policies use open structured forms, not playful cards.

## 12. Dark mode

Dark mode is a deliberate inversion, not gray-on-gray:

- Canvas `#121311`, surface `#1B1D19`, elevated `#242720`.
- Ink becomes `#F5F6F0`; lines `#3A3E35`.
- Lime becomes slightly less luminous `#A9ED55` to control glare.
- White cards become deep olive/graphite planes.
- Black primary capsules become lime when placed on very dark surfaces, or light paper capsules for secondary emphasis.
- Preserve the high-contrast editorial relationship.

## 13. Motion

Motion feels precise and spatial:

- Pulse Track progress glides 240–320 ms; never loops decoratively.
- Capsule selection uses fill sweep or 2–4 px translation under 180 ms.
- Context Lens slides/fades 220–260 ms.
- Cards do not float/bounce on hover; use border, fill, or 1–2 px lift only.
- Completion may move the active lime point to the next state; no confetti.
- Reduced motion replaces geometry changes with instant state + short fade.

## 14. RTL and Arabic

- Orbital Rail moves to the right; Context Lens moves to the left.
- Pulse Track starts from the right for chronological interface flows unless a universal left-to-right time/chart convention is required; document each exception.
- Capsules, avatars, arrows, and label groups reorder semantically—not with a blind transform.
- Alexandria is used for the same expressive geometric feeling.
- Arabic titles may require smaller size or two-line composition; never squash tracking.
- URLs, emails, hashes, file names, code, and many time expressions are isolated LTR.

## 15. Stress-test requirement

Claude must first create one **Visual North Star board** from the supplied reference and then 12 connected high-fidelity TManage stress screens: Home, Inbox, Chat/thread, Work list, Board, Project overview, Document, Deliverable review, Client preview, Client approval, Insights, and Admin/automation. Include light/dark, populated/empty/error, mobile, and representative Arabic RTL.

No scale-out is allowed until the direction scores at least 90/100 in file 45 and clearly resembles the reference’s DNA in palette, type, geometry, rhythm, and composition.

## 16. Anti-copy / anti-generic guardrails

The result fails if it:

- reproduces the supplied CRM content/layout instead of designing TManage;
- uses a conventional blue/purple SaaS palette;
- turns lime into a tiny accent while most of the product looks generic;
- creates a standard left sidebar + top bar + six KPI cards dashboard;
- uses one size of rounded card everywhere;
- has no large editorial type, asymmetry, Pulse Track, or circular control language;
- sacrifices task clarity, data density, accessibility, or Arabic quality for style;
- makes every screen visually loud; contrast requires quiet working surfaces.
