# Plan 52 rollout flags (52-24)

The agency money-and-work features of plan 52 each sit behind one feature flag. A flag is a
switch per company: on, the feature is there; off, its pages are hidden and the server answers
its routes with the calm "not found" (404), exactly as if the feature did not exist.

The flags live in the existing feature-flag mechanism (`OPTIONAL_MODULE_FLAGS` in
`apps/api/src/modules/admin/feature-flags.service.ts`). Nothing new is stored: the platform
layer (`platform_feature_flags`, `platform_org_flag_overrides`, migration 0244) and each
company's own row (`org_feature_flags`, migration 0147) already hold them.

## What each flag gates

| Flag (plain name on screen)       | Key                     | Plan items        | Server routes refused while off                                                                                                                     | Web entry points hidden                                                                                 |
| --------------------------------- | ----------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Time tracking                     | `time_tracking`         | 52-01, 02, 03     | `…/time/*` (timer, timesheets, period locks, automatic timer, team time)                                                                            | Timer pill and automatic-timer status in the header; Timesheets, Team time, Period locks cards and tabs |
| Rate cards, budgets and retainers | `finance_rates_budgets` | 52-04, 05, 06     | `…/finance/rate-cards`, `…/finance/rates/*`, `…/finance/cost-rates/*`, `…/retainers/*`, `…/client-organizations/:id/retainers`                      | Rate cards and Retainers cards and tabs                                                                 |
| Expenses                          | `expenses`              | 52-07             | `…/expenses/*`                                                                                                                                      | Expenses card and tab                                                                                   |
| Quotes                            | `quotes`                | 52-08             | `…/quotes/*`, `…/portal/quotes/*`                                                                                                                   | Quotes card                                                                                             |
| Client invoices                   | `client_invoicing`      | 52-09, 10, 11, 13 | `…/client-invoices/*`, `…/finance/exports/*`, `…/portal/invoices/*`, `…/portal/projects/:id/budget`, `…/portal/retainers/*`                         | Invoices card and tab                                                                                   |
| E-invoicing (Saudi Arabia)        | `einvoicing_ksa`        | 52-12             | `…/finance/einvoicing/*` (certificate, chain)                                                                                                       | none (reached from the finance profile)                                                                 |
| Finance reports                   | `finance_reports`       | 52-14             | `…/insights/finance/*` (profitability, unbilled, utilisation, export)                                                                               | Reports card and tab                                                                                    |
| Proofing                          | `proofing`              | 52-15, 16, 17     | `…/files/:id/review/*`, `…/review/*`, `…/projects/:id/review/*` and their portal twins                                                              | File viewer: the Pin / Box / Draw tools and the rail's "Add comment" button                             |
| Outside approval links            | `approval_links`        | 52-18, 19         | `…/deliverables/:id/versions/:id/external-approvals`                                                                                                | "Send for approval" card on the deliverable page                                                        |
| Public request forms              | `public_forms`          | 52-20, 21         | `…/work-forms/:id/publish`, `unpublish`, submissions triage; every anonymous door `v1/public/forms/:slug` (form, upload token, uploads, submission) | Work forms: the "Public link" card and the "Let people attach files" switch                             |

The finance profile (52-23, shared foundations) has no flag: every money feature needs it.

**Default:** every flag is **on**. Each wave has passed its gate and is live, so a company that
never touched a switch keeps what it has today (spec 52 §11.6: "on for new beta orgs once each
wave passes its gate").

No flag turns off a security check. Sign-in, CSRF, the company check and the capability check
all run before the flag gate; spam protection on public forms (52-21) is not flagged. A flag only
ever removes a feature.

## Who decides, in what order

For one company the server reads, and the first answer wins:

1. **Server lock** — `TMANAGE_FLAG_LOCKS` in the Hostinger environment, e.g. `quotes=off`.
2. **Platform force** for that company (on or off).
3. **The company's own switch** (Control Center → What this studio uses).
4. **Platform default**, if its rollout includes the company (everyone, chosen companies, or a percentage).
5. **The code default** (on, for all ten).

The web asks the same read (`GET /v1/organizations/:slug/feature-flags`) to hide the entry points,
so a hidden page and a refused route always agree.

## Turn a feature off or on for one company

1. Sign in as platform owner and open **Platform → Settings → Feature flags**.
2. Find the flag by its plain name and open its companies drawer.
3. Search the company and set **Force on** or **Force off**. Give a reason; it is audited
   (`platform.flag_updated`).

The company's owner can also flip it under **Control Center → What this studio uses**, unless the platform forced
or locked it.

## Turn a feature on or off for everyone

1. **Platform → Settings → Feature flags**, choose the flag.
2. Set the default on or off, rollout **Everyone**. Save with a reason.
3. For a gradual rollout use **Percentage** (a company always lands in the same bucket, so raising
   the number only adds companies) or **Chosen organizations**.

Forced companies and companies that set their own switch keep their setting.

## Emergency: off everywhere, now

Set `TMANAGE_FLAG_LOCKS` in Hostinger (e.g. `public_forms=off`), then restart quietly (restart,
wait 3 minutes, one request). A locked flag cannot be changed from the platform screen until the
lock is removed.

## What to check after a change

- The "used by N organizations" count on the flag row moved as expected.
- As a member of an affected company: the Finance home shows (or no longer shows) the card, and
  opening its address directly gives "not found" while off.
- For `public_forms`: open a published form link in a private window — off gives "not found".
- For `time_tracking`: a running timer's pill disappears; the desktop app's heartbeats get 404 and
  stop counting until it is on again. Turn it off at a quiet hour.
- Nothing is deleted while a flag is off: turning it back on shows every record as it was.

## Turn it back on

Undo the step you took: remove the force, set the default back on, or remove the server lock and
restart. No data migration is involved either way.

## Not covered yet

- With `proofing` off the file viewer still opens the file, but its Comments rail shows the
  "could not load" notice (the thread read is refused) instead of an empty, hidden rail.
- Links already sent to outside approvers and public quote-accept links (56-07 `v1/public/links`)
  are shared by several features and are not gated by these flags.
- The company screen ("What this studio uses") and the platform screen list the new flags with plain names; no new
  screen was needed.
