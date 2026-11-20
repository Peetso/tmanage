---
part: api/identity # registry id (docs/architecture/parts.json)
kind: api-module # api-module | api-common | package | ds-area | app-runtime | web-area | web-shared | ops
context: identity-and-access # VIEWS.md §4 context (Backstage "system")
owner: implementation-lead
lifecycle: production # experimental | production | deprecated
depends_on: [api/tenancy, api/audit, package/domain]
provides_api: ['/v1/sessions/*', '/v1/auth/*']
consumes_api: []
tables_owned: [users, sessions, mfa_factors]
rules: [SE-2, SE-3, AR-8, AR-9, HT-1] # IDs from the standards that apply
ux_rules: [UX-8] # UI-UX standard IDs (web/ds parts)
last_verified_commit: <sha>
last_verified_date: YYYY-MM-DD
last_verified_by: <model/name>
---

# <part id>: <one-line name>

<!--
Template for a part doc (docs/architecture/PART-DOCS.md §4). Copy it to the part's folder as
PART.md, add a CLAUDE.md beside it whose only line is @PART.md, and replace every comment.
`node scripts/arch/part-docs-check.mjs` (PD-1…PD-8) checks this file: headings exactly as below
and in this order, no empty section (write "n/a — reason" where a section does not apply),
every rule ID defined in the standards, at most 30,000 characters.
-->

## Purpose and bounded context

<!-- Explanation (arc42 §1, §3): what the part is for, who uses it, context-map relations
(upstream/downstream, shared kernel). -->

## Domain model and invariants

<!-- Explanation + reference (arc42 §5, §8): entities, value objects, state machines; each
invariant as a checkable statement with the test that proves it. -->

## Public API and contracts

<!-- Reference (arc42 §3, §5): routes (method, path, status codes per ENGINEERING-STANDARD §4),
events published/consumed, exported services; contract entries in
e2e/contracts/api-web-shapes.ts. -->

## Data: tables and migrations

<!-- Reference (arc42 §5, §8): owned tables, columns that matter, unique/dedupe keys, migrations
(ids), expand/contract state, retention class. -->

## Permissions and tenant rules

<!-- Reference (arc42 §8): capabilities per route, tenant scope, trust zone, step-up needs;
where each decision is made (single source of truth). -->

## Runtime, background work and failure modes

<!-- Explanation (arc42 §6, §8, §11): jobs, consumers, sweeps owned; leases; timeouts; breaker;
what happens on DB, network or third-party failure, and on two instances (stability patterns by
ID). -->

## UX rules for its screens

<!-- Reference (arc42 §8, §10): screens and Figma node ids, persona journeys, UX-* IDs, copy keys,
empty, error and unknown states. "n/a — reason" for non-UI parts. -->

## Standards that apply

<!-- Reference (arc42 §8): rule IDs from the front-matter, each with one line on how this part
meets it or the ADR that bends it. -->

## How to change this part

<!-- How-to (arc42 §4), the golden path: where a new route, table, job or screen goes; which
files change together; which checks to run. -->

## Tests and fitness checks

<!-- Reference (arc42 §10): test files (unit, db, e2e, VR), fitness functions, revert proofs. -->

## Open defects, decisions and risks

<!-- Reference (arc42 §9, §11): DC-* classes present, ADR links, technical debt with an exit. -->

## Glossary (optional)

<!-- Reference (arc42 §12): domain terms (EN and AR where the UI uses them). Delete the section
if the part has none. -->
