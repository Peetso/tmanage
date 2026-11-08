# Runbook — browser security policy: soak, enforce, roll back (56-01)

> **r47 L2 (2026-11-08) supersedes the defaults below.** A production build now ENFORCES by
> default; `CSP_MODE=report` (or `report-only`) is the roll-back to report-only, `next dev` stays
> report-only unless `enforce`. Trusted Types is inside the page policy (enforced with it), with a
> `default` policy from `apps/web/src/lib/trusted-types-boot.ts`; `trusted-types default nextjs
nextjs#bundler`. Reports go to `report-uri /csp-report` and `report-to csp-endpoint`
> (`Reporting-Endpoints`). HSTS is `max-age=63072000; includeSubDomains; preload`, on HTTPS
> (`X-Forwarded-Proto: https`) only. Prerendered pages' inline-script hashes are computed at build
> time into `.next/csp-script-hashes.json` (`apps/web/scripts/write-csp-hashes.mjs`); the B18 live
> check compares the served `script-src` against that file.

What ships in 56-01:

| Header                                              | Where it is set                                                      | Value                                                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Content-Security-Policy(-Report-Only)               | `apps/web/src/proxy.ts` (policy: `apps/web/src/lib/csp.ts`)          | per-request nonce, `'strict-dynamic'`, no `'unsafe-inline'` for scripts, `report-uri /csp-report` |
| Content-Security-Policy-Report-Only (second policy) | same                                                                 | `require-trusted-types-for 'script'` — report-only in this train by design                        |
| Content-Security-Policy `frame-ancestors 'none'`    | same, enforced in both modes                                         | clickjacking guard (S9/S10)                                                                       |
| Strict-Transport-Security                           | `apps/web/next.config.ts`; `apps/server/boot-guards.mjs` as fallback | `max-age=31536000; includeSubDomains; preload`                                                    |
| Cross-Origin-Opener-Policy                          | same two places                                                      | `same-origin-allow-popups` (the OneDrive picker is a popup; plain `same-origin` would cut it off) |
| Permissions-Policy                                  | `apps/web/next.config.ts`                                            | `camera=(), microphone=(self), geolocation=(), interest-cohort=()`                                |

The switch is one environment variable, `CSP_MODE`, read by the web app on every request:
`report-only` (default) or `enforce`. Changing it needs a restart of the Node app in hPanel, not
a rebuild.

## 1. Before the soak — the regression wall

Run the whole e2e suite once with the enforcing policy:

```
CSP_MODE=enforce pnpm test:e2e
```

`e2e/tests/security-headers.spec.ts` checks the headers on every page family and fails on any CSP
violation outside Trusted Types. Every other journey then proves its screen still works with the
policy enforced. Known follow-up: `e2e/tests/a11y-audit.spec.ts` injects axe-core as an inline
`<script>` (`page.addScriptTag`), which an enforcing policy blocks. Its contexts need
`bypassCSP: true`, because that script is test tooling and not part of the product.

## 2. The 7-day soak (live, report-only)

1. Deploy with `CSP_MODE` unset, or set to `report-only`.
2. Each day, read the app's log in hPanel (Node.js app → logs) and filter for `csp-report`. Each
   line is one violation, already redacted to the page path, the directive name, and the blocked
   origin (or a keyword such as `inline` or `eval`):

   ```
   [server] csp-report {"documentUri":"/pricing","violatedDirective":"script-src-elem","blockedUri":"inline"}
   ```

   The receiver keeps no user id, no query string and no cookie. It takes at most 60 reports a
   minute from one address and at most 1 KB per report.

3. Ignore `require-trusted-types-for` lines for now. They are the input for the Trusted Types
   enforcement item, not a blocker here.
4. For every other line, fix the page, or widen `lib/csp.ts` with a comment that says why. Then
   restart the 7 days.

### Prerendered public pages, the expected first finding

A page prerendered at build time (the public site: `/`, `/ar`, `/pricing`, `/status`, the legal
pages, see `deploy/hostinger/build.mjs`) was rendered with no request, so Next could not stamp a
nonce on its scripts. Under `'strict-dynamic'` those scripts are reported (`script-src-elem`,
`blockedUri` `inline` or the site's own origin). `next dev`, and so the e2e suite, renders every
page per request and cannot show this. Before you flip, pick one of these:

- render those pages per request: `await connection()` in the public layout. The CDN still caches
  them for 60 s. But `build.mjs` then has to stop requiring their prerendered `.html`.
- or give the public pages their own policy without `'strict-dynamic'` (`'self'` plus hashes)
  in `src/proxy.ts`.

Do not flip to `enforce` while these lines still appear. If you do, the public pages stop
hydrating.

## 3. Flip to enforce

When a full 7 days pass with no violation outside Trusted Types:

1. hPanel → the Node app → Environment variables → `CSP_MODE=enforce` → Save → Restart.
2. Check it: `curl -sI https://tmanage.peetrix.com/ | grep -i content-security-policy`. You should
   see `content-security-policy:` with the nonce policy, plus `content-security-policy-report-only:`
   for Trusted Types.
3. Open the home page, sign in, open a project, and open the client portal. The browser console
   should show no `Refused to …` lines.
4. Keep reading the `csp-report` lines for another week. An enforced violation is now a broken
   feature for someone.

## 4. Roll back

Set `CSP_MODE=report-only` (or delete the variable) and restart. This takes effect on the next
request, and nothing needs rebuilding. HSTS cannot be rolled back this quickly, because browsers
remember it for a year. Leave it alone.

## 5. HSTS preload, optional, for Peter

The header now carries `preload`, which makes the domain eligible for the browsers' built-in
HTTPS-only list. Getting onto the list is a separate, voluntary step:

1. Make sure every subdomain of the registrable domain (`peetrix.com`, not just `tmanage.`) serves
   HTTPS. Preloading covers the whole domain, and any HTTP-only subdomain stops working.
2. The list reads the header from the apex (`https://peetrix.com/`), not from this app. So the
   apex site has to send the same `Strict-Transport-Security` value first.
3. Submit the domain at https://hstspreload.org. The form checks the header and lists any problem.
4. Removing a domain from the list later takes months. If any doubt remains, skip this step. The
   header works without it.
