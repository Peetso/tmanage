# Design quality scorecard (self-assessed against file 45)

Scope of this score: **the whole 172-screen matrix** across 25 artifacts (Foundations + 24 screen files),
re-scored 15 Aug 2026 after ADM-01…14, BIL-01…03, PREF-01…05 and SYS-04…06 landed. Coverage per ID is in
`screens/screen-status.md`. The previous 85/100 covered only the Phase 1 stress set of 26 screens and is
kept below for comparison.

| Category | Weight | Score | Evidence / why not full |
|---|---:|---:|---|
| Reference DNA fidelity | 15 | 14 | Ink/paper/concrete/lime, capsules, orbs, radius ladder, whitespace, asymmetry, the track, one lime focal card per screen, dark overlapping panels — a system, not a set of one-offs. Held back: overlap moments are still concentrated in Home, publish check and the admin dark cards. |
| Original TManage identity | 10 | 10 | Pulse Track, Work Story, Focus Capsule, Audience Halo, Editorial Metric, Context Lens, governed version track and a real Client Preview all recur across 172 screens. Administration reuses them rather than inventing settings chrome; the offboarding pair (ADM-12/13) is identity-carrying, not generic. |
| Information hierarchy | 10 | 9 | Location, meaning, next action, owner, timing and audience read in five seconds on Home, Project, Inbox, Work, Portal and the admin surfaces. Insights still runs one competing region too many. |
| Whole-product coherence | 10 | 10 | 25 artifacts share type, palette, geometry, selection and orbs across editorial, balanced and operational densities. DOC-02 and WK-04 closed the two unproven families; Administration and Billing sit on one shell, Preferences on a deliberately narrower personal shell. |
| Workflow completeness | 10 | 8 | Request→commitment, chat→work, review→publish→approve, automation dry run, conflict recovery, meeting→summary→actions, search→evidence→action and member offboarding→transfer→receipt are all drawn end to end. Still no clickable prototype — flows 3 and 5 from `prototype-map.md` are the remaining gap. |
| Client experience and safety | 10 | 10 | Portal mode is a real projection, CL-09 intake drawn, exclusions and authority explicit, versions bound to approvals, ADM-04 makes client defaults legible, and every admin action states what the client would see (ADM-12 says plainly: nothing). |
| Design-system depth | 10 | 9 | Tokens (JSON + CSS + themes), inventory, contracts, state matrix, five pattern specs, deprecation rule, and the real brand mark now linked as an asset in every file. A few components remain specified rather than drawn. |
| Accessibility and inclusivity | 10 | 8 | Contrast maths, focus ring, targets, keyboard paths, SR order, reduced motion, labelled orbs, and PREF-04 exposes the whole set to the user. Still no real assistive-tech run. |
| Responsive / desktop quality | 5 | 4 | Four mobile screens composed rather than scaled; breakpoint table with tablet behaviour. Tablet still not drawn. |
| Arabic RTL quality | 5 | 4 | Native Arabic content, Alexandria metrics, semantic mirroring, isolated LTR fragments, long-title test; ADM-04 and ADM-14 carry language into policy. Only two RTL surfaces drawn. |
| Content realism | 3 | 3 | One seed world used everywhere: same people, dates, hashes, 26h wait, 214 rows, 40 channels, and now seats, invoices, retention counts and an offboarding that references the same committed milestone. |
| Developer readiness | 2 | 2 | Contracts, tokens, state matrix, traceability, screen map, handoff entry point. |
| **Total** | **100** | **91** | Was 85 on the Phase-1 subset. |

## Gate decision
**Passes the 90 threshold.** No critical failure from §3 is present. The remaining gap is verification —
a real assistive-tech pass, tablet composition and two clickable prototypes — rather than coverage or
direction.

## Corrections still open (in order)
1. Build prototypes 3 and 5 from `prototype-map.md` — the last workflow-completeness point.
2. Run one real AT pass and one Arabic reader pass (+1 accessibility).
3. Compose tablet WK-02 and CL-01 (+1 responsive).
4. Draw two more RTL surfaces, ideally one admin and one mobile (+1 Arabic).
5. Add one further deliberate overlap moment outside Home and publish (+1 reference DNA).

## Anti-generic test (file 45 §4)
1. Identifiable by rail, track, story, focus capsule, ink/paper/lime — **yes**.
2. Resembles the reference DNA without copying its content — **yes**.
3. More intentional than a template dashboard — **yes**; the admin set is the hard case and it holds:
   consequence cards instead of settings lists, ADM-12 built as an impact story.
4. At least three TManage-specific relationships visible per screen — **yes** (source, blocks, audience,
   version, authority; in admin: who is affected, what the client sees, what is logged).
5. Operational screens keep identity without decoration — **yes** (work list, board, audit log, invoices).

## Previous score for comparison
85/100, Phase 1 stress set (Foundations + 26 screens, 9 artifacts), 13 Aug 2026. Gains since: coherence
+2, workflow +1, client +1, identity +1, system depth +1.
