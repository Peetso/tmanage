# TManage — Legal, Privacy, and Compliance Requirements for Execution

## 1. Status

This document defines product and operational requirements; it is not final legal text. Final Terms, Privacy Notice, DPA, cookie notice, and cross-border transfer documents require the legal entity, governing law, launch countries, subprocessors, and commercial model. Product implementation can proceed only with the controls below; public launch requires counsel approval.

## 2. Required legal inputs before public beta

Company legal name/address/jurisdiction; target customer/user countries; B2B/B2C role; age restriction; controller/processor allocation; payment provider; cloud/email/AI/analytics/support subprocessors; data regions/transfers; retention; acceptable-use categories; SLA/support; IP ownership; client deliverable/approval legal meaning; governing law/dispute method; marketing consent; cookies/trackers.

## 3. Product privacy requirements

- Just-in-time notice at account, invitation, file upload, analytics preference, AI use, export/deletion.
- Collect minimum identity/profile/activity necessary; optional fields clearly optional.
- Separate product telemetry, security logs, and marketing consent.
- Privacy center: profile correction, export request, deletion request, session/device list, notification preferences, AI policy summary.
- Organization admin controls retention/exports within contract and law; users see when organization policy governs their business records.
- Data subject request workflow verifies identity, scopes tenant roles, tracks deadline, exports safely, records audit without leaking other users.
- Tenant termination shows export deadline, deletion schedule, holds, and completion confirmation.

## 4. Controller/processor model to validate

For organization work content, TManage will generally act as processor/service provider and customer as controller/business; for account security, billing, service analytics, and abuse prevention, TManage may act as independent controller. Counsel must validate per jurisdiction and document in DPA/privacy notice.

## 5. Required contract pack

- Terms of Service / Master Subscription Agreement.
- Privacy Notice.
- Data Processing Addendum with security measures and subprocessor/change terms.
- Acceptable Use Policy.
- SLA/support policy for paid tiers.
- Cookie/analytics notice and consent configuration where required.
- Subprocessor list and transfer mechanism.
- Security/trust overview and incident notification clause.
- Beta/alpha participation agreement and data handling consent.

## 6. Approval legal semantics

Product copy must not universally claim legal signature. “Approval” records business acceptance of a governed version under customer-configured workflow. If electronic-signature equivalence is later marketed, obtain jurisdiction-specific legal analysis, stronger identity/evidence, consent, signature intent, record retention, and downloadable certificate.

Configurable “approval by silence” is off by default, requires customer policy/contract confirmation, visible deadline/consequence, reminder evidence, and legal review. It must never be enabled globally by TManage.

## 7. Data retention baseline for counsel/customer configuration

| Data | Proposed default | Product behavior |
|---|---|---|
| Active work/content | contract life | customer-managed archive/delete |
| Audit/security events | 12–24 months by plan/risk | access controlled, append-only |
| Deleted content recovery | 30 days | clearly communicated soft-delete window |
| Backups | 35 days target | expires automatically; limited restoration |
| Invitations/magic tokens | minutes–14 days | hashed, single-use, revoked after expiry |
| Session/security metadata | 12 months proposed | minimize IP/device detail |
| Product analytics | 13 months proposed | metadata only; policy/consent |
| Support tickets | contract + defined period | content minimized/redacted |

Exact periods require legal/customer/security approval and must be configurable where the market requires.

## 8. Data rights workflow

Intake → identity/authority verification → classify user vs tenant request → discover records across DB/search/storage/logs/AI index/support → legal hold/third-party review → export/correct/delete/anonymize → propagate → verify → respond → audit. Never give an individual employee an organization-wide export.

## 9. Children and sensitive categories

TManage is a business tool, not directed to children. Set minimum age and contract representation according to launch jurisdiction. Do not intentionally collect health, biometric, government ID, payment card, or special-category data in MVP. If customers can upload arbitrary sensitive content, terms/classification/admin controls must state responsibility and prohibited use until compliance tier exists.

## 10. Accessibility and consumer protection

Publish accessibility statement and support route after audit. Pricing, plan limits, trial conversion, cancellation, renewal, storage/retention, AI limitations, and service status must be clear and non-deceptive.

## 11. Records and evidence

Maintain versions of terms/privacy/DPA, user/customer acceptance timestamp and version, subprocessor notices, security assessments, incidents, data requests, deletion jobs, consent/preferences, and approval workflow evidence. Access is least privilege and retention-defined.

## 12. Launch legal gate

- Name/trademark/domain cleared.
- Entity and tax/payment decisions complete.
- Contract/privacy pack approved.
- Data map/subprocessors/transfer mechanism published.
- Retention and rights workflows tested.
- Security measures reflect actual implementation.
- Alpha/beta agreement signed by design partners.
- No marketing claim exceeds tested/certified capability.
