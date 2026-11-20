# ADR-0013 — A tip leaves from the signing person's own mailbox over SMTP, and every e-mail carries one-click unsubscribe

- **Status:** Accepted (lane M, 2026-11-20; revised the same day for the owner's decisions 1–3 below)
- **Date:** 2026-11-20
- **Deciders:**
  - Peter, for the rules: correction 4; "every e-mail carries unsubscribe"; one shared mailbox password; never "sent from support@ in X's name".
  - The implementation lead (lane M), for the mechanism.
  - Accepted by the pass manager.
- **Rules affected:**
  - RT-1: secrets are never logged, returned or committed.
  - SE-6: STRIDE row T-24.
  - ST-1: outbound calls are bounded.
  - AS-1 and AS-2: retries go only through the queue.
  - PR-1: tests are revert-proven.
  - **Bends a rule:** yes, see "Risk accepted by the owner".
- **Quality scenarios:** QA-SE (secrets), QA-AV (a failing mailbox is visible, not silent).
- **Evidence:**
  - `packages/mail/src/identity-mailer.ts` (`PersonMailboxes`, `IdentityRoutingMailer`, `createIdentityMailers`).
  - `packages/mail/src/mailbox-login.ts` (`resolveMailboxLogin`, `MailLoginCheck`).
  - `packages/mail/src/sender-resolver.ts` (`unsubscribeFor`, `withFooter`).
  - `packages/mail/src/sign-off.ts` (`unsubscribeFooter`, `STILL_SENT_LINE`).
  - `packages/mail/src/send-ceiling.ts` (`isBulkMessage`).
  - `apps/api/src/common/email/mail-login-check.ts`.
  - `apps/api/src/common/observability/deep-health.ts` (`mail`).
  - `apps/api/src/modules/platform-admin/settings/mail-people.service.ts` (`mailboxes`, test route).
  - `apps/worker/src/main.ts` (`sendersFrom`, `securityMailerFrom`).
  - `apps/api/src/modules/email-deliverability/unsubscribe.controller.ts` (GET).
  - `apps/web/src/components/screens/UnsubscribeScreen.tsx`.
  - `apps/web/src/components/platform/settings/MailPeopleCard.tsx`.

## Context

1. **Correction 4** (EMAIL-AMENDMENT-3) says a tip (template `tip`, category `person`) must truly leave from the signing employee's real mailbox (mariam@tmanageapp.com …), with From set to that address.
   - The earlier build sent it through the support login, with the person only in the display name and Reply-To.
2. **The Hostinger Mail API cannot carry the headers.** I read its send endpoint `POST /api/v1/mailboxes/{mailboxResourceId}/send` from `https://api.mail.hostinger.com/openapi/openapi.json` (schema `V1.Send.Request`) on 2026-11-20.
   - It accepts only `to`, `cc`, `bcc`, `displayName`, `subject`, `text`, `html`, `attachments`, `inReplyTo` and `forwardOf`.
   - It has no custom-header field, no Reply-To and no Message-ID.
   - It answers 204, and says a delivery failure "is not reported on this call".
3. **The owner's decisions (2026-11-20):**
   1. Every e-mail carries unsubscribe: a visible body link AND the RFC 8058 header pair.
   2. All 36 mailboxes share ONE password, set once as `SMTP_PASSWORD`. Each mailbox signs in with its own address as the username.
   3. "Sent from support@ in X's name" is rejected. When `SMTP_PASSWORD` is set, a tip always leaves from that person's own mailbox. If that login fails, the mail is retried, then marked failed and logged. It is never sent from another mailbox.
4. **What the sources require** (each read on 2026-11-20):
   - **RFC 8058 §3.1** (<https://www.rfc-editor.org/rfc/rfc8058>):
     - `List-Unsubscribe` "MUST contain one HTTPS URI".
     - `List-Unsubscribe-Post` "MUST contain the single key/value pair `List-Unsubscribe=One-Click`".
     - The POST "MUST NOT include cookies, HTTP authorization, or any other context information".
   - **Google, Email sender guidelines** (<https://support.google.com/a/answer/81126>): senders of more than 5,000 messages a day must support one-click unsubscribe on marketing and subscribed mail, plus a visible link in the body.
   - **Yahoo, Sender best practices** (<https://senders.yahooinc.com/best-practices/>): bulk senders need a functioning one-click `list-unsubscribe` header, and RFC 8058 POST is "highly recommended".
   - **FTC, CAN-SPAM compliance guide** (<https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business>):
     - Commercial mail needs "a clear and conspicuous explanation of how the recipient can opt out".
     - Transactional mail is largely exempt, read narrowly.
   - **UK PECR (ICO guide)**: an opt-out in every marketing message. The page refused automated reading (HTTP 403), so this source is **partly verified**.
   - **OWASP ASVS 5.0** (<https://github.com/OWASP/ASVS/tree/v5.0.0/5.0/en>):
     - 13.3.1: secrets are kept out of source and in a secrets store.
     - 13.3.2: least privilege on secret assets.
     - 13.2.1: unchanging shared passwords for backend auth are not preferred.
     - 11.2.2: credentials must be replaceable.

## Decision

**A. One login rule for every mailbox.**

1. The role mailboxes (hello, support, security) follow one rule, `resolveMailboxLogin`:
   - The username is the mailbox's own username override (`SMTP_HELLO_USER`, `SMTP_SUPPORT_USER`, `SMTP_SECURITY_USERNAME`). Without one, it is its own address (`hello@`, `support@`, `EMAIL_SECURITY_FROM_ADDRESS`).
   - The password is its own `SMTP_HELLO_PASS`, `SMTP_SUPPORT_PASS` or `SMTP_SECURITY_PASSWORD` when set. Otherwise it is the shared `SMTP_PASSWORD`.
   - So a missing `*_PASS` signs in as that mailbox with the shared password. It does not fall back to noreply. The boot WARN "no login for hello, support; that mail leaves through noreply" now appears only when no password exists at all.
2. noreply keeps `SMTP_USERNAME` + `SMTP_PASSWORD`.

**B. Person mail leaves only from the person's own mailbox.**

1. The sender resolver gives a tip the identity `person` and always sets:
   - From: `"{name} from TManage" <person address>`.
   - Reply-To: the person.
2. `IdentityRoutingMailer` sends `person` through `PersonMailboxes`:
   - One lazy, pooled `SmtpMailer` per person address: max 1 connection, closed after 10 minutes idle.
   - Username = the person's address, password = `SMTP_PASSWORD`.
   - The existing 10 s connection, greeting and socket timeouts apply.
   - Each address has its own `SendCeilingMailer`, keyed on the sending address.
3. **No other mailbox, ever.** The send throws in each of these cases:
   - The login is refused (535/534/530/EAUTH). The transport is dropped and rebuilt on the next try, with one WARN per address and no value.
   - The address's ceiling is reached.
   - The server times out.
   - There is no valid own address.
   - No `SMTP_PASSWORD` is set (`PersonMailboxUnavailableError`).

   The queue drainer's existing path then applies: it retries with backoff, and after `MAX_SEND_ATTEMPTS` it marks the row `failed` with the error token and logs it in the tick report. There is no second retry loop.

4. No per-person password is stored. The earlier per-person encrypted field (0385) was removed before commit, so there is no new secret storage, column or grant.
5. `EMAIL_SEND_AS` no longer affects tips: they always show the person's own address.

**C. A failing login is visible (MAILSTATUS).**

1. `MailLoginCheck` signs in to each role mailbox (noreply, hello, support, security) with `verify()`. It connects, starts TLS, authenticates and quits; it sends nothing.
2. A mailbox's state is `ok`, `login_refused`, `unreachable` or `not_configured`. Readings are cached for 15 minutes, and concurrent reads share one check.
3. `/healthz/deep` reports `checks.mail` with the worst state and each mailbox's state:
   - Names only: no address, no error text.
   - It is never awaited there (`checking` until the first reading).
   - It never causes a 503.
4. The platform settings "E-mail people" card lists the same states with the usernames:
   - A refused login shows "Mail is not going out" and names the mailbox addresses.
   - Server error text and passwords are never shown.
5. The check logs one WARN line with mailbox names and states only.

**D. Every e-mail carries unsubscribe.**

1. The sender resolver sees every message once, in the API and in the worker. It stamps `List-Unsubscribe: <https://…/v1/public/email/unsubscribe?t=v1.…>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` on any message the notification transport did not already stamp.
   - It uses the existing signed token (format unchanged), the existing route and the existing handler.
2. Notices and tips keep their sign-off links line ("Notification settings | Unsubscribe").
3. Every other mail gets an honest footer, in EN and AR, in text and HTML:
   - "Notification settings | Unsubscribe from optional e-mails".
   - "Sign-in, security and account messages are still sent after you unsubscribe."
4. The one-click POST suppresses optional mail only. Codes and security mail are never suppressed.
5. **GET never acts.**
   - A browser opening the link gets a 303 to `/unsubscribe/{token}`, and only when the token verifies; anything else goes to `/`.
   - That page asks for one click, posts the same token, and says plainly that sign-in, security and account messages still come.
6. "Bulk" for the ceiling's headroom is now `message.optional === true`. Only `NotificationMailTransport` sets it, and it is kept through the queue. It is no longer "has a `List-Unsubscribe` header", which would have put codes under the bulk share.

## Risk accepted by the owner: one shared password

ASVS 5.0 13.2.1 and 13.3.2 prefer one credential per service and least privilege. A single password for 36 mailboxes departs from that.

- **Risk.**
  - One leak exposes every mailbox, both for reading and for sending as any staff member.
  - Rotation means changing all 36 mailboxes in hPanel at once and then `SMTP_PASSWORD`. Any mailbox missed refuses its login until it is fixed.
- **Decision.** The owner chose this on 2026-11-20 for simplicity. It is recorded here as his decision.
- **Mitigation.**
  1. SMTP only: the app uses the password for SMTP AUTH over TLS (465 implicit, or STARTTLS required) and for nothing else.
  2. The app never exposes it: it is not returned, logged, audited or shown. The health and card readings carry states and usernames only. The tests assert the password never appears in logs.
  3. It is stored only in the host's environment (ASVS 13.3.1), never in the repository or the database.
  4. A refused login is visible within 15 minutes on `/healthz/deep` and on the card, so a missed mailbox after rotation is found.
- **How to rotate.** This is in the runbook `docs/runbooks/mail-lanes.md`:
  1. Generate one new password (8–50 characters, with upper, lower, number and symbol).
  2. In hPanel > Emails > Mailboxes > each mailbox's ⋮ > Change Password, set it on all 36 mailboxes.
  3. Set `SMTP_PASSWORD` once. Change only that one variable; never do a full env replace.
  4. Restart.
  5. Check that `/healthz/deep` shows `mail.state: ok`. Queued mail that failed in between is retried by the queue.
- **Overrides.** `SMTP_HELLO_PASS`, `SMTP_SUPPORT_PASS` and `SMTP_SECURITY_PASSWORD` remain. Giving those mailboxes their own passwords narrows the blast radius.

## Alternatives considered

| Option                                                                              | Pros                             | Cons                                                             | Why not chosen                          |
| ----------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------- | --------------------------------------- |
| Hostinger Mail API, one token                                                       | Real From, no passwords          | No custom headers, Reply-To or Message-ID; failures not reported | Breaks "every mail carries unsubscribe" |
| A password per person, encrypted in the people registry (built first, then removed) | Per-mailbox blast radius         | 36 passwords to manage; a new column and secret store            | Owner decision 2: one shared password   |
| Fall back to support@ under the person's name                                       | Never a failed tip               | From is not the person                                           | Owner decision 3 rejects it             |
| `EMAIL_SEND_AS=on` through support                                                  | No person logins                 | May be refused by Hostinger or fail DMARC alignment              | Not the person's own mailbox            |
| Header only on optional mail                                                        | Matches Google and Yahoo exactly | The owner's rule is every mail                                   | Owner's rule; honest wording            |

## Consequences

- **Good.**
  - A tip's From, SMTP login and envelope sender are the person's own mailbox.
  - Each mailbox spends its own Hostinger daily limit.
  - Every mail has one-click unsubscribe and a visible footer.
  - A refused login (such as the live noreply 535 since 2026-11-20 08:39Z) is now visible on `/healthz/deep` and on the card.
- **Bad.**
  - The shared-password risk above.
  - A tip whose mailbox refuses the login is not delivered: it ends `failed` after the queue's attempts. This is the owner's choice over sending it in the person's name.
- **Open gaps.**
  - A tip's bounce returns to the person's mailbox, which does not forward to the bounce intake (the same gap as hello@ and support@).
  - Person mailboxes are not in the login check (36 logins every 15 minutes is too many). Their failures appear as WARN lines and failed queue rows.
  - The card's test route is predicted from the configuration (`own_mailbox` with `SMTP_PASSWORD`, otherwise `none`). The actual send result is shown as sent or failed.
- **Neutral.** No new env variable and no migration. `SMTP_PASSWORD` already exists.

## Fitness functions

| Rule                                                                    | Check (path)                                                                                                                                                                                                                                                       | Exists / to build |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| Every mail carries headers and footer                                   | `packages/mail/src/unsubscribe-every-mail.test.ts` walks `TEMPLATE_KEYS` × EN/AR: header pair, signed token, text and HTML footer, the "still sent" line                                                                                                           | exists            |
| Shared password, own username; overrides                                | `packages/mail/src/mailbox-login.test.ts`; `packages/mail/src/person-mailbox.test.ts` "a missing *_PASS …"                                                                                                                                                         | exists            |
| Person login uses the person's address; never via support; never logged | `packages/mail/src/person-mailbox.test.ts`                                                                                                                                                                                                                         | exists            |
| A refused login is visible, with no value                               | `packages/mail/src/mailbox-login.test.ts`; `apps/api/src/common/observability/deep-health.test.ts` "MAILSTATUS"; `apps/api/src/modules/platform-admin/settings/mail-people.service.test.ts` "MAILSTATUS"; `apps/web/tests/platform-settings.test.tsx` "MAILSTATUS" | exists            |
| Codes keep their headroom                                               | `packages/mail/src/deliverability.test.ts`, `identity-mailer.test.ts` (bulk = `optional`)                                                                                                                                                                          | exists            |
| GET never acts                                                          | `apps/api/src/modules/email-deliverability/unsubscribe.controller.test.ts`; `apps/web/tests/unsubscribe-screen.test.tsx`                                                                                                                                           | exists            |
