# TManage — Design Decision Log

| # | Date | Decision | Rationale | Affects |
|---|---|---|---|---|
| 1 | 2026-08-14 | Direction locked to Limeframe; no alternative visual directions presented | File 39 §1 and brief: one direction, stress-tested | whole system |
| 2 | 2026-08-14 | Rail orbs carry permanent 10px labels instead of hover-only tooltips | Icon-only navigation fails WCAG 2.2 AA and Arabic comprehension | OrbitalRail, DockedOrbs |
| 3 | 2026-08-14 | Ink text on all lime fields; white on lime prohibited | 1.5:1 contrast white-on-`#B7FF57` vs 12.9:1 ink-on-lime | tokens, all lime components |
| 4 | 2026-08-14 | Pulse Track segments always carry a text state label plus lime fill | Colour cannot be the only state carrier | PulseTrack |
| 5 | 2026-08-14 | Editorial Metric limited to 3 per region and requires a meaning line + source | File 47 §4; prevents KPI-card regression | EditorialMetric |
| 6 | 2026-08-14 | White cards get a 1px `line.300` outline rather than shadow | Survives high contrast, dark inversion, and print | WorkCard, all surfaces |
| 7 | 2026-08-14 | Avatars rendered as ink/lime initial orbs until real assets arrive | No stock photography in system artifacts | Avatar |
| 8 | 2026-08-14 | Three composition densities share one visual language | Reference has no dense case; 200-row test must pass | layout tokens |
