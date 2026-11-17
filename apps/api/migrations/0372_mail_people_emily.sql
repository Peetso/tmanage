-- 0372_mail_people_emily — rename one seeded person (EMAILBUILD).
--
-- The mail host refuses the mailbox name "emma", so the seeded onboarding person for the west
-- region is Emily (إيميلي), emily@tmanageapp.com. 0371 is applied and never edited; this changes
-- the one seeded row in place, only while it still holds the old address (an admin's later edit
-- is left alone). Assignments keep pointing at the same id, so users keep the same person.
--
-- MariaDB-safe: one plain UPDATE with literal values; no DDL.

UPDATE platform_mail_people
   SET name_en = 'Emily',
       name_ar = 'إيميلي',
       address = 'emily@tmanageapp.com',
       updated_at = '2026-11-18 00:00:00.000'
 WHERE id = '939b9670-fb27-508f-84ef-03ef269f3425'
   AND address = 'emma@tmanageapp.com';
