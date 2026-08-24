# TManage — Design Reference Research

**Research cut:** 14 August 2026  
**Method:** Official product, help, standards, and platform sources. References supply principles and stress-test ideas—not layouts to copy.

## 1. Findings that change the design

### Calm hierarchy in a dense product

Linear’s 2024 redesign describes reducing visual noise, aligning navigation, and testing the same language across inbox, project, list, roadmap, search, and other views. Its March 2026 refresh goes further: supporting chrome should recede so the active task owns attention. TManage adopts the principle of a low-attention Quiet Frame and requires cross-view stress tests, but creates its own four-layer Connected Canvas and client boundary patterns.

Sources: [How Linear redesigned its UI](https://linear.app/now/how-we-redesigned-the-linear-ui), [Linear’s 2026 calmer interface refresh](https://linear.app/now/behind-the-latest-design-refresh).

### One object model, many useful representations

Attio separates its workspace into a sidebar and main panel, combines global search/quick actions with object navigation, and treats objects, lists, and views as related layers. TManage uses this as evidence that a complex system can stay understandable when the object model and representations are explicit. TManage’s own Work Object DNA, however, is delivery-specific and includes audience, commitment, forecast, source, approvals, and Work Story.

Sources: [Navigating an Attio workspace](https://attio.com/help/reference/productivity-collaborating/navigating-your-workspace), [Attio objects, lists, and views](https://attio.com/help/reference/attio-101/attios-data-model/define-your-data-model-objects-lists-and-views).

### Put action next to context

Slack Canvas combines knowledge, files, collaboration, and workflows within a contextual surface. TManage adopts the underlying principle that work should be actionable where its context lives. It does not reproduce Slack’s canvas or channel UI; it uses linked live objects, Context Lens, and message-to-object conversion.

Sources: [Slack Canvas](https://slack.com/features/canvas), [Ways to use canvases](https://slack.com/help/articles/19470130744595-Discover-ways-to-use-canvases).

### Purpose-built before infinitely configurable

Linear’s published method advocates purpose-built tools, “simple first, then powerful,” clarity, and reducing busywork. That supports opinionated TManage defaults and templates, followed by progressive customization rather than a blank database builder on day one.

Source: [Linear Method principles](https://linear.app/method/introduction).

### Adaptive hierarchy, not a squeezed desktop

Apple’s current guidance recommends sidebars for broad hierarchies on larger surfaces, split views when detail should remain in context, and compact tab navigation when space is limited. TManage therefore uses Dock + contextual sidebar + canvas + Context Lens on desktop, transforms secondary panes on tablet, and uses five primary mobile destinations.

Sources: [Apple sidebar guidance](https://developer.apple.com/design/human-interface-guidelines/sidebars), [Apple split views](https://developer.apple.com/design/human-interface-guidelines/split-views), [Apple tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars).

### Accessibility changes the interaction model

WCAG 2.2 adds requirements including Focus Not Obscured, a minimum pointer target criterion, and a non-drag alternative for functionality based on dragging. That directly affects sticky toolbars, boards, timelines, resize handles, and dense data views. TManage requires keyboard/single-pointer alternatives and focus visibility rather than treating accessibility as a visual audit at the end.

Sources: [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [What’s new in WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/).

## 2. Reference-to-TManage translation

| Reference lesson | Use in TManage | Explicitly do not copy |
|---|---|---|
| Linear: navigation recedes; hierarchy remains consistent | Quiet Frame, fixed location/view bars, cross-surface stress tests | Sidebar geometry, typography treatment, colors, issue UI |
| Attio: objects support lists and views | Work Object DNA and view switching without identity loss | CRM information architecture, record page composition |
| Slack: context can contain action | Live linked objects in docs/chat, embedded requests/workflows | Channel chrome, canvas layout, Slack visual language |
| Apple: sidebar/split/tab adapt by space | Desktop panes, tablet overlays, mobile tabs, future desktop windows | Platform-specific Liquid Glass as the product identity |
| WCAG: focus/targets/drag alternatives | Board keyboard moves, visible focus, unobscured active controls, target spacing | Merely checking contrast and claiming compliance |

## 3. White-space opportunity

The opportunity is not to look more futuristic than every competitor. It is to make the entire delivery story legible across internal and external users:

- Chat products preserve conversation but weaken commitment and governance.
- Task products structure work but often detach it from source discussion and client-facing consequences.
- Document products preserve narrative but need manual status maintenance.
- Client portals often become separate reporting surfaces that teams update by hand.

TManage’s design edge is the **visible continuity** between these moments. Work Story, Context Lens, audience seam, governed version, Project Pulse, and true Client Preview must express that edge on screen.

## 4. Design review questions derived from research

- Does the chrome recede after the user knows where they are?
- Can the same object move between list, board, timeline, document, and portal projection without feeling duplicated?
- Is the action available where the relevant context is being read?
- Can a new team begin with an opinionated workflow before learning customization?
- Does the hierarchy adapt at tablet/mobile sizes instead of collapsing into a hamburger-only experience?
- Can every drag action be completed without dragging?
- Is focused content ever obscured by sticky bars, sheets, or toasts?
- Is TManage recognizable without borrowing another product’s visual signature?

## 5. Research limitation

Official product material reveals intended behavior and design rationale but can overstate success. It is used here to generate principles and risks, not prevalence claims. The direction must still pass scenario-based usability tests and later alpha observation with real teams and clients.
