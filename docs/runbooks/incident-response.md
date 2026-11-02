# Incident response — one-person edition (56-13)

TManage has one operator. This runbook is written so that one person, tired and alone, can follow
it in order. Read it once now, before anything goes wrong.

The incident register is **Platform admin → Incidents** (`/v1/platform/incidents`). It is the same
table the public status page reads, but the status page only ever shows six fields: component,
status, title, public write-up, started and resolved. Everything else in the register stays
private. Rows are kept 5 years (the breach register).

## 1. Severity ladder

Pick the highest that fits. You can raise or lower it later; the change is in the platform audit.

| Severity | Meaning                                                                                       | Example                                                    | First move                      |
| -------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------- |
| SEV0     | Data of one organization reachable by another, or a credential (key, token, password) exposed | A bug shows another company's files; a PAT leaks in a repo | Contain now. Clocks start.      |
| SEV1     | Personal data exposed or lost inside one organization, or the whole service down              | A malicious file reached a member; database restore needed | Contain within the hour.        |
| SEV2     | One feature broken or degraded for many people, no data at risk                               | Uploads fail for everyone                                  | Status post, fix today.         |
| SEV3     | Minor, few people, a workaround exists                                                        | One report is slow                                         | Log it; fix in the normal flow. |

## 2. The first 60 minutes

Do these in order. Write each time into the register as you go (detected, contained, notified).

1. **Open the register.** Create the incident: severity, component, a plain title, "We are
   investigating." as the public text. `detected_at` is now unless you knew earlier — set the
   moment you became aware; every legal clock runs from it. Leave it unpublished for now.
2. **Preserve the evidence before you change anything.**
   - Copy `authentication_events` for the window: phpMyAdmin → Export → SQL, filtered on
     `created_at` from shortly before the start.
   - Export the `audit_events` slice for the affected organizations and the
     `platform_admin_audit_events` slice.
   - Download the Hostinger access logs for the days involved (hPanel → Websites → Logs).
   - Put the files in one private folder named `incident-YYYY-MM-DD`. Do not edit them.
3. **Stop the bleeding.**
   - Rotate the suspected secret per the key rotation steps (56-02, `docs/runbooks/deploy.md`
     "Rotating a key"). A leaked personal access token: revoke it in Platform admin → People.
   - Global sign-out when sessions may be stolen: set a new `SESSION_SECRET` **without**
     `SESSION_SECRET_PREVIOUS`, then restart the app. Every session ends; people sign in again.
   - Maintenance mode when the service must stop: Platform admin → Settings → Maintenance (SPEC
     D4). It shows the banner and blocks writes.
4. **Mark it contained** in the register (`contained_at`) once the hole is closed, even if the
   clean-up goes on.
5. **Decide on personal data and countries** (section 3) and fill in affected organizations, data
   categories, countries and "personal data involved". The register then shows the clocks.
6. **Publish a status post** when customers can notice: Publish on the incident. Use the
   status-post template. Never name an organization or a person in it.

## 3. Personal data? Which countries? → the clocks

```
Is personal data involved (names, emails, files about people, sign-in data)?
├─ No  → no legal clock. Status post if people notice. Resolve when fixed.
└─ Yes → customer clock: tell each affected organization within 48 hours (our DPA).
         Which countries are those customers in?
         ├─ EU / EEA → supervisory authority, 72 hours (GDPR Art. 33)
         ├─ Saudi Arabia → SDAIA, 72 hours (PDPL Implementing Regulations Art. 24)
         ├─ UAE → Data Office, "as soon as practicable" — we treat it as 72 hours (PDPL Art. 9)
         ├─ Egypt → Personal Data Protection Center, 72 hours (Law 151/2020 Art. 7)
         └─ none of these → no authority clock from us; counsel decides.
         SEV0/SEV1 → also tell the people themselves without undue delay (GDPR Art. 34).
```

The register computes the same table (`packages/domain/src/security/incident-clocks.ts`). A clock
is **due soon** inside 12 hours and **overdue** after its deadline.

Resolving is refused (`clock_open`) for SEV0/SEV1 with personal data until the customer notice is
recorded and, where an authority clock applies, the authority notice is recorded **or** you write
why it was not needed (`authorityNotRequiredReason`, kept in the platform audit). Example: the data
was encrypted and the key was never exposed.

In this product, TManage is usually the **processor**: our customer (the organization) is the
controller and decides whether to notify its authority. We still tell them inside 48 hours with
everything they need. When TManage is the controller (our own accounts, billing, marketing), the
authority notice is ours.

## 4. Who to tell

| Who                         | When                                        | How                                                 |
| --------------------------- | ------------------------------------------- | --------------------------------------------------- |
| Affected organizations      | Within 48 hours when personal data involved | Customer-notice template, from `security@`          |
| Authorities                 | Within the clock (section 3)                | Authority-notice template, on their online form     |
| Everyone using TManage      | When people can notice                      | Status post + in-app banner (Settings → Announce.)  |
| Hostinger support           | Host compromise, logs needed, abuse         | hPanel → Help → live chat; ask for logs by date     |
| Cloudflare                  | DNS, TLS or DDoS involved                   | Dashboard → Support; turn on "Under attack" mode    |
| Google / Microsoft consoles | OAuth client secret exposed or abused       | Rotate the client secret; review consent grants     |
| Counsel                     | Any SEV0, any authority notice, any doubt   | `{{counsel_name}}`, `{{counsel_contact}}` (fill in) |

Mail goes out on the `security@` lane (`docs/runbooks/mail-lanes.md`), never behind a digest.

## 5. Postmortem rule

Every SEV0 and SEV1, and any SEV2 that lasted over 4 hours, gets a postmortem within 5 working
days, written from `docs/runbooks/incident-templates/postmortem.md`. No blame: describe what the
system allowed, not who slipped. Store it privately and put its link in the register
(`postmortem_url`). Each action item becomes a task with an owner and a date.

## 6. Quarterly tabletop

One hour, once a quarter. Pick one scenario, play it against this runbook with a timer, and write
what was slow or unclear. Record it in `docs/runbooks/tabletops/YYYY-MM.md` (see the README there).
The first tabletop is Peter with Claude.

Scenarios, in rotation:

1. **Leaked PAT.** A personal access token is pasted in a public repository. Find whose, revoke it,
   check `authentication_events` for its use, decide on clocks.
2. **Malicious file.** A member uploaded a file the scanner missed and others downloaded it. Find
   who downloaded, quarantine, tell the organization.
3. **Support-account compromise.** A platform admin account signs in from an unknown place. Sign it
   out, check `platform_admin_audit_events` for support sessions, rotate, decide on clocks.
4. **Lost keyring.** The field-cipher keyring backup is missing after a host move. Restore from the
   offline copy; if none, list what cannot be decrypted and who to tell.

## 7. Templates

`docs/runbooks/incident-templates/` holds, each in English then Arabic:
`authority-notice.md`, `customer-notice.md`, `in-app-banner.md`, `status-post.md`,
`postmortem.md`. Placeholders look like `{{incident_title}}`. Follow the copy rules
(`docs/product/copy-rules.md`, 55-13): short sentences, what happened, what it means for the
reader, what we did, what they should do. No internal words.
