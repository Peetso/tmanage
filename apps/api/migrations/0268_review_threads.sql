-- 0268_review_threads — the proofing viewer's comment threads (R4 slice 5; SPEC R4 §3.1).
--
-- A reviewer drops a numbered pin, draws a box or a stroke, marks a moment in a video, or picks a
-- spreadsheet cell, and writes a comment there; others reply, and the thread is resolved when the
-- change is made. One `review_threads` row is the pin and its place; `review_comments` are what
-- people said on it, oldest first.
--
-- ## What a thread row says
--
-- `(subject_type, subject_id)` is what the thread is about: `file_asset` names the ROOT asset of
-- an attachment version chain (or the asset itself when it has no chain), so a pin's number stays
-- the same from v1 to v3; `figma_frame` is reserved for the Figma slice. `file_version_id` is the
-- uploaded version the anchor was drawn on (NULL only for Figma frames).
--
-- `anchor_kind` / `anchor` place the thread, in numbers relative to the page or frame (0..1), so
-- a pin stays put at any screen size: `pin` {x,y}; `box` {x,y,w,h}; `draw` {strokes,bbox};
-- `time` {timeMs,x?,y?}; `cell` {sheet,cell}; `none` (no place — the old file comments).
-- `page_no` / `time_ms` copy the page and the moment out of the JSON so a list can filter on them.
-- Closed lists checked in the application (`review-threads.repository.ts`), as 0265 does.
--
-- `number` is the visible pin number, per subject, monotonic: the service takes MAX under a
-- FOR UPDATE lock and the unique key turns a lost race into a duplicate-key retry. A deleted
-- thread keeps its number (numbers are never reused).
--
-- `audience` is `internal` or `client_visible`. It is IMMUTABLE (trigger): an internal thread
-- never becomes visible to the client by an edit — that would publish its whole history. A new
-- thread is made instead.
--
-- `created_by_membership_id` is the author's membership — an internal `memberships` row or a
-- client `client_memberships` row (no foreign key: it names one of two tables).
--
-- ## Soft delete (PA-03, 0245)
--
-- Both tables carry `deleted_at`, `deleted_by_user_id`, `deleted_reason`, `purge_after`; the
-- worker's `--sweep-purge` removes rows past their window, comments before threads.
--
-- ## Backfill
--
-- Every live `file_comments` row (0199) becomes one thread with `anchor_kind = 'none'` and one
-- comment, numbered per subject in the order they were written. The thread's audience follows the
-- file's: `internal` stays internal, every client audience becomes `client_visible`. The thread
-- and its comment reuse the old comment's id (different tables), so the copy is traceable.
-- `file_comments` stays as it is, read-only from now on; a later cleanup migration drops it.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- CHAR(36) ids, `(organization_id, id)` unique, composite tenant foreign keys, DATETIME(3), JSON
-- columns without a default, no generated column, no CHECK, no functional index, a window
-- function (MariaDB 10.2+) only inside the one-off backfill, utf8mb4_unicode_ci.

