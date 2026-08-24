# TManage — UX, UI, and Design System

> **Visual-system supersession (14 August 2026):** Sections in this file remain UX behavior principles. Files 39–42 and 47 are the current visual, token, component, interaction, responsive, and RTL authority. Where this file mentions conservative indigo/blue styling, Inter, small radii, or the old shell, the Limeframe black/paper/acid-lime direction supersedes it.

## 1. Experience strategy

The interface must feel calm under heavy work. Density is allowed, ambiguity is not. The design system optimizes for “scan, decide, act” and separates internal from client-visible context unmistakably.

## 2. Product UX laws

- One primary action per state; secondary actions stay reachable.
- Every item answers: what is it, who owns it, what happens next, when, and who can see it.
- Status changes happen in context; avoid routing users to admin screens.
- Destructive, external, permission, and approval actions require clear consequence text.
- All asynchronous actions show pending/success/failure and safe retry.
- Empty states teach the workflow with realistic examples, not marketing copy.
- Preserve user context across navigation with split panes, drawers, and back-stack behavior.
- Mobile supports triage, approval, chat, and updates; complex planning remains desktop-first.

## 3. Navigation and page anatomy

Desktop uses a collapsible global rail, contextual sidebar, main canvas, and optional detail pane. Small screens use bottom navigation for Home, Inbox, Chat, Work, and More. The command palette is available via `Ctrl/Cmd+K`.

Core object pages share a header pattern: identity and breadcrumb; state, owner, dates; audience badge; primary action; overflow; tabs for Overview, Discussion, Files, Decisions, Activity.

## 4. Client Portal experience

The portal must answer three questions above the fold:

1. Where does the project stand?
2. What needs my attention?
3. What happens next and when?

Use plain client language instead of internal workflow jargon. Progress is milestone-based, not a misleading average of task completion. Each client action card includes required action, consequence, owner, due date, artifact version, and estimated review time. A persistent `Client view` banner prevents internal users from mistaking the external surface for their own workspace.

## 5. Key interaction specifications

### Message to task

Hover or long-press → “Create work item” → prefilled title and project suggestion → choose owner/date/audience → create. The source message receives a linked badge. Task shows the source thread with inherited access warning; sharing externally requires a deliberate audience decision.

### Publish to client

Select object/version → system checks missing title, owner, due date, audience conflicts, sensitive fields, and linked internal-only content → preview as each client role → publish → audited notification. Never bulk-switch visibility silently.

### Approval

Reviewer sees artifact, criteria, prior version difference, due date, and buttons: Approve or Request changes. Request changes requires actionable feedback. Approval records version hash and becomes invalid if governed content changes.

### Project pulse

System drafts: achieved, next, risks, decisions, dates, asks. Manager edits, previews client-safe version, then publishes. AI never publishes automatically.

## 6. Design language

- Tone: precise, composed, capable; no gamification of work pressure.
- Typography: Manrope Variable for Latin, Alexandria Variable for Arabic, Geist Mono for technical content; tabular numerals for dates/metrics.
- Base spacing: 4px grid; common increments 8/12/16/24/32.
- Radius: 14px controls, full capsules, 24px standard cards, 28–32px feature/sheet surfaces; operational density may reduce surface radius while preserving the same geometry.
- Color: ink black, warm paper/concrete, and acid lime as the defining visual field; small semantic green/orange/red and a restrained violet client boundary.
- Audience is communicated by icon + label + color, never color alone.
- Shadows are limited to overlays and elevation changes.
- Charts show definitions, time range, and accessible tables.

## 7. Component inventory

Foundation: tokens, typography, iconography, focus ring, motion, breakpoints. Inputs: text, select, people picker, date, rich text, upload, command menu. Work: status, priority, assignee, due date, dependency, audience, progress, activity. Collaboration: message, thread, mention, presence, reaction, comment, decision, approval. Layout: rail, sidebar, split pane, tabs, drawer, modal, toast. Data: table, board, timeline, calendar, workload, chart. Client: action card, deliverable viewer, version comparator, approval panel, external banner.

Each component ships with anatomy, variants, states, keyboard behavior, accessibility name, error copy, loading/skeleton behavior, analytics event, and visual regression stories.

## 8. Accessibility baseline

- WCAG 2.2 AA target from first sprint.
- Visible focus; logical tab order; skip links; landmarks; heading hierarchy.
- Core boards, tables, dialogs, menus, and date pickers fully keyboard operable.
- Minimum 44×44 CSS-pixel touch targets for primary mobile actions.
- Contrast ≥4.5:1 for normal text; reduced-motion support.
- Live regions for relevant async results, not every real-time event.
- Status and audience never encoded only by color.
- Screen-reader tested main journeys using NVDA/Chrome and VoiceOver/Safari.
- Localization supports Arabic RTL and English LTR from architecture start; mirrored layout without mirroring media or time direction incorrectly.

## 9. Content design

- Use verbs: “Publish to client,” not “Submit.”
- State consequences: “This will notify 3 client reviewers.”
- Replace blame language (“You missed”) with factual state (“Due 2 days ago”).
- Dates show absolute date and helpful relative label; timezone is explicit in cross-zone contexts.
- Permission errors explain what is unavailable and who can grant access without leaking hidden object names.

## 10. Research and testing program

- Current discovery uses structured online desk research by role: workplace studies, official product behavior, practitioner discussions, reviews, and competitor workflows.
- Code evidence as observation, context, pain, workaround, consequence, confidence, and product implication; down-weight vendor promotion and single anecdotes.
- Prototype testing can use remote unmoderated tasks, expert cognitive walkthroughs, accessibility review, and public feedback when direct interviews are unavailable.
- During private alpha, opt-in observed sessions, support issues, short in-product surveys, and behavioral funnels replace desk assumptions with product evidence.
- Never infer user intent solely from clicks, and never claim desk research proves prevalence.

## 11. UX acceptance metrics

- First-time client locates required action in ≤15 seconds.
- Client approval completion median ≤90 seconds excluding artifact review.
- Team member converts message to correctly scoped task in ≤30 seconds.
- Manager publishes client-safe pulse in ≤5 minutes.
- ≥90% success for keyboard-only core tasks.
- ≥95% of tested users correctly identify whether an object is client-visible.
