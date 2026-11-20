# Design checklist (fill in before any design or build)

Copy this block into the brief (or the ADR) and fill every line. Write "n/a — reason" where a line does not apply; a blank line fails review. Rule IDs refer to `ENGINEERING-STANDARD.md`.

```text
DESIGN-CHECKLIST v1
Brief / ADR:                     <path>
Author / model:                  <name>
Date:                            <YYYY-MM-DD>
```

## A. Qualities (QM-1, QM-2)

- [ ] ISO 25010 characteristics affected: …
- [ ] Scenario IDs that must stay green (`QUALITY-ATTRIBUTES.md`): QA-…
- [ ] Any trade-off against the QM-2 priority order? If yes → ADR …

## B. Placement and reuse (AR-5…AR-8, AR-11)

- [ ] Bounded context(s) touched (`VIEWS.md` §4): …
- [ ] Single source of truth for each rule introduced or changed: the rule, then the file it is decided in (`packages/domain/...` or one service)
- [ ] Searched `graphify-out/` and the modules: the existing thing reused is … / "none found" with the query used
- [ ] New cross-context access goes through: the owner's service … / a domain event … (never a foreign repository)
- [ ] Tables written, with their owning context: …

## C. Interface (AR-9, AR-10, HT-1…HT-5)

- [ ] New or changed routes: method, path, status codes per the §4 table
- [ ] The client receives **decisions** (required fields), not raw facts to re-derive
- [ ] The client handles **unknown** (5xx, 408, 429, timeout, network) as a visible retry state, not as empty, denied or signed out
- [ ] Unsafe retried requests: `Idempotency-Key` or natural unique key: …
- [ ] Contract pair added to `e2e/contracts/api-web-shapes.ts`
- [ ] Route census and permission map updated (SE-1)

## D. Data and concurrency (DA-1…DA-12)

- [ ] Read-then-write paths: anomaly prevented (lost update / write skew / phantom) and mechanism (unique key / conditional update / `FOR UPDATE` / lease)
- [ ] Isolation level if not the default, and why
- [ ] Write-conflict retry through the shared helper (DA-2)
- [ ] Migration kind: **expand** / **migrate** / **contract (contract-of NNNN)**; works with the previous release's code
- [ ] MariaDB 11.8 safe (`pnpm check:mariadb`); hot-table `ALTER` states `ALGORITHM`/`LOCK`
- [ ] Grants added to `scripts/db/users.sql`; cross-tenant test for every new tenant table

## E. Security (SE-1…SE-8)

- [ ] STRIDE row in `docs/security/threat-model.md`: T-…
- [ ] Guard chain unchanged, or the change is explained
- [ ] Session, step-up and re-auth decisions are read from identity only
- [ ] Secrets: env only; nothing logged

## F. Runtime and async (AS-_, ST-_, RT-_, OB-_)

- [ ] Correct with **two overlapping instances** (no instance-unique file or socket, no in-memory throttle, singleton work under the leader lease)
- [ ] Side effects via the outbox; consumer idempotent with a business dedupe key
- [ ] Multi-context process: saga steps + compensations (AS-5)
- [ ] Every outbound call has a timeout; integrations go through the breaker
- [ ] Job: page and time budget, cursor, run record, dead-letter
- [ ] Logs carry correlation id; no personal data

## G. Proof (PR-1, PR-3)

- [ ] Fitness function(s) added or extended: path …
- [ ] Revert proof: the test that fails when the change is reverted: …
- [ ] Defect class (if this is a fix): DC-…; sweep done (the query, and the sites found or fixed)
- [ ] Rule bent? → ADR-… with an end date

## H. UI and UX (UI-UX-DESIGN-STANDARD; skip only for non-UI work, with the reason)

- [ ] Figma node id(s) in `ZdUCRiqBiT7s3u08HA28RO`; the design is approved before build (UX-1)
- [ ] Personas and their journeys (EN and AR); the four extra states designed: loading, empty, error, unknown (UX-23)
- [ ] WCAG 2.2 AA items touched: target size, focus not obscured, accessible authentication (UX-4…UX-10)
- [ ] Tokens only (semantic tier), logical CSS properties only, reduced-motion path (UX-11, UX-14, UX-16, UX-21)
- [ ] Copy keys in all catalogs; GOV.UK writing rules (UX-15, UX-24)
- [ ] New component: the five contribution criteria, plus the component doc sections (UX-20, UX-22)
- [ ] Persona evaluation report planned: `UX-EVAL-<feature>.md` (UX-19)

## I. Parts read (PART-DOCS §3.3)

- [ ] Parts touched, from `docs/architecture/parts.json`: …
- [ ] `docs/architecture/README.md` was Read this session; the general-standard rule IDs applied: …
- [ ] Where a touched part has a `PART.md` (most have none): it was Read before any edit, its rule IDs are quoted, and it is updated in the same change with `last_verified_commit` restamped

## J. Production readiness review (PR-5; required for a new part, external dependency or background job)

- [ ] Architecture and dependencies · integration · capacity (DB connections, RAM: `docs/ops/hostinger-profile.md`) · failure modes · client behaviour (retries, unknown state) · processes and automation · development process · external dependencies (timeouts, breaker) · rollout and rollback
