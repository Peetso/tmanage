-- 0004_credentials — password, second factor, recovery codes, and the pre-tenant security log
-- (ID-002).
--
-- Governing sources: 04-SECURITY-PRIVACY.md §3 ("Passkeys/WebAuthn and MFA; verified email
-- … Passwords, if supported, use Argon2id with tuned parameters and breached-password
-- screening"), 12-PERMISSION-MATRIX.md §12 ("denied sensitive attempts are security events
-- with safe metadata"), 22-SCREEN-BY-SCREEN-SPEC.md §3 ID-02 and ID-05,
-- 27-TEST-CATALOG.md SEC-02.
--
-- ## Four tables, and why not fewer
--
-- The obvious shape is "add three columns to `users`" — a password hash, a TOTP secret, a
-- recovery-code blob. It is rejected for reasons that are specific rather than stylistic:
--
--   * A person may hold **several** second factors (a phone, a tablet, later a passkey), and
--     a column holds one. `user_mfa_factors` is a table because the plural is the real case.
--   * Recovery codes are **individually single-use**. A JSON blob of ten would have to be
--     rewritten to spend one, and two concurrent spends of two different codes would race and
--     lose one. A row per code makes spending an `UPDATE ... WHERE used_at IS NULL` that the
--     database serialises for us.
--   * `users` is read on paths that have nothing to do with authentication. A password hash
--     in that row is a password hash in every `SELECT *` that ever touches it, in every log
--     line that dumps a user, and in every future projection someone builds from it. Keeping
--     credentials in tables of their own means the accident has to be deliberate.
--
-- ## Not tenant-owned, like `users` and `sessions`
--
-- None of these tables carries an `organization_id`. A person is one account holding
-- memberships in many organizations; forking their password per tenant would mean a
-- compromise in one organization is not a compromise in the others, which sounds appealing
-- until you notice it also means revoking a credential in one does not revoke it in the
-- rest. They are registered in the tenant guard's NON_TENANT_TABLES list, so the omission is
-- a decision on the record rather than a gap the guard failed to notice.
--
-- ## Why `authentication_events` is not `audit_events`
--
-- §12 asks for denied sensitive attempts to be recorded, and a failed sign-in is the most
-- sensitive denial in the system. It cannot go in `audit_events`: that table's
-- `organization_id` is `NOT NULL` with a foreign key, and **authentication happens before any
-- tenant exists**. The person signing in has not chosen an organization yet — `ID-04` is the
-- screen where they do — and a failed attempt may not correspond to a user at all.
--
-- This is the gap `docs/implementation-status.md` has carried since the HTTP surface landed:
-- "denials before tenant resolution leave no audit row". Rather than widening `audit_events`
-- — loosening a NOT NULL on an append-only table so that half its rows answer a different
-- question from the other half — identity gets its own append-only log, beside the other
-- non-tenant identity tables. Two tables with one clear meaning each, rather than one table
-- with two.
--
-- ## The rate limiter this table also makes possible
--
-- `13-ENGINEERING-EXECUTION-SPEC` §1 assumes Redis for rate limits. There is no Redis here
-- and there will be none on the shared host, so the failure counter is a `COUNT(*)` over this
-- table within a window. That is a real limiter with real limitations, both recorded in
-- `docs/implementation-status.md`: it costs a query per attempt, and it counts per **user**
-- rather than per IP, so it stops credential stuffing against one account and does not stop
-- one attempt each against a thousand accounts.

-- ─────────────────────────────────────────────────────────────────────────────
-- Passwords
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per user, or none. `user_id` is the primary key rather than a surrogate with a
-- unique index on it: a second password for one person is not a state this system has, and
-- the key that says so is free.

CREATE TABLE user_passwords (
  user_id       CHAR(36)     NOT NULL,
  -- Argon2id in PHC string form: `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`. The salt and
  -- every cost parameter travel inside the value, which is what lets the cost be raised later
  -- without invalidating a single credential. 255 is ample: the current form is 97 characters.
  password_hash VARCHAR(255) NOT NULL,
  -- When the password was last set. Shown on the security screen and used by nothing else —
  -- in particular there is no expiry, because NIST 800-63B removed forced rotation and it is
  -- not being reintroduced here.
  set_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                             ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  CONSTRAINT fk_user_passwords_user
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Second factors
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE user_mfa_factors (
  id                    CHAR(36)     NOT NULL,
  user_id               CHAR(36)     NOT NULL,
  -- `totp` is the only kind implemented. The column exists so that adding `webauthn` is a new
  -- value rather than a new table, and it is a VARCHAR rather than an ENUM for the reason
  -- every other status column in this schema is: an ENUM change is an ALTER on a large table.
  kind                  VARCHAR(32)  NOT NULL,
  -- A human label — "iPhone", "Work laptop". Shown on ID-05 so a person can tell two factors
  -- apart before revoking one.
  label                 VARCHAR(190) NOT NULL,
  -- The base32 shared secret for `totp`. Stored recoverably, because TOTP verification needs
  -- the secret itself — there is no hash that would let the server compute the same code.
  -- That is a real property of the algorithm and the reason a passkey is the better
  -- credential: a WebAuthn public key is useless to whoever steals the database.
  secret                VARCHAR(255) NOT NULL,
  -- NULL until the person has proved they can produce a code from it. An unconfirmed factor
  -- authorises nothing and is not counted when deciding whether MFA is required — otherwise
  -- starting enrolment and closing the tab would lock the account.
  confirmed_at          DATETIME(3)  NULL,
  -- The RFC 6238 counter of the last accepted code, so the same code cannot be presented
  -- twice within its 90-second window. See `totp.ts` for why this column is the whole reason
  -- `verifyTotp` returns a counter rather than a boolean.
  last_accepted_counter BIGINT       NULL,
  last_used_at          DATETIME(3)  NULL,
  created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Soft-disabled rather than deleted: "this factor was removed on the 3rd" is a security
  -- question someone will ask, and a deleted row cannot answer it.
  disabled_at           DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY ix_user_mfa_factors_user (user_id, disabled_at),
  CONSTRAINT fk_user_mfa_factors_user
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Recovery codes
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per code, for the concurrency reason in the header. `batch_id` groups the ten
-- codes issued together so that "regenerating invalidates the old set immediately" — ID-05's
-- own words — is one UPDATE against a batch rather than a delete of unknown scope.

CREATE TABLE user_recovery_codes (
  id         CHAR(36)    NOT NULL,
  user_id    CHAR(36)    NOT NULL,
  batch_id   CHAR(36)    NOT NULL,
  -- SHA-256 hex of the normalised code. Not Argon2id, deliberately — `recovery-codes.ts`
  -- carries the reasoning: the code is 50 bits of randomness with no dictionary to run
  -- against it, and ten Argon2 verifications per attempt on a pre-authentication endpoint is
  -- a denial-of-service amplifier with a factor of ten built in.
  code_hash  CHAR(64)    NOT NULL,
  used_at    DATETIME(3) NULL,
  -- Set when a newer batch supersedes this one. Distinct from `used_at`: "spent" and
  -- "replaced" are different answers to "why did my code not work".
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- A hash is unambiguous across the whole table, not merely within one user's set. Two
  -- users cannot share a code by coincidence at 50 bits, and if they somehow did, one of them
  -- could sign in as the other.
  UNIQUE KEY uq_user_recovery_codes_hash (code_hash),
  KEY ix_user_recovery_codes_user (user_id, used_at, revoked_at),
  KEY ix_user_recovery_codes_batch (batch_id),
  CONSTRAINT fk_user_recovery_codes_user
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- The pre-tenant security log
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE authentication_events (
  id             CHAR(36)     NOT NULL,
  -- NULL when the attempt named an address no account holds. That row still matters: a burst
  -- of them from one source is enumeration, and it is the only trace of it.
  user_id        CHAR(36)     NULL,
  -- A closed vocabulary enforced in TypeScript, the same arrangement `audit_events.action`
  -- has and for the same reason: a column the database would let anyone spell any way is a
  -- column no query can be written against.
  action         VARCHAR(64)  NOT NULL,
  outcome        VARCHAR(16)  NOT NULL,
  -- The specific reason, from a closed list — `bad_password`, `no_such_user`, `mfa_replayed`.
  -- Recorded here and NEVER returned to the caller: the response says one thing for every
  -- failure so that an outsider cannot tell "no such account" from "wrong password", and this
  -- column is where the precision that the response drops is kept.
  reason         VARCHAR(64)  NULL,
  -- Present so a burst against many accounts is visible. Truncated to 45 characters, which
  -- fits an IPv6 address with an embedded IPv4 suffix.
  ip             VARCHAR(45)  NULL,
  user_agent     VARCHAR(255) NULL,
  correlation_id CHAR(36)     NULL,
  occurred_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The rate-limit query: failures for one user inside a window.
  KEY ix_authentication_events_user (user_id, occurred_at),
  KEY ix_authentication_events_occurred (occurred_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- No foreign key on `user_id`, and that is the one deliberate omission in this file.
--
-- A foreign key would forbid the row from outliving the user it names, and this log has to:
-- deleting an account must not erase the record of the attempts made against it, which is
-- exactly the evidence an incident review needs. `audit_events` makes the same trade for the
-- same reason.

-- ─────────────────────────────────────────────────────────────────────────────
-- Triggers — append-only
-- ─────────────────────────────────────────────────────────────────────────────
-- Same argument as `audit_events` and `session_refresh_tokens`: the log is the evidence, and
-- evidence that the application can rewrite is not evidence. The runtime user is additionally
-- granted INSERT and SELECT only, so the attempt cannot be made in the first place; the
-- triggers are the second layer, for whoever connects with a different credential.

DELIMITER $$

CREATE TRIGGER trg_authentication_events_no_update
BEFORE UPDATE ON authentication_events FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'authentication_events is append-only: a sign-in attempt is evidence';
END$$

CREATE TRIGGER trg_authentication_events_no_delete
BEFORE DELETE ON authentication_events FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'authentication_events is append-only: rows cannot be deleted';
END$$

DELIMITER ;
