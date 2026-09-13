# Deployment runbook

What has to happen, and in what order, to put a new build of TManage in front of people
without breaking anybody who is already using it.

This file is for the person doing the deploy, at whatever hour that turns out to be. It is
deliberately short and deliberately concrete: exact commands, exact variable names, and what
each failure means. Background and rationale live in `docs/planning/` and in the ADRs; if you
are reading this because something is wrong, you do not need them.

Sections are added per slice, newest first. `scripts/db/users.sql` points here for how the
database users are provisioned in a deployed environment: they come from the secret store,
never from the passwords in that file, which exist for local development only.

---

## D09 — the API only believes a proxy you have named

**Read this before deploying any build from 2026-09-12 onwards.** Nothing locks anybody out and
there is no migration to run. What changes is which address the API thinks a request came from,
and every per-address control — the sign-in abuse budgets, the upload-part limiter, the address
in every `authentication_events` row — follows it.

### What changed

The API used to pass Fastify `trustProxy: true`, which means "believe `X-Forwarded-For` from
whoever sends it". Anyone who could reach the process could therefore choose the address it
counted them under, simply by writing the header. It now believes forwarding headers **only from
peers you have named**, in one new variable.

### The variable

`TRUSTED_PROXY_ADDRESSES` — a comma-separated list of IPv4/IPv6 addresses and CIDR ranges:

```
TRUSTED_PROXY_ADDRESSES=203.0.113.7,10.0.0.0/8,2001:db8::/32
```

**Leaving it unset or blank is the safe default, and it is the right value unless you actually
run a reverse proxy in front of the API.** Unset, the API reads the socket peer — the address the
connection genuinely came from — and `X-Forwarded-For` changes nothing. You do not have to
configure anything to get that.

If you do run a proxy in front of the API, set this to **the addresses or CIDR ranges of the
proxies that actually front it, and nothing else**. Not the client networks, not "the office",
not a range that is convenient — only the hops that terminate the connection and forward it.
Every address in this list is a peer that is allowed to tell the API who somebody else is.

A malformed value **fails the boot** and names the entry: a hostname instead of an address, a
stray or trailing comma, `/33` on an IPv4 range. `/0` is refused by name as well — it matches
every address, so it is the old trust-everybody setting spelled as a range. Nothing is silently
repaired and nothing silently falls back. Only the API uses the value, but all four processes
(API, worker, `verify`, `sweep`) load the same validated environment, so a malformed value set
globally stops all of them.

### How the address is picked, and the three ways it goes wrong

This is the part that is easy to get wrong, and getting it wrong quietly gives back most of what
the change bought — so the mechanism comes before the advice.

When a request arrives from a trusted peer, `@fastify/proxy-addr` builds the list
`[socket peer, ...X-Forwarded-For reversed]` and walks it from the socket peer inwards while
each entry is one of your trusted peers. `request.ip` is the first entry it reaches that is
**not** trusted, and it is taken **verbatim** — nothing between the socket and the API's controls
checks that the entry is honest, or even that it is an address.

Walking from the socket peer inwards means walking the header **from the right**. The address the
API believes is therefore the **right-most entry your trusted peers did not write**. Measured
against this branch's own `fastify@5.11.3`, with `TRUSTED_PROXY_ADDRESSES=203.0.113.7` and the
connection arriving from `203.0.113.7`:

| `X-Forwarded-For` the API receives | `request.ip`   |
| ---------------------------------- | -------------- |
| `198.51.100.9`                     | `198.51.100.9` |
| `9.9.9.9, 198.51.100.9`            | `198.51.100.9` |
| `1.1.1.1, 2.2.2.2, 198.51.100.9`   | `198.51.100.9` |
| `9.9.9.9`                          | `9.9.9.9`      |
| `198.51.100.9, 9.9.9.9`            | `9.9.9.9`      |
| (header absent)                    | `203.0.113.7`  |

Rows two and three are the ones to read twice. A proxy that **appends** its own observation puts
that observation at the right-hand end, which is the first untrusted entry reached walking from
the right — so the client's invented entries, which sit to its **left**, are never looked at.
**Appending is the safe form**, and in most of the servers below it is the default or the
recommended setting. Earlier revisions of this section said the reverse and told you to make the
proxy overwrite the header; that was wrong, and the nginx directive it recommended is actively
harmful (see below).

Three shapes do break it, and these are what to check for:

