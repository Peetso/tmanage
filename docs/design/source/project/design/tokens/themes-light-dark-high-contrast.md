# Themes — light, dark, high contrast

## Light (default)
Canvas `paper.150` #E9E9E5, rail `paper.350` #E4E4DF, surfaces white and `paper.50`, text `ink.*`,
one lime focal field per viewport. Cards carry a 1px `line.300` outline instead of a shadow.

## Dark (deliberate inversion)
Canvas #121311, rail #171814, surface 1 #1B1D19, surface 2 #242720, line #3A3E35, ink #F5F6F0.
Changes that are not a simple colour swap:

- Lime drops to #A9ED55 and lime *fields* shrink: large lime planes glare on near-black. A lime plane
  larger than a capsule becomes `limePlane` #29351D with #A9ED55 text.
- Black primary capsules become paper (#F5F6F0 on ink text) or lime when the surface is very dark.
- Warning/danger shift to #E9A85C / #FF7780 to hold 4.5:1 on #1B1D19.
- Client violet becomes #A98AE5.
- Selection edge is #F5F6F0, not lime — lime stays reserved for current/live.

Verified pairings (contrast): ink #090A09 on lime #B7FF57 = 12.9:1 · #F5F6F0 on #1B1D19 = 14.1:1 ·
#A7ACA0 on #1B1D19 = 6.4:1 · #A9ED55 on #121311 = 11.6:1 · #E9A85C on #1B1D19 = 6.9:1.

## High contrast
`[data-contrast="high"]`: quiet lines adopt `line.700`, border widths rise to 1.5px, muted text
promotes to `ink.800`, dashed "future" states gain a leading glyph, and every capsule keeps a visible
1.5px edge so state is legible without relying on fill.

## Theme switching rules
Theme is per user (`PREF-02`) with system option. Pulse Track segment *order* and labels never change
between themes — only fill values. Screenshots for visual regression exist for light, dark and
high-contrast on HOME-01, WK-02, CL-01, DEL-04, AUT-02.
