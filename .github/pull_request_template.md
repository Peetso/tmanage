## What and why

<!-- One or two sentences. Link the ticket. -->

## Security block

<!-- Required (docs/security/ticket-security-template.md). The CI security job fails a pull
     request whose body is missing a line or leaves one empty. "none" is an answer. -->

SECURITY:

- Principals:
- Tables:
- Routes:
- Secrets:
- Public surface:
- Abuse case:
- Tests:

## Review checklist (04 §10)

Tick the sections this change touches; a reviewer ticks them too.

**Authentication**

- [ ] Session, MFA and step-up rules unchanged, or the change is covered by a test
- [ ] No credential, token or reset link is logged or returned in an error

**Authorization**

- [ ] Every new route is placed by the route census (capability, platform permission or `PUBLIC_ROUTES`)
- [ ] Every new route is classified in the AI-connector registry (op or `NEVER`)
- [ ] Queries are scoped by `organization_id`; a guessed id from another tenant returns 404

**Cryptography and secrets**

- [ ] Secrets come from the environment only and are listed in `.env.example`
- [ ] Stored secrets use FieldCipher; the feature degrades safely when the key is unset

**File handling**

- [ ] Uploads go through the quarantine and scan path; size and type are checked server-side
- [ ] Downloads respect the file-download policy

**Migrations**

- [ ] Additive and MariaDB-safe (`pnpm check:mariadb`): no generated columns, no CHECK on JSON, no functional indexes
- [ ] A new table is registered in all four places: schema, tenant guard, `users.sql` grants, migrator list

**Audit**

- [ ] Every state change a customer would ask about writes an audit action from the catalogue

## Gates run

- [ ] `pnpm format:check` · `pnpm typecheck` · `pnpm lint` · `pnpm test`
- [ ] `node scripts/security/secrets-census.mjs`
