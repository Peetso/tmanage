-- 0022_notification_preferences — how one person, in one studio, wants to be told (NOTIF-001).
--
-- Governing sources: 24-EVENT-CATALOG.md (the notification-triggering events name
-- `bundler/preferences` among their consumers; §2 names the two delivery channels this
-- system has — the durable email path and the realtime/in-app projection) and
-- 22-SCREEN-BY-SCREEN-SPEC.md TM-27 Preferences, which enumerates the settings this table
-- stores in exactly these words: "notification channels, quiet hours, digest".
--
-- NOTIF-001's first half deliberately built the notification record without preferences,
-- because `contracts/tmanage-core.dbml` drew no table and "building one would outrun the
-- contract" (docs/implementation-status.md). This slice is the contract decision that half
-- was waiting on: the storage those preferences live in. It stores the settings; it does not
-- yet honour them — the bundler/relay reading this table to suppress or defer a delivery is a
-- later slice, recorded as out of scope in the status doc.
--
-- ## One row per person per studio
--
-- A person holds memberships in several organizations and may want different settings in
-- each, so the row is keyed by `(organization_id, user_id)` — tenant-owned like every other
-- grant, and registered in the query guard's `TENANT_TABLES`. `user_id` references the global
-- `users` table (identity is global, `notifications.recipient_user_id` is the same choice):
-- a preference outlives a membership being revoked and re-granted, which is why it is not
-- keyed to `membership_id`.
--
-- ## Defaults live on the columns, and absence is a default too
--
-- Every channel is on by default and the digest is off (immediate, not batched), so a person
-- who has never opened the settings screen is reachable on both channels. The read path
-- returns the same defaults when no row exists at all (the service's `DEFAULT_NOTIFICATION_
-- PREFERENCES`), so "never saved" and "saved the defaults" are one behaviour, not two.
--
-- ## Quiet hours are stored, not applied
--
-- `quiet_hours_start`/`_end` are wall-clock times in `quiet_hours_timezone`; all three are
-- nullable and null means "no quiet hours". They are the columns INBOX-001 needs and were
-- asked for by this slice's brief; nothing in this slice reads them, and the deferral is in
-- the status doc. A TIME is the local time of day only — the timezone it is read in is its
-- own column, because a studio's people are not all in one zone.

CREATE TABLE notification_preferences (
  id                    CHAR(36)     NOT NULL,
  organization_id       CHAR(36)     NOT NULL,
  -- The global user, not a membership — see the header. One person's setting in this studio.
  user_id               CHAR(36)     NOT NULL,
  -- The two delivery channels 24 §2 has: the durable email path and the in-app/realtime
  -- projection. Booleans, on by default, because an account that opted into nothing would be
  -- an account told nothing — the safe default for being reached is "reachable".
  in_app_enabled        BOOLEAN      NOT NULL DEFAULT TRUE,
  email_enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
  -- TM-27's "digest". `off` is immediate delivery (no batching); `daily`/`weekly` are the
  -- bundling windows a later slice's bundler will read. ENUM because the vocabulary is closed
  -- and small, and a new window is a deliberate schema change rather than a stray string.
  digest_frequency      ENUM('off','daily','weekly') NOT NULL DEFAULT 'off',
  -- Quiet hours — stored by this slice, honoured by INBOX-001. Wall-clock local time in the
  -- zone below; all nullable, and null is "no quiet hours".
  quiet_hours_start     TIME         NULL,
  quiet_hours_end       TIME         NULL,
  quiet_hours_timezone  VARCHAR(64)  NULL,
  created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The composite tenant-unique every table in this schema carries: the target a composite
  -- foreign key including `organization_id` (ADR-0001 layer 1) would point at.
  UNIQUE KEY uq_notification_preferences_org_id (organization_id, id),
  -- One row per person per studio. This is the upsert key: the read/upsert repository writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
  UNIQUE KEY uq_notification_preferences_org_user (organization_id, user_id),
  CONSTRAINT fk_notification_preferences_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_notification_preferences_user
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
