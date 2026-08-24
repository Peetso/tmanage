# TManage — Claude Whole-App Design Operating Guide

## 1. Mission

Claude is a design-production agent, not a brainstorming partner for this handoff. File 16 is the first-chat prompt. This guide defines how to keep a long whole-app design coherent across multiple context windows or sessions.

## 2. Session bootstrap

At the start of every design session, Claude reads:

1. Current `design/screen-status.md` and `design/decision-log.md`.
2. The specific module contract in file 41.
3. Limeframe foundations in files 39–40 and the primary reference image.
4. Relevant detailed behavior from file 22 and permissions from file 12.
5. Unresolved quality findings from file 45.

Claude never restarts visual direction, silently renames tokens, or creates a second component for an existing role without documenting why the first cannot serve it.

## 3. Design production loop

For each module:

1. Map role → job → information hierarchy → primary action → risk.
2. Select a shared screen template before drawing.
3. Reuse published components; list justified gaps.
4. Create low-detail composition only long enough to validate hierarchy.
5. Apply Limeframe and realistic content.
6. Design relevant states beside the populated screen, not in a forgotten appendix.
7. Produce desktop, responsive transformation, and RTL decisions.
8. Connect the flow to preceding/following modules.
9. Run the quality rubric and correct failures.
10. Update status, traceability, component inventory, and decision log.

## 4. Context-persistence files

- `design/session-handoff.md`: current phase, last completed screen, exact next screen, open questions, known defects.
- `design/screen-status.md`: one row per file-41 ID.
- `design/decision-log.md`: decision, reason, affected surfaces, alternatives, evidence, revisit trigger.
- `design/component-inventory.md`: name, status, variants, owner screen, consumers.
- `design/change-log.md`: visual/system changes and migration impact.

At the end of a session, Claude updates these files before summarizing.

## 5. Coherence controls

- One published token source; no raw colors or arbitrary spacing in final artifacts.
- One component per semantic role; variants before duplication.
- Overview, operational, and control-plane density share the same DNA.
- Lime appears as a focal field, but only one major lime region should dominate a viewport unless the Pulse Track requires multiple connected segments.
- Large metrics are limited to meaningful decisions and capped at three per overview zone.
- Every dark panel must have a reason: context, summary, media, or high-focus work—not decoration.
- Intentional overlap must preserve zoom, focus, text reflow, and mobile order.

## 6. Change authority

Claude may refine visual tokens and composition. Claude may not alter roles, client projection, approval/version rules, security, object semantics, or committed/forecast/desired meaning. Any conflict becomes a recorded design/security decision, not a silent visual shortcut.

## 7. Evidence requirements

Every “complete” module links to: screens, relevant state board, responsive example, RTL example or mapped template, prototype path, accessibility check, quality score, and developer annotations. A text description alone is never completion.

## 8. Final handoff structure

The final package separates:

- Foundations and published components.
- Complete screen library.
- Connected prototypes.
- Content/localization.
- Accessibility/quality evidence.
- Developer specs and exported assets.
- Future concepts clearly marked non-release.

Deprecated explorations remain outside published pages so the coder cannot mistake them for implementation authority.
