# Pattern — Work Story

**Problem.** An activity log records events; a delivery team needs causality: what was asked, what was
decided, who committed, what changed, what was approved.

**Anatomy.** Chapters on an ink/lime rail: REQUESTED → DISCUSSED → COMMITTED → EXECUTED → REVIEWED →
PUBLISHED → DECIDED → DELIVERED. Each chapter carries actor, time, evidence link, and where relevant a
version badge and audience state. The current chapter uses a lime node with an ink ring.

**Rules.** Chapters are derived from events, never hand-written. A chapter without evidence cannot be
shown as fact. The client projection *removes* internal chapters rather than showing locked placeholders.

**Where.** PRJ-03 (full), WK-09 / DEL-02 / DEC-02 (object scope), Context Lens (last 3 chapters),
CL-11 (client-safe subset).

**Density.** 20-event stories collapse the middle: first two chapters, "12 more", last three.
