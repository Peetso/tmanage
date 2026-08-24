# TManage — Complete Product Scope and Module Map

## 1. Scope decision

The complete application is designed now and engineered in releases. Claude must not treat “MVP first” as “design only the MVP.” The full product design protects the information architecture, shell, design system, and connected work graph from later redesign debt.

## 2. Product anatomy

TManage is one system with four deliberately different modes:

1. **Team Workspace:** dense, fast execution for internal teams.
2. **Focus Space:** reduced-noise personal work, inbox, and daily planning.
3. **Client Portal:** simpler, warmer, action-first external collaboration.
4. **Control Center:** governance, templates, automations, security, billing, and operations.

These modes share objects and tokens but not identical navigation or density.

## 3. Complete module map

| Module | User outcome | Principal surfaces | Signature behavior | Engineering release |
|---|---|---|---|---|
| Public and trust | Understand the promise and trust posture | Landing, product, client portal, pricing, security, accessibility, status, legal | Interactive “work story” demonstration without fake metrics | Pre-alpha/GA as needed |
| Identity and account security | Enter the correct organization safely | Sign in, SSO, MFA/passkey, recovery, invitation, sessions | Organization and access scope are visible before entry | MVP |
| Onboarding and migration | Reach a useful first project quickly | Organization setup, operating template, project setup, team/client invite, sample data, import | Preview the operating system being created, not a blank-form wizard | MVP then expanded |
| Home / My Day | Know what deserves attention now | Personal brief, focus queue, meetings, approvals, blockers, recent context | Explainable “why now” ranking and time-aware focus lane | MVP |
| Universal Inbox | Act without opening every source | Important, all, waiting, client actions, bundles, digests | Bundled events with inline actions and consequence preview | MVP |
| Chat and collaboration | Discuss and turn commitment into durable work | Channels, DMs, threads, composer, voice note, bookmarks, huddle later | Message-to-object conversion preserves source and audience | MVP core; rich comms later |
| Work management | Plan and execute from the same object model | List, board, timeline, calendar, workload, forms, saved views | One Work Item changes representation without losing identity | MVP core; views expanded |
| Projects and portfolio | Understand delivery health and direction | Project overview, milestones, plans, portfolio, objectives, dependencies | Project Pulse ribbon exposes forecast, commitment, risk, freshness | MVP project; portfolio later |
| Calendar and meetings | Connect time, decisions, and actions | Personal/project calendars, meeting detail, agenda, notes, focus blocks | A meeting closes with linked decisions and actions, not loose notes | Post-MVP design complete |
| Docs and knowledge | Create durable context beside execution | Documents, briefs, wiki, templates, decision register, glossary | Inline linked objects and a Context Lens replace pasted status tables | MVP-lite; collaboration later |
| Files and deliverables | Govern the exact reviewed version | Upload center, file viewer, version compare, deliverables, internal review | Governed version and approval chain are always visible | MVP |
| Requests, decisions, and approvals | Make commitments and authority explicit | Request intake/triage, decision detail, approval review/history | Immutable Work Story from request to outcome | MVP |
| Client Portal | See progress and complete assigned work with minimal learning | Overview, My Actions, timeline, updates, requests, approvals, deliverables, files, people | External mode transforms the shell and shows only allowlisted projections | MVP |
| People and capacity | Find ownership and plan availability without surveillance | Directory, teams, profile, availability, workload, skills later | Capacity is about commitments and constraints, never employee scoring | Post-MVP design complete |
| Insights and reporting | Understand flow, risk, and improvement | Project health, portfolio, delivery flow, approval cycle, adoption, exports | Every score is explainable and drills into source work | Post-MVP design complete |
| Search, command, and AI | Reach or act on connected context quickly | Command palette, universal search, answer view, AI copilot, saved queries | Results show evidence, permission boundary, and next safe action | Search MVP; AI phased |
| Automations and integrations | Remove repeat coordination safely | Template gallery, workflow builder, run history, credentials, app directory | Test/dry run and executing-principal preview before activation | Post-MVP design complete |
| Administration and governance | Operate the system safely at scale | Members, roles, clients, policies, fields, templates, audit, retention, exports | Impact preview before permission/offboarding/policy changes | MVP core; enterprise later |
| Billing and plan management | Understand cost and entitlement | Workspace plan, paid internal seats, included client roles, active-project allowance, pooled storage/usage, add-ons, invoices, payment method, limits | Clear entitlement, impact preview, non-destructive downgrade, and no dark-pattern upgrades | Paid beta; quota foundation in P0 files |
| Preferences and accessibility | Make the product fit the person | Profile, locale, timezone, appearance, density, notifications, shortcuts, accessibility | Theme, contrast, density, motion, LTR/RTL preview | MVP core |
| Platform states | Trust the system during failure or change | Offline, reconnect, maintenance, partial outage, sync conflict, access changed, update available | Persistent state strip with recovery path; never silent data loss | MVP |
| Desktop companion | Feel native without forking the product | Window shell, tabs, deep links, notifications, quick capture, updater | Shared canvas with platform-native window behavior | After web evidence |
| Mobile companion | Triage, communicate, approve, and capture away from desk | Home, inbox, chat, task, approval, upload, quick capture | Five-item primary navigation; planning-heavy views transform to summaries | Responsive web first; native later decision |