**(a) The proxy forwards the client's `X-Forwarded-For` through untouched** — row four. Nothing
trusted is added to the right, so the first untrusted entry is whatever the client wrote, and the
client picks the address every per-address control counts them under.

**(b) The proxy puts its own observation _before_ the client's value** — row five. The proxy's
honest entry is to the left of the client's invented one, so the walk stops on the client's.

**(c) The trusted list is broad enough to contain real clients.** With
`TRUSTED_PROXY_ADDRESSES=10.0.0.0/8`, a connection from `10.0.0.1` and a header of
`9.9.9.9, 10.5.5.5`, `request.ip` is `9.9.9.9`: the walk trusts `10.5.5.5` because it is inside
the range, steps past it, and lands on the client's entry. Every address in the list must be a
hop that terminates connections and forwards them, and nothing else.

### What to configure

- **nginx** — `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`. nginx sends no
  `X-Forwarded-For` of its own unless you ask it to, and the nginx documentation defines this
  variable as the client's `X-Forwarded-For` "with the `$remote_addr` variable appended to it,
  separated by a comma" — nginx's own observation goes last, which is exactly the shape above.
  Do **not** use `proxy_set_header X-Forwarded-For $remote_addr;`. In the CDN → nginx → API
  topology this runbook contemplates, `$remote_addr` at nginx is the **CDN**, so every client in
  the deployment collapses into one address and `RATE_LIMIT_AUTH_MAX_PER_SOURCE` (30 charges per
  five minutes, about fifteen complete MFA sign-ins) applies to all of them at once — a sign-in
  outage produced by configuration alone.
- **Apache** — leave `ProxyAddHeaders` at its default of `On` and add nothing in front of it.
  The Apache documentation says the header "will contain more than one (comma-separated) value if
  the original request already contained one", with the client address appended — the safe form,
  already correct out of the box. Do not add a `RequestHeader set X-Forwarded-For` before
  `mod_proxy`: it discards the chain a CDN in front of you wrote, with the same collapsing effect
  as the nginx case above.
- **Caddy** — `reverse_proxy` "sets or augments" `X-Forwarded-For`, and the Caddy documentation
  states that for the `X-Forwarded-*` headers "by default, the proxy will ignore their values
  from incoming requests, to prevent spoofing". That default is safe. If a real proxy or CDN sits
  in front of Caddy, set `trusted_proxies` — the documentation recommends the global
  `servers > trusted_proxies` option — so Caddy keeps the upstream chain instead of discarding it.
- **Traefik** — on the entrypoint, set `forwardedHeaders.trustedIPs` to the addresses or ranges of
  whatever sits in front of Traefik; Traefik then trusts `X-Forwarded-*` only from those sources.
  Do not use `forwardedHeaders.insecure`, which trusts everyone and which the documentation
  recommends "only for tests purposes, not in production". **Unverified:** Traefik's own
  documentation does not state whether it appends its observation to the right of an existing
  chain or replaces the chain, so which of the shapes above it produces has not been confirmed
  here. Establish it with the check below before relying on it.
- **Any other edge, and any CDN in front of any of the above** — unverified here. Nothing in this
  list was tested against a live deployment; the vendor statements above are quoted from the
  vendors' own documentation, and the fastify table above was measured. Run the check below.

**With more than one hop in front of the API, name them all.** In a CDN → nginx → API topology
with nginx appending correctly, the header the API sees is `<client>, <CDN>` and the socket peer
is nginx. If `TRUSTED_PROXY_ADDRESSES` names only nginx, the walk stops on the CDN's address and
every client collapses into it — the same outage as the `$remote_addr` mistake, reached from the
other direction. Naming both nginx and the CDN's egress ranges yields the client. This is the one
legitimate reason the list is ever longer than one entry, and it does not license hazard (c):
those ranges must be the CDN's egress, never a network that carries clients.

If you cannot establish which shape your proxy produces, leave `TRUSTED_PROXY_ADDRESSES` unset.
The API will then count everybody behind the proxy as one address, which throttles honest shared
traffic (raise `RATE_LIMIT_AUTH_MAX_PER_SOURCE` deliberately if it bites) but tells no lies.

### Checking it after the deploy

Sign in once from a client whose address you know, and read the `ip` column of the newest
`authentication_events` row. Unset, it should be the address of whatever connects to the API
directly. With a proxy configured, it should be the real client address — and if you then send a
request with a forged `X-Forwarded-For` from a machine that is **not** in the list, the row must
show that machine's own address rather than the forged one.

