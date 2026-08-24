# Prototype map

Status: **all ten flows are built and clickable**, across three prototype files (rail to jump, primary
action to advance, orange action to take the failure or permission path):

- `TManage Prototype - Flows 3 and 5.dc.html` — flows 3, 5
- `TManage Prototype - Flows 1, 2 and 6.dc.html` — flows 1, 2, 6
- `TManage Prototype - Flows 4, 7, 8, 9 and 10.dc.html` — flows 4, 7, 8, 9, 10

Flow 8 is prototyped as SR-01 → SR-02 → SR-03 → AI-03 → WK-09 (AI-01/02/04 are drawn in the Search and
AI file but are not on this path).

Built flow 1 runs ON-01 → ON-03 → ON-05 → ON-06 → ON-07 → ON-08 (ON-02 and ON-04 are collapsed into
ON-01 and ON-05 in the prototype; both are drawn in full in the Onboarding file).

| # | Flow | Screens in order | Decisions and recovery |
|---|---|---|---|
| 1 | Organization / project / client onboarding | ON-01 → ON-02 → ON-03 → ON-04 → ON-05 → ON-06 → ON-07 → ON-08 → CL-01 | client preview before invitations; duplicate domain; skip-and-return |
| 2 | Client request → clarification → commitment | CL-09 → REQ-01 → REQ-02 → CH-05 (question) → REQ-03 → WK-09 | desired vs committed date; decline with reason; clarification loop |
| 3 | Chat commitment → linked work | CH-02 → CH-05 → CH-08 → WK-09 → HOME-01 | inherited-access warning; audience stays internal; source link preserved |
| 4 | Planning → blocker → dependency resolution | PRJ-02 → WK-12 → WK-03 (invalid transition) → WK-09 → PRJ-01 | forecast moves and states why; cycle warning; keyboard move |
| 5 | Work → internal review → publication → approval → final | DEL-02 → DEL-03 → FIL-04 → DEL-04 → DEL-05 → CL-05 → APP-03 (changes) → DEL-02 v3 → APP-04 | separation of duty; exclusion list; invalidation on new version |
| 6 | Client login → understand progress → act | ID-01 → CL-01 → CL-05 → CL-06 | 30-second comprehension; actionable feedback required |
| 7 | Meeting → summary → decisions and actions | CAL-03 → MTG-02 → MTG-03 → DEC-01 → WK-09 | draft summary confirmed before anything is published |
| 8 | Search / AI answer → evidence → safe action | SR-01 → SR-02 → SR-03 → AI-03 → WK-09 | citations required; consequential action needs explicit confirmation |
| 9 | Automation build → dry run → failure → retry | AUT-01 → AUT-02 → AUT-03 → AUT-04 → AUT-05 | activation blocked by permission; retry twice then raise |
| 10 | Member / client offboarding → transfer → receipt | ADM-02 → ADM-12 → ADM-13 → CL-14 | ownership transfer, session revocation, immutable receipt |

Each flow records: entry point, happy path, one failure path, one permission path, and the object that
proves the flow worked (a committed date, a version hash, a receipt).
