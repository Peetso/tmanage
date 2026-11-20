# Mail lanes (56-31)

Hostinger's hosting mail caps each mailbox per hour. With the mail queue on, no producer talks to
SMTP directly: it enqueues one `mail_queue` row and the worker drainer
(`apps/worker/src/jobs/mail-drainer.ts`) submits rows in lane order against a durable, shared
hour window (`mail_hour_windows`). A sign-in code is never stuck behind a digest.

## Switching it on

| Variable                      | Where          | Meaning                                             |
| ----------------------------- | -------------- | --------------------------------------------------- |
| `MAIL_QUEUE=on`               | API and worker | Producers enqueue; the drainer is the only sender.  |
| `SMTP_SECURITY_USERNAME`      | worker         | The security@ mailbox (same `SMTP_HOST`). Optional. |
| `SMTP_SECURITY_PASSWORD`      | worker         | Its password.                                       |
| `EMAIL_SECURITY_FROM_ADDRESS` | worker         | Its From address (default: the username).           |

Off (the default) keeps the pre-56-31 path: each producer submits through `SendCeilingMailer`.
Turn it on only where the drainer runs beside the API (the single Hostinger app runs both).

Peter's 10-minute step for the second mailbox: hPanel → Emails → create
`security@tmanageapp.com`, then set the three `SMTP_SECURITY_*` / `EMAIL_SECURITY_*`
variables. Without it there is one mailbox (noreply@) and the lane order alone protects `auth`.

## Lanes

The lane comes only from the template key (`laneForTemplate` in `packages/mail/src/lanes.ts`);
no request can choose it, and an unknown key is `transactional`, never `auth`.

| Lane            | Examples                                                  | Mailbox                   |
| --------------- | --------------------------------------------------------- | ------------------------- |
| `auth`          | sign-in code, magic link, password reset, MFA, credential | security@ (else noreply@) |
| `transactional` | invitation, welcome, approval, client request, ops alert  | noreply@                  |
| `digest`        | digest, nudge, collaboration notice, usage threshold      | noreply@                  |
| `bulk`          | announcement, GTM, report                                 | noreply@                  |

## Ceilings

- Per mailbox per clock hour (UTC): `platform_settings.mail_hour_ceiling_security` and
  `mail_hour_ceiling_noreply`; absent = `HOST_MAIL_CEILING.perHour`. Seed with one SQL line on the
  migration credential, e.g.
  `INSERT INTO platform_settings (setting_key, setting_value) VALUES ('mail_hour_ceiling_noreply','100') ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);`
- 10 % safety margin below the stated ceiling.
- On the shared mailbox `digest` + `bulk` stop at 80 % of the usable budget; 20 % stays for
  `transactional` (and `auth` when it has no mailbox of its own).
- A row that does not fit is `deferred` to the next window, never dropped.
- An `auth` row past its code TTL is marked `failed` with error `deadline` — never sent late.

## Alerts

| Kind                          | Meaning                                                                      | Do                                                        |
| ----------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| `auth_mail_deferred` (high)   | A sign-in/security mail is waiting for the next window.                      | Check the ceilings and the mailbox at the host; raise it. |
| `transactional_mail_deferred` | More than 50 transactional mails deferred in the hour.                       | Pause `bulk`/`digest`; check what is sending.             |
| `mail_provider_degraded`      | security@ refused (auth failure or a 4xx storm); auth fell back to noreply@. | Fix the security@ credentials or the mailbox in hPanel.   |

Each kind is sent at most once per window to `ALERT_EMAILS`.

## Reading `/v1/platform/mail/health`

`GET /v1/platform/mail/health` (platform admin, `platform.activity.view`) returns counts only,
never an address: per lane `sentThisHour`, `hourCeiling`, `queued`, `deferred`, `paused`; per
mailbox `ceiling`, `reserved`, `sentThisHour`; `deferredAuth`; `degraded`.

`POST /v1/platform/mail/lanes/:lane/pause` (`platform.settings.edit`) with
`{ "paused": true|false, "reason": "…" }` pauses or resumes a lane; it is audited. `auth` can
never be paused (400).

## Retention

