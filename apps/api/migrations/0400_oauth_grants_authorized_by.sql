-- 0400_oauth_grants_authorized_by — the person who consented to a grant (plan 60 v2, 60-02, M3).
--
-- Plan 60 v2 §4.5: "The sponsor signs in and consents with 'works as: Mat'. The grant row is bound
-- to Mat's membership; `authorized_by_membership_id` records the human." For a person's own grant
-- the column stays NULL (the grant's `membership_id` is the person who consented); for a grant that
-- works as an AI employee it names the sponsor or the `ai_employee.manage` holder who bound it
-- (60-05). Shown on the AI employee's Connections tab and written to the audit row.
--
-- MariaDB-safe (DA-5): one plain nullable ADD COLUMN, no default expression, no generated column,
-- no IF NOT EXISTS. Online on both engines (DA-7). Expand only (DA-6). No new grant: the existing
-- table grants on `oauth_grants` cover it.

ALTER TABLE oauth_grants
  ADD COLUMN authorized_by_membership_id CHAR(36) NULL AFTER user_id,
  ALGORITHM=INPLACE, LOCK=NONE;
