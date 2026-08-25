# ADR-0004 — CSRF as a session-bound signed token, not a plain double-submit cookie

- **Status:** Accepted
- **Date:** 2026-08-24
- **Deciders:** Implementation lead
- **Governing sources:** `04-SECURITY-PRIVACY.md` §3 ("Secure, HttpOnly, SameSite cookies for
  browser; **CSRF protection for state-changing requests**");
  `27-TEST-CATALOG.md` SEC-03 ("CSRF for cookie-auth mutations; CORS and origin policy");
  `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §3 (the guard sequence this slots into)
- **Evidence:** `apps/api/src/common/http/csrf.test.ts`;
  `apps/api/test/http-pipeline.db.test.ts` (the `CSRF` and `the session routes` describes);
  `apps/api/test/sessions.db.test.ts`

## Context

The browser client authenticates with cookies. `04-SECURITY-PRIVACY` §3 requires CSRF
protection for state-changing requests as a control in its own right, listed alongside the
cookie attributes rather than as something they subsume. This ADR records how that control is
shaped and why it is not the textbook version.

### Why `SameSite` is not the answer on its own

The access cookie is `SameSite=Lax` and the refresh cookie is `SameSite=Strict`. That is a real
defence — `Lax` withholds cookies from cross-site form posts — and it is not sufficient:

- **`Lax` still sends the cookie on a top-level cross-site `GET` navigation.** Nothing in this
  API may mutate on `GET`, and the guard enforces that by exempting only the safe methods. But
  a control whose correctness depends on every future route author remembering a convention is
  exactly the class of control ADR-0001 exists to replace.
- **`SameSite` is same-_site_, not same-_origin_.** A sibling subdomain is the same site. On a
  bootstrap deployment where marketing, app, and any future customer-facing subdomain share a
  registrable domain, that is not a hypothetical.
- **Browser behaviour is not ours to depend on.** `Lax`-by-default rollout has been reverted
  and re-applied across browsers, and enterprise fleets pin old versions.
- **The spec asks for the control explicitly.** It is not offered as something `SameSite` may
  cover.

### Why a plain double-submit cookie is not enough either

The standard stateless pattern — put a random value in a readable cookie, require the client to
echo it in a header, compare the two — is defeated by **cookie tossing**. An attacker who
controls any sibling subdomain (a stale CNAME, a shared hosting neighbour, a customer-controlled
subdomain, an XSS on an unrelated sibling) can set a cookie scoped to the parent domain. They
then know the CSRF cookie's value, because they chose it, and can send a matching header. The
comparison succeeds. The victim's `HttpOnly` session cookie rides along and the mutation
executes as the victim.

The reason the attack works is that the token is bound to nothing. Both halves of the
comparison are attacker-supplied.

## Decision

The CSRF token is **`HMAC-SHA256(CSRF_SECRET, "v1." + sessionId)`**, base64url, prefixed with
its version: `v1.<signature>`. It is issued in a readable cookie and must be echoed in the
`X-CSRF-Token` header on every unsafe method.

Verification never parses the presented value. It recomputes the expected token from the
session the request actually authenticated as, and compares in constant time. There is no
attacker-controlled field to decode, so there is nothing to mis-parse.

### The four properties this buys

1. **Session binding defeats cookie tossing.** An attacker can plant a cookie on the parent
   domain, but cannot plant the victim's _session_ cookie. A token they minted or planted is
   bound to their session id, not the victim's, so the recomputation fails. This is the property
   the plain pattern lacks and the reason for the whole design.
2. **The signature defeats minting.** `CSRF_SECRET` means an attacker who has merely _observed_
   a session id — from a log, a support ticket, a shared screen — cannot derive its token.
   `packages/config` requires `CSRF_SECRET` to differ from `SESSION_SECRET` in production and
   refuses to boot otherwise, so a compromise of one is not automatically a compromise of both.
3. **No server state.** Nothing is stored, so nothing expires independently, nothing needs
   purging, and horizontal scaling needs no shared token store. The token's lifetime _is_ the
   session's lifetime, which is the correct coupling.
4. **Deterministic, so re-issue is safe.** The same session always yields the same token. A
   client that lost the cookie can be handed the identical value back without invalidating a
   tab that still holds the old one — which is what removes the usual reason to build a
   token-rotation escape hatch that then becomes the weak point.

### The custom header is part of the mechanism

The token must arrive in `X-CSRF-Token`, not in a form field. A cross-origin HTML form cannot
set a custom header; a cross-origin `fetch` that sets one is no longer a CORS "simple" request
and is preflighted, which the origin policy then refuses. The header requirement is therefore
load-bearing, not a convention.

### Why this token may be read by JavaScript

`serializeCookie` hard-codes `HttpOnly` and takes no flag to disable it, because a session
credential readable by script turns any XSS on the origin into full session theft. The CSRF
token is issued through a **separate** function, `serializeReadableCookie`, so that dropping
`HttpOnly` is a deliberate, greppable choice rather than an argument someone passes by mistake.
That function builds its output by removing the flag from the checked `serializeCookie` result,
so the readable cookie cannot drift from the validation, the injection refusal, or the
`SameSite=None` rule the other one enforces.

The exception is sound rather than merely convenient: **the token authorises nothing.**
Presented without the `HttpOnly` session cookie it proves nothing and grants nothing. And a
value that must be readable by same-origin script in order to work is precisely the value a
cross-origin attacker cannot obtain.

Note what this does _not_ weaken. An XSS that can read this token can already issue same-origin
requests carrying the session cookie, so CSRF protection was never the control standing between
an XSS and a mutation. Its job is the cross-origin case, and there it is intact.

### Where the check runs

`CsrfGuard` is registered **second** in the global guard array, immediately after
`SessionAuthGuard`. The order is required, not tidy: the token is bound to a session id, so
there is nothing to verify against until step 1 has established which session this is.

The guard skips:

- **Safe methods** — `GET`, `HEAD`, `OPTIONS`, defined as an allowlist so that an unfamiliar or
  future method (`PURGE`, a proxy's `LINK`) is guarded by default rather than silently exempt.
  That is the direction a mistake should fall.
- **`@Public()` routes** — a route reached without a session has no session to bind a token to.
  What protects a public mutation is that it _establishes_ authority rather than exercising it.

### The refresh route is the one real seam

`POST /v1/sessions/refresh` is `@Public()` and therefore skipped by the guard — but it **is**
CSRF-checked, inside `SessionService.refresh()`.

It has to be. The refresh request deliberately carries no access cookie, so its session id is
unknown until the refresh token has been looked up in the database. Verification happens at the
first moment the session id exists: inside the rotation transaction, **after** the token
resolves and **before** the rotation commits.

Three details make that seam safe rather than a hole:

- The check returns a _verdict_ rather than throwing. Throwing from inside the transaction
  would roll back — harmless for a plain rejection, but the adjacent reuse-detection path
  revokes the session and must survive its own refusal. One exit discipline for both.
- A CSRF failure refuses with the **same generic message** as every other refresh failure, so
  the refusal is not an oracle for "that refresh token was real".
- A refused refresh leaves the session untouched and still usable. The database suite asserts
  exactly that, so a CSRF failure cannot be used to grief a user out of their session.

This service already owns cookie serialisation for the same structural reason, so the seam is
not a new one being opened for CSRF's convenience.

## Consequences

**Positive**

- Resistant to cookie tossing from a sibling subdomain, which is the failure mode the plain
  double-submit pattern has and the one a shared registrable domain makes plausible.
- Stateless: no store, no expiry job, no cross-instance coordination.
- Pure and therefore fully testable without a server — `mintCsrfToken` / `verifyCsrfToken` are
  functions over strings, in the same shape as `session-token.ts`.
- `CSRF_TOKEN_VERSION` is inside the signed material, so a future scheme cannot be produced by
  re-labelling this one.

**Negative**

- One more secret to provision, rotate, and keep distinct from `SESSION_SECRET`. Rotating
  `CSRF_SECRET` invalidates every outstanding token, so every open tab's next mutation fails
  once and must re-read the cookie. Acceptable, and better than the alternative of a token that
  survives rotation.
- The client must read a cookie and set a header. Ordinary for a SPA; it does mean a plain
  server-rendered form post will not work without threading the token through, which is a
  constraint on the web app's design and is recorded as such.
- Deterministic tokens mean the token is stable for the session's life. That is intended — it
  is not a credential — but it does mean the token cannot double as a replay nonce, and nothing
  should be built assuming it can.

## Alternatives rejected

- **`SameSite` alone.** Covered above: `Lax` on top-level `GET`, same-site ≠ same-origin, and
  §3 asks for the control explicitly.
- **Plain random double-submit cookie.** Defeated by cookie tossing. This is the specific
  weakness the design is a response to.
- **Server-stored synchroniser token.** The classic, and strong, but it needs per-session
  storage, expiry, and a shared store across instances — real operational surface on the
  bootstrap profile (`50-BOOTSTRAP`), in exchange for a property the HMAC binding already
  provides.
- **`Origin` / `Referer` header checking as the only control.** `Origin` is absent on some
  legitimate requests and `Referer` is strippable by proxies and privacy tooling, so this
  degrades to either false refusals or a check that can be omitted. Retained as a defence in
  depth via the CORS/origin policy, never as the control.
- **`__Host-` cookie prefix for the CSRF cookie.** Wanted, and it would add another layer
  against a sibling subdomain planting cookies. It forces `Secure`, `Path=/`, and no `Domain`,
  which needs the deployment-domain decision that has not been made. Recorded as an open gap
  under ID-001 in `docs/implementation-status.md`, not silently skipped.

## Revisit trigger

Revisit when the deployment domain is settled (adopt `__Host-` prefixes then), if the product
ever needs non-`fetch` form posts, or if the API moves to a token-in-header scheme with no
cookies at all — at which point CSRF stops applying and this control should be **removed**
deliberately rather than left in place as decoration.