## 4. Role-specific product homes

### Owner / Executive

Lands on portfolio exceptions, commitment confidence, late approvals, capacity constraints, and published client status. Does not see individual productivity rankings.

### Workspace Admin / Operations

Lands on operating health: invitation/access exceptions, automation failures, template adoption, unowned work, audit alerts, and setup recommendations.

### Manager / Project Lead

Lands on delivery decisions: milestone forecast, blockers, waiting client actions, workload conflicts, requests needing commitment, and pulse publishing.

### Member / Specialist

Lands on the next useful action, active context, requests for review, meetings, focus plan, and a compact project switcher.

### Client Admin

Lands on multi-project progress, client organization actions, stakeholder access, upcoming milestones, and approval authority.

### Client Reviewer / Member / Viewer

Lands on a plain-language My Actions view. Viewer receives progress and deliverables without controls they cannot use.

## 5. Cross-module object contract

Every major object exposes the same predictable core:

- Identity: type, title, stable ID, project/workspace.
- Responsibility: owner, collaborators, authority.
- State: current status, next valid transitions, blockers.
- Time: desired, committed, forecast, due, completed, freshness.
- Audience: internal, client visible, client action required.
- Context: source, relationships, dependencies, decisions, documents, messages, meetings.
- Evidence: activity, versions, approvals, audit events.
- Action: one primary next action and relevant secondary actions.

This core becomes the reusable **Work Object DNA** in the design system.

## 6. Navigation architecture

### Internal desktop default

Global Dock: Home, Inbox, Chat, Work, Calendar, Docs, People, Insights. Search/Command is global; Create is persistent. The contextual sidebar changes within the chosen area. The main canvas holds the active view. The optional Context Lens appears on the trailing side.

### Client desktop default

Overview, My Actions, Timeline, Deliverables, Updates, Files, People. No internal module labels, dense admin affordances, or hidden internal controls.

### Mobile default

Home, Inbox, Chat, Work, More for internal users. Overview, My Actions, Deliverables, Updates, More for clients. Each tab preserves its navigation state. Create/quick capture is a reachable primary action, not a sixth tab.

### Control Center

Separate entry from workspace settings. Categories: Organization, People & access, Work system, Clients, Automations, Integrations, Security, Data, Billing. Destructive and tenant-wide changes use explicit impact review.

## 7. Full-design / phased-build boundary

| Artifact | Must cover now | May be built later |
|---|---|---|
| Information architecture | Entire application | — |
| Visual direction and tokens | Entire application | — |
| Component foundations | Entire application | Rare specialized components |
| Screen families and key states | Entire application | Long-tail permutations may use documented templates |
| High-fidelity stress tests | All core modes and modules | Additional views after system validation |
| Clickable golden flows | MVP loop plus representative later flows | Full prototype of every settings route |
| Production code | MVP release contract | Later modules by roadmap |

## 8. Product success story

The design must make this one story feel continuous:

**Client request → team clarification → accepted commitment → planned milestone → work and discussion → internal review → client-safe publication → review/changes → approval → final delivery → searchable evidence → portfolio learning.**

If the prototype feels like separate chat, PM, docs, and portal products stitched together, the design has failed regardless of visual polish.
