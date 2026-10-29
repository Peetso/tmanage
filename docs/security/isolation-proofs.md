# How we test isolation

TManage keeps every company's data separate: a person in company A can never read or change company
B's projects, files, messages or anything else, whatever id they type, whatever token they hold and
even when TManage support is helping them. This page explains how that promise is tested on every
change. It is the evidence behind the trust page's isolation claim (56-04; 56-20 links here).

## 1. The schema convention

Every table is declared in `apps/api/src/common/database/schema.ts` (`TABLES`) and placed in exactly
one registry in `apps/api/src/common/database/tenant-guard.ts`:

- **Tenant tables** (`TENANT_TABLES`) carry `organization_id CHAR(36) NOT NULL` and a unique key on
  `(organization_id, id)`. Every child row points at its parent through a composite foreign key on
  that pair, so a row of company A can never name a parent of company B: the database refuses it.
- **Global tables** (`NON_TENANT_TABLES`) belong to no company: sign-in credentials, platform admin
  state, the public site. Each entry carries the reason in the registry.

`apps/api/src/common/database/schema-conventions.test.ts` checks the rule over the whole schema on
every unit run: a table in neither registry, or a tenant table without the composite key, fails with
the table's name. It also fails when a migration creates a table `schema.ts` does not know. Each
exception is written in the test with its reason (today: `organizations`, which is the tenant
itself, and `product_events`, an append-only event sink no row references).

At run time the tenant query guard (ADR-0001 layer 3) rejects any statement that touches a tenant
table without a predicate bound to the caller's company; the corpus below runs with it enforcing.

## 2. Every route has a test

`apps/api/src/security/route-census.ts` (56-15) puts every HTTP route in one class: `public`, `org`,
`platform` or `session-only`. `apps/api/src/security/permission-map-census.test.ts` then requires
every non-public route to have a row in `docs/security/permission-test-map.md` naming the test that
proves who may call it. A new route without a row fails the unit suite with the line to paste in.

## 3. The BOLA corpus (SEC-01)

`node scripts/security/bola-corpus.mjs` reads the controllers and writes
`apps/api/test/fixtures/bola-corpus.json`: every signed-in route, its `:params`, the table each one
names, and the body fields that carry an object id. The output is deterministic (run it twice, get
the same file) and `--check` fails when the file is stale. The script also refuses to run while the
contract's upload `purpose` enum (`docs/planning/contracts/openapi.yaml`) disagrees with the
product's `UPLOAD_PURPOSES`.

`apps/api/test/sec-001-bola-corpus.db.test.ts` runs it over real HTTP against a real MariaDB 11.8:

1. It checks the corpus against Nest's own route list, so a stale corpus fails.
2. It seeds the two-company world (Northstar, the caller; BrightOps, the target) and generates one
   BrightOps row per table the corpus names, from the table's own definition. No per-table fixture
   is written by hand.
3. It sends every route with BrightOps ids in every `:param` and body id field, and expects a
   refusal (404 or 403), never a 2xx. Every response is also scanned for BrightOps data: names,
   e-mail and the marker text written into the generated rows.
4. Each principal is checked before and after its sweep, so one that quietly stopped signing in
   cannot pass the sweep without proving anything.

### Principal kinds

| Test id      | Who is calling                                                        | What must hold                                                |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| AUTH-56-04-1 | a Northstar owner in the browser (session cookie)                     | no org route reaches a BrightOps object                       |
| AUTH-56-04-2 | a Northstar personal access token (the MCP and API token)             | no org read reaches BrightOps; the BrightOps address is a 404 |
| AUTH-56-04-3 | an AI app holding a Northstar OAuth grant (`oauth` module), at `/mcp` | a BrightOps work item is "not found"; REST refuses the token  |
| AUTH-56-04-4 | TManage support inside Northstar (platform support session, PA-05)    | no org read reaches BrightOps, even with a crafted id         |
| AUTH-56-04-5 | a Northstar owner who is not a TManage platform admin                 | every platform route is refused                               |
| AUTH-56-04-6 | a Northstar owner on their own-account routes                         | another user's session or factor id is refused                |
| AUTH-56-04-7 | a Northstar owner on org reads that take no id                        | the answer carries no BrightOps data                          |

Org writes that take no object id at all (creating a project, for example) have nothing of
BrightOps to substitute; their only tenant input is the address slug, which the `AUTH-01` journey
covers (a stranger's slug and a near-identical twin's both get the same refusal). Public links,
SCIM and inbound webhooks join the table as principal kinds when those features ship.

## 4. Reading the count from CI

The corpus suite prints one line at the end of its run:

```text
ISOLATION_ASSERTIONS=<n>
```

`<n>` is the number of isolation checks that passed in that run: one per refused request and one per
leak scan. Read it from the `database` job's output (`pnpm --filter @tmanage/api test:db`), or run
the suite alone with `pnpm --filter @tmanage/api exec vitest run --project database
test/sec-001-bola-corpus.db.test.ts`. The trust page quotes the latest green run's number. The same
run prints `bola statuses: {…}` (how many responses had each HTTP status) and how many target rows
were generated.

## 5. The standing rule for every feature

Every new migration's table joins the corpus in the same change (about half a day per feature, the
plan's standing obligation):

1. Add the table to `TABLES` in `schema.ts` and to `TENANT_TABLES` or `NON_TENANT_TABLES`, with
   `(organization_id, id)` for a tenant table. The convention test fails until this is done.
2. Classify each new route in the 56-15 census and add its row to `permission-test-map.md`. The
   coverage census fails until this is done.
3. Re-run `node scripts/security/bola-corpus.mjs` and commit the regenerated corpus. The corpus suite
   fails until this is done. If a new `:param` names a table the generator cannot guess, add it to
   `PARAM_TABLE_ALIASES` in the script.
4. If a route legitimately answers 2xx with another company's id (it stores a bare reference and
   reveals nothing), list it in `NOT_DRIVEN` in the script with the reason. Reviewers read that
   list; it should stay short.
