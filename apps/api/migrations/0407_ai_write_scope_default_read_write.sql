-- 0407_ai_write_scope_default_read_write — the in-app AI may make changes by default.
--
-- Owner rule 2026-11-23 (ADR-0015): "the AI should do anything that I can do". A new workspace's
-- AI started on 'read' (answer only), so every change request was refused until an owner found the
-- switch. The default is now 'read_write': every change is still shown on a card first and runs
-- only when the member confirms it; the owner can still choose "Answer questions only".
--
-- Rows an owner never saved (updated_by_membership_id is null: written by the platform's own
-- upserts, the retention setting or the credit packs) move to 'read_write' too. A row an owner saved
-- keeps the owner's choice. 0383 is shipped and is not edited (DA-4).
--
-- MariaDB-safe: a literal ENUM default and a plain UPDATE; no CHECK, no generated column.

ALTER TABLE ai_workspace_settings
  MODIFY COLUMN write_scope ENUM('read', 'read_write') NOT NULL DEFAULT 'read_write';

UPDATE ai_workspace_settings
   SET write_scope = 'read_write'
 WHERE write_scope = 'read'
   AND updated_by_membership_id IS NULL;
