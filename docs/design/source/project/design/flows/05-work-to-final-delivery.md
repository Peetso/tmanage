# Flow 05 — work → internal review → publication → approval → final

**Actor:** Omar Adel (PM), Maya Hassan (reviewer), Youssef Kamal (client reviewer).
**Precondition:** Homepage Concept v2 exists, milestone "Homepage direction" committed 18 Aug.

| Step | Screen | What must be true |
|---|---|---|
| 1 | DEL-02 deliverable detail | v2 is the current governed version, hash visible |
| 2 | DEL-03 internal review | criteria list, separation of duty enforced (author cannot pass) |
| 3 | FIL-04 version compare | changes are annotated and have a text diff summary |
| 4 | DEL-04 publish safety check | recipients with authority, exclusions, internal-link block |
| 5 | DEL-05 projection preview | real client projection, freshness stated |
| 6 | CL-05 client approval | decision bound to hash; approve or request changes |
| 7 | APP-03 request changes | at least one specific point required |
| 8 | DEL-02 v3 | new version invalidates the prior approval (APP-04) |
| 9 | APP-04 approval history | immutable record: version, actor, authority, time, criteria |

**Failure path:** publication attempted while a linked internal object exists → blocked with two
remedies. **Permission path:** reviewer authority moved → nudge automation stops and notifies the PM.
**Evidence produced:** approval record tied to hash 8f2c·d41a, milestone evidence entry, Work Story
chapters PUBLISHED and DECIDED.
