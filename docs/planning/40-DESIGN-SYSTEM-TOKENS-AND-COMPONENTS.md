# TManage — Limeframe Design System: Tokens and Components

## 1. System contract

**Design system:** Limeframe  
**Primary reference:** `assets/references/TManage-primary-visual-reference.webp`  
**Platforms:** responsive web/PWA, future Tauri desktop, internal workspace, client portal, Control Center, English LTR, Arabic RTL, light/dark/high contrast.

These are executable starter tokens derived from the supplied visual reference. Claude may tune values only with contrast evidence, stress-screen evidence, and a decision-log entry.

## 2. Core tokens

### Light palette

| Role | Token | Value |
|---|---|---:|
| Absolute ink | `ink.950` | `#090A09` |
| Strong text | `ink.800` | `#232521` |
| Body text | `ink.650` | `#4D5049` |
| Muted text | `ink.500` | `#74786F` |
| Paper | `paper.0` | `#FFFFFF` |
| Warm paper | `paper.50` | `#F7F7F3` |
| Canvas | `paper.150` | `#E9E9E5` |
| Concrete | `paper.250` | `#D5D6D1` |
| Strong line | `line.700` | `#2C2E29` |
| Quiet line | `line.300` | `#C5C7C0` |
| Acid lime | `lime.500` | `#B7FF57` |
| Pressed lime | `lime.600` | `#9CEA3F` |
| Pale lime | `lime.100` | `#E9FFD0` |
| Client violet | `client.500` | `#7755C7` |
| Success | `success.600` | `#1D8A63` |
| Warning | `warning.600` | `#C96F18` |
| Danger | `danger.600` | `#D9474F` |

### Dark palette

Canvas `#121311`; Surface 1 `#1B1D19`; Surface 2 `#242720`; line `#3A3E35`; strong ink `#F5F6F0`; muted ink `#A7ACA0`; lime `#A9ED55`; pale lime plane `#29351D`; client violet `#A98AE5`; danger `#FF7780`.

### Semantic law

- Lime = active, selected, current, next, live progress.
- Green = successful completion/approval/delivery.
- Orange = risk/waiting/forecast warning.
- Red = destructive, failure, security incident.
- Violet = external/client boundary.
- Black = decisive action and primary structure.

Never reuse lime as generic success. Meaning always has icon/shape/text support.

## 3. Typography tokens

Latin uses Manrope Variable; Arabic uses Alexandria Variable; technical content uses Geist Mono.

| Token | Desktop | Mobile | Weight | Use |
|---|---:|---:|---:|---|
| `display.xl` | 72/76 | 44/48 | 500 | Public/rare product hero |
| `display.lg` | 56/62 | 38/44 | 500 | Home/project/client overview |
| `display.metric` | 64/64 | 44/48 | 400 | Meaningful large figure |
| `heading.page` | 36/42 | 30/36 | 550 | Operational page title |
| `heading.section` | 24/31 | 22/29 | 550 | Section title |
| `heading.card` | 20/27 | 19/26 | 550 | Primary card/object identity |
| `body.lg` | 17/25 | 17/26 | 400 | Lead/client narrative |
| `body.md` | 15/22 | 16/24 | 400 | Body |
| `ui.md` | 14/20 | 15/22 | 500 | Controls |
| `ui.sm` | 13/18 | 14/20 | 500 | Dense controls |
| `caption` | 12/17 | 13/19 | 500 | Metadata |

Arabic line heights are 8–14% larger by role. Do not apply negative tracking to Arabic.

## 4. Geometry and space

- Base space 4 px; scale: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96.
- Capsules: full radius.
- Icon orbs: 32 compact, 40 default, 48 comfortable, 56 navigation/feature, 64 hero.
- Controls: 36 compact, 40 default, 44 accessible, 48/56 feature.
- Radius: 10 micro, 14 control, 18 compact surface, 24 standard card, 28 sheet/dialog, 32 feature/client.
- Border: 1 px quiet; 1.5 px structural; 2 px expressive/focus.
- Focus: 2 px ink outer + 3 px lime halo, or contrast-safe inverse in dark mode.
- Shadows: only overlay/elevation; cards use plane and line first.

## 5. Layout tokens

- Orbital Rail 72 px expanded / 60 px compact.
- Context Rail 248 px default; 216–304 range.
- Canvas page padding 32 px at 1180+, 48 px at 1440+, 64 px at 1920+.
- Context Lens 360 px default; 320–520 range.
- Reading column 680 px; wide document 820 px.
- Overview hero minimum 220 px; operational header 104–148 px.
- Grid: 12 desktop, 8 tablet, 4 mobile; 24 px gutter desktop, 16 px tablet/mobile.

