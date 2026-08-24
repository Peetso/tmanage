# TManage — Security, Privacy, and Trust Plan

## 1. Security target

Use OWASP ASVS 5.0 Level 2 as the product security baseline; raise selected identity, admin, cryptography, and multi-tenant controls toward Level 3 for enterprise. Security is designed into product workflows and verified continuously.

## 2. Threat model priorities

Highest risks: cross-tenant data exposure; client seeing internal content; broken object authorization; compromised admin session; malicious file upload; XSS through chat/docs; stolen sessions; automation privilege escalation; AI data leakage/prompt injection; webhook abuse; supply-chain compromise; destructive bulk actions; ransomware/account takeover.

Maintain data-flow diagrams and STRIDE-style threat models for identity, invitation, client publishing, files, search, AI, automations, and exports. Review on architecture changes and before beta/GA.

## 3. Identity and sessions

- Passkeys/WebAuthn and MFA; verified email; SSO/SAML and SCIM for enterprise.
- Passwords, if supported, use Argon2id with tuned parameters and breached-password screening.
- Short-lived access session plus rotating refresh token; refresh reuse detection and device/session list.
- Secure, HttpOnly, SameSite cookies for browser; CSRF protection for state-changing requests.
- Risk-based reauthentication for role change, export, billing, external publish, and security settings.
- Invitation tokens are single-use, hashed at rest, scoped, expiring, and show the inviting organization before acceptance.
- Immediate server-side revocation on offboarding and sensitive permission changes.

## 4. Authorization and tenant isolation

- Default deny. Every action checks tenant, membership, object relation, audience, role, and policy.
- Never accept tenant identity solely from URL/header. Resolve it against authenticated membership.
- MySQL tenant isolation is enforced by verified `TenantContext`, tenant-scoped repositories, composite tenant foreign keys/unique keys, least-privilege runtime credentials, explicit client projections, and adversarial isolation tests. MySQL has no native PostgreSQL-style RLS, so no control may assume it exists.
- Dedicated tests attempt every role/action/object-audience combination and cross-tenant identifiers.
- Admin access is separate, strongly authenticated, just-in-time where possible, and fully audited.
- Client-visible projections exclude internal fields at serialization/query level—not by hiding UI elements.
- Search, AI retrieval, exports, caches, notifications, and analytics apply the same authorization boundary.

## 5. Client Portal safety

- New objects default `internal`.
- Publishing checks linked object visibility and warns about internal references.
- “View as client” uses the actual authorization policy, not a simulated CSS state.
- A versioned client projection prevents later internal edits from silently changing an approved external record.
- No client can discover another client organization, user, project, file key, or search result.
- External links expire, can be revoked, use constrained scopes, and are never indexable.

## 6. Application security

- Strict input schemas; contextual output encoding; sanitized rich-text allowlist.
- Content Security Policy with nonces/hashes; no unsafe inline script; Trusted Types where practical.
- File validation uses content signatures, size/type quotas, malware scan, sandboxed preview, and safe Content-Disposition.
- SSRF protections: outbound allowlists, DNS/IP validation, metadata service blocking, egress proxy for fetch features.
- Parameterized queries; no dynamic SQL from filters without a controlled query builder.
- Rate limiting, abuse detection, pagination ceilings, complexity limits, and backpressure.
- Secrets in managed secret store, never source or client bundles; automated rotation and leak scanning.

## 7. Encryption and key management

- TLS 1.2+ with modern suites; HSTS.
- Managed encryption at rest for database, backups, search, logs, and object storage.
- Envelope encryption for selected highly sensitive fields; keys in cloud KMS with separation of duties and rotation.
- Signed URLs and webhook HMAC keys are scoped and rotated.
- Passwords are hashed, never encrypted.

## 8. Audit and monitoring

Audit events: sign-in, MFA, invitations, role and policy changes, project/client sharing, view/download of sensitive exports, approval, publish, delete/purge, automation changes, admin impersonation, API keys, webhooks, AI consequential proposals.

Audit log records actor, effective actor, organization, action, object, before/after summary, source, IP/device metadata, timestamp, correlation ID, and result. It is append-only, access-controlled, retention-managed, exportable, and monitored for tampering.

Detection rules cover impossible travel, credential stuffing, mass download, cross-project enumeration, abnormal invitations, rapid permission changes, token replay, high-volume export, and suspicious automation behavior.

## 9. Privacy program

- Data inventory and classification: public, internal, confidential, restricted.
- Purpose limitation, data minimization, transparent analytics, and separate consent/legal basis where required.
- Product workflows for access, correction, export, deletion, and tenant termination.
- Retention schedules per object type; legal hold is explicit and enterprise-gated.
- Subprocessor register, DPAs, transfer mechanisms, regional processing plan.
- No customer content used to train shared models by default; document AI provider retention and opt-outs.
- Analytics avoid message/document content unless essential and consented; prefer event metadata.

## 10. Secure development lifecycle

- Security requirements and abuse cases in every relevant story.
- Dependency lockfiles, automated updates, SCA, SAST, secret scan, IaC scan, container scan, SBOM.
- Signed build artifacts, protected CI identity, least-privilege deployment roles, provenance where supported.
- Mandatory review for authentication, authorization, cryptography, file handling, migrations, and audit.
- External penetration test before GA and annually; coordinated vulnerability disclosure and later bug bounty.

## 11. Incident response and resilience

- Severity model, on-call ownership, communication templates, evidence preservation, legal/privacy escalation.
- Playbooks for tenant leak, account takeover, malicious file, compromised dependency, ransomware, and lost signing key.
- Quarterly tabletop exercises; annual recovery exercise; restore tests more frequent than backups.
- Public status page and post-incident review with corrective actions.

## 12. Compliance path

Phase 1: GDPR-ready controls, DPA, privacy rights, breach process, OWASP ASVS L2 evidence. Phase 2: SOC 2 Type I then Type II, SSO/SCIM, audit export, vendor risk program. Phase 3 based on market: ISO 27001, regional hosting, HIPAA or sector requirements. Never claim certification before independent completion.

## 13. Security release gates

- No unresolved critical/high vulnerability without documented executive exception.
- Tenant-isolation suite passes.
- Backup restore and disaster procedure tested.
- Client-view authorization and export tests pass.
- Secrets and dependency scans clean.
- Threat models updated; logging and alerts verified.
- Privacy impact assessment complete for AI and analytics.
