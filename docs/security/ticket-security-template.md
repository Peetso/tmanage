# Ticket security block (56-15)

Every ticket in a build plan, and every pull request that changes behaviour, carries this block.
A ticket is not "ready" until each line has an answer. "none" is an answer; a blank line is not.
The pull-request check (`scripts/security/pr-security-block.mjs`, CI `security` job) refuses a
pull request whose body is missing a line or leaves one empty.

Copy it as it stands:

```text
SECURITY:
- Principals: <member roles / client roles / platform admin / anonymous / AI connector touched>
- Tables: <new tables; composite (organization_id, id) key? NON_TENANT and why? or none>
- Routes: <new routes; capability, scope class, throttle, audit action; or none>
- Secrets: <new secrets or tokens; env-only? FieldCipher at rest? degrades keyless? or none>
- Public surface: <anything an outsider or anonymous caller can reach; or none>
- Abuse case: <the one way this gets misused, and what stops it>
- Tests: <test ids that prove the controls above>
```

## What each line means

| Line           | Answer it by checking                                                                                                                                                                                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Principals     | Which kinds of caller reach the new code. A client role or anonymous caller raises the review bar.                                                                                                                                                                                                                                                   |
| Tables         | A new tenant table needs all four registration places: the schema definition (`TABLES` + type), the tenant guard, the grants in `scripts/db/users.sql`, and the migrator list. Migrations are additive and MariaDB-safe (`pnpm check:mariadb`).                                                                                                      |
| Routes         | The route census (`apps/api/src/security/route-census.ts`) must place each new route: `@RequireCapability` for organization routes, `@RequirePlatformPermission` for platform routes, a `PUBLIC_ROUTES` entry with a named `@Throttle` for anonymous writes. The AI-connector registry (`ai-actions/registry`) must classify it as an op or `NEVER`. |
| Secrets        | Read from the environment only, declared in `packages/config` and listed in `.env.example` (the secrets census fails otherwise). Stored secrets go through FieldCipher. With the variable unset, the feature switches off rather than failing open.                                                                                                  |
| Public surface | Anonymous routes, public links, e-mail content, files served to outsiders. Name the throttle and the enumeration defence.                                                                                                                                                                                                                            |
| Abuse case     | One sentence an attacker would recognise: "a client viewer guesses another project's id", "a script fills the contact form".                                                                                                                                                                                                                         |
| Tests          | The ids of the unit or suite tests that fail if the control is removed.                                                                                                                                                                                                                                                                              |

## Mandatory review areas (04 §10)

A change touching any of these gets the matching section of the pull-request checklist ticked by
a reviewer, not only by its author: authentication, authorization, cryptography, file handling,
migrations, audit.

## Where the gates run

Chain order, cheapest first: format, typecheck, lint, unit (includes the route census), DB suite
with the isolation corpus, e2e, VR, `pnpm audit`, gitleaks, secrets census. The `security-audit`
skill runs once, after the whole wave is built and green, as the last step before the approver;
its report is filed in `docs/security/reports/`. Each release is ticked against
[`release-checklist.md`](release-checklist.md).
