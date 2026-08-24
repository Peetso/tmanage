# TManage — Design Quality Gate and Critique Rubric

## 1. Shipping threshold

The design needs **90/100 or higher**, no critical failure, and no category below 7/10. Claude scores itself with evidence links; a human owner can override only with a written decision.

## 2. Scorecard

| Category | Weight | Full-score evidence |
|---|---:|---|
| Reference DNA fidelity | 15 | Monochrome/acid lime, geometric editorial type, capsules, orbs, radius, whitespace, asymmetry, track, focal card, dark layered panel all appear as a coherent system |
| Original TManage identity | 10 | Work Story, Pulse Track, Focus Capsule, Audience Halo, governed version, Client Preview are recognizably TManage and not copied CRM content |
| Information hierarchy | 10 | Location, meaning, next action, owner, timing, and audience are clear in five seconds on representative screens |
| Whole-product coherence | 10 | Home, dense list, chat, docs, client, insights, admin, mobile, dark, and RTL feel related without identical layouts |
| Workflow completeness | 10 | End-to-end flows include decisions, states, recovery, and preserved context |
| Client experience and safety | 10 | Premium dedicated portal; actions/progress/deadlines clear; no internal leakage or fake hidden controls |
| Design-system depth | 10 | Tokens, components, variants, state contracts, responsive/RTL/theme rules, and deprecation exist and are used |
| Accessibility and inclusivity | 10 | WCAG 2.2 AA evidence, keyboard, non-drag alternatives, focus, reduced motion, high contrast, screen reader, 200% zoom |
| Responsive/desktop quality | 5 | Composition transforms intelligently; no squeezed desktop or card-only mobile |
| Arabic RTL quality | 5 | Native Arabic typography/content, semantic mirroring, mixed-direction correctness |
| Content realism | 3 | Real TManage data/copy, long content, multiple roles, edge cases; no lorem ipsum |
| Developer readiness | 2 | Specs, tokens, component props, assets, behavior, traceability and status are unambiguous |

## 3. Critical failures — automatic rejection

- Uploaded reference image was not inspected or is ignored.
- Design is only a dashboard/MVP subset rather than the whole product.
- Generic blue/purple SaaS language replaces black/paper/lime.
- Client Portal exposes internal-only information or is internal UI with hidden controls.
- Approval is not tied to exact governed version and authority.
- Core workflow cannot be completed keyboard-only or drag is mandatory.
- Arabic is only a mirrored English screenshot with broken direction/content.
- Contrast makes lime, thin text, or dark panels unreadable.
- Final artifacts are descriptions without actual visual screens/components/prototype.

## 4. Anti-generic test

Hide the logo and ask:

1. Can someone identify the product family through Orbital Rail, Pulse Track, Work Story, Focus Capsule, and ink/paper/lime composition?
2. Does the screen still resemble the reference DNA without copying its CRM content?
3. Is the page composition more intentional than a template dashboard?
4. Are at least three TManage-specific relationships visible?
5. Does the operational screen preserve identity without oversized decoration?

If fewer than four answers are yes, return to the stress set before scale-out.

## 5. Reference fidelity checklist

- Acid lime occupies a meaningful focal region on appropriate overview/action screens.
- Black capsules and circular controls have confident scale.
- Large titles/numbers create hierarchy without dominating every screen.
- White cards sit on a light concrete plane with generous spacing.
- Card radii and cut/overlap moments feel intentional.
- Thin outlines and low-shadow depth are consistent.
- The schedule/progress track inspired Pulse Track rather than being pasted decoratively.
- Dark layered context is used for summary/media/high focus only.
- Avatars communicate responsibility or participation.
- The composition has both energy and an underlying grid.

## 6. Dense-data test

Test at least: 200 work rows, 12 board columns, long Arabic titles, 30 filters, 40 channels, 15 client actions, a 20-event Work Story, 12 deliverable versions, and audit pagination. No layout may depend on unrealistically little data.

## 7. State test

Representative screens must show populated, first-use, no-results, loading, partial loading, saving, offline, error/retry, permission denied, access changed, conflict, stale, overdue, blocked, archived, scan failed, invalidated approval, and empty client projection.

## 8. Critique format

For each review, record: screenshot/link, category score, observable problem, user consequence, system-level cause, correction, components/tokens affected, before/after evidence, and regression screens checked. Avoid subjective notes such as “make it pop.”

## 9. Final sign-off

Sign-off requires scorecard, critical-failure checklist, accessibility report, RTL evidence, responsive evidence, screen-status ledger, component inventory, prototype map, and recorded deviations from the reference. Final polish is not approval if coverage or safety is incomplete.
