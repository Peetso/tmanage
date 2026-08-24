-- 0003_session_rotation — refresh-token rotation and reuse detection (ID-001).
--
-- Governing sources: 04-SECURITY-PRIVACY.md §3 ("short-lived access session plus rotating
-- refresh token; refresh reuse detection and device/session list"),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md §3 step 1, 27-TEST-CATALOG.md SEC-02.
--
-- ## Why the tables in 0001 were not enough
--
-- `sessions` as created in 0001_tenancy.sql holds exactly one refresh-token hash per row.
-- Rotation can be done with that alone — overwrite the hash — but **reuse detection cannot**.
-- A stolen token that has already been rotated away hashes to a value the table no longer
-- holds, so replaying it is indistinguishable from replaying random noise. The one signal
-- that matters is lost precisely when it fires.
--
-- Reuse detection needs the superseded hashes to survive. So:
--
--   * `sessions.refresh_token_hash` keeps its meaning and its unique key: it is the **one
--     live** refresh token for that session.
--   * `session_refresh_tokens` is an append-only ledger of hashes that **used to be** live.
--
-- The two sets are disjoint by construction — a hash is either current or superseded, never
-- both — so there is no denormalised copy to drift. A presented token resolves to exactly
-- one of three answers: live (rotate it), superseded (**reuse — kill the session**), or
-- unknown (refuse).
--
-- ## Why the ledger is append-only
--
-- The same reasoning as `audit_events` in 0002, and for a sharper reason: this ledger *is*
-- the evidence. An attacker who could delete their superseded hash would make their stolen
-- token look unknown rather than replayed, and the compromise would pass as a typo. Triggers
-- reject UPDATE and DELETE for every credential; `scripts/db/users.sql` additionally grants
-- the runtime user INSERT and SELECT only, so the attempt cannot even be made. Retention is
-- therefore a privileged, separately-credentialed procedure — exactly as it is for the audit
-- log.
--
-- ## Not tenant-owned
--
-- `users`, `sessions` and `session_refresh_tokens` carry no `organization_id`, deliberately:
-- one person is one account holding memberships in many organizations, and forking identity
-- per tenant would break session revocation across them. They are registered in the guard's
-- NON_TENANT_TABLES list so the omission is a decision on the record rather than a gap.

-- ─────────────────────────────────────────────────────────────────────────────
-- Session lifecycle columns
-- ─────────────────────────────────────────────────────────────────────────────
-- `expires_at` is the session's **absolute** deadline and is deliberately not extended by
-- rotation: a rotating refresh token that also slides its own expiry never ends, and a
-- stolen one inherits that. A sliding idle window is a second clock and a product decision
-- the pack does not make, so it is not invented here.

ALTER TABLE sessions
  ADD COLUMN rotated_at     DATETIME(3) NULL AFTER expires_at,
  ADD COLUMN revoked_reason VARCHAR(64) NULL AFTER revoked_at;

-- ─────────────────────────────────────────────────────────────────────────────
-- The superseded-token ledger
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE session_refresh_tokens (
  id            CHAR(36)    NOT NULL,
  session_id    CHAR(36)    NOT NULL,
  -- SHA-256 hex of the opaque token. The token itself is never stored anywhere: a database
  -- disclosure must not hand the reader a usable credential.
  token_hash    CHAR(64)    NOT NULL,
  issued_at     DATETIME(3) NOT NULL,
  superseded_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  -- The lookup that detects reuse, and the constraint that makes a hash unambiguous across
  -- the whole ledger rather than only within one session.
  UNIQUE KEY uq_session_refresh_tokens_hash (token_hash),
  KEY ix_session_refresh_tokens_session (session_id, superseded_at),
  CONSTRAINT fk_session_refresh_tokens_session
    FOREIGN KEY (session_id) REFERENCES sessions (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Triggers — append-only
-- ─────────────────────────────────────────────────────────────────────────────

DELIMITER $$

CREATE TRIGGER trg_session_refresh_tokens_no_update
BEFORE UPDATE ON session_refresh_tokens FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'session_refresh_tokens is append-only: a superseded token hash is evidence';
END$$

CREATE TRIGGER trg_session_refresh_tokens_no_delete
BEFORE DELETE ON session_refresh_tokens FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'session_refresh_tokens is append-only: rows cannot be deleted';
END$$

DELIMITER ;