Then check for hazards (a) and (b), which the test above does not distinguish from a correct
setup. From a client whose address you know, sign in once sending a header of your own:
`X-Forwarded-For: 192.0.2.111`. The `ip` column must show your **real** client address. If it
shows `192.0.2.111`, your proxy is either passing the header through untouched or prepending its
own observation, and until that is fixed anyone can choose the address they are counted under —
unset `TRUSTED_PROXY_ADDRESSES` in the meantime.

---

## D07 — TOTP seeds are encrypted at rest

**Read this before deploying any build from 2026-09-06 onwards onto an environment that has
people with two-factor authentication enabled.** This deploy locks every one of them out
until one command has been run.

### What changed

`user_mfa_factors.secret` used to hold the authenticator seed exactly as the phone produced
it, so anyone holding a database dump or a backup held every second factor in the system. It
now holds an encrypted envelope under a key that lives in the environment rather than in the
database. Rows written before this deploy are still bare seeds, and the sign-in path refuses
them on purpose — accepting them would leave plaintext working indefinitely and invisibly.
The command that converts them is `mfa:encrypt-seeds`, and until it has run, every person with
a confirmed factor gets a failed sign-in with no explanation on screen (the message is
deliberately discarded before it reaches a response body).

So the deploy window is a lockout window. Keep it short, and do not start it at a time when
you cannot finish it.

### The new variable

`AUTH_MFA_SEED_KEYS` is now required. Four processes refuse to start without it:

- the API (`apps/api/src/main.ts`),
- the relay/worker (`apps/worker/src/main.ts`),
- the `verify` pass (`apps/api/src/verify.ts`),
- the `sweep` pass (`apps/api/src/sweep.ts`).

Only the API ever decrypts anything. The other three refuse because they load the same
validated environment, and a process that starts with half a configuration is worse than one
that will not start: the failure would otherwise appear later, somewhere else, as something
that looks unrelated. Set the variable for all four — including the cron entries — or the
first tick after the deploy fails.

Its value is one or more `version:key` pairs separated by `;`, for example `1:<key>` or
`1:<older key>;2:<key>`. The **highest version is active**: everything written from now on is
encrypted under it, and the lower entries stay so that rows written before a rotation still
open. Generate a key with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

The value in `.env.example` is a real working key so that local development starts, and it is
refused outright when `NODE_ENV=production`. Never promote it.

### Where the key lives

Outside the database, and outside anything that gets backed up with the database. The whole
point of the change is that a database dump is not enough to impersonate somebody's
authenticator; a key sitting in the same backup archive as the dump gives that back.

- Hold it in the environment's secret store, the same place the database passwords come from.
- Keep one offline copy somewhere a person with the right authority can reach without the
  production environment — a password manager entry or a sealed envelope, not a file on the
  application server.
- **Losing every key means losing every enrolled factor.** The seeds are not recoverable from
  anything else; each affected person has to have their factor row disabled by an operator and
  then re-enrol. Back the keyring up before the deploy, not after.

### The deploy, in order

1. **Set `AUTH_MFA_SEED_KEYS`** in every process's environment: API, worker, and the `verify`
   and `sweep` cron entries. Same value everywhere — a second key generated by accident for
   one process makes that process's writes unreadable to the others.
2. **Deploy** the build and restart the processes as usual.
3. **Run the backfill immediately**, before anything else on the checklist:

   ```
   DATABASE_MIGRATION_URL=... AUTH_MFA_SEED_KEYS=... \
     pnpm --filter @tmanage/api mfa:encrypt-seeds
   ```

   It runs on the migration credential rather than the runtime one, so it needs
   `DATABASE_MIGRATION_URL` as well as the keyring. Expect `plaintext_encrypted` to equal the
   number of existing factor rows and `failed` to be `0`. That is every row in
   `user_mfa_factors`, not only the confirmed ones: the sweep walks unconfirmed and disabled
   rows too, because their column holds a seed like any other and leaving it readable is the
   disclosure this deploy exists to close. Do not be alarmed if the number is higher than your
   count of working authenticators. It is safe to re-run: a row already on the active key is
   counted as `unchanged` and not written.

