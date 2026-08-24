# Sitemap and role-based navigation

## Internal shell (Orbital Rail, top to bottom)
My Day · Inbox · Chat · Work · Docs · Files · Clients · Insights — then Control Center and the account orb
pinned to the bottom. Every orb carries a permanent 9–10px label; hover/focus expands the rail to 248px
with full labels and shortcut hints.

## What each role sees in the rail
| Role | Rail | Notes |
|---|---|---|
| Owner / Admin | all 8 + Control Center | Control Center orb is the only path to policy, roles, audit, billing |
| Project Manager | all 8, Control Center hidden | can open ADM-04 client organizations for own clients only |
| Team member | My Day, Inbox, Chat, Work, Docs, Files, Insights (project scope) | Clients orb appears only if assigned to a client project |
| Client Admin | portal frame only: Overview, My actions, Timeline, Deliverables, Updates, Files, People, Members | no internal rail exists in this mode |
| Client Reviewer | portal frame minus Members | approval authority shown on their own actions |
| Client Viewer | portal frame minus Members and New request | read + download only where explicitly shared |

## Second level (Context Rail)
Work → saved views + projects · Chat → channels + DMs · Docs → spaces + templates ·
Clients → client organizations · Control Center → admin categories. The rail is flat: no card stacks,
no nested accordions deeper than one level.

## Cross-cutting entries
Command surface (⌘K) reaches Go to / Find / Create / Act. Every object opens either in place, in the
Context Lens, or as a full detail screen — never in a modal that hides its context.

## Client portal information architecture
Overview (progress + your actions) → My actions → Timeline → Deliverables → Updates → Files → People.
Nothing in the portal is generated from internal navigation; each entry maps to an allowlisted projection.
