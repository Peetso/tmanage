# State matrix

Required for every component: default · hover · focus-visible · pressed · selected · disabled ·
read-only · loading · success · warning · error · offline · stale · permission-limited · conflict ·
archived · invalidated · RTL · long English · long Arabic · light · dark · high contrast ·
reduced motion · pointer-coarse · keyboard-only.

## Evidence for the built components
| Component | States shown in artifacts | Gap |
|---|---|---|
| InkButton / LimeButton / OutlineButton | default, disabled, destructive, pressed (lime.600), focus ring | hover captured in spec only |
| StateCapsule | not started, in progress, blocked, client review, approved, archived, invalidated | stale |
| OpenTable row | default, selected, grouped, blocked, archived, permission-limited, skeleton, pagination | conflict row |
| PulseTrack | done, current, next, future, risk, schedule/milestone/request/delivery/client variants, RTL | vertical mobile variant drawn as step list only |
| WorkCard | feature (lime), white, blocked, no owner, client action | archived |
| Board column | normal, WIP at limit, invalid transition, keyboard move mode | drag hover |
| AudienceHalo | internal, client visible, client action required, conflict | mixed |
| GovernedVersionTrack | v1 done, current review, future, invalidated | superseded compare |
| ContextLens | dark overlay, light pinned | mobile sheet |
| Global | offline+queue, conflict, access changed, empty, loading, invalidated approval | partial outage, maintenance |

## Dense-data evidence (file 45 §6)
214-row work list with grouping and pagination · 12 board columns (6 shown, 4 hidden, overflow column) ·
40 channels with overflow · long Arabic work title with ellipsis in a 38px row · 30 filters collapsed to
"+26 filters" · 5-segment milestone track · 5-state version track. Remaining to prove: 20-event Work
Story, 12 deliverable versions, audit pagination, 15 client actions.
