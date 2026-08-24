# TManage — Claude Design Phase Continuation Prompts

Use file 16 for the first chat. Use these only if Claude stops, a context window ends, or work is intentionally split. Attach the planning pack, current design files, and reference image again when the environment does not retain them.

## Resume rule for every phase

“Read `design/session-handoff.md`, `design/screen-status.md`, `design/decision-log.md`, and `design/component-inventory.md`. Confirm the primary reference image is visible. Continue from the exact next incomplete deliverable. Do not restart strategy or redesign completed work unless it fails file 45.”

## Phase 1 — North star and stress test

“Continue Phase 1 from file 16. Produce the visual-reference analysis and actual high-fidelity stress screens. Apply Limeframe’s monochrome/acid-lime/editorial/capsule/orb/overlap DNA. Design actual TManage workflows, not the CRM reference. Score the set with file 45, correct it until ≥90 with no critical failure, update all status files, then proceed to Phase 2.”

## Phase 2 — Design system

“Using the approved stress screens as evidence, publish the Limeframe foundations and complete component library in file 40. Create every documented variant and state; include accessibility, RTL, responsive, themes, properties, and developer contracts. Remove duplicate/ad hoc components. Update the component inventory and proceed to whole-app scale-out.”

## Phase 3 — Whole-app scale-out

“Design every remaining ID in file 41 by module. Use shared templates only when each screen still has explicit role, hierarchy, action, data, permissions, and states. Preserve visual interest across operational surfaces without making them noisy. Update `screen-status.md` after each module and continue until no ID remains unmapped or visually incomplete.”

## Phase 4 — Prototype

“Connect the ten end-to-end flows in file 16 using the completed screen system. Include success, error, permission, client-boundary, and recovery branches. Verify browser/back behavior, focus, keyboard, mobile, and representative Arabic RTL. Record every prototype starting point and expected outcome.”

## Phase 5 — Audit and handoff

“Run file 45, accessibility, localization, permissions, dense-data, responsive, and developer-handoff audits. Fix all critical/major defects. Export tokens/assets/specs, finalize traceability and screen status, archive explorations, and provide the final completion report defined in file 16.”

## Correction prompt if the output becomes generic

“Stop scale-out. Compare the current screens side by side with the uploaded primary reference and files 39–40. Identify exactly where the design lost the acid-lime focal field, editorial hierarchy, capsules/orbs, disciplined asymmetry, whitespace, track language, featured work object, or dark layered context. Redesign the smallest representative set that proves the corrected system, rescore with file 45, then propagate through components—not screen-by-screen patches.”

## Correction prompt if style harms usability

“Keep Limeframe’s identity but correct hierarchy, density, accessibility, or content problems. Do not retreat to generic enterprise UI. Use the Editorial/Balanced/Operational density model, preserve meaningful whitespace, and express the identity through type, geometry, ink/lime state, Pulse Track, and orbs rather than oversized cards everywhere.”
