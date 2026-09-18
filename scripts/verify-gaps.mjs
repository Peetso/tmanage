#!/usr/bin/env node
/**
 * The honest closing line of `pnpm verify`.
 *
 * `verify` runs format:check, typecheck, lint, contracts:validate, audit:design and the fast
 * `pnpm test` — which for `@tmanage/api` is `vitest run --project unit`. It deliberately does
 * NOT run the database corpus (`test:db`), the browser end-to-end suite (`test:e2e`) or the
 * visual-regression suite (`test:vr`): those gates take tens of minutes and start real
 * servers, so they run on their own. That separation is correct; the danger is only that the
 * *name* "verify" reads as "everything checked" while forty of the API's test files — the
 * whole tenant-isolation corpus, the role grid, the least-privilege suite, every repository
 * and migration test, i.e. everything that demonstrates ADR-0001 and ADR-0002 — sit outside
 * it. This line says so out loud, so a green `verify` is never mistaken for a green `test:db`.
 *
 * Run every gate, including the slow ones, with `pnpm verify:full`.
 *
 * The script only prints; it never fails a build. `apps/api/src/verify-gate.test.ts` (in the
 * API unit suite) is what keeps `verify` wired to this line and keeps `verify:full` chaining
 * the three.
 */
const gates = ['test:db', 'test:e2e', 'test:vr'];
console.log(
  [
    '',
    'verify passed the fast gates. It did NOT run: ' + gates.join(', ') + '.',
    'Those are the database corpus, the end-to-end suite and the visual-regression suite —',
    'each a separate, slower gate. Run everything with: pnpm verify:full',
    '',
  ].join('\n'),
);
