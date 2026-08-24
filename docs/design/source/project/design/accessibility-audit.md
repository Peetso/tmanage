# Accessibility audit (WCAG 2.2 AA target)

## Passing evidence
- **Contrast.** ink #090A09 on lime #B7FF57 12.9:1 · ink on paper 19.6:1 · body #4D5049 on #E9E9E5 7.1:1 ·
  muted #74786F on #FFFFFF 4.6:1 · dark #F5F6F0 on #1B1D19 14.1:1 · #A7ACA0 on #1B1D19 6.4:1 ·
  #A9ED55 on #121311 11.6:1 · warning #C96F18 on white 4.6:1 · danger #D9474F on white 4.5:1.
  White-on-lime is prohibited by token law.
- **Colour is never alone.** Every state capsule pairs fill with a word and a distinct dot shape
  (circle = flowing state, square = blocked, check = approved, dashed = invalidated).
- **Focus.** 2px ink ring + 3px lime halo (inverted in dark). Never clipped by sticky headers; the Lens
  and sheets return focus to the trigger.
- **Targets.** 44px on mobile primary actions and dock orbs; ≥32px with 8px spacing in operational rows.
- **Drag alternatives.** Board move has a keyboard mode with a live announcer ("column 3 of 12,
  ← → choose column, Enter confirm"). Milestone reordering has a list editor.
- **Screen reader order.** Fixed object read order: type, title, owner, state, committed, forecast,
  audience, next action. Pulse Track exposes an ordered list with "step n of m, current".
- **Reduced motion.** Track glides and capsule sweeps become instant state changes with a 120ms fade.
- **Zoom.** Editorial screens reflow at 200% because hero, metrics and content are separate flex regions,
  not absolutely positioned; dense tables scroll horizontally with a sticky first column.
- **Labels.** No icon-only navigation anywhere, which is the main deliberate deviation from the reference.

## Open items before sign-off
1. Real AT passes (NVDA + Windows, VoiceOver + macOS/iOS) on WK-02, DEL-04, CL-05 — not yet run.
2. Arabic screen-reader review with a native reader (pronunciation of mixed LTR fragments).
3. Board keyboard mode needs a documented escape path when a column is filtered out mid-move.
4. High-contrast rendering of dashed "future" segments needs a glyph, currently specified but not drawn.
5. 200% zoom evidence screenshots for the portal are outstanding.
