# TManage implementation patterns

**Status:** binding (Peter, ABSOLUTE RULE, 2026-11-20). **Version** 1.0, 2026-11-20.

This file covers how code is written in this stack:

- TypeScript strict
- NestJS 11 DI without decorator metadata (ADR-0003)
- Fastify 5
- Drizzle ORM on mysql2 (API); raw mysql2 (worker)
- MariaDB 11.8
- Next.js App Router with React and TanStack Query
- Vitest, Playwright

Each pattern gives:

- **When**: when to use it.
- **Canonical**: the example in this repo to copy (`file:line`).
- **Anti-pattern seen here**: the example not to copy (`file:line`).
- **Check**: **E** exists, **B** to build. Build specs are in `FITNESS-FUNCTIONS.md` §IP.

Counts are lane-B grep counts (2026-11-20). Treat them as approximate baselines, not exact figures.

## 1. Source register (checked on the web, 2026-11-20)

| ID  | Source                                                                                                                                                  | Version                                    | URL                                                                                                                                        | Status                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| P1  | Martin Fowler, _Refactoring_, 2nd ed., Addison-Wesley                                                                                                   | 2018, ISBN 978-0-13-475759-9               | https://refactoring.com/catalog/                                                                                                           | Verified                                                                               |
| P2  | Gamma, Helm, Johnson, Vlissides, _Design Patterns_ (Strategy, Adapter, Decorator)                                                                       | 1994, ISBN 978-0-201-63361-0               | https://www.oreilly.com/library/view/design-patterns-elements/0201633612/                                                                  | Book verified; individual pattern pages not opened                                     |
| P3  | Fowler, _Patterns of Enterprise Application Architecture_: Repository, Unit of Work, Data Mapper                                                        | 2002, ISBN 978-0-321-12742-6               | https://martinfowler.com/eaaCatalog/repository.html ; /unitOfWork.html ; /dataMapper.html                                                  | Verified                                                                               |
| P4  | Gary Bernhardt, _Functional Core, Imperative Shell_ (Destroy All Software, das-0072)                                                                    | 2012 (secondary sources only)              | https://www.destroyallsoftware.com/screencasts/catalog/functional-core-imperative-shell                                                    | Partly (date)                                                                          |
| P5  | Alexis King, _Parse, don't validate_                                                                                                                    | 2019-11-05                                 | https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/                                                                        | Verified                                                                               |
| P6  | R. C. Martin, _Design Principles and Design Patterns_ (SOLID, 2000); _Clean Code_ (2008, ISBN 978-0-13-235088-4); critique: Dan North, _CUPID_ (2022)   | as cited                                   | https://www.thoughtworks.com/radar/techniques/cupid                                                                                        | Partly: the 2000 paper has no official host. **No empirical study of SOLID was found** |
| P7  | TypeScript TSConfig reference (`strict` family, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`) | current TS 7.0.2. **The repo is on 5.9.3** | https://www.typescriptlang.org/tsconfig/#strict                                                                                            | Verified                                                                               |
| P8  | React docs: _You Might Not Need an Effect_; _Server Components_; `'use client'` (React 19.3)                                                            | live                                       | https://react.dev/learn/you-might-not-need-an-effect ; https://react.dev/reference/rsc/server-components                                   | Verified                                                                               |
| P9  | Next.js docs: _Server and Client Components_ (App Router; Next 16.4)                                                                                    | updated 2026-10-05                         | https://nextjs.org/docs/app/getting-started/server-and-client-components                                                                   | Verified                                                                               |
| P10 | NestJS _Custom providers_ (`useFactory` + `inject`); Fastify _Encapsulation_, _Lifecycle_                                                               | Nest 12.5 docs; Fastify 5.12               | https://docs.nestjs.com/fundamentals/custom-providers ; https://fastify.dev/docs/latest/Reference/Lifecycle/                               | Verified                                                                               |
| P11 | Drizzle ORM; Kysely (alternative, not used)                                                                                                             | Drizzle 0.45.4; Kysely 0.29.9              | https://orm.drizzle.team/docs/overview ; https://kysely.dev/                                                                               | Verified (neither site states MariaDB support)                                         |
| P12 | Zod 4                                                                                                                                                   | 4.6.7                                      | https://zod.dev/                                                                                                                           | Verified                                                                               |
| P13 | Test pyramid (Cohn 2009, via Vocke, _The Practical Test Pyramid_, 2018); Kent C. Dodds, _The Testing Trophy_ (2021)                                     | as cited                                   | https://martinfowler.com/articles/practical-test-pyramid.html ; https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications | Verified (Cohn year partly)                                                            |
| P14 | fast-check (property-based testing)                                                                                                                     | 4.10.3                                     | https://fast-check.dev/                                                                                                                    | Verified                                                                               |
| P15 | StrykerJS (mutation testing) + Vitest runner                                                                                                            | 10.1.1                                     | https://stryker-mutator.io/docs/stryker-js/vitest-runner/                                                                                  | Verified                                                                               |
| P16 | Gerard Meszaros, _xUnit Test Patterns_ (Dummy, Stub, Spy, Mock, Fake)                                                                                   | 2007, ISBN 978-0-13-149505-0               | https://martinfowler.com/bliki/TestDouble.html (xunitpatterns.com unreachable)                                                             | Partly                                                                                 |
| P17 | neverthrow (typed Result for TS), cited as the reference shape only                                                                                     | 8.2.0                                      | https://github.com/supermacro/neverthrow                                                                                                   | Verified                                                                               |

## 2. Patterns

### IP-1 Strict types, no unchecked casts

- **When:** always.
- **Source:** P7.
- **Canonical:** `tsconfig.base.json:10-12` turns on `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. It also sets `noImplicitOverride`, `useUnknownInCatchVariables`, `verbatimModuleSyntax`, `noImplicitReturns`, `noFallthroughCasesInSwitch` and `noPropertyAccessFromIndexSignature`. `apps/api/tsconfig.json:11-16` enables decorators **without** `emitDecoratorMetadata` (ADR-0003).
- **Anti-pattern seen here:** about 61 `body as Record<string, unknown>` casts, e.g. `apps/api/src/modules/admin/audit-retention.service.ts:72`, `policy-simulate.service.ts:107`, `ai-actions/bound-token-confirm.interceptor.ts:123`.
- **Check:**
  - **E:** `pnpm typecheck`; `no-explicit-any` (lint).
  - **B:** enable `@typescript-eslint/no-unsafe-type-assertion`. It is present in the installed typescript-eslint 8.67. Use a baseline ratchet.
  - **B:** a TypeScript 7 upgrade ADR. The repo is on 5.9.3; TS 6.0 made `strict` the default and changed the `types` default.

### IP-2 Parse, don't validate, at the boundary, once

- **When:** every request body, query, header, env var, webhook, outbox payload and file import.
- **The idea:** parse `unknown` into a precise type once, then pass only the parsed type inward (P5). The parser is a schema (Zod 4, P12) or a hand-written parser that returns a typed value.
- **Canonical:** `apps/api/src/modules/admin/audit-retention.controller.ts:66-68` takes `@Body() body: unknown` and calls `this.service.parse(body)` once. 142 controllers take `body: unknown`. Env: zod `envSchema`, `packages/config/src/env.ts:184`. Events: JSON schemas in `packages/contracts/src/events/json-schema.ts`.
- **Anti-pattern seen here:** `apps/api/src/modules/admin/announcements.controller.ts:61-67` types the body as an interface (`CreateAnnouncementBody`) that nothing checks, then picks fields with `asOptionalString(body?.title)`. **337** `@Body()` parameters are typed with an interface, which is a lie to the compiler.
- **Target:** request schemas in `packages/contracts` (Zod 4). The API parses with them; the web imports `z.infer` types. Today Zod is in `apps/api`, `mcp-server` and `config` only.
- **Check:**
  - **B:** ESLint `no-restricted-syntax`: a parameter decorated with `@Body`, `@Query` or `@Headers` must be annotated `unknown`. Use a baseline ratchet from 337.

### IP-3 Functional core, imperative shell

- **When:** any rule (policy, money, dates, state transitions).
- **The idea:** the decision is a pure function in `packages/domain`. I/O happens around it (P4; Clean Architecture's Dependency Rule, see ENGINEERING-STANDARD AR-1).
- **Canonical:** `packages/domain/src/policies/authorize.ts:257` (`authorize(request): AuthorizationDecision`, pure), called by the shell at `apps/api/src/modules/activity/activity.service.ts:141,311`. Also `modules/identity/reauthentication-code.ts:14-27`.
- **Anti-pattern seen here:** the rule re-implemented at the edge: `apps/web/src/components/meetings/CalendarConnections.tsx:61` (role set) and `apps/web/src/lib/public-signup.ts:66` (password minimum).
- **Check:**
  - **E:** AR-1 lint (domain stays pure).
  - **B:** AR-8 lint (no policy literals in the web).
  - **B:** IP-15 property tests on the core.

### IP-4 Typed outcomes for expected failures; exceptions only for defects and infrastructure

- **When:** an outcome the caller must handle (refused, not found, conflict, unknown) is a **discriminated union** in the return type. `throw` is for bugs and for infrastructure failures that a boundary handler maps to 5xx.
- **Decision:** no Result library. A native union keeps the domain dependency-free (AR-1); `neverthrow` (P17) is the reference shape.
- **Canonical:**
  - `AiBudgetRefusal`: `apps/api/src/modules/copilot/ai-budget.service.ts:70`
  - `AuthorizationDecision`: `packages/domain/src/policies/authorize.ts:196`
  - The web session check: `apps/web/src/lib/session-check.ts:24`
  - HTTP mapping: `ApiErrorCode` / `ApiError` / `apiErrorBody`, `apps/api/src/common/http/errors.ts:31,87,106`
  - Typed storage errors: `packages/storage/src/errors.ts:9-99`
- **Anti-pattern seen here:**
  - A union that loses a case: `SweepLockOutcome` at `apps/worker/src/common/database/sweep-lock.ts:24` has no `error` case, so a DB error becomes `{ran:false}` (`:50-51`), which is DC-1.
  - About **197** `throw new Error(...)` in API modules, e.g. `modules/calendar/meeting-join.service.ts:408`.
  - About **643** bare `catch {`, e.g. `modules/app-connect/app-connect.service.ts:147,175`.
- **Check:**
  - **B:** ESLint ratchet on `ThrowStatement > NewExpression[callee.name='Error']` in `apps/api/src/modules/**`.
  - **B:** a bare-`catch` ratchet that allows a catch only if it rethrows, returns a typed outcome, or carries a `// swallow: <reason>` comment.
  - **B:** `@typescript-eslint/only-throw-error` (installed).

### IP-5 Repository + Unit of Work (tenant-bound)

- **When:** all persistence.
- **The pattern:** a repository gives collection-like access to one context's tables (P3). The Unit of Work is the one tenant-bound transaction.
- **Canonical:** `TenantDatabase.transaction<T>()` and `read<T>()`, `apps/api/src/common/database/tenant-context.ts:642-689`, documented as "the only supported route to the database" (`:34`). About 406 `*.repository.ts`, e.g. `common/database/mail-queue.repository.ts`. Drizzle on mysql2 (`apps/api/package.json:48,55`).
- **Anti-pattern seen here:** a repository used across contexts. There are 521 foreign-repository imports, e.g. `modules/activity/activity.service.ts:18` → `projects/projects.repository` (ENGINEERING-STANDARD AR-5).
- **Check:**
  - **E:** AR-4 lint, plus the tenant guard tests.
  - **B:** AR-5 ratchet script.

### IP-6 Ports & adapters with Strategy / Adapter / Decorator

- **When:** any infrastructure the domain uses (storage, mail, calendars, connectors, AI provider).
- **The pattern:** the port is an interface owned by the core; each adapter is a Strategy chosen in the composition root (P2; Hexagonal, ENGINEERING-STANDARD S4).
- **Canonical:**
  - `ObjectStore` (`packages/storage/src/object-store.ts:222`), implemented by `FilesystemObjectStore` (`filesystem-object-store.ts:239`) and `FakeObjectStore` (`fake-object-store.ts:47`).
  - `Mailer` (`packages/mail/src/mailer.ts:167`), implemented by `ConsoleMailer`, `QueueMailer` and `SmtpMailer`. `BounceGuardMailer` is a **Decorator**.
  - `CalendarProviderAdapter` (`modules/google-calendar/calendar-sync.job.ts:30`).
  - `PublicLinkTargetAdapter` (`modules/public-links/public-link-targets.ts:76`).
- **Anti-pattern seen here:** an adapter with no timeout or breaker: `modules/identity/geo/tor-exit-list.ts:16` (`fetch(target)`). See ST-1 and ST-4.
- **Check:**
  - **B:** ST-1 lint (fetch needs a signal).
  - **B:** ST-4 breaker import rule.

### IP-7 Explicit DI without decorator metadata (ADR-0003)

- **When:** every Nest provider.
- **The pattern:** every constructor parameter carries `@Inject(TOKEN)`. Factories use `useFactory` + `inject` (P10).
- **Canonical:**
  - `apps/api/src/modules/admin/announcements.controller.ts:48` (`@Inject(ORG_ANNOUNCEMENTS_SERVICE)`, about 803 uses).
  - `apps/api/src/common/email/mailer.module.ts:154-170` (`inject: [TENANT_DATABASE]`, `useFactory`).
  - The composition root: `apps/api/src/app.module.ts:1248`.
- **Anti-pattern:** a parameter with no `@Inject`, which resolves to `undefined` at runtime because there is no metadata.
- **Check:**
  - **E:** `apps/api/src/common/http/nest-di.test.ts`.

### IP-8 Cross-cutting concerns in one place per layer

- **When:** auth, CSRF, tenancy, rate limits, correlation, idempotency, error mapping.
- **The pattern:** Nest guards and interceptors registered globally in order (`apps/api/src/app.module.ts:1262-1270`). Fastify hooks are used only in `apps/api/src/common/http/fastify-adapter.ts`, following Fastify's lifecycle order (onRequest → … → onResponse, P10).
- **Canonical:**
  - `common/http/correlation.interceptor.ts`
  - `common/http/idempotency-replay.interceptor.ts:39`
  - `common/http/http-exception.filter.ts`
- **Anti-pattern:** per-controller re-implementation of a guard concern. None found by lane B.
- **Check:**
  - **E:** `security/sdlc-census.test.ts` (route classes).

### IP-9 Server Components by default; client components at the leaves

- **When:** every page and layout.
- **The pattern:** fetch on the server where the data does not need interactivity. Push `'use client'` down to interactive leaves (P8, P9). The goal is a smaller client bundle, which serves LCP and INP (UI-UX UX-17).
- **Canonical:** `apps/web/src/app/[orgSlug]/layout.tsx:27-34` (server gate before render); `(website)/alternatives/[slug]/page.tsx` (async server page).
- **Anti-pattern seen here:** **1076 of ~1161** `.tsx` files are `'use client'`, and only 22 of 344 `page.tsx` are async server components. Product data loads entirely on the client.
- **Check:**
  - **B:** `scripts/arch/client-boundary.mjs`: count `'use client'` files under `apps/web/src`; the baseline (1076) may only fall.
  - **B:** the UX-17 performance budget.

### IP-10 You might not need an Effect

- **When:** never use `useEffect` for derived state, for copying query data into state, for event-driven logic, or for fetching. Use render-time derivation, the `key` prop, event handlers, or TanStack Query (P8).
- **Canonical:** TanStack Query for server state (519 files, about 728 `useQuery(` calls).
- **Anti-pattern seen here:**
  - `apps/web/src/components/admin/SignInPolicyCard.tsx:122-124` copies `policy.data` into state.
  - `apps/web/src/components/brand/BrandColourCard.tsx:45-47`: the same.
  - `apps/web/src/components/website/pages/download/DownloadPage.tsx:21-23` fetches in an effect.
  - Total: about 371 `useEffect` in `apps/web/src`.
- **Check:**
  - **B:** enable `react-hooks/set-state-in-effect`. It ships in the installed `eslint-plugin-react-hooks` 7.1.1, but `eslint.config.js:117-126` enables only `rules-of-hooks` and `exhaustive-deps`. Start it as a warning with a ratchet.

### IP-11 Refactoring discipline

- **When:** every structural change.
- **The pattern:** small, behaviour-preserving steps from Fowler's catalog (P1), each under green tests. Refactoring commits are separate from behaviour changes. When refactoring a module, migrate one call site of a foreign repository at a time (AR-5).
- **Canonical:** the ratchet approach in FITNESS-FUNCTIONS (AR-5, AR-6).
- **Anti-pattern:** a "v2" left beside a "v1" (AR-11).
- **Check:**
  - **M:** code review (commit split).

### IP-12 SOLID, where the evidence supports it

- **When:** only as named consequences of the rules above:
  - Single Responsibility = one bounded context per module and one reason to change (S5).
  - Dependency Inversion = ports owned by the core (IP-6).
  - Interface Segregation = narrow ports (`ObjectStore` methods per use).
- **Why so narrow:** no empirical study backs SOLID as a whole; the CUPID critique is an expert opinion (P6). We do **not** add interfaces "for SOLID" where there is only one implementation and no test seam.
- **Check:**
  - **M:** design review.

### IP-13 Test shape: static → unit (pure core) → integration on real MariaDB → few e2e journeys

- **Source:** P13. Our shape is a trophy-like weighting: static checks and integration carry the most weight, because the risky behaviour sits in SQL, isolation and the boundaries.
- **Today:** about 1404 unit, 160 `*.db.test.ts`, 58 e2e specs, 108 VR baselines.
- **Rules:**
  - Domain functions get unit tests.
  - Repositories and transactions get db tests on MariaDB 11.8, never mocked SQL.
  - Cross-boundary rules get a contract test or an e2e journey (PR-1).
- **Check:**
  - **E:** `pnpm verify` / `verify:full`.

### IP-14 Test doubles: fakes for ports, mocks only at the process edge

- **Source:** P16 vocabulary.
- **The pattern:**
  - Use **Fakes** for ports (`packages/storage/src/fake-object-store.ts:47`).
  - Use **Stubs** for clocks and ids.
  - Use **Mocks** (`vi.mock`) only for modules at the process edge (network, crypto randomness).
  - Never mock our own repositories in a test that should be a db test.
- **Today:** 1 fake file; 78 files use `vi.mock(`.
- **Check:**
  - **B:** ratchet on the `vi.mock(` file count (78).
  - **B:** a `packages/test-kit` home for shared fakes (Mailer, Clock, ObjectStore).

### IP-15 Property-based tests for the pure core

- **When:** functions with a large input space: authorize/permission matrices, money, schedules and working-calendar maths, state machines, the HTTP outcome classifier (HT-2), copy placeholders.
- **Tool:** fast-check 4.10 with Vitest (P14).
- **Today:** not present.
- **Check:**
  - **B:** `packages/domain/**/*.property.test.ts` for authorize, money and state machines.
  - **B:** a FITNESS row asserting each listed module has at least one property test.

### IP-16 Mutation testing as a fitness function (proposed)

- **When:** for the code where a weak test is most dangerous: `packages/domain/src/policies/**`, `modules/identity/reauthentication-code.ts`, `apps/web/src/lib/session-check.ts`, `apps/server/platform-gate.mjs`, the tenant guard.
- **Tool:** StrykerJS 10.1 with the Vitest runner (P15).
- **Target:** proposed mutation score ≥ 80 % on those files, run per pass (not per commit, for laptop load; memory "leave machine headroom").
- **Check:**
  - **B:** `stryker.config.mjs` scoped to those files; `pnpm test:mutation`. The score is recorded in `docs/architecture/baselines/mutation.json` and may only rise.

### IP-17 Worker job shape

- **When:** every sweep and consumer.
- **The pattern:**
  - a lease (AS-4 / RT-3)
  - a page and time budget with a cursor (AS-6)
  - an effect keyed by a business unique key (AS-2)
  - an attempt recorded **before** the handler runs
  - backoff, then dead-letter
- **Canonical:** `apps/worker/src/outbox/dispatcher.ts:27-31` (claim with `FOR UPDATE SKIP LOCKED`, durable attempt, savepoint per handler); `outbox/backoff.ts:8`.
- **Anti-pattern seen here:** `sweep-lock.ts:50-51` (an error looks like "held"); in-memory throttles at `apps/server/scheduled-sweeps.mjs:591-597`.
- **Families:** 31 jobs in `apps/worker/src/jobs/`, 18 consumers in `apps/worker/src/consumers/`, 16 sweeps in `apps/server/scheduled-sweeps.mjs:85-594`. They are listed as parts in `PART-DOCS.md`.
- **Check:**
  - **B:** the AS-4 and AS-6 sweep census tests.

## 3. Benchmark: implementation practice at leading organisations (own pages, accessed 2026-11-20)

| #    | Organisation, source (URL)                                                                                                         | Published practice                                                                                                                                      | Decision                                                                                                                                                                                                            | Where            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| IB-1 | Google, _What to look for in a code review_ https://google.github.io/eng-practices/review/reviewer/looking-for.html                | Twelve review headings: design, functionality, complexity, tests, naming, comments, style, consistency, documentation, every line, context, good things | **Adopted** as the manager's review rubric, plus one TManage line: "which IP-/AR-/HT- pattern does this follow, and does it copy a listed anti-pattern?"                                                            | §2 (all IP rows) |
| IB-2 | Winters et al., _Software Engineering at Google_ ch. 11 (test sizes) https://abseil.io/resources/swe-book/html/ch11.html           | Small: one process, no I/O. Medium: one machine. Large: several machines. Mix about 80/15/5                                                             | **Adapted** (IP-13): small = unit, medium = db test on local MariaDB, large = e2e. **Rejected:** the 80/15/5 target, because our risk sits in SQL and boundaries (IP-13 rationale).                                 | IP-13            |
| IB-3 | GitHub, _Scientist_ https://github.com/github/scientist                                                                            | Run the control and the candidate, compare and publish mismatches when refactoring critical paths                                                       | **Adapted:** comparison tests with fast-check (IP-15) for rewrites of `authorize`, `session-check` and the tenant guard.                                                                                            | IP-15            |
| IB-4 | Stripe, _Idempotent requests_ https://docs.stripe.com/api/idempotent_requests ; blog (2017) https://stripe.com/blog/idempotency    | Keys ≤ 255 chars, replay of the first result, mismatch is an error, backoff with jitter                                                                 | **Adopted:** the implementation of `apps/api/src/common/http/idempotency-replay.interceptor.ts:39` must meet ENGINEERING-STANDARD HT-4, and client retries (`apps/web/src/lib/api/client.ts`) use jittered backoff. | HT-4; IP-4       |
| IB-5 | Shopify, _Under Deconstruction_ (2020) https://shopify.engineering/shopify-monolith ; Packwerk https://github.com/Shopify/packwerk | Static reference checks reject dependency and privacy violations in the pull-request workflow                                                           | **Adopted** as the model for the AR-5 and AR-6 scripts; IP-5 explains why the boundary matters.                                                                                                                     | IP-5             |
| IB-6 | Thoughtworks Technology Radar Vol. 35 (Nov 2026) https://www.thoughtworks.com/radar/techniques                                     | Mutation testing in **Adopt**                                                                                                                           | **Adopted** (IP-16), scoped to the highest-risk files so the laptop is not overloaded.                                                                                                                              | IP-16            |
| IB-7 | Martin Fowler, _Refactoring_ catalog https://refactoring.com/catalog/                                                              | Named, behaviour-preserving refactorings                                                                                                                | **Adopted:** commit messages for refactors name the catalog entry (for example "Move Function", "Replace Conditional with Polymorphism").                                                                           | IP-11            |