4. **Check the result:**

   ```
   DATABASE_MIGRATION_URL=... AUTH_MFA_SEED_KEYS=... \
     pnpm --filter @tmanage/api mfa:seeds-status
   ```

   A healthy environment reports every row under the active key version, with `plaintext`,
   `unreadable` and `unopenable` all `0`.

5. **Confirm with one real sign-in** by somebody who has an authenticator, before you close the
   deploy.

### Rotating a key

Rotation is an append, never a replacement — removing the key rows are written under is how
you lose them.

1. Generate a new key and **append** it with the next higher version:
   `AUTH_MFA_SEED_KEYS=1:<old>;2:<new>`. Keep the old entry.
2. Restart every process that carries the variable.
3. Run `mfa:encrypt-seeds`. Expect `rotated` to equal the number of factors and `failed` to be
   `0`.
4. Run `mfa:seeds-status` and confirm no rows remain under the old version.
5. Only then remove the old entry from `AUTH_MFA_SEED_KEYS` and restart again.

If step 4 still shows rows under the old version, the old entry stays. Find out which rows
first — the status output names them.

### When somebody cannot sign in

Run `mfa:seeds-status`. Alongside the per-version counts it lists, by factor id, the rows it
tried to open and could not: `unknown_key_version`, `authentication_failed` and `malformed`, on
live factors only. Two kinds of row are deliberately absent from that list. A row still in
plaintext is reported as a count and never by id — it is not a fault and the remedy is the same
for all of them, so a list of ids would only send you looking for a key you have not lost. A
disabled row is absent because the list answers "who is being refused a sign-in", and nobody
signs in on a retired factor. Match the reason:

| Reason                  | What it means                                            | What to do                                                                      |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| counted as `plaintext`  | The row predates this deploy and the backfill missed it. | Run `mfa:encrypt-seeds`. This is the ordinary case in a deploy window.          |
| `unknown_key_version`   | The row names a key this environment no longer holds.    | Restore that key into `AUTH_MFA_SEED_KEYS` and restart. Do not re-encrypt.      |
| `authentication_failed` | The stored value was altered, or moved between rows.     | Treat as tampering: investigate before you clear it, then disable and re-enrol. |
| `malformed`             | The column holds neither a seed nor a readable envelope. | Same as above — investigate, then disable and re-enrol.                         |

The backfill deliberately refuses to rewrite any of these rows. Re-encrypting a tampered value
would replace the evidence with something that looks correct, and a row whose key is merely
missing from this process cannot be re-encrypted at all without destroying the only copy of the
seed.

**Disabling a factor so the person can re-enrol.** Do this only after you have verified who you
are talking to, through whatever identity check the support process requires — this removes a
second factor, which is exactly what an attacker would ask for. If the person still has a live
session, they can remove the factor themselves from their own security screen; that path never
opens the envelope, so it works on the broken row. Otherwise, with the migration credential:

```sql
-- Find the factor. Confirm the label with the person before touching anything.
SELECT f.id, f.label, f.confirmed_at
  FROM user_mfa_factors f
  JOIN users u ON u.id = f.user_id
 WHERE u.email = '<their address>'
   AND f.disabled_at IS NULL;

-- Disable the one you agreed on. The row is kept, so the history stays readable.
UPDATE user_mfa_factors
   SET disabled_at = current_timestamp(3)
 WHERE id = '<factor id>'
   AND disabled_at IS NULL;
```

Disabling the row also takes it off the `unopenable` list, so a re-run of `mfa:seeds-status`
reports `unopenable 0` once every broken factor has been disabled or repaired — the state step
4 above calls healthy. The row still counts towards `total` and towards its key version, and
`mfa:encrypt-seeds` still re-encrypts it, because the column holds a seed until somebody clears
it.

The person can then sign in with their password and a code from whichever factor of theirs
still works — or a recovery code, if the one you disabled was the last that did. If it was
their only factor, the password alone signs them in, which is why the identity check above is
the part that matters.

### What is deliberate here

Two behaviours look like bugs at 02:00 and are not:

- **A sign-in fails closed.** A row that will not open refuses the sign-in rather than being
  skipped. Skipping it would mean anyone able to write one database column could delete
  somebody's second factor by corrupting it, leaving the account on a password alone.
- **A broken row costs only itself.** Somebody with two factors still signs in on the working
  one; only when _no_ factor of theirs opens is the sign-in refused. That is the same closed
  door, held open exactly as far as it safely can be.
