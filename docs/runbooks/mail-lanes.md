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
