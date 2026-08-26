-- 0005_invitations — how somebody who is not yet in an organization gets into one (TEN-003).
--
-- Governing sources: 23-ERD-AND-STATE-MACHINES.md §9 ("`pending → accepted | expired |
-- revoked`. Tokens are single-use, hashed, and never recoverable. Role/scope change after
-- issuance revokes old invitation and issues a new one"), 12-PERMISSION-MATRIX.md §12
-- (invitations require audit), 22-SCREEN-BY-SCREEN-SPEC.md §3 ID-03 and ON-04/ON-06,
-- 04-SECURITY-PRIVACY.md §3.
--
-- ## One table for two destinations
--
-- An invitation ends in either a `memberships` row (internal) or a `client_memberships` row
-- (a client organization). It is one table because the *token* is the same object in both
-- cases — issued, mailed, single-use, expiring — and splitting it would mean two token
-- lifecycles, two expiry sweeps and two acceptance paths, three of which would eventually
-- disagree. `client_organization_id` is the discriminator: null means internal.
--
-- ## The token is never stored
--
-- `token_hash` holds SHA-256 of a 32-byte random token, hex-encoded. The token itself exists
-- once, in the response to the request that created it, and is then only in the invitee's
-- email. §9 says "never recoverable" and this is what makes that true rather than aspirational:
-- a database dump, a backup, or a support engineer reading the row cannot produce a working
-- link. Re-sending an invitation issues a *new* token, which is also why there is no "show me
-- the link again" endpoint to build later.
--
-- SHA-256 rather than Argon2id, and the difference from `user_passwords` is the point: a
-- password is low-entropy and chosen by a person, so it needs a slow hash to survive being
-- guessed. This token is 256 bits from a CSPRNG. There is nothing to guess, and a slow hash
-- on the acceptance path would only slow down the person accepting.
--
-- ## Why `email` and not `user_id`
--
-- The invitee usually does not have an account yet — that is what an invitation is for. The
-- address is the only thing the inviter knows. `accepted_by_user_id` records who actually
-- accepted, which is deliberately allowed to be an account whose address differs: a person
-- invited at work@example.com who signs in with an existing account is a real case, and
-- recording both facts is more honest than refusing it or pretending they are the same.
--
-- ## Status is a column, not an inference
--
-- `expired` could be derived from `expires_at < now()`, and is not. §9 makes expiry a state in
-- the machine, and a derived expiry would mean a revoked invitation whose date has passed
-- reads as "expired" — losing the fact that a person revoked it. The column records what
-- happened; `expires_at` records when it would happen on its own.

CREATE TABLE invitations (
  id                     CHAR(36)     NOT NULL,
  organization_id        CHAR(36)     NOT NULL,
  -- Null for an internal membership invitation; set for a client one.
  client_organization_id CHAR(36)     NULL,
  -- 320 is the maximum length of an email address (64 local + @ + 255 domain).
  email                  VARCHAR(320) NOT NULL,
  -- `memberships.role` and `client_memberships.role` are both VARCHAR(64); the vocabulary
  -- lives in `packages/domain`, which is the one place it can be checked exhaustively.
  role                   VARCHAR(64)  NOT NULL,
  -- SHA-256, hex. 64 characters, fixed.
  token_hash             CHAR(64)     NOT NULL,
  status                 ENUM('pending','accepted','expired','revoked')
                                      NOT NULL DEFAULT 'pending',
  expires_at             DATETIME(3)  NOT NULL,
  invited_by_user_id     CHAR(36)     NOT NULL,
  accepted_by_user_id    CHAR(36)     NULL,
  accepted_at            DATETIME(3)  NULL,
  revoked_at             DATETIME(3)  NULL,
  created_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_invitations_org_id (organization_id, id),
  -- The token is the lookup key on the acceptance path, and acceptance happens before any
  -- tenant context exists — so this index cannot include `organization_id`. It is unique
  -- across the whole table, which is what makes "find the invitation this token names" a
  -- single scoped read rather than a scan.
  UNIQUE KEY uq_invitations_token (token_hash),
  KEY ix_invitations_org_email (organization_id, email, status),
  KEY ix_invitations_expiry (status, expires_at),
  CONSTRAINT fk_invitations_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- Composite, including `organization_id`: an invitation into tenant A's client cannot name
  -- tenant B's client organization even if an application bug supplies both ids.
  CONSTRAINT fk_invitations_client_org_tenant
    FOREIGN KEY (organization_id, client_organization_id)
    REFERENCES client_organizations (organization_id, id),
  CONSTRAINT fk_invitations_invited_by
    FOREIGN KEY (invited_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_invitations_accepted_by
    FOREIGN KEY (accepted_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The tenant an invitation belongs to never changes, for the same reason it never changes on
-- any other tenant-owned row: an UPDATE that moved one would move a pending grant from one
-- customer to another, and no application code has a reason to do it.
DELIMITER $$

CREATE TRIGGER trg_invitations_org_immutable
BEFORE UPDATE ON invitations FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'invitations.organization_id is immutable';
  END IF;
  IF NEW.token_hash <> OLD.token_hash THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'invitations.token_hash is immutable; issue a new invitation instead';
  END IF;
END$$

DELIMITER ;
