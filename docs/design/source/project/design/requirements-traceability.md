# Requirements traceability (design ↔ pack)

| Requirement source | Rule | Where it is visible in the design |
|---|---|---|
| 09-MVP-PRD, 22 | New content defaults internal | CH-08 convert panel: Internal preselected + inherited-access warning |
| 12-PERMISSION-MATRIX, 25 | Client sees only allowlisted projection | DEL-05 projection preview, CL-01/CL-05 portal frame, PRJ-01 "what the client can see" |
| 12, 25 | Permission-limited objects are not silently hidden in lists | WK-02 restricted row states existence without content |
| 04-SECURITY, 26 | Publication is an explicit, previewed act | DEL-04 safety check with exclusions and blocking internal link |
| 22 | Approval bound to exact version, authority, actor, time | Governed version track + hash beside every approve action, CL-05 statement |
| 22 | Approval invalidated when version changes | APP-04 invalidated state, disabled Approve, history kept |
| 22 | Request changes requires actionable feedback | CL-05 helper text; APP-03 requires at least one specific point |
| 09, 23 | Invalid state transitions are explained, not just refused | WK-03 "Move not allowed" with cause and two do-instead actions |
| 09 | Desired ≠ committed ≠ forecast | Foundations fields, WK-02 columns, PRJ-01 track, CL-01 wording |
| 11-USER-STORIES | Client understands progress in 30 seconds | CL-01: stage track + days to launch + one action above the fold |
| 15-AI-EXECUTION-HANDBOOK | AI/automation cannot act consequentially without confirmation | AUT-02 "automations can never approve, publish, change access, invite or delete" + activation blocked by permission issue |
| 08, 06 | No productivity scoring | INS-01 measurement policy panel; PEO-02 has no score |
| 42-INTERACTION | Drag is never the only way | WK-03 keyboard move mode with announcer |
| 42 | Reduced motion | tokens.css media query; motion spec per pattern |
| 19-SEED-DATA-AND-COPY | Exact audience/publication/invalidation/empty copy | used verbatim in Foundations, DEL-04, APP-04, states |
| 31-BRAND-FOUNDATION, 39 | Limeframe direction, Manrope + Alexandria | Foundations 01–02 |
| 40 | Token contract | design/tokens/* derived from contracts/design/tokens.foundation.json |
| 41 | 172 screens mapped with statuses | design/screens/screen-status.md |
| 45 | Self-scored quality gate | design/design-quality-scorecard.md |
