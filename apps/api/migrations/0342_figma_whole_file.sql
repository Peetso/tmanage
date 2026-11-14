-- 0342_figma_whole_file — a Figma link brings in the whole file (Peter, 2026-11-10: "in figma
-- it's not capturing the whole page with all its frames!!! why??").
--
-- Before: a link held at most 20 frames the member picked by hand, read from the file at depth 2
-- (frames inside a section were never seen). Now a link lists every frame of every page, sections
-- walked, and captures up to 250 of them in the background, most relevant first.
--
-- figma_links
--   capture_mode      'whole_file' (every frame) or 'picked' (only some frames, the old way;
--                     every link made before this migration).
--   focus_node_id     the frame or page the pasted link pointed at: the viewer opens there and it
--                     is captured first.
--   outline_json      the pages ([{id, name}]) and whether the outline was cut short; written at
--                     attach and on every "Refresh from Figma".
--   page_filter_json  the pages the team chose to capture when the file has more frames than one
--                     link captures (a JSON list of page ids), or NULL for "all pages".
--   synced_at         when the outline was last read from Figma.
-- figma_frames
--   page_id, page_name  the Figma page the frame is on (NULL: a nested frame named by its link).
--   section_name        the section(s) it sits in, outermost first, or NULL.
--   pos_x, pos_y        where it sits on the page's canvas (the whole-page view lays frames out).
--   capture_rank        the order the snapshot job captures in (linked frame, its page, the rest).
--   gone_at             the frame was not in Figma at the last refresh. The row and its comment
--                       threads stay; the viewer says "Removed in Figma".
--   has_thumb           a small picture of the snapshot is stored (the whole-page view).
--   snapshot_error      why the last capture failed, as a short token the team's screen words
--                       (no_connection, no_access, not_found, too_large, unreachable).
-- snapshot_status gains 'skipped': listed, but beyond what the link captures.
--
-- MariaDB-safe: plain ADD COLUMN (VARCHAR, INT, TEXT, DATETIME, TINYINT), no CHECK, no generated
-- column, no JSON functions.

ALTER TABLE figma_links
  ADD COLUMN capture_mode VARCHAR(16) NOT NULL DEFAULT 'picked',
  ADD COLUMN focus_node_id VARCHAR(64) NULL,
  ADD COLUMN outline_json TEXT NULL,
  ADD COLUMN page_filter_json TEXT NULL,
  ADD COLUMN synced_at DATETIME(3) NULL;

ALTER TABLE figma_frames
  ADD COLUMN page_id VARCHAR(64) NULL,
  ADD COLUMN page_name VARCHAR(300) NULL,
  ADD COLUMN section_name VARCHAR(300) NULL,
  ADD COLUMN pos_x INT NULL,
  ADD COLUMN pos_y INT NULL,
  ADD COLUMN capture_rank INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN gone_at DATETIME(3) NULL,
  ADD COLUMN has_thumb TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN snapshot_error VARCHAR(32) NULL;
