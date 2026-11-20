# ADR-0011 — Every part has a co-located PART.md, and an edit gate refuses changes to a part until its PART.md has been read

- **Status:** Proposed (lane B, 2026-11-20)
- **Date:** 2026-11-20
- **Deciders:** Peter (ABSOLUTE RULE, 2026-11-20); implementation lead builds it; Fable 5.2 reviews
- **Rules affected:** PD-1…PD-8, CO-2, PR-1; **bends a rule:** no
- **Quality scenarios:** QA-MT-1, QA-MT-2
- **Evidence:** Defect classes DC-1 and DC-2 were rules the implementer did not know (`docs/architecture/ENGINEERING-STANDARD.md` §13). No part documentation exists today. The repo has one 5-line root `CLAUDE.md`, `apps/web/CLAUDE.md` (`@AGENTS.md`), and no `.claude/` folder.

## Context

Peter's rule says every part of the system has its own documentation, and the implementing model reads it before implementing. The Claude Code docs (https://code.claude.com/docs/en/memory, accessed 2026-11-20) give three relevant behaviours:

- CLAUDE.md files in subdirectories load **on demand**, "once Claude reads, writes, or edits another file in that subdirectory".
- CLAUDE.md is context, **not enforcement**.
- On-demand files are truncated at 40,000 characters.

The hooks docs (https://code.claude.com/docs/en/hooks) add that `PreToolUse` hooks see `tool_input.file_path` and can deny an action, fire for subagents too, and fail open unless `"onFailure": "block"` is set. The subagent docs add that the built-in Explore and Plan agents skip CLAUDE.md.

Benchmarks:

- Backstage TechDocs: docs "live together with their code".
- Backstage catalog descriptor.
- Diátaxis: four forms.
- arc42 v9.1: building-block view.
- Write the Docs: docs as code.
- Shopify: a component owns its public API and data.

All are cited in `docs/architecture/PART-DOCS.md` §1.

## Decision

1. **Parts:** about 190, from the directory rules in PART-DOCS §3.4, recorded in a generated `docs/architecture/parts.json`. Background jobs, consumers and sweeps are documented in their owning context's part.
2. **Doc:** `PART.md` sits in the part's folder. It has YAML front-matter (Backstage-style fields plus `rules` and `last_verified_commit`), the 12-section template in PART-DOCS §4 (each section labelled with its Diátaxis form and arc42 mapping), and a cap of 30,000 characters.
3. **Context loading:** a one-line `CLAUDE.md` (`@PART.md`) in each part folder.
4. **Enforcement:** project hooks in `.claude/settings.json`:
   - a PostToolUse hook on Read records `PART.md` reads per `session_id` + `agent_id`;
   - a PreToolUse hook on Edit, Write and NotebookEdit denies an edit to a part with no recorded read;
   - `onFailure: block`.
5. **Freshness:** `scripts/arch/part-docs-check.mjs` in `pnpm verify` fails on:
   - a missing doc (ratchet), invalid front-matter, missing headings, or unknown rule IDs;
   - a doc that is stale by more than 15 commits on the part's paths (proposed);
   - a doc over the size cap.
6. **Briefs:** every worker brief lists its parts. Every report carries a `Parts read:` line quoting the rule IDs it applied. Implementers are never Explore or Plan agents.

## Alternatives considered

| Option                                                         | Pros           | Cons                                                                                                | Why not chosen             |
| -------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------- | -------------------------- |
| Central `docs/parts/<part>.md` + `.claude/rules` with `paths:` | one folder     | the docs drift away from the code (TechDocs and docs-as-code argue for co-location); 190 rule files | co-location wins           |
| Context loading only (nested CLAUDE.md, no hook)               | zero tooling   | loads only after the first touch; not enforced (the docs' own warning)                              | does not meet "read first" |
| Run Backstage / MkDocs                                         | portal, search | a server and a build to run; shared hosting; a one-person team                                      | cost without benefit now   |
| Parse the transcript in the hook                               | no state file  | which transcript a subagent's hook receives is unverified                                           | fragile                    |

## Consequences

- Good: a model cannot edit a part blind. Docs change with their code and are checked like code.
- Cost: build the registry, the check script and two hooks. Write about 190 docs over time, P0 first (PART-DOCS §7).
- Risk: an over-strict gate blocks urgent fixes. The documented exception is to Read the doc, since even a stub `PART.md` satisfies the gate, and then update it in the same change.

## Fitness functions

| Rule      | Check                                            | Exists / to build |
| --------- | ------------------------------------------------ | ----------------- |
| PD-1…PD-8 | `scripts/arch/part-docs-check.mjs`               | to build          |
| GATE      | `.claude/settings.json` PostToolUse + PreToolUse | to build          |

## Amendment, 2026-11-20 (Peter): general standards, not a doc for every part

Peter changed the rule the same day: TManage follows **general standards**, not a doc for every part. What changes:

- The rollout of `PART.md` to the remaining 184 parts is cancelled. A part without a `PART.md` never blocks an edit and never fails `pnpm arch:parts`.
- The missing-docs ratchet (`docs/architecture/baselines/parts-missing.json`) and the P0 list are removed.
- The edit gate now asks for `docs/architecture/README.md` to be read once per session (per agent) before any repository edit outside `docs/` and `.claude/`. Where a part has a `PART.md`, that one is still required as well.
- The 18 existing `PART.md` files stay, with PD-1 (loader) to PD-8.

Implemented in `scripts/arch/part-docs-gate.mjs`, `part-docs-check.mjs`, `parts-lib.mjs`; tests in `scripts/arch/part-docs.test.mjs`. `PART-DOCS.md` v1.1 and `README.md` say the same.
