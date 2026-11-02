-- 0313_org_secrets_signing — 52-12 e-invoicing readiness (backend, part 3a), R22-a.
--
-- Governing source: 52-FEATURE-GAPS-AGENCY-CORE "52-12" scope 3 and 5, Security "Key handling".
--
-- `org_secrets` — an organization's recoverable secrets, today the ZATCA CSID certificate and its
-- private key (`secret_key = 'zatca_signing'`). `ciphertext` is the FieldCipher `fc1.` envelope
-- (purpose `org_secret`, AAD owner = the row id), so it is TEXT, not BLOB: the cipher writes
-- strings (deviation from the planning text, stated). `key_version` is the FieldCipher key id the
-- envelope was written under. `meta_json` holds the certificate's public facts only — issuer,
-- subject, serial, notBefore/notAfter, SHA-256 fingerprint, `sandbox` — never key material.
-- `status` is active | rotated | revoked (app-checked): a replaced certificate is kept `rotated`
-- so an old invoice's Phase-2 QR still rebuilds; no DELETE grant. `key` is a reserved word in
-- MySQL, hence `secret_key`.
--
-- `zatca_signature` (base64 DER ECDSA-SHA256 over the stored XML) and `zatca_cert_fingerprint`
-- (SHA-256 of the signing certificate) on both fiscal tables: written at send / issue, under the
-- same transaction as the chain link; `zatca_status` then reads `signed`.
--
-- MariaDB-safe (Hostinger): VARCHAR instead of ENUM, no CHECK, no generated column, no IF NOT
-- EXISTS. Registry: schema.ts (`orgSecrets`, TABLES, `OrgSecretRow`), tenant-guard
-- (`organization_id`), users.sql (app SELECT/INSERT/UPDATE, worker SELECT/UPDATE).

CREATE TABLE org_secrets (
  id CHAR(36) NOT NULL,
  organization_id CHAR(36) NOT NULL,
  secret_key VARCHAR(64) NOT NULL,
  ciphertext TEXT NOT NULL,
  key_version VARCHAR(32) NULL,
  meta_json TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_by CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  rotated_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_org_secrets_org_id (organization_id, id),
  KEY ix_org_secrets_org_key (organization_id, secret_key, status)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE client_invoices
  ADD COLUMN zatca_signature VARCHAR(255) NULL,
  ADD COLUMN zatca_cert_fingerprint CHAR(64) NULL;

ALTER TABLE client_credit_notes
  ADD COLUMN zatca_signature VARCHAR(255) NULL,
  ADD COLUMN zatca_cert_fingerprint CHAR(64) NULL;
