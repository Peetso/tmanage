-- 0215_member_profile_job_title — the member's own job title for Profile & preferences (t2-b).
--
-- The Profile & preferences screen lets a member edit their own name and job title. The name has a
-- home (`users.display_name`, the person's own identity); a job title had none. It is tenant-local —
-- the same person can be "Art director" in one studio and "Freelance illustrator" in another — so it
-- belongs beside the other per-studio member fields in `member_profiles` (0094), not on the global
-- users row. No new table: one nullable column on the existing tenant-scoped store.
--
-- NULL means "not set" (every row before this migration, and every member who never saves one).
-- Bounded at 120 characters so an oversize value is a 400 the route refuses, never a truncated store.
-- Plain ADD COLUMN, no CHECK and no generated column: the live host is MariaDB, and this schema keeps
-- to the syntax both engines read the same way. The admin profile upsert (x216) updates only its own
-- four fields on a duplicate key, so it never clears a title the member set.

ALTER TABLE member_profiles
  ADD COLUMN job_title VARCHAR(120) NULL AFTER user_id;
