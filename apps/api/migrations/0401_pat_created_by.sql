-- 0401_pat_created_by — who created an agent key (plan 60 v2, 60-02, M4).
--
-- Plan 60 v2 §4.5: an agent key is a personal access token whose membership is the AI employee.
-- `created_by_membership_id` names the person who created it (the sponsor or an
-- `ai_employee.manage` holder, 60-05), because the token's own `membership_id` is the AI employee,
-- who can never create a key. NULL for a person's own token (the creator is the holder).
--
-- MariaDB-safe (DA-5): one plain nullable ADD COLUMN, no default expression, no generated column,
-- no IF NOT EXISTS. Online on both engines (DA-7). Expand only (DA-6). No new grant: the existing
-- table grants on `personal_access_tokens` (SELECT, INSERT, UPDATE) cover it.

ALTER TABLE personal_access_tokens
  ADD COLUMN created_by_membership_id CHAR(36) NULL AFTER membership_id,
  ALGORITHM=INPLACE, LOCK=NONE;
