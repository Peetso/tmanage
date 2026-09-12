-- 0020_credential_change_notices — the notice that tells the account holder, unprompted,
-- that their own credentials changed (`D05d`).
--
-- Governing sources: 24-EVENT-CATALOG §2 ("Producer writes state and outbox event
-- atomically") and §3 step 8; 22-SCREEN-BY-SCREEN-SPEC `ID-05` ("security event receipt");
-- migration 0004 (the credential tables and the append-only `authentication_events`);
-- migration 0002 (`outbox_events`, whose column shape this table copies deliberately);
-- ADR-0001 layer 3 (the tenant guard, and why this table cannot be `outbox_events`).
--
-- ## Why this is not a row in `outbox_events`
--
-- It should have been. `outbox_events` is the transactional outbox and every notification
-- in this system leaves through it, so the first design wrote one there. It cannot be
-- done, and the reason is structural rather than stylistic:
--
--   * `outbox_events.organization_id` is `NOT NULL` with a foreign key to `organizations`.
--     A credential is *not* tenant-owned — migration 0004's header says why at length: one
--     person is one account holding memberships in many organizations, so a password
--     revoked in one tenant cannot still work in the rest. A credential change therefore
--     has no organization to name, and naming an arbitrary one of the owner's memberships
--     would be a fiction that `ix_outbox_events_org_aggregate` then indexes.
--   * The credential routes run on the identity path, before any organization is resolved.
--     `makeIdentityRunner` (apps/api/src/common/database/tenant-context.ts) refuses *any*
--     statement mentioning a tenant table, unconditionally and in both guard modes. An
--     identity transaction physically cannot write `outbox_events`, so a notice written
--     there could not share the transaction that is the whole point of the pattern.
--
-- So this is the same pattern with the tenant column removed: an append-and-drain queue
-- whose rows are written by the transaction that caused them, claimed by the relay, and
-- stamped when delivered. Every column below has the same meaning as its namesake in
-- `outbox_events`, and `apps/api/migrations/0002_platform_primitives.sql` carries the
-- argument for each.
--
-- ## What a notice carries: a reference, never a secret and never content
--
-- The person, what changed, and when. No password, no seed, no recovery code, no address
-- and no user agent — the same rule as `notifications` in 0010, with one addition of its
-- own: the relay credential is deliberately denied every other credential table
-- (`scripts/db/users.sql`, and `least-privilege.db.test.ts` pins the denial), so a queue it
-- *can* read must not reintroduce what those tables hold. `action` is the closed vocabulary
-- of `authentication_events.action`, restricted further to the four that change something.
--
-- The address that made the change is deliberately absent even though the log beside it
-- holds one: the notice is delivered to the owner's mailbox, and an intruder who can read
-- that mailbox would otherwise be handed the addresses the owner signs in from.

CREATE TABLE credential_change_notices (
  id             CHAR(36)      NOT NULL,
  -- NOT NULL and a foreign key, unlike `authentication_events.user_id`. That log records
  -- attempts that name no account and must outlive the account they name; this is a
  -- delivery queue for a live person, and an undeliverable notice is not evidence.
  user_id        CHAR(36)      NOT NULL,
  -- `password_set`, `mfa_factor_enrolled`, `mfa_factor_disabled`, `recovery_codes_issued`.
  -- A closed vocabulary in TypeScript (`CREDENTIAL_CHANGE_ACTIONS`), the same arrangement
  -- `authentication_events.action` and `audit_events.action` have, for the same reason.
  action         VARCHAR(64)   NOT NULL,
  -- The request that changed the credential is the request that caused the notice.
  correlation_id CHAR(36)      NULL,
  occurred_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Redelivery backoff, separate from `occurred_at` so a retry never rewrites history.
  available_at   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at   DATETIME(3)   NULL,
  attempts       INT UNSIGNED  NOT NULL DEFAULT 0,
  last_error     VARCHAR(1000) NULL,
  PRIMARY KEY (id),
  -- The relay's claim index, leading with `published_at` so the undelivered tail stays
  -- small and contiguous — `ix_outbox_events_unpublished`'s shape and its reasoning.
  KEY ix_credential_change_notices_unpublished (published_at, available_at),
  -- "What was this person told, and when" — the support question, and the read a future
  -- bundler needs before it can widen a key.
  KEY ix_credential_change_notices_user (user_id, occurred_at),
  CONSTRAINT fk_credential_change_notices_user
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
