# scripts/load

A free, local load test against the planning pack's performance targets. No extra dependency:
it uses Node 22's built-in `fetch`.

| File                 | What it does                                                                   |
| -------------------- | ------------------------------------------------------------------------------ |
| `run.mjs`            | signs in seeded users, loads each route, prints the report, sets the exit code |
| `load-plan.mjs`      | pure helpers: targets, routes, local-host guard, percentiles, report           |
| `load-plan.test.mjs` | unit tests for the report maths and the guard                                  |

## Targets

| Route               | Target       | Source                                                   |
| ------------------- | ------------ | -------------------------------------------------------- |
| `home-my-day`       | p95 < 300 ms | PERF-01, NFR-04                                          |
| `work-list`         | p95 < 300 ms | PERF-02                                                  |
| `inbox`             | p95 < 300 ms | PERF-04                                                  |
| `conversations`     | p95 < 300 ms | NFR-04 (common read)                                     |
| `search`            | p95 < 500 ms | PERF-03                                                  |
| `recent-item-write` | p95 < 500 ms | not in the plan; the script's default, see `--write-p95` |
| `realtime-fan-out`  | p95 < 1 s    | NFR-06, PERF-06 (only with `--realtime-sockets`)         |

Every route also misses when more than 1 % of its requests fail (non-2xx, timeout after 10 s,
or network error). Latency percentiles include failed requests.

## It never runs against the live site

`--api` and `--origin` must be a local development host (`localhost`, `127.0.0.1`, `::1`,
`*.localhost`, `*.test`). Anything else is refused before a single request is sent.

## Run it

1. Start a local database, migrate it, and seed the two-tenant test world:

   ```sh
   pnpm db:migrate
   TMANAGE_SEED_DATABASE_URL=mysql://user:pass@127.0.0.1:3306/tmanage \
     pnpm --filter @tmanage/api exec tsx test/seed-cli.ts > world.json
   ```

2. Start the API on that database, not in production mode (the dev sign-in route
   `POST /v1/dev/sessions` only exists outside production), with the same environment the e2e
   stack sets in `e2e/setup/stack.ts`: `pnpm --filter @tmanage/api exec tsx src/main.ts`.

3. Run the load test:

   ```sh
   node scripts/load/run.mjs --world world.json
   ```

   It signs in the Northstar owner, manager and designer from `world.json` and uses that
   tenant's project, work item and work-item title (as the search term).

Exit code: `0` every route met its target, `1` at least one missed, `2` setup error
(refused host, sign-in failed, bad option).

## Options

| Option                     | Default                           | Meaning                                               |
| -------------------------- | --------------------------------- | ----------------------------------------------------- |
| `--api`                    | `http://localhost:3001`           | API base URL (local only)                             |
| `--origin`                 | `http://localhost:3000`           | web origin sent with every request                    |
| `--org`                    | `northstar-studio`                | organization slug                                     |
| `--world <file>`           | -                                 | seed-cli JSON output                                  |
| `--user-id <id>`           | -                                 | sign in by id via the dev route; repeatable           |
| `--email <email>`          | -                                 | sign in by password (`LOAD_PASSWORD` env); repeatable |
| `--project`, `--work-item` | from `--world`                    | ids used by the work list and the write               |
| `--search <term>`          | first word of the work item title | search query                                          |
| `--duration <s>`           | `20`                              | measured seconds per route                            |
| `--warmup <s>`             | `2`                               | unmeasured seconds per route first                    |
| `--connections <n>`        | `10`                              | concurrent request loops                              |
| `--only a,b`               | all                               | run only these route names                            |
| `--max-error-rate <0..1>`  | `0.01`                            | allowed share of failed requests                      |
| `--write-p95 <ms>`         | `500`                             | target for the write route                            |
| `--json <file>`            | -                                 | also write the full results as JSON                   |
| `--fill-work <n>`          | `0`                               | first create n work items through the API             |
| `--fill-messages <n>`      | `0`                               | first post n messages in a fresh channel              |
| `--realtime-sockets <n>`   | `0` (off)                         | run the fan-out probe with n subscribed sockets       |
| `--realtime-messages <n>`  | `20`                              | messages the probe posts                              |
| `--realtime-gap <ms>`      | `1500`                            | pause between probe messages                          |
| `--realtime-p95 <ms>`      | `1000`                            | target for the probe                                  |

The write route records a recent item (`PUT /home/recent-items`), which is an idempotent upsert,
so a long run does not grow the database.

## Realtime fan-out probe

The socket lives in the worker, so the probe needs the worker in loop mode with `REALTIME_PORT`
set, and the API with `REALTIME_PUBLIC_URL` pointing at it (a local `ws://` URL). The probe
creates a channel, adds the signed-in users, opens n sockets with tickets from
`POST .../realtime/tickets`, subscribes each one, posts the messages and times each POST to
each socket's `message.created.v1` frame. A frame not seen within 10 s counts as a failure at
10 s. Delivery waits on the outbox poll (`OUTBOX_POLL_INTERVAL_MS`, 5 s by default).

## Tests

```sh
node --test scripts/load/load-plan.test.mjs
```
