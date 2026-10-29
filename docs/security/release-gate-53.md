# Release gate 53-20 (planning and collaboration scope)

Plan item 53-20 (spec `53-FEATURE-GAPS-PLANNING-COLLAB.md` §53-20 and §8.2). One checklist the
Fable 5.1 approver runs before any 53 item goes live to the beta organizations. It sits next to
the general security checklist (`release-checklist.md`, 56-15), which still applies.

Copy this file into the release record, tick each line, and paste the command output or link as
evidence. A line that cannot be ticked blocks the release, unless an exception is written down
with its owner and a date. A train ships without the failing item, never with a red gate.

## How to run the suites

| Suite                       | Command                                                                     |
| --------------------------- | --------------------------------------------------------------------------- |
| Database suite (all)        | `pnpm test:db`                                                              |
| One database file           | `pnpm --filter @tmanage/api exec vitest run --project database test/<file>` |
| API unit suite              | `pnpm --filter @tmanage/api test`                                           |
| End-to-end suite (all)      | `pnpm test:e2e`                                                             |
| One end-to-end spec         | `pnpm --filter @tmanage/e2e exec playwright test tests/<spec>`              |
| Storybook visual regression | `pnpm test:vr`                                                              |
| Load test (local only)      | `node scripts/load/run.mjs` (see `scripts/load/README.md`)                  |

## The nine gate lines (53 §53-20)

| #   | Gate line                                                                                                                                                                                | Test id or command                                                                                                                                                                       | Status today                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Authorization and security corpus covers every new route of 53, including the SEC-01 BOLA corpus generated from the OpenAPI file (and its stale upload enum fixed, SEC56-19).            | SEC-01: `apps/api/test/sec-001-bola-corpus.db.test.ts` (built by 56-04). Custom-role ceiling: AUTH-53-50. Then `pnpm test:db`.                                                           | AUTH-53-50 green. SEC-01 is 56-04's file; tick when it is green. |
| 2   | Visual baselines re-taken only for the stories a change touched (keep the existing shots, add per story).                                                                                | `pnpm test:vr` for the Storybook suite (its shots stay as they are); per changed story `pnpm test:vr:update -- -g "<story>"`. Arabic public pages: VR-53-54.                             | VR-53-54: 6 baselines committed next to the spec.                |
| 3   | Arabic e2e journeys for every item, including the public `/ar` pages.                                                                                                                    | E2E-53-53 `e2e/tests/ar-public-pages.spec.ts`, plus `arabic-journeys.spec.ts`, `ar-auth-rtl.spec.ts`, `ar-not-found.spec.ts`. Run `pnpm test:e2e`.                                       | E2E-53-53 written; see the audit debt rows below for its result. |
| 4   | PERF-02, PERF-03, PERF-06 and the new PERF tests run at the live host's size.                                                                                                            | `node scripts/load/run.mjs --realtime-sockets <n>` against a local stack sized like the Hostinger plan (the script refuses any non-local host). Report in `docs/reports/PERF-<date>.md`. | Open. Last report: `docs/reports/PERF-2026-10-25.md`.            |
| 5   | Threat-model update triggers from doc 26 §10 fired for: mobile/desktop shell, public link (ICS feed), new external connector (Jitsi public, FCM/APNs), AI tool call (`summary.propose`). | Review: `26-THREAT-MODEL` §10 triggers, STRIDE rows in `56-SECURITY-AND-TRUST-PLAN.md` §5 and §5.18. Evidence: the doc diff naming each trigger.                                         | Open (documents, no command).                                    |
| 6   | Privacy notice and subprocessor list updated (Jitsi public, FCM/APNs/Mozilla push, browser speech vendors, the customer's own AI) and just-in-time notices in place.                     | Pages `/legal/privacy` and `/security/data-location` (subprocessor list), opened in Arabic by E2E-53-53. Data inventory: `docs/security/data-inventory.md` (PRIV-53-52).                 | Open (copy change). The pages render and pass E2E-53-53.         |
| 7   | Deploy runbook gains the LiteSpeed WebSocket proof, VAPID/FCM environment keys and the desktop release steps.                                                                            | `docs/runbooks/deploy.md`, `docs/runbooks/realtime-live-proof.md`, `docs/runbooks/hostinger-shared-hosting.md`. Evidence: the runbook diff.                                              | Open.                                                            |
| 8   | `graphify update .` and the planning-pack cross-references.                                                                                                                              | `graphify update .` at the repository root after the last change of the train.                                                                                                           | Run for this slice.                                              |
| 9   | Fable 5.1 approval before anything goes live to the beta organizations.                                                                                                                  | The Fable approver's written GO in the release record, after lines 1 to 8 are ticked and the full test phase (`pnpm verify:full`) is green.                                              | Open; always last.                                               |

## The audit debts this gate owns (53 §8.2)

| Debt                     | Gate line | Test id                                                                                  | File                                                                                     | Command                                                                                                       |
| ------------------------ | --------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Custom roles             | 1         | AUTH-53-50 (12 capabilities × 3 custom roles = 36 cells)                                 | `apps/api/test/auth-053-custom-roles-ceiling.db.test.ts`                                 | `pnpm --filter @tmanage/api exec vitest run --project database test/auth-053-custom-roles-ceiling.db.test.ts` |
| Custom roles             | 1         | UNIT-53-51 (simulator = runtime, every capability id)                                    | `apps/api/src/modules/platform-admin/permissions/simulator-parity.test.ts`               | `pnpm --filter @tmanage/api test`                                                                             |
| Erasure                  | 6         | PRIV-53-52 (inventory-driven; a table missing from the inventory fails the run)          | `apps/api/test/priv-053-erasure-inventory.db.test.ts`, `docs/security/data-inventory.md` | `pnpm --filter @tmanage/api exec vitest run --project database test/priv-053-erasure-inventory.db.test.ts`    |
| Arabic public pages      | 3         | E2E-53-53 (`dir`, `lang`, no English fallback, U+200F on Latin-led lines, axe 0 serious) | `e2e/tests/ar-public-pages.spec.ts`                                                      | `pnpm --filter @tmanage/e2e exec playwright test tests/ar-public-pages.spec.ts`                               |
| Arabic public pages (VR) | 2         | VR-53-54 (desktop and phone for `/ar`, `/ar/pricing`, `/ar/security`)                    | `e2e/tests/ar-public-pages.spec.ts-snapshots/`                                           | same spec; re-take only for a change to these pages: add `-u`                                                 |

## What the erasure proof does and does not cover yet

PRIV-53-52 proves what the privacy job does today: an account deletion offboards the member (their
session and personal access token stop working), and a company deletion empties every tenant table
the inventory marks `enforced`, keeps the audit trail and leaves other companies untouched. The
inventory marks 35 rows `gap`, owned by 56-18: the global account and its credentials are not
removed or pseudonymised, nothing redacts the kept audit rows, and fiscal records go with the
company. 56-18 replaces the seed inventory; the test keeps the same contract.
