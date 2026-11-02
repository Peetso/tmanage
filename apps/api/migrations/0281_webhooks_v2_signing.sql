-- 0281_webhooks_v2_signing — R13 slice 2 (54-03 + 56-08): outbound webhooks v2.
--
-- Signing, secret rotation, retries with a breaker, and a delivery-time egress guard. Additive: no
-- new table, new columns only on the two webhook tables of 0066 / 0097.
--
-- 1. `webhook_endpoints` gains what delivery needs:
--    - `description`, `events_json` (the subscribed kinds, a JSON array; backfilled from the single
--      legacy `event_kind`, which stays and stays pinned), `status` ('active' | 'paused' |
--      'needs_rotation'), `updated_at`;
--    - the secret at rest, encrypted by `@tmanage/domain/field-cipher` (purpose `webhook_secret`,
--      AAD owner = the endpoint id): `secret_enc`, and for the 24 h rotation overlap
--      `secret_prev_enc`, `secret_prev_hash`, `secret_rotated_at`, `secret_prev_expires_at`.
--      `secret_hash` keeps the SHA-256 of the current secret (its first 8 hex chars are the
--      signature key id a delivery row records);
--    - the breaker: `failure_streak` (consecutive failed attempts) and `paused_reason`.
--    A row registered before this migration has only a hash — it cannot be signed — so the backfill
--    sets `status = 'needs_rotation'`; an owner rotates it to get a secret the worker can use.
-- 2. `webhook_deliveries` becomes one row per attempt: `event_id`, `event_kind`, `attempt`,
--    `next_attempt_at` (the retry schedule; NULL once a row is settled), `duration_ms`,
--    `response_excerpt` (500 chars at most — never the request body, never a secret),
--    `signature_key_id`, `resolved_ip` (the address the delivery was pinned to), and
--    `ix_wd_next (organization_id, next_attempt_at)` for the retry sweep.
--
-- The 0066 column-pinning trigger is replaced: rotation must now change `secret_hash`, so the new
-- trigger pins the tenant, URL, legacy event kind, author and creation instant, and nothing else.
--
-- Grants (scripts/db/users.sql 0281 block): the app keeps INSERT, UPDATE on endpoints and INSERT on
-- deliveries (a manual retry / replay INSERTs a pending row); the worker gains SELECT, UPDATE on
-- `webhook_endpoints` (the breaker) and INSERT, UPDATE on `webhook_deliveries` (it settles attempts
-- and schedules the next one).
--
-- MariaDB 11.8 / MySQL 8 safe: no generated column, no IF NOT EXISTS on columns, no CHECK, no
-- expression default. `events_json` is TEXT without a default (MySQL refuses a literal TEXT default
-- and this schema refuses expression defaults), so it is added NULL, backfilled, then made NOT NULL;
-- the application always writes it.

ALTER TABLE webhook_endpoints
  ADD COLUMN description            VARCHAR(300) NULL AFTER url,
  ADD COLUMN events_json            TEXT         NULL AFTER event_kind,
  ADD COLUMN status                 VARCHAR(16)  NOT NULL DEFAULT 'active' AFTER enabled,
  ADD COLUMN secret_enc             TEXT         NULL AFTER secret_hash,
  ADD COLUMN secret_prev_enc        TEXT         NULL AFTER secret_enc,
  ADD COLUMN secret_prev_hash       CHAR(64)     NULL AFTER secret_prev_enc,
  ADD COLUMN secret_rotated_at      DATETIME(3)  NULL AFTER secret_prev_hash,
  ADD COLUMN secret_prev_expires_at DATETIME(3)  NULL AFTER secret_rotated_at,
  ADD COLUMN failure_streak         INT          NOT NULL DEFAULT 0 AFTER status,
  ADD COLUMN paused_reason          VARCHAR(200) NULL AFTER failure_streak,
  ADD COLUMN updated_at             DATETIME(3)  NULL AFTER created_at;

DROP TRIGGER IF EXISTS trg_webhook_endpoints_pin_columns;

-- Every pre-0281 endpoint subscribes to its one legacy kind, and holds no secret the worker can
-- read: it waits for a rotation before anything is delivered to it.
UPDATE webhook_endpoints
   SET events_json = CONCAT('["', event_kind, '"]'),
       status = 'needs_rotation'
 WHERE events_json IS NULL;

ALTER TABLE webhook_endpoints
  MODIFY COLUMN events_json TEXT NOT NULL;

ALTER TABLE webhook_deliveries
  ADD COLUMN event_id         CHAR(36)     NULL AFTER endpoint_id,
  ADD COLUMN event_kind       VARCHAR(64)  NULL AFTER event_id,
  ADD COLUMN attempt          INT          NOT NULL DEFAULT 1 AFTER status,
  ADD COLUMN next_attempt_at  DATETIME(3)  NULL AFTER attempted_at,
  ADD COLUMN duration_ms      INT          NULL AFTER next_attempt_at,
  ADD COLUMN response_excerpt VARCHAR(500) NULL AFTER response_code,
  ADD COLUMN signature_key_id VARCHAR(8)   NULL AFTER response_excerpt,
  ADD COLUMN resolved_ip      VARCHAR(45)  NULL AFTER signature_key_id,
  ADD KEY ix_wd_next (organization_id, next_attempt_at);

-- The tenant, the URL, the legacy event kind, the author and the creation instant are what an
-- endpoint is. Everything else — enabled, status, events, description, the secret columns and the
-- breaker — is maintained by the application (the app rotates and pauses; the worker trips the
-- breaker).
DELIMITER $$

CREATE TRIGGER trg_webhook_endpoints_pin_columns
BEFORE UPDATE ON webhook_endpoints FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'webhook_endpoints.organization_id is immutable';
  END IF;
  IF NEW.url <> OLD.url THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'webhook_endpoints.url is immutable';
  END IF;
  IF NEW.event_kind <> OLD.event_kind THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'webhook_endpoints.event_kind is immutable';
  END IF;
  IF NEW.created_by <> OLD.created_by THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'webhook_endpoints.created_by is immutable';
  END IF;
  IF NEW.created_at <> OLD.created_at THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'webhook_endpoints.created_at is immutable';
  END IF;
END$$

DELIMITER ;
