# ADR-0012 — The public server keeps idle connections longer than the proxy in front of it, and allows a whole request 300 s

- **Status:** Accepted (lane K, 2026-11-20)
- **Date:** 2026-11-20
- **Deciders:** Implementation lead (lane K); accepted by the pass manager
- **Rules affected:** ST-3 (corrected by this ADR); **bends a rule:** no
- **Quality scenarios:** QA-AV-1, QA-AV-3 (no 502 from the proxy reusing a socket the server closed; slow uploads complete)
- **Evidence:** `apps/server/server-timeouts.mjs` (the values and `timeoutViolations`), `apps/server/server-timeouts.test.mjs` (one test per value, against a real `http.Server`), `apps/server/server.mjs` (`createPublicServer`, `WEB_UPSTREAM_AGENT`, `webChildKeepAliveArgs`), commit `2821aef1`. Upload part size and boot hold: `STARTUP_HOLD_MS` 30 s in `apps/server/web-transport.mjs`; 8 MiB default part.

## Context

ST-3 (ENGINEERING-STANDARD §3) asked for `requestTimeout`, `headersTimeout` and `keepAliveTimeout` to be set explicitly, "below the host proxy's limits", and proposed requestTimeout 120 s, headersTimeout 20 s, keep-alive 5 s. Setting them (lane K, 2026-11-20) showed that two of those values are wrong:

1. **Keep-alive points the wrong way.** A proxy that pools upstream connections reuses an idle one for the next request. If the application closes that connection first, the proxy can send the request into a socket that is already closing and answers 502. AWS states the rule for its load balancer: "configure the idle timeout of your application to be larger than the idle timeout configured for the load balancer. Otherwise … the load balancer sends an HTTP 502 Bad Gateway error to the client" (S27); its default idle timeout is 60 s. nginx's upstream `keepalive_timeout` also defaults to 60 s (S28). Node's own default `keepAliveTimeout` is 5 s (S26), far below both. So the server must be **above** the proxy's idle time, not below it.
2. **120 s cuts uploads.** `requestTimeout` bounds the whole request, body included (S26). An upload part is 8 MiB by default and may first be held up to 30 s while a copy boots. At a 64 KiB/s floor (a weak mobile uplink) the part needs 30 s + 128 s = 158 s, over 120 s. Node documents `requestTimeout` as DoS protection "in case the server is deployed without a reverse proxy in front" (S26), and this server always has one.

What the host does is **not documented**. Hostinger runs the app behind its own proxy (LiteSpeed); its upstream idle time and whether it buffers request bodies were searched for and not found. The values below therefore beat the documented 60 s common default with margin, and are bounded by our own uploads rather than by a guess about the host.

## Decision

1. `keepAliveTimeout` is **65 s**: longer than the 60 s idle time that AWS ELB and nginx document as default, so the server never closes an idle connection the proxy may still reuse.
2. `requestTimeout` is **300 s**, set explicitly (equal to Node's default, now a decision instead of an accident). It covers the slowest supported upload part (158 s) with margin.
3. `headersTimeout` is **20 s**, with `connectionsCheckingInterval` **5 s**. The proxy sends a request's headers in one go. Node enforces both limits only at the checking interval (S26), so the effective header limit is at most 25 s, where Node's 30 s default interval would allow up to 50 s.
4. **The same rule on our own hop.** server.mjs is the client of the web child (Next). The child is started with `--keepAliveTimeout 65000`, and the parent proxies through a dedicated agent that drops idle sockets after 5 s, so the child (server) always outlasts the parent (client).
5. The invariants are code, not prose: `timeoutViolations()` refuses a set where keep-alive does not exceed the assumed 60 s proxy idle time, requestTimeout does not fit the boot hold plus one part at the floor rate, headersTimeout exceeds requestTimeout, headersTimeout plus its checking interval exceeds 30 s, or the child's keep-alive is not at least 1 s above the agent's idle time. A test asserts each value on a real server.

## Alternatives considered

| Option                                                | Pros                               | Cons                                                                                                            | Why not chosen                                                                                       |
| ----------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| ST-3 as written: keep-alive 5 s, requestTimeout 120 s | short timeouts free sockets sooner | 5 s is below every documented proxy idle time (502 on reuse, S27); 120 s cuts a slow 8 MiB part                 | contradicts S27; breaks uploads                                                                      |
| Leave Node's defaults (5 s / 300 s / 60 s / 30 s)     | no code                            | keep-alive 5 s has the same 502 race; header limit up to 90 s with the 30 s interval                            | ST-3 asks for explicit values                                                                        |
| Keep-alive far higher (e.g. 600 s)                    | certainly above any proxy          | idle sockets held for ten minutes on a shared host with a process and memory cap; RT-6 shutdown must close more | 65 s already beats the documented defaults                                                           |
| requestTimeout 0 (off)                                | no upload can be cut               | a stalled request holds the process forever (S15, Timeouts)                                                     | the proxy-idle kill (`WEB_PROXY_IDLE_MS` 120 s) covers stalls, but an absolute bound is still wanted |

## Consequences

- Good: no 502 from a proxy reusing a connection the server closed; slow uploads complete; the header limit is tighter than before (≤ 25 s instead of ≤ 90 s).
- Bad: idle connections live 65 s instead of 5 s, so a copy holds more open sockets. Shutdown is not slowed: since Node 19, `server.close()` closes idle connections before returning (S26), and the RT-6 drain budget applies only to connections with a request in flight.
- Neutral: the host proxy's real values stay unverified. If Hostinger publishes a proxy idle time above 60 s, keep-alive is raised above it (the check in `timeoutViolations` is the single place to change).

## Fitness functions

| Rule | Check (path)                                                                                                                                                 | Exists / to build          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| ST-3 | `apps/server/server-timeouts.test.mjs`: each value on a real `http.Server`; `timeoutViolations` refuses each wrong direction; the web child's flag and agent | Exists (commit `2821aef1`) |
| ST-3 | `apps/server/web-child-host.test.mjs`: the child is spawned with `--keepAliveTimeout`                                                                        | Exists                     |

## Sources

- **S26** Node.js `http` docs: `server.requestTimeout` (default 300 000 ms, "in case the server is deployed without a reverse proxy in front"), `server.headersTimeout` (default `min(60000, requestTimeout)`), `server.keepAliveTimeout` (default 5000 ms), `connectionsCheckingInterval` (default 30 000 ms); `server.close()` closes idle connections since v19.0.0. https://nodejs.org/docs/latest-v22.x/api/http.html (checked 2026-11-20)
- **S27** AWS, Elastic Load Balancing, "Edit attributes for your Application Load Balancer — Connection idle timeout": default 60 s; application idle timeout larger than the load balancer's, or HTTP 502. https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html (checked 2026-11-20)
- **S28** nginx, `ngx_http_upstream_module`, `keepalive_timeout`: default 60 s, "a timeout during which an idle keepalive connection to an upstream server will stay open". https://nginx.org/en/docs/http/ngx_http_upstream_module.html (checked 2026-11-20)
- **S15** Nygard, _Release It!_ 2nd ed., Timeouts.
