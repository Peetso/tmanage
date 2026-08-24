# Responsive, tablet and desktop behaviour

| Breakpoint | Shell | Composition changes |
|---|---|---|
| ≥1920 | Rail 88px + Context Rail 248 + canvas 64px padding + Lens pinned 360–520 | Editorial screens gain a fourth metric column; tracks show 6 segments |
| 1440–1919 | Rail 88 + Context Rail 200–248 + canvas 48 + Lens pinned 360 | the built artifacts are drawn at this width |
| 1180–1439 | Rail 72 compact + Context Rail collapsible + canvas 32 | Lens becomes an overlay; metrics drop to two; board shows 3 columns with scroll |
| 900–1179 (tablet landscape) | Rail 72 icon+label, Context Rail as a drawer | split workspaces become list→detail with a back capsule; Pulse Track scrolls horizontally |
| 640–899 (tablet portrait) | Docked Orbs appear, rail hidden | one column; Lens is a sheet; tables become card rows with the same DNA order |
| ≤639 (mobile) | Docked Orbs + quick-action orb | display type 34–40px; Pulse Track becomes a vertical step track or scrollable capsules; 44px minimum targets |

**Not permitted:** a scaled-down desktop layout, a card-only mobile experience with no dense view, or a
mobile screen where the primary action needs scrolling.

**Print / export:** deliverable and approval screens print the artefact plus the decision record
(version hash, actor, time, criteria) on one page. Insights exports the exception list with evidence links.

**Future desktop (Tauri 2):** same web shell. Additions only: native window chrome with the rail inset,
global shortcut for the command surface, offline queue surfaced in the title bar, updater in SYS-05.
No desktop-only navigation model.
