# SOC 2 readiness — gaps, ranked (56-18)

Read with `control-map.md` in this folder. Graded from the code on 2026-11-16. TManage has not
been audited; nothing here is a SOC 2 report or a certification. The plan's order is SOC 2 Type I
first, then Type II (`docs/planning/04-SECURITY-PRIVACY.md` §12).

## 1. Gaps ranked by risk, then effort

Effort: S = under a day, M = a few days, L = a week or more.

| #   | Gap                                                                        | Risk   | Effort | Kind                |
| --- | -------------------------------------------------------------------------- | ------ | ------ | ------------------- |
| 1   | CI cannot start (GitHub billing block): no independent gate record         | High   | S      | Owner decision      |
| 2   | No restore drill on record (CC9.1, A1)                                     | High   | S      | Policy / people     |
| 3   | Erasure not automated for 49 inventory rows (global account, audit fields) | High   | L      | Code                |
| 4   | No information-security policy set (CC1, CC5)                              | High   | M      | Policy / people     |
| 5   | No external penetration test (CC7.1)                                       | High   | M      | Auditor / paid      |
| 6   | No Data Processing Addendum, no transfer mechanism (GDPR Art. 28, 44–49)   | High   | M      | Legal, owner        |
| 7   | No periodic access-review report (CC6.3)                                   | Medium | S      | Code + policy       |
| 8   | Audit-log purge is preview-only (C1.2, GDPR Art. 5(1)(e))                  | Medium | M      | Code                |
| 9   | No analytics/cookie consent switch (GDPR Art. 6–7)                         | Medium | M      | Code                |
| 10  | First incident tabletop not held (CC7.3–7.5)                               | Medium | S      | Policy / people     |
| 11  | Least-privilege database proof open on MariaDB (CC6.1)                     | Medium | S      | Code (test)         |
| 12  | Live upload scanner not confirmed on shared hosting (CC6.8)                | Medium | S      | Code (health check) |
| 13  | No second reviewer on changes (CC8.1)                                      | Medium | —      | People              |
| 14  | No scored risk register (CC3)                                              | Low    | S      | Policy              |
| 15  | Subprocessor list not dated, no change notice (CC9.2, Art. 28(2))          | Low    | S      | Policy + page copy  |
| 16  | No privacy impact assessment for AI and analytics (Art. 35)                | Low    | S      | Policy              |
| 17  | Hosting provider's assurance report not obtained (CC6.4)                   | Low    | S      | Owner decision      |

## 2. Split by who does it

**Code work (can be built now, no paid service):**

- Automate erasure for the inventory `gap` rows: pseudonymise `authentication_events`, redact
  personal fields kept in `audit_events`, delete global identity rows on account deletion
  (`docs/security/data-inventory.md`).
- A separately credentialed audit-log purge that honours the stored retention window
  (`apps/api/src/modules/admin/audit-retention.service.ts` says the purge is a later step).
- An access-review export: every member, role, last sign-in and second-factor state, per
  organization, recorded in the audit log when taken.
- Analytics and cookie consent setting, wired to the product-events registry.
- A deep-health check that reports whether the malware scanner is reachable on the live host.
- Close the MariaDB least-privilege proof (the chain currently skips it).

**Policy and people work (owner, no code):**

- Information-security policy set: access control, change management, incident response,
  backup and recovery, vendor management, acceptable use, data retention.
- Hold the monthly restore drill and the first quarterly tabletop; file each record.
- Quarterly access review and threat-model review on the dates the threat model names.
- Risk register, vendor reviews, dated subprocessor list, privacy impact assessment.

**Needs an auditor, counsel or a paid tool — owner's decision, not started:**

- Clearing the GitHub billing block so CI runs.
- External penetration test.
- Counsel for the DPA, privacy notice approval and the transfer mechanism.
- A SOC 2 auditor (CPA firm) for a Type I report, then a Type II observation window.
- Optional compliance-automation platform; the evidence below can be kept by hand instead.

## 3. Evidence-collection checklist

Keep each item dated, in one folder, from the day the Type II window would start.

- [ ] Each release: the `pnpm verify` result and `pnpm audit:prod` output, with the commit.
- [ ] Each release: the filled `docs/security/release-checklist.md`.
- [ ] Monthly: restore-drill record (`scripts/ops/restore-drill.mjs`, `docs/runbooks/backup-restore.md`).
- [ ] Monthly: backup-health and uptime results.
- [ ] Quarterly: tabletop record in `docs/runbooks/tabletops/` and threat-model review.
- [ ] Quarterly: access-review export and who signed it off.
- [ ] Quarterly: audit-chain integrity check result (`apps/api/src/modules/audit/audit-integrity.service.ts`).
- [ ] Per incident: the incident template and postmortem (`docs/runbooks/incident-response.md`).
- [ ] Per new vendor: vendor review and subprocessor-list update.
- [ ] Yearly: penetration-test report and the fixes it led to.
- [ ] Signed policy set, with the date each policy was last reviewed.
