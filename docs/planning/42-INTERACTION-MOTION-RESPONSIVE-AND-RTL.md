# TManage — Interaction, Motion, Responsive, Desktop, and RTL Specification

## 1. Interaction model

TManage should feel direct: select an object, act in place, keep context visible. Routing is for changing work areas; inspectors, sheets, and split views are for understanding or modifying the current object.

### Predictable layers

1. Canvas: current work.
2. Context Lens: relationships/access/activity.
3. Popover/menu: small choice.
4. Sheet/drawer: focused secondary task.
5. Dialog: consequential decision only.

Avoid nested modal chains. Opening a fourth layer closes or commits the previous transient layer.

## 2. Navigation and state preservation

- Orbital Rail switches top-level areas and preserves each area’s last internal state.
- Back/forward works in browser and future desktop app.
- Opening detail from a collection keeps selection, filters, sort, and scroll.
- `Cmd/Ctrl+K` opens the Command Surface; `/` focuses contextual search when safe.
- `Esc` closes one transient layer at a time; it never discards unsaved work without warning.
- Deep links restore organization, project, view, object, and safe Lens tab.

## 3. Core interaction patterns

### Capsule action

The black or lime capsule contains one verb. A circular leading segment may hold an icon or step marker. Loading occurs inside the capsule; success may advance the lime fill. Labels do not shift position.

### Inline edit

Click/Enter opens editing in place; Enter commits when appropriate; Escape reverts; Tab commits and advances. Pending save is visible. Conflict preserves both values and names the source.

### Drag and reorder

Drag is an enhancement. Every board/timeline/reorder action offers a menu and keyboard command. Drop zones name the resulting state. Invalid transition explains requirements and returns the item to its origin.

### Publish/client boundary

Any internal-to-client action opens an Audience Seam review: exact recipients/roles, projected fields, linked-content warnings, version, notification, and consequence. Preview is the actual server projection—not a CSS approximation.

### Undo

Low-risk reversible actions offer 8–12 second undo. Permission, external publication, approval, deletion, and irreversible transitions use review/confirmation instead.

## 4. Motion language

| Event | Motion | Duration |
|---|---|---:|
| Hover/focus/press | Fill, outline, or 1 px translation | 100–140 ms |
| Capsule select | Ink/lime fill sweep | 160–180 ms |
| Row/card select | Border/fill emphasis | 140 ms |
| Context Lens open | 12 px slide + fade | 220–260 ms |
| Mobile sheet | Vertical slide + backdrop | 260 ms |
| Pulse Track advance | Marker glide with state crossfade | 260–320 ms |
| View transformation | Shared-object crossfade/position | ≤340 ms |
| Toast/connection strip | Fade/short translate | 180–220 ms |

No looping ambient motion inside the work product. No parallax in operational surfaces. Reduced motion removes translation, sweep, and shared-layout animation; state remains obvious.

## 5. Responsive transformations

### Wide desktop `≥1440`

Orbital Rail, Context Rail, Canvas, and Lens can coexist. Editorial overview may use controlled overlap and large figures. Narrative width stays capped.

### Desktop `1180–1439`

Orbital Rail stays; Context Rail may collapse; Lens pins only when enough canvas remains, otherwise overlays. Large titles reduce one scale step.

### Tablet/compact window `900–1179`

Rail becomes compact; secondary navigation is a side sheet; Lens is overlay; toolbar actions collapse into one capsule/overflow. Tables pin identity and allow horizontal scroll with a column chooser.

### Small tablet `600–899`

Top-level navigation becomes docked orbs; split views become list → detail routes while preserving return position. Boards become horizontally scrollable columns plus grouped list mode. Timeline offers agenda/list default.

### Mobile `<600`

Five top-level destinations. Single content column. Primary action remains within thumb reach but does not cover content. Complex forms become step sections with persistent summary. Tables become object rows/cards; the user can open a column/details sheet. Client approval keeps artifact, criteria, version, and action together.

## 6. Component transformations

| Desktop component | Tablet | Mobile |
|---|---|---|
| Context Lens | Overlay side sheet | Full-height bottom/page sheet |
| Pulse Track | Scroll or compressed labels | Horizontal scroll or vertical step track |
| Open table | Fewer pinned columns | Structured object rows/cards |
| Board | Horizontal columns | Column carousel + accessible grouped list |
| Timeline | Scroll/zoom | Milestone agenda + dependency detail |
| Command Surface | Centered overlay | Full-screen command/search |
| Split inbox/chat | Resizable panes | List → detail; back restores position |
| Client action grid | 2 columns | 1 column with dominant action |
| Dark summary panel | Trailing overlay | Full-screen layered summary |

## 7. Future Tauri desktop behavior

- Reuse responsive web canvas; add platform-native title bar behavior, deep links, notifications, file drop, quick capture, updater, and optional tabs.
- Support window widths from compact single-pane to wide multi-pane.
- Do not recreate system window buttons.
- Command menu and shortcuts respect macOS/Windows conventions.
- Opening a second window is optional for documents, meetings, or focused review—not default for every object.

## 8. Arabic and bidirectionality

### Mirroring rules

- Leading navigation: right in RTL.
- Trailing Lens: left in RTL.
- Breadcrumb and step order follow reading direction.
- Back/forward arrows mirror; media play, download, external-link, check, and brand marks do not.
- Progress/time direction follows the meaning of the specific visualization and is documented; interface step tracks mirror by default.
- Charts using a universal chronological x-axis may remain left-to-right, with Arabic labels aligned correctly and a clear axis.

### Mixed-direction content

Use Unicode isolation or semantic HTML for email, URL, code, file hash, ticket ID, phone, currency, and mixed project names. Text inputs determine direction from content where appropriate; labels remain interface direction.

### Arabic visual quality

- Alexandria variable is the expressive primary; test all weights actually loaded.
- Increase line height and vertical padding where glyphs require it.
- Avoid forced uppercase analogues, excessive tracking, and narrow pill widths.
- Capsule components size to content and wrap or transform rather than truncating critical actions.
- Provide Arabic sample data, not transliterated English names only.

## 9. Keyboard contract

- Global: command, create, search, home/inbox navigation, go back/forward.
- Collections: arrows move active row/card, Enter opens, Space selects, Shift extends, menu key opens actions.
- Board: move action menu and documented shortcuts; live region announces result.
- Dialog/sheet: trap focus, initial focus based on task, restore trigger on close.
- Rich text: standard editing keys; product shortcuts do not override text input unexpectedly.
- Shortcut hints localize for platform and never become the only label.

## 10. Async, offline, and conflict

- Optimistic UI only for reversible low-risk actions.
- Approval, publication, role changes, and destructive actions wait for server authority.
- Offline drafts are labeled and queued; the interface does not imply publication.
- Reconnect runs gap recovery and shows a compact Connection Strip only when the user must know.
- Conflict resolution names the two versions/actors/times and preserves content.

## 11. Accessibility verification

Test at 200% browser zoom, keyboard-only, NVDA/Chrome, VoiceOver/Safari, reduced motion, high contrast, coarse pointer, English LTR, and Arabic RTL. Verify focus is never obscured by the Pulse Track, sticky bars, dock, sheets, or toasts. All spatial tracks have textual equivalents.
