# ADR-0003 — Explicit injection tokens, because the test transform emits no decorator metadata

- **Status:** Accepted
- **Date:** 2026-08-24
- **Deciders:** Implementation lead
- **Governing sources:** `13-ENGINEERING-EXECUTION-SPEC.md` (NestJS 11 + Fastify);
  `27-TEST-CATALOG.md` (the suite that must be able to boot the real application);
  ADR-0002 (why the database suite runs in-process rather than against a container)
- **Evidence:** `apps/api/src/common/http/nest-di.test.ts` — both directions asserted

## Context

NestJS resolves constructor dependencies in two ways. The idiomatic way relies on TypeScript
emitting a `design:paramtypes` metadata entry for every decorated class, which requires the
compiler option `emitDecoratorMetadata`. The explicit way puts `@Inject(TOKEN)` on each
parameter and does not depend on emitted metadata at all.

`tsc` implements `emitDecoratorMetadata`. **esbuild does not**, and has stated it will not:
the option requires a full type checker, and esbuild deliberately does not have one.

That matters here because of where the application is actually exercised. The one suite that
proves the request pipeline is correct — `apps/api/test/http-pipeline.db.test.ts` — boots the
real `AppModule` over a real MySQL server (ADR-0002) and drives real HTTP through Fastify.
It runs under vitest, and **vitest transforms TypeScript with esbuild**. So the environment in
which the security-critical wiring is verified is precisely the environment that cannot supply
`design:paramtypes`.

### The failure mode is worse than a wiring error

This is the part that decided it, and it was observed rather than reasoned about.

Without `design:paramtypes`, Nest does not see a dependency it cannot resolve. It sees a
constructor that takes **no arguments**. There is nothing to report, so:

1. `NestFactory.create()` succeeds.
2. `app.init()` succeeds — no "Nest can't resolve dependencies" error, because from the
   container's point of view there was never a dependency.
3. Every route registers.
4. A health check passes.
5. The first real request dereferences `undefined` inside the handler and the caller gets a
   bare 500.

An application that starts cleanly, reports healthy, and then fails every request is a far
worse outcome than one that refuses to start. Worse still for this codebase specifically: a
guard whose collaborator is `undefined` throws — which is a refusal, and therefore _looks_
safe — while a guard whose collaborator is `undefined` and whose first act is a metadata
lookup returning `undefined` may simply **allow**. The distance between those two is the whole
access-control layer.

The alternative of "just enable `emitDecoratorMetadata`" does not resolve it. The option
changes what `tsc` emits; it changes nothing about what esbuild emits, so the production build
would work and the suite that verifies the production build would not.

## Decision

**Every provider is registered under an explicit token, and every injected constructor
parameter carries `@Inject(TOKEN)`.** No parameter in `apps/api` relies on emitted type
metadata, including parameters whose type is a concrete class that would resolve fine under
`tsc`.

Three supporting rules:

1. **`emitDecoratorMetadata` stays off.** `apps/api/tsconfig.json` sets `experimentalDecorators`
   and deliberately omits `emitDecoratorMetadata`, with a comment pointing here. Leaving it off
   means `tsc` and esbuild agree about what the decorators mean, so the build and the test run
   cannot diverge in the one way that matters.

2. **Tokens are `Symbol.for`, not `Symbol`.** They live in
   `apps/api/src/common/http/tokens.ts`. Under vitest's transform pipeline the database suite
   and the application can end up holding two module instances, and two distinct `Symbol()`
   values with the same description then present as two different providers — a
   "Nest can't resolve dependencies" failure with no visible cause. The global symbol registry
   makes token identity survive that.

3. **The rule is exception-free.** A convention that holds for security-critical providers and
   lapses for convenient ones has no failure signal: the lapse is invisible until the request
   that needed it. Uniformity is what makes a missing `@Inject` a reviewable diff rather than
   a judgement call.

### Held by a test, not by this document

`apps/api/src/common/http/nest-di.test.ts` builds two identical miniature Nest graphs — one
tokenised, one relying on emitted parameter types — and asserts **both** directions:

- The tokenised graph starts and serves 200.
- The metadata graph starts without complaint, registers its route, and returns **500** on the
  first request.

The negative case is the load-bearing one. The positive case alone would keep passing if
someone enabled `emitDecoratorMetadata` and quietly started omitting tokens; the negative case
is what says the constraint is still real. If it ever returns 200, the premise of this ADR has
changed and the change should be made deliberately, not discovered when half the providers had
already stopped carrying tokens.

## Consequences

**Positive**

- The application wires identically under `tsc` and under esbuild, so the suite verifies the
  thing that ships.
- Dependency edges are readable in the source. `@Inject(MEMBERSHIP_RESOLVER)` names an
  interface boundary; a bare parameter type names an implementation class.
- Type-only imports stay type-only. Every guard imports its collaborators as
  `import type { MembershipResolver }`, `import type { TenantDatabase }`,
  `import type { SessionService }`, and `ApiConfig` is a plain interface with no runtime value
  at all. `emitDecoratorMetadata` needs the _value_ in scope to emit it, so relying on metadata
  would force those imports to become value imports purely to satisfy the transform — pulling
  concrete repository and service implementations into the guard's runtime import graph, which
  is precisely the coupling ADR-0001 layer 4's lint boundary exists to prevent. Explicit tokens
  let the guard depend on the shape and nothing else.
- No dependency on a transform-level feature that one of our two toolchains has declined to
  implement.

**Negative**

- More ceremony per constructor, and one more thing to forget. Mitigated by uniformity (a
  missing token stands out) and by the pipeline suite, which boots the whole graph and would
  500 rather than pass.
- A newcomer coming from idiomatic Nest documentation will find this unfamiliar. Mitigated by
  the comment in `tokens.ts` and by this record.
- The token file is a small module every provider depends on. Acceptable: it holds symbols and
  no behaviour.

## Alternatives rejected

- **Enable `emitDecoratorMetadata`.** Does not affect esbuild, so the production build would
  resolve and the verifying suite would not. Rejected as the exact opposite of the property
  wanted.
- **Run the database suite through `tsc` or SWC instead of esbuild.** Adds a second transform
  toolchain, and its output would then differ from every other suite. It also fixes the symptom
  at the cost of making the test environment less like the one every other test runs in.
- **Use `@Inject` only where a token is strictly needed (interfaces).** This is the tempting
  middle. It leaves class-typed parameters resolving through metadata, which means they resolve
  under `tsc` and become silent `undefined`s under esbuild — reintroducing the whole failure
  mode for the subset of dependencies nobody thought about.

## Revisit trigger

Revisit if vitest's transform gains `emitDecoratorMetadata`, or if the API moves to a runtime
that supplies it (for example TypeScript 5 standard decorators with a metadata proposal Nest
supports). Even then: change it deliberately, delete the negative test case in the same commit
with a note, and only after confirming the pipeline suite still boots the real `AppModule`.
