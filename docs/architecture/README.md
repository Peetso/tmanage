# docs/architecture: how TManage is designed and how that is enforced

Peter, 2026-11-20: "The system design and the architecture design for the processes in the backend is the most important thing we have." This folder is where that is written down and made checkable.

## 1. Read order

| #   | File                                         | What it is                                                                                                                                                    | When you need it                                   |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 0   | **this file**                                | The entry point to the general standards. The edit gate asks for it to be Read once per session before any code edit (`PART-DOCS.md` §3.3)                    | **before any edit**, once per session              |
| 0b  | the part's `PART.md`, **only if it has one** | 18 parts have one. Where it exists, the gate also asks for it before an edit in that part. A part without one needs nothing more: the general standards apply | before an edit in that part                        |
| 1   | `ENGINEERING-STANDARD.md`                    | The binding system-design and backend rules: ID, verified source, today's `file:line`, target, check. §13 defect classes, §14 benchmark                       | before any design, build, review or deploy         |
| 2   | `IMPLEMENTATION-PATTERNS.md`                 | How code is written in this stack: patterns, the example in this repo to copy, the anti-pattern seen here, and the check                                      | before writing code                                |
| 3   | `UI-UX-DESIGN-STANDARD.md`                   | WCAG 2.2 AA, ISO 9241, UX laws, tokens, RTL, motion, performance, the persona evaluation method, design-system governance                                     | before any screen, component, token or copy change |
| 4   | `PART-DOCS.md`                               | The part list, the optional `PART.md` template, its checks and the edit gate                                                                                  | when changing an existing part doc or the gate     |
| 5   | `VIEWS.md`                                   | C4 views and the context map of the 75 API modules                                                                                                            | to place a change                                  |
| 6   | `QUALITY-ATTRIBUTES.md`                      | Measurable scenarios (QA-*), all targets marked _proposed_                                                                                                    | to say what "good" means                           |
| 7   | `DESIGN-CHECKLIST.md`                        | The form every brief fills in (§A–J)                                                                                                                          | before a design or build starts                    |
| 8   | `FITNESS-FUNCTIONS.md`                       | Every check (125 rows): exists or to build, where it runs, build order                                                                                        | when adding or changing a check                    |
| 9   | `../adr/`                                    | ADR-0001…0007 accepted; ADR-0008…0011 proposed, plus `ADR-TEMPLATE.md`                                                                                        | for decisions and bent rules                       |
| —   | `ENGINEERING-RULES.md`                       | Pointer kept for old links                                                                                                                                    | —                                                  |

## 2. How to use it

1. **Before an edit:** Read this file once per session; where a part you touch has a `PART.md`, Read that too and quote its rule IDs (PART-DOCS §3.3). TManage follows **general standards, not a doc for every part** (Peter, 2026-11-20): a part without a `PART.md` is normal. **Before a design:** read the standard sections your change touches. Fill `DESIGN-CHECKLIST.md` in the brief. Cite rule IDs (for example `RT-3`, `HT-2`) and scenario IDs (`QA-AV-1`).
2. **Worker briefs** list the rule IDs that apply and attach the filled checklist (CO-2). A brief without one is returned.
3. **During the build:** every rule you touch keeps its check green. If a rule's check is "to build" and your change is the natural place for it, build it (PR-1).
4. **When you find a defect:** name its class (§13 of the standard; add a `DC-` row if it is new), sweep the codebase for the same class, fix or list every site, and add or extend a fitness function (PR-3).
5. **Before a deploy:** `pnpm verify:full` green, plus the deploy guards (RT-9).

## 3. Which gate enforces what

| Gate          | Command                                                                                                       | Enforces (rule IDs, examples)                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Lint          | `pnpm lint` (`eslint.config.js`)                                                                              | AR-1…AR-4, AR-12; to build: AR-4b, AR-6, AR-8, AR-9, HT-3, DA-3, ST-1                                                  |
| Types         | `pnpm typecheck`                                                                                              | AR-12                                                                                                                  |
| Unit          | `pnpm test`                                                                                                   | HT-1, SE-1, SE-3, SE-5, ST-7, ST-8, DA-4, AS-1, AS-6; to build: HT-2, SE-2, RT-2…RT-6, ST-3                            |
| Contracts     | `pnpm contracts:check`                                                                                        | AR-10                                                                                                                  |
| MariaDB DDL   | `pnpm check:mariadb`                                                                                          | DA-5; to build: DA-6, DA-7                                                                                             |
| Supply chain  | `pnpm security:supply-chain`, `security:licenses`, `audit:prod`                                               | SE-7                                                                                                                   |
| DB suite      | `pnpm test:db` (MariaDB 11.8 in CI)                                                                           | DA-8, DA-9, DA-11, DA-12; to build: DA-1, AS-3, AS-4, RT-3, OB-4                                                       |
| E2E           | `pnpm test:e2e`                                                                                               | to build: SE-2 restart journey, SE-3 step-up journey                                                                   |
| Merge gate    | `pnpm verify`                                                                                                 | all of the above except DB, E2E and VR                                                                                 |
| Deploy gate   | `pnpm verify:full` + `deploy/hostinger/build.mjs` + `smoke.mjs`                                               | RT-9, HT-1, DA-4                                                                                                       |
| CI            | `.github/workflows/ci.yml`                                                                                    | static, database and security jobs. It cannot start until GitHub billing is fixed, so `verify` is the real gate (PR-4) |
| Review        | design review (Fable 5.2) + ADR                                                                               | QM-2, AR-11, PR-2, PR-3, CO-1, UX-2, UX-3, IP-11, IP-12                                                                |
| Part-doc gate | `.claude/settings.json` hooks (`scripts/arch/part-docs-gate.mjs`) + `pnpm arch:parts`, tests `pnpm test:arch` | README read once per session before any edit; PD-1…PD-8 on the existing `PART.md` files                                |
| UI checks     | `pnpm test:vr`, e2e a11y audit, copy-lint, design-token and logical-CSS lints (to build)                      | UX-4…UX-24                                                                                                             |

## 4. Governance

- **Owner of the standard:** the implementation lead (Opus 5.5). Fable 5.2 reviews designs and writes plans (CO-1). Peter decides principle changes.
- **Changing a rule:** propose it in an ADR (template `docs/adr/ADR-TEMPLATE.md`, format after Nygard 2011). The ADR names the rule ID and the source, and changes `ENGINEERING-STANDARD.md` and `FITNESS-FUNCTIONS.md` in the same commit.
- **Bending a rule for one change:** an ADR with the rule ID, the reason, the compensating control and an end date or exit condition. ADR-0007 is the model.
- **Ratchets:** baseline files under `docs/architecture/baselines/` may only shrink. Raising one needs an ADR.
- **Review cadence:** at each pass, `FITNESS-FUNCTIONS.md` is updated (an E/B change needs the check's path), and proposed SLOs are compared with measurements once OB-1 exists.
- **Sources:** cite only sources verified on the web (§1 of the standard). Mark anything partly verified as such.

## 5. Decision records

ADRs live in `docs/adr/` (ADR-0001 onward; template `docs/adr/ADR-TEMPLATE.md`). ADR-0008 to ADR-0011 adopt this standard.
