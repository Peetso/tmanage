# Security release checklist (56-15)

Copy this list into the release record and tick it before a release goes live. The gates are
04 §13, reused as written; the evidence column says where the proof comes from. A line that
cannot be ticked blocks the release unless an exception is written down with its owner and date.

## 04 §13 release gates

- [ ] No unresolved critical/high vulnerability without documented executive exception.
- [ ] Tenant-isolation suite passes.
- [ ] Backup restore and disaster procedure tested.
- [ ] Client-view authorization and export tests pass.
- [ ] Secrets and dependency scans clean.
- [ ] Threat models updated; logging and alerts verified.
- [ ] Privacy impact assessment complete for AI and analytics.
- [ ] origin_tls daysLeft ≥ 30 (SEC56-30) — `/healthz/deep` `checks.origin_tls`; see `docs/runbooks/origin-tls-526.md`.

## Evidence

| Gate                     | Evidence                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Critical/high            | The latest `security-audit` report in `docs/security/reports/`, every critical/high finding fixed or excepted           |
| Tenant isolation         | `pnpm test:db` green, including `test/tenant-isolation.db.test.ts`                                                      |
| Backup and restore       | `docs/runbooks/backup-restore.md` drill date within the last 90 days                                                    |
| Client view and export   | `pnpm test:db` (client projection and export suites) and `pnpm test:e2e`                                                |
| Secrets and dependencies | CI `security` job: gitleaks, `node scripts/security/secrets-census.mjs`, `pnpm audit --prod --audit-level=high`         |
| Route census             | `pnpm test` (unit): `apps/api/src/security/sdlc-census.test.ts` and `ai-actions/registry/registry-sync.test.ts`         |
| Migrations               | `pnpm check:mariadb`, and the migrations applied to a local MariaDB 11.8 (`scripts/db/mariadb-server.mjs`) before merge |
| Ticket security blocks   | Every pull request in the release passed the `SECURITY:` block check                                                    |
| Public claims            | Nothing on the trust centre page claims more than the evidence above proves, checked against the public-claims registry |

## Last step

After the whole wave is built and its test phase is green: run the `security-audit` skill over the
repository, fix the findings, file the report in `docs/security/reports/`, then hand over to the
approver. The skill is not run per change.