## 6. Component families

### Primitives

InkButton, LimeButton, OutlineButton, TextButton, OrbButton, SplitCapsuleButton, Field, SearchField, Select, Combobox, Checkbox, Radio, Switch, Date/Time, Avatar, Icon, Tooltip, StatusDot, Badge, InlineAlert, Toast, Skeleton.

### Shell

OrbitalRail, DockedOrbs, ContextRail, CanvasHeader, PulseTrack, ViewCapsules, Breadcrumb, ProjectSwitcher, CommandSurface, ContextLens, ClientPreviewBar.

### Work Object DNA

ObjectIdentity, OwnerAvatar, StateCapsule, DateStack, AudienceHalo, PriorityMark, RelationCapsule, SourceLink, NextActionCapsule, WorkStory, Freshness, DependencyTrack.

### Planning and data

OpenTable, FilterCapsules, FilterBuilder, SavedView, Board, WorkCard, TimelineTrack, Calendar, WorkloadLane, PortfolioRow, EditorialMetric, TrendLine, AccessibleDataTable, BulkActionCapsule.

### Collaboration and knowledge

ChannelRow, Message, Thread, Composer, Mention, Reaction, Presence, CommentOrb, BlockEditor, InlineObjectCapsule, DecisionBlock, MeetingBlock, SideComment.

### Delivery and client

GovernedVersionTrack, FileViewer, Annotation, VersionCompare, ReviewPanel, ApprovalCapsule, ClientActionCard, PortalProgressTrack, DeliverableCard, RequestCard, ProjectionPreview.

### Administration

PermissionMatrix, AccessSummary, ImpactPreview, AuditChapter, PolicyEditor, WorkflowCanvas, WorkflowNode, RunInspector, IntegrationTile, UsageTrack.

## 7. Signature component anatomy

### PulseTrack

Segments, current lime segment, time/state label, participant avatar, progress marker, optional risk marker, accessible ordered-step equivalent. Variants: schedule, milestone, delivery, request, onboarding, client.

### WorkStory

Chapter label, black/lime causal rail, actor/time, source evidence, decision/version badge, audience state, expand action. Client projection removes internal chapters rather than showing locks.

### FocusCapsule

Black body, circular leading control, action label, secondary “why now,” optional time/owner. Lime fill transition can show completion or forward movement.

### AudienceHalo

Icon/avatar, ring style, audience text, recipient count, projection freshness. Variants internal, client visible, client action required, mixed, conflict.

### EditorialMetric

Large figure, unit/meaning, change marker, period, source, drill-down. Maximum three visible in one overview region; never use for vanity counts.

## 8. State matrix required for every component

Default, hover, focus-visible, pressed, selected, disabled, read-only, loading, success, warning, error, offline, stale, permission-limited, conflict, archived, invalidated, RTL, long English, long Arabic, light, dark, high contrast, reduced motion, pointer coarse, and keyboard-only.

## 9. Data-density adaptations

The system has three composition densities:

- **Editorial:** overview/client/onboarding; 48–64 px rhythm, large type, feature radius.
- **Balanced:** everyday project/task/docs; 36–44 px controls and rows.
- **Operational:** lists/audit/admin; 32–38 px rows, compact type, fewer containers.

All densities share typeface, palette, black/lime selection, orbs, capsule actions, and outline grammar. The user may select Balanced or Operational on desktop; Editorial is screen-defined.

## 10. Accessibility contract

- WCAG 2.2 AA target; aim for focus appearance comparable to AAA guidance.
- 44 px mobile primary targets; at least 24 px or compliant spacing/equivalent controls elsewhere.
- All drag interactions have single-pointer and keyboard alternatives.
- Sticky headers/sheets never obscure focus.
- Lime/white pairings require checked text color; lime uses ink text by default.
- Thin display fonts are prohibited for operational or low-contrast text.
- Pulse Track has an ordered textual equivalent and does not rely on spatial position alone.
- Screen readers receive object type, state, owner, due, audience, and next action in a predictable order.

## 11. Library structure

```text
00 Visual north star + supplied reference
01 Foundations
02 Primitives
03 Shell + responsive navigation
04 Work Object DNA
05 Pulse Track + Work Story
06 Planning + data
07 Chat + docs
08 Delivery + approvals
09 Client Portal
10 Admin + automation
11 Patterns + global states
12 Screen templates
13 Stress tests
14 Prototype
15 Accessibility + localization
16 Deprecated
```

Every published component includes purpose, anatomy, variants, props/slots, states, content rules, keyboard, screen-reader behavior, responsive, RTL, theme, permissions, motion, analytics, and visual regression cases.
