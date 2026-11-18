-- 0373_person_mail — the person-mail engine's own state (EMAILBUILD2, amendment 2).
--
-- ## What this migration is for
--
-- 0371 made the people who sign tips, the (user, topic) assignment and the once-per-user tip log.
-- The engine that sends them needs three more facts:
--
-- - The per-user preference "Tips from the TManage team" reuses the existing per-kind preference
--   machinery (amendment 1: "do not build a second one"): `notification_kind_prefs.kind` gains
--   the value 'tips', the way 0207 added 'mention'. No row means on; a row with `enabled = 0`
--   stops every person mail to that member except the after-new-device security follow-up.
-- - `platform_feature_news` (GLOBAL, platform table): the release notes a platform admin writes on
--   the "Feature news" card (title and two sentences, English and Arabic, one link). `sent_at` is
--   set once, when the admin presses Send; from then on the hourly sweep delivers the note to every
--   team member with tips on, once per user (the `mail_tip_log` row `news:{id}` is the proof).
-- - `platform_person_mail_sweep` (GLOBAL, one row): where the round-robin sweep stopped, so each run
--   looks at the next at most 100 users and every user is looked at about once a day.
--
-- The platform switch "Tips and reminders" is the `platform_settings` row `mail.tips_enabled`
-- ('on' | 'off'; absent = on), written by the platform settings API; it needs no table.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns with literal defaults, DATETIME(3), no CHECK, no generated column, no JSON
-- function, no functional or partial index, no trigger. The ENUM change only appends a value
-- (an in-place change on MariaDB and MySQL), as 0207 did. 0371/0372 are not edited.

ALTER TABLE notification_kind_prefs
  MODIFY kind ENUM('client_request', 'work_item', 'message', 'file', 'mention', 'tips') NOT NULL;

CREATE TABLE platform_feature_news (
  id                 CHAR(36)     NOT NULL,
  title_en           VARCHAR(120) NOT NULL,
  title_ar           VARCHAR(120) NOT NULL,
  body_en            VARCHAR(400) NOT NULL,
  body_ar            VARCHAR(400) NOT NULL,
  link               VARCHAR(500) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_by_user_id CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL,
  sent_at            DATETIME(3)  NULL,
  sent_by_user_id    CHAR(36)     NULL,
  PRIMARY KEY (id),
  KEY ix_platform_feature_news_sent (sent_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE platform_person_mail_sweep (
  id             TINYINT     NOT NULL,
  cursor_user_id CHAR(36)    NULL,
  last_run_at    DATETIME(3) NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO platform_person_mail_sweep (id, cursor_user_id, last_run_at) VALUES (1, NULL, NULL);
