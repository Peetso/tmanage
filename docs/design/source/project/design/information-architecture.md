# Information architecture

## The work graph
Request → Discussion → Commitment (work item) → Plan (milestone) → Execution → Internal review →
Publication → Client decision → Final delivery → Evidence. Every object keeps typed edges:
`source` (where it came from), `blocks` / `blocked_by`, `decides` / `decided_by`, `version_of`,
`published_as`, `approved_by`, `belongs_to` (project, milestone), `audience`.

## Object identity in the UI (Work Object DNA)
Type glyph (TSK/DEL/DOC/REQ/DEC/FIL) · title · owner · state capsule · committed date · forecast date ·
audience halo · freshness. This order is fixed across list, board, card, detail and screen reader output.

## Date vocabulary — never interchangeable
- **desired** — client's wish; rendered with "not committed" wherever it appears.
- **committed** — the promise; ink, tabular numerals.
- **forecast** — current expectation; orange when later than committed, with the delta.
- **baseline** — original committed date, shown only in plan and insights comparisons.

## Progress model
Milestone-based. A milestone advances when its evidence items are done or approved; the UI never presents
an average of task completion as progress. Where a percentage is unavoidable (portal), it is expressed as
"stage 2 of 5" with the current stage named.

## Visibility model
Internal by default. Client visibility is a projection, computed per client role from an allowlist, not a
flag on the internal record. Publication creates a governed version; the projection references that exact
version hash.

## Search and evidence
Every synthesized answer (SR-03, AI-01) must cite objects the current actor may see; snippets are
permission-filtered before ranking, and the citation list is part of the answer, not a footnote.
