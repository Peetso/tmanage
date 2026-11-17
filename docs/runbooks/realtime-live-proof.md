# Realtime live proof (51-06)

How to prove that chat pushes reach a second browser through Hostinger's LiteSpeed proxy, and
how to record the result. The code side is built: the worker's socket server is attached to the
single app on `/realtime` (`apps/server/realtime-inprocess.mjs`), tickets are minted at
`POST /v1/organizations/:orgSlug/realtime/tickets`, and the browser hook
(`apps/web/src/lib/use-channel-live-feed.ts`) subscribes and refetches on every frame.

The `/healthz/deep` `realtime` line is 56-30's, not this runbook's.

## 1. Environment knobs

All optional; the defaults are the shared-hosting figures (56 §12.2). Read once at boot by
`apps/worker/src/realtime/server.ts` (`realtimeLimitsFromEnv`); a malformed value falls back to
the default.

| Variable                          | Default                       | What it does                                                                                                |
| --------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `REALTIME_MAX_SOCKETS`            | `500`                         | Sockets the process holds at once. The next is accepted, then closed `4429` with reason `retry-after=30`.   |
| `REALTIME_MAX_SOCKETS_PER_MEMBER` | `5`                           | Sockets one member (`organizationId:userId`) holds at once. The next is closed `4429` `retry-after=5`.      |
| `REALTIME_PING_INTERVAL_MS`       | `25000`                       | Server ping period. A socket that misses two pongs is terminated. 25 s sits under LiteSpeed's idle timeout. |
| `REALTIME_INPROCESS`              | on with `WORKER_INPROCESS=1`  | `0` turns the attached socket off; clients fall back to refetch.                                            |
| `REALTIME_PUBLIC_URL`             | derived from `WEB_PUBLIC_URL` | The `wss://…/realtime` URL served beside the ticket.                                                        |

Other server behaviour you do not configure:

- A ticket opens one socket, once. If the same ticket is used again inside its 60 s life, the
  socket is closed `4401`, the same close a forged ticket gets.
- Any client frame other than `subscribe` is answered `{type:'error'}` and changes nothing.
- The browser treats `4429` as a retry after the hinted seconds, not as an error. Only
  `revoked` is terminal.

## 2. Measure LiteSpeed's idle timeout (the 5-minute idle test)

Do this once, before trusting the 25 s ping, and again after any Hostinger plan change.

1. Open one channel in a signed-in browser on live, with DevTools → Network → WS open.
2. Leave the tab in the foreground and touch nothing for **5 minutes**.
3. Note whether the `/realtime` socket is still open (no new row, frames show `ping`/`pong`
   control traffic as the 25 s cadence) or was closed and re-dialled (a second row; note the
   close code and the time it closed after the last frame).
4. If it was closed in under 5 minutes even with pings, lower `REALTIME_PING_INTERVAL_MS` below
   the observed idle (say to two thirds of it), restart the app, and repeat.

RT-LIVE-02 below automates this. The manual pass tells you _why_ it failed if it does.

## 3. Run RT-LIVE-01/02/03 on live

The test needs two test accounts, both members of one channel, and must not create any other
data on live. Sign each account in by hand once and save its browser state:

```
pnpm --filter @tmanage/e2e exec playwright codegen --save-storage=.auth/rt-a.json https://tmanageapp.com
pnpm --filter @tmanage/e2e exec playwright codegen --save-storage=.auth/rt-b.json https://tmanageapp.com
```

(The files land in `e2e/.auth/`, and the paths below resolve from `e2e/`. Keep `.auth/` out of git: the files hold session cookies.) Then, from the repo root:

```
E2E_BASE_URL=https://tmanageapp.com \
E2E_RT_STORAGE_A=./.auth/rt-a.json \
E2E_RT_STORAGE_B=./.auth/rt-b.json \
E2E_RT_CHANNEL_PATH=/<org-slug>/chat/<channel-id> \
pnpm --filter @tmanage/e2e exec playwright test -c playwright.live.config.ts
```

- `playwright.live.config.ts` has no global setup (it boots no local stack) and keeps a trace
  of every run (`trace: 'on'`).
- `E2E_API_URL` defaults to `E2E_BASE_URL` (the single app serves `/v1` on the same origin).
- `E2E_RT_IDLE_MS` (default `300000`) is RT-LIVE-02's idle. Keep the full 5 minutes for the gate
  run.
- `E2E_RT_MEMBER_CAP` (default `5` live) must equal the live `REALTIME_MAX_SOCKETS_PER_MEMBER`.
  RT-LIVE-03 opens that many pages for account B, then one more.

What each one checks:

- **RT-LIVE-01** — a message sent by A appears in B within 1 s. B's trace shows the socket
  `event` frame before any `GET …/messages`, so the message came by push, not by polling.
- **RT-LIVE-02** — after the idle, a message from A appears in B within 5 s. The run notes
  (`rt-live-02` annotation) say whether the socket survived or was re-dialled.
- **RT-LIVE-03** — the extra page's socket is closed `4429 retry-after=<s>`, and its hook dials
  again after the hint.

On the local e2e stack (`pnpm test:e2e`) the same spec runs with the dev sign-in and a fresh
channel. It **skips** with a stated reason when the stack's ticket mint answers
`socketUrl: null`, which is the case while `e2e/setup/stack.ts` boots the API alone and not
`server.mjs` with `WORKER_INPROCESS=1`. For the stack run, set `REALTIME_MAX_SOCKETS_PER_MEMBER=2`
and a short `REALTIME_PING_INTERVAL_MS` in the stack env, and `E2E_RT_IDLE_MS` to match.

## 4. Record the run

The gate is `51-SWITCH-ON-PLAN.md` §4 step 10 and inventory row 10 ("not verified live"): RT-LIVE-01
and 02 green on live **twice, on different days**. For each run, add a row below with the date,
the commit, the Playwright list output (pass/fail per journey), the `rt-live-02` annotation, and
where the trace zip is kept. Only after two green rows may row 10's "not verified live" note be
removed, with this table as the evidence.

| Date          | Commit | RT-LIVE-01 | RT-LIVE-02 (annotation) | RT-LIVE-03 | Trace |
| ------------- | ------ | ---------- | ----------------------- | ---------- | ----- |
| _not run yet_ |        |            |                         |            |       |