Rows are purged 7 days after `sent`/`failed`; an `auth` row's `payload_json` is stripped one hour
after it is sent (the recipient hash stays). A row left `sending` for more than 10 minutes (a
crash between claim and send) is re-queued once.

## One shared mailbox password; person mail from the person's own mailbox (PERSONMAIL, ADR-0013)

Owner decision 2026-11-20: all 36 `@tmanageapp.com` mailboxes share ONE password, `SMTP_PASSWORD`.

- **Every mailbox signs in as itself.**
  - noreply uses `SMTP_USERNAME` + `SMTP_PASSWORD`.
  - hello, support and security sign in with their own username (`SMTP_HELLO_USER`,
    `SMTP_SUPPORT_USER`, `SMTP_SECURITY_USERNAME`; default their own address) and their own
    `SMTP_HELLO_PASS`, `SMTP_SUPPORT_PASS` or `SMTP_SECURITY_PASSWORD` when set. Otherwise they use
    `SMTP_PASSWORD`.
  - The boot line "no login for hello, support; that mail leaves through noreply" now means no
    password exists at all.
- **A tip** (template `tip`, sender category `person`) leaves ONLY from the signing person's own
  mailbox over SMTP.
  - From is `"{name} from TManage" <mariam@tmanageapp.com>`. The login is `mariam@tmanageapp.com`
    with `SMTP_PASSWORD`.
  - Every header stays (`List-Unsubscribe`, `List-Unsubscribe-Post`, `Auto-Submitted`).
  - It is never sent from support@ in the person's name.
- **When a person login fails** (535/EAUTH, a timeout, the mailbox's own ceiling), the send throws
  and the queue retries the row with its backoff. After 3 attempts the row is `failed` with the
  reason, and it is counted in the drainer's tick log line. A refused login also gives one WARN per
  address. A new person needs only a mailbox in hPanel with the shared password, plus a row on the
  card.
- **Connections.** There is one lazy pooled SMTP connection per person mailbox (max 1), closed after
  10 minutes idle, with 10 s timeouts. Each mailbox has its own ceiling, keyed on the sending
  address.
- **Is a login refused?**
  - `/healthz/deep` shows `checks.mail`: `state` plus each of noreply, hello, support and security
    as `ok`, `login_refused`, `unreachable` or `not_configured`. It shows states only, never a 503,
    and it is re-checked every 15 minutes.
  - Platform settings > E-mail people shows "Mail is not going out" with the refused addresses.
  - Person mailboxes are not in this check. Look for "refused its login" WARN lines and `failed`
    queue rows.
- **Rotating the shared password** (one leak exposes every mailbox, so rotate on any doubt):
  1. Pick one new password (8–50 characters with upper, lower, number and symbol).
  2. Go to hPanel > Emails > Mailboxes (next to tmanageapp.com) > each mailbox's ⋮ > Change
     Password, and set it on ALL mailboxes.
  3. Change only `SMTP_PASSWORD` in the Node.js app's environment variables. Never do a full env
     replace.
  4. Restart quietly.
  5. Check that `/healthz/deep` shows `mail.state: ok`.

  Any mailbox you missed shows `login_refused`. Mail queued in between is retried by the queue.

- **Send test** on the card says "Test sent … from mariam@…, this person's own mailbox". When
  `SMTP_PASSWORD` is not set, it says the test was not sent.
- **Bounces.** A bounce of a tip returns to the person's mailbox, which does not forward to the
  bounce intake yet. This is the same open gap as hello@ and support@.

## Unsubscribe on every mail (PERSONMAIL, ADR-0013)

Every mail, every category, carries `List-Unsubscribe` (one HTTPS URL with the existing signed
`v1.` token) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, plus a footer with
"Notification settings" and "Unsubscribe". Mail a person cannot switch off (codes, security,
account, support, agency, internal) says "Unsubscribe from optional e-mails" and "Sign-in,
security and account messages are still sent after you unsubscribe." The one-click POST
suppresses the address for optional mail only (notifications, digests, tips); codes and security
mail are never suppressed. A browser that opens the link (GET) is sent to
`/unsubscribe/{token}`, which asks for one click and says the same. The "bulk" share of a
ceiling now follows `optional` (set by the notification transport), not the header.