CREATE TABLE review_threads (
  id                         CHAR(36)      NOT NULL,
  organization_id            CHAR(36)      NOT NULL,
  project_id                 CHAR(36)      NOT NULL,
  subject_type               VARCHAR(16)   NOT NULL,
  subject_id                 CHAR(36)      NOT NULL,
  file_version_id            CHAR(36)      NULL,
  anchor_kind                VARCHAR(8)    NOT NULL DEFAULT 'none',
  anchor                     JSON          NULL,
  page_no                    INT UNSIGNED  NULL,
  time_ms                    INT UNSIGNED  NULL,
  number                     INT UNSIGNED  NOT NULL,
  audience                   VARCHAR(16)   NOT NULL DEFAULT 'internal',
  status                     VARCHAR(10)   NOT NULL DEFAULT 'open',
  resolved_by_membership_id  CHAR(36)      NULL,
  resolved_at                DATETIME(3)   NULL,
  carried_from_thread_id     CHAR(36)      NULL,
  created_by_membership_id   CHAR(36)      NOT NULL,
  created_at                 DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                 DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at                 DATETIME(3)   NULL,
  deleted_by_user_id         CHAR(36)      NULL,
  deleted_reason             VARCHAR(500)  NULL,
  purge_after                DATETIME(3)   NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_review_threads_org_id (organization_id, id),
  -- One pin number per subject: two writers that took the same MAX collide here and retry.
  UNIQUE KEY uq_review_threads_number (organization_id, subject_type, subject_id, number),
  -- The viewer's read: one subject's threads, open first, oldest first.
  KEY ix_review_threads_subject (organization_id, subject_type, subject_id, status, created_at),
  -- "Threads drawn on this version" (compare, carry-forward).
  KEY ix_review_threads_version (organization_id, file_version_id),
  KEY ix_review_threads_project (organization_id, project_id),
  KEY ix_review_threads_org_deleted (organization_id, deleted_at),
  KEY ix_review_threads_purge (purge_after),
  CONSTRAINT fk_review_threads_project
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_review_threads_version
    FOREIGN KEY (organization_id, file_version_id) REFERENCES file_versions (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE review_comments (
  id                        CHAR(36)      NOT NULL,
  organization_id           CHAR(36)      NOT NULL,
  thread_id                 CHAR(36)      NOT NULL,
  body                      TEXT          NOT NULL,
  -- The user ids the comment mentions (`@<userId>` tokens and the picker's list), for notices.
  mentions                  JSON          NULL,
  created_by_membership_id  CHAR(36)      NOT NULL,
  created_at                DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  edited_at                 DATETIME(3)   NULL,
  deleted_at                DATETIME(3)   NULL,
  deleted_by_user_id        CHAR(36)      NULL,
  deleted_reason            VARCHAR(500)  NULL,
  purge_after               DATETIME(3)   NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_review_comments_org_id (organization_id, id),
  -- The thread is read oldest first.
  KEY ix_review_comments_thread (organization_id, thread_id, created_at, id),
  KEY ix_review_comments_org_deleted (organization_id, deleted_at),
  KEY ix_review_comments_purge (purge_after),
  CONSTRAINT fk_review_comments_thread
    FOREIGN KEY (organization_id, thread_id) REFERENCES review_threads (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- Backfill from file_comments (0199) ----
INSERT INTO review_threads (
  id, organization_id, project_id, subject_type, subject_id, file_version_id,
  anchor_kind, anchor, page_no, time_ms, number, audience, status,
  created_by_membership_id, created_at, updated_at
)
SELECT
  fc.id,
  fc.organization_id,
  fa.project_id,
  'file_asset',
  COALESCE(av.root_file_asset_id, fc.file_asset_id),
  (SELECT fv.id
     FROM file_versions fv
    WHERE fv.organization_id = fc.organization_id
      AND fv.file_asset_id = fc.file_asset_id
    ORDER BY fv.version_no DESC
    LIMIT 1),
  'none',
  NULL,
  NULL,
  NULL,
  ROW_NUMBER() OVER (
    PARTITION BY fc.organization_id, COALESCE(av.root_file_asset_id, fc.file_asset_id)
    ORDER BY fc.created_at, fc.id
  ),
  CASE fa.audience WHEN 'internal' THEN 'internal' ELSE 'client_visible' END,
  'open',
  fc.created_by,
  fc.created_at,
  fc.created_at
FROM file_comments fc
INNER JOIN file_assets fa
  ON fa.organization_id = fc.organization_id AND fa.id = fc.file_asset_id
LEFT JOIN attachment_versions av
  ON av.organization_id = fc.organization_id AND av.file_asset_id = fc.file_asset_id
WHERE fc.deleted_at IS NULL;

INSERT INTO review_comments (
  id, organization_id, thread_id, body, mentions, created_by_membership_id, created_at
)
SELECT fc.id, fc.organization_id, rt.id, fc.body, NULL, fc.created_by, fc.created_at
FROM file_comments fc
INNER JOIN review_threads rt
  ON rt.organization_id = fc.organization_id AND rt.id = fc.id;

DELIMITER $$

CREATE TRIGGER trg_review_threads_identity
BEFORE UPDATE ON review_threads FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.project_id <> OLD.project_id
     OR NEW.subject_type <> OLD.subject_type
     OR NEW.subject_id <> OLD.subject_id
     OR NOT (NEW.file_version_id <=> OLD.file_version_id)
     OR NEW.number <> OLD.number
     OR NOT (NEW.carried_from_thread_id <=> OLD.carried_from_thread_id)
     OR NEW.created_by_membership_id <> OLD.created_by_membership_id
     OR NEW.created_at <> OLD.created_at THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'review_threads identity columns are immutable';
  END IF;
  IF NEW.audience <> OLD.audience THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'review_threads.audience is immutable';
  END IF;
END$$

CREATE TRIGGER trg_review_comments_identity
BEFORE UPDATE ON review_comments FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.thread_id <> OLD.thread_id
     OR NEW.created_by_membership_id <> OLD.created_by_membership_id
     OR NEW.created_at <> OLD.created_at THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'review_comments identity columns are immutable';
  END IF;
END$$

DELIMITER ;
