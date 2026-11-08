-- 0319_invitation_pending_keys — B11: at most one open invitation per address per organization,
-- enforced by the database rather than by a read before the insert.
--
-- The issue path used to check "is there a pending invitation for this address?" and then
-- insert one. Two requests arriving together both passed the check and both inserted, so one
-- address could hold two live tokens. A unique key on `invitations` itself cannot say "unique
-- among the pending rows only" on MariaDB (no partial index, and the brief rules out a generated
-- column), so the claim lives in its own small table:
--
--   * one row per (organization, address) that currently has an open invitation;
--   * inserted in the same transaction as the invitation; the UNIQUE key makes the second of two
--     racing inserts wait for the first and then fail with a duplicate-key error, which the API
--     answers with the existing 409 `invitation_already_pending`;
--   * deleted when the invitation is accepted, revoked or expired by the API's sweep. The
--     worker's scheduled sweep holds no DELETE anywhere (users.sql), so a key left behind by an
--     invitation it expired — or by one whose date simply passed — is reclaimed by the next
--     issue for that address, after it checks that the invitation the key names is no longer
--     pending and in date.
--
-- ## Tenant keys
--
-- Composite foreign key on `(organization_id, invitation_id)`: a key can name only its own
-- tenant's invitation, and goes with it if the company erasure removes the invitation.
--
-- MariaDB-safe (Hostinger): plain columns, composite keys, no generated column, no CHECK, no
-- functional or partial index, no IF NOT EXISTS. Same charset and collation as `invitations`,
-- so the address compares exactly as `invitations.email` does.

CREATE TABLE invitation_pending_keys (
  organization_id  CHAR(36)     NOT NULL,
  email_normalized VARCHAR(320) NOT NULL,
  invitation_id    CHAR(36)     NOT NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (organization_id, invitation_id),
  UNIQUE KEY uq_ipk_email (organization_id, email_normalized),
  CONSTRAINT fk_ipk_invitation
    FOREIGN KEY (organization_id, invitation_id) REFERENCES invitations (organization_id, id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Back-fill: every invitation open right now claims its address. Where the old race already
-- produced two open invitations for one address, the newest (highest uuidv7 id) holds the key;
-- the older one still works until it is accepted, revoked or expires, and nothing new can be
-- issued for that address meanwhile.
INSERT INTO invitation_pending_keys (organization_id, email_normalized, invitation_id, created_at)
SELECT i.organization_id, i.email, i.id, current_timestamp(3)
  FROM invitations i
 WHERE i.status = 'pending'
   AND i.expires_at > current_timestamp(3)
   AND NOT EXISTS (
     SELECT 1
       FROM invitations n
      WHERE n.organization_id = i.organization_id
        AND n.email = i.email
        AND n.status = 'pending'
        AND n.expires_at > current_timestamp(3)
        AND n.id > i.id
   );
