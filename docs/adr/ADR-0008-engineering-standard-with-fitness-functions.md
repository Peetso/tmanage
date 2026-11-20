# ADR-0008 — TManage is governed by a cited engineering standard whose rules are enforced by fitness functions

- **Status:** Proposed (lane B, 2026-11-20; accepted on manager commit under Peter's delegation, memory "Peter delegated the open decisions")
- **Date:** 2026-11-20
- **Deciders:** Implementation lead (Opus 5.5); design review Fable 5.2; Peter owns principle changes
- **Rules affected:** all; **bends a rule:** no
- **Quality scenarios:** all in `docs/architecture/QUALITY-ATTRIBUTES.md`
- **Evidence:** Peter, 2026-11-20, called `docs/architecture/ENGINEERING-RULES.md` "superficial". Defect classes DC-1…DC-6 (`ENGINEERING-STANDARD.md` §13).

## Context

The rule list in ENGINEERING-RULES.md (2026-11-20) was right in intent but had three gaps:

- **No sources.** Rules were house opinions, so a reviewer could not tell a principle from a preference.
- **No mapping to code.** It said "requests flow controller → service → repository", but 144 controller files import repositories and 521 imports reach into another module's repository (lane-B scan). Nothing showed this.
- **No enforcement.** Most rules had no check, so they held only while someone remembered them.

The same defect classes recurred: rule decided twice, transient treated as signed out, second process.

## Decision

1. `docs/architecture/ENGINEERING-STANDARD.md` is the binding standard. Each rule carries an ID, a verified source (ISO/IEC 25010:2023, C4, Clean/Hexagonal, DDD, Twelve-Factor, RFC 9110, the Idempotency-Key draft, outbox/saga, Berenson et al. 1995, MariaDB/MySQL docs, ParallelChange, Release It! 2nd ed., the Google SRE book, OWASP ASVS 5.0.0, NIST SP 800-63B-4, STRIDE, OpenTelemetry, Building Evolutionary Architectures 2nd ed.), today's evidence, a target and a check.
2. `docs/architecture/FITNESS-FUNCTIONS.md` lists one check per rule. A rule whose check is "to build" is still binding; its check is scheduled in the ranked build order.
3. Every design or build brief includes a filled `DESIGN-CHECKLIST.md`.
4. A rule is bent only by an ADR in `docs/adr/` (template `ADR-TEMPLATE.md`), with a compensating control and an end date.
5. Ratchets: for rules violated today at scale (AR-5, AR-6), the baseline count may only fall.
6. `ENGINEERING-RULES.md` remains as a pointer, so existing links and the repo `CLAUDE.md` still resolve.

## Alternatives considered

| Option                                       | Pros               | Cons                                                        | Why not chosen          |
| -------------------------------------------- | ------------------ | ----------------------------------------------------------- | ----------------------- |
| Keep the house rule list, add more rules     | short              | still uncited and unenforced                                | the failure being fixed |
| Adopt one external standard wholesale (ASVS) | external authority | covers security only, not process model, data or boundaries | incomplete              |
| Write the rules as lint config only          | fully automatic    | loses the reasons; some rules need design review            | rationale lost          |

## Consequences

- Good: a reviewer can reject a design by rule ID and source. Recurring classes get a check instead of a reminder.
- Cost: 39 checks (plus the to-build half of 10 partial ones) still have to be built. Ratchets need baseline files maintained.
- Neutral: some source details are partly verified (ISO characteristic names, Release It! chapter numbers, BEA definition wording, ASVS chapters other than V6–V10). They are marked in §1 of the standard.

## Fitness functions

See `docs/architecture/FITNESS-FUNCTIONS.md`: the engineering standard has 76 rules (17 E, 10 E+B, 41 B, 8 M); all standards together have 125 rows (22 E, 18 E+B, 73 B, 12 M). The companion standards are `IMPLEMENTATION-PATTERNS.md` and `UI-UX-DESIGN-STANDARD.md`, and part docs are covered by ADR-0011.
