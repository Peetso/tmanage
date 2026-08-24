# Limeframe component inventory

Status legend: **built** = designed at high fidelity in a .dc.html screen · **specified** = anatomy and
states defined here, composition inherited from a built sibling · **planned** = mapped, not yet drawn.

## 01 Primitives
| Component | Status | Where it is built |
|---|---|---|
| InkButton / LimeButton / OutlineButton / TextButton / DestructiveButton | built | Foundations 04, all screens |
| SplitCapsuleButton (orb + label) | built | Home "New work", Project "Post update" |
| OrbButton 32/40/44/48/56/64 | built | Foundations 03, Orbital Rail, card actions |
| Field / SearchField / DateField | built | Foundations 04, Chat convert panel |
| Select / Combobox / Checkbox / Radio / Switch | specified | Work list header, approval criteria |
| Avatar (internal, client ring, presence, overflow) | built | Foundations 04 |
| StatusDot / Badge / StateCapsule | built | Foundations 04, Work list |
| InlineAlert / Toast / Skeleton | built | States screen, Work list loading row |

## 02 Shell
| Component | Status | Where |
|---|---|---|
| OrbitalRail (labelled, active ink, client violet ring) | built | every internal screen |
| DockedOrbs + quick-action orb | built | Mobile screens |
| ContextRail (flat, saved views / channels / admin) | built | Work list, Chat, Control Center |
| CanvasHeader (editorial + operational sizes) | built | all |
| PulseTrack — schedule / milestone / request / delivery / client | built | Foundations 05, Home, Project, Portal, Inbox, Deliverable |
| ViewCapsules (list/board/timeline/calendar/workload) | built | Work list, Board |
| FilterCapsules + overflow to FilterBuilder | built | Work list, Home, Inbox |
| ContextLens (light inspector, dark overlay) | built | Home, Work list, Project |
| ClientPreviewBar / portal frame | built | Publish safety check, Portal |
| CommandSurface | planned | SR-01 |

## 03 Work Object DNA
ObjectIdentity, OwnerAvatar, StateCapsule, DateStack (committed vs forecast vs desired), AudienceHalo,
RelationCapsule, SourceLink, NextActionCapsule, WorkStory, Freshness, DependencyTrack — **built** across
Work list, Board, Project overview, Inbox bundle, Foundations 05.

## 04 Planning and data
OpenTable (grouped, selected edge, bulk capsule, permission-limited row, skeleton row, pagination),
Board (WIP limit, invalid transition, keyboard move announcer), WorkCard (feature lime / white),
EditorialMetric, TrendLine (stage bars), SavedView — **built**. TimelineTrack, Calendar, WorkloadLane,
PortfolioRow — **specified** from PulseTrack + OpenTable.

## 05 Collaboration and knowledge
ChannelRow, Message, Thread, Composer with audience seam, InlineObjectCapsule, ConvertPanel — **built**.
BlockEditor, DecisionBlock, MeetingBlock, CommentOrb, SideComment — **specified** (DOC-02 planned).

## 06 Delivery and client
GovernedVersionTrack, VersionCompare (side by side + annotations), ReviewPanel with criteria,
ApprovalCapsule, PublishSafetyCheck, ProjectionPreview, ClientActionCard, PortalProgressTrack,
DeliverableCard, RequestCard — **built**.

## 07 Administration and automation
ContextRail admin, WorkflowCanvas (numbered orb steps), WorkflowNode, ImpactPreview / validation panel,
RunInspector (dry run results) — **built**. PermissionMatrix, PolicyEditor, AuditChapter, IntegrationTile,
UsageTrack — **specified**.

## 08 Global states
OfflineStrip, ConflictResolver, AccessChangedPanel, InvalidatedApproval, EmptyQueue, LoadingSkeleton,
PermissionLimitedRow — **built** (States screen).

## Deprecation rules
A component is deprecated only with: replacement named, migration note, affected screen IDs listed, and
one release of dual availability. Deprecated entries move to library section 16 and keep their state
matrix so audits stay reproducible. Nothing is silently deleted.
