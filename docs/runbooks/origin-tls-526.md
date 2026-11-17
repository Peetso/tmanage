# Origin TLS and the Cloudflare 526 (56-30)

Cloudflare sits in front of the Hostinger shared host with SSL/TLS **Full (strict)**. In that mode
Cloudflare refuses to talk to an origin whose certificate is expired or untrusted, and every visitor
sees **error 526**, while the app itself is healthy. Hostinger's free certificate renews by Let's
Encrypt HTTP-01, and with the orange cloud on that renewal can fail silently. This page is how the
origin gets a certificate that does not expire for 15 years, how we check it, and what to do if a
526 ever happens.

Spec: planning pack 56 §11.2. Proof id: **SEC56-30** (manual, recorded in the release checklist).

## Peter's five steps (once, about 10 minutes, free)

Do these in the same session as the Cloudflare DNS switch (56-05).

1. **hPanel → Security → SSL**: note the current certificate's expiry date (Hostinger shows it).
2. **Cloudflare → SSL/TLS → Origin Server → Create Certificate**: RSA 2048, hostnames
   `tmanageapp.com` and `*.tmanageapp.com`, validity **15 years**. Download the certificate and
   the private key. Keep the key private; it is only ever pasted into hPanel.
3. **hPanel → SSL → Install custom SSL** for `tmanageapp.com`: paste the certificate and the
   key. The origin now presents a certificate only Cloudflare trusts. That is fine: all traffic
   comes through Cloudflare, and the Cloudflare rule "Always use HTTPS" stays on.
4. **Cloudflare → SSL/TLS → Full (strict)**. It works with Origin CA certificates.
5. Optional belt-and-braces: **Cloudflare → Rules**, a Configuration (or Page) rule for
   `tmanageapp.com/.well-known/acme-challenge/*` with SSL **Off** and cache bypass, so
   Hostinger's AutoSSL can still renew in the background if the custom certificate is ever removed.

Hardening, where the host allows it:

- **Authenticated Origin Pulls** (Cloudflare → SSL/TLS → Origin Server, free): the origin accepts
  only Cloudflare's client certificate. Turn it on in hPanel only if the LiteSpeed configuration
  permits client-certificate verification.
- Otherwise restrict the origin to Cloudflare's addresses in `.htaccess` (LiteSpeed reads it):
  `Require ip` with each range from <https://www.cloudflare.com/ips/>. If neither is possible, the
  app's trusted-proxy list and host check (56-05, 54-30) still refuse unknown hosts. See the known
  limitation below.

## Verification (the builder runs, Peter watches)

```sh
# The origin itself presents the Cloudflare Origin CA certificate (issuer "CloudFlare Origin ...").
openssl s_client -connect <origin ip>:443 -servername tmanageapp.com </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -subject -enddate

# Through Cloudflare the site answers 200.
curl -sI https://tmanageapp.com | head -1

# The app's own reading: daysLeft above 365 right after the install.
curl -s https://tmanageapp.com/healthz/deep
```

`/healthz/deep` reports `checks.origin_tls` as `{ state, issuer, notAfter, daysLeft }` once the
server has `ORIGIN_TLS_PROBE_ADDRESS=<origin ip>:443` in its environment (SNI is the host of
`WEB_PUBLIC_URL`). Without it the reading is `{ "state": "not_configured" }`. The reading is cached
for one hour, is `fail` at 14 days or fewer (or when the handshake fails), and never turns the
answer into a 503. While it is `fail` the operator (`ALERT_EMAILS`) gets one `origin_tls:expiring`
mail per UTC day.

The external check does the same from outside, bypassing Cloudflare:

```sh
UPTIME_URL=https://tmanageapp.com \
UPTIME_ORIGIN_ADDRESS=<origin ip>:443 \
UPTIME_ORIGIN_SERVERNAME=tmanageapp.com \
node scripts/ops/uptime-check.mjs --once
```

It prints `origin_tls daysLeft=<n>`, alerts `origin_tls_expiring` at 14 days or fewer and
`origin_tls_unreadable` when the handshake fails, and exits 1 while either is true. Without
`UPTIME_ORIGIN_ADDRESS` the check is skipped (and says so).

## If a 526 happens

1. **Cloudflare → SSL/TLS → Full** (not strict) — **never Flexible**. Full still encrypts the
   edge-to-origin hop; Flexible sends visitors' traffic to the origin in plain HTTP. The site is
   back within a minute.
2. Find out why: run the `openssl s_client` line above. Expired, missing, or the wrong hostname.
3. Reinstall: either install the existing Origin CA certificate again (step 3), or create a new one
   (step 2) and revoke the old one in Cloudflare.
4. Switch back to **Full (strict)** and run the verification commands. The window in Full should be
   minutes, not days.

If the Origin CA private key leaks: it is useless outside Cloudflare's edge-to-origin hop. Revoke it
in Cloudflare → Origin Server, create a new one, install it (steps 2 and 3).

## Known limitation on shared hosting

The Origin CA certificate is trusted only by Cloudflare, so a direct hit on the origin IP gets a
browser warning. That is acceptable and wanted (traffic should not bypass Cloudflare). On Hostinger
shared hosting we cannot always enforce that only Cloudflare reaches the origin: Authenticated
Origin Pulls and `Require ip` depend on what LiteSpeed allows. When neither is available, another
Cloudflare zone could be pointed at our origin IP; the app's trusted-proxy and host checks refuse
unknown hosts, and that is recorded as an accepted limitation.

If the five steps are not done, the default is Hostinger AutoSSL with Full (strict) and the monitor
only, with the 526 risk logged in roadmap 58 §13.
