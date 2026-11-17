-- 0371_mail_people — the people who sign TManage's tips and reminders (EMAILBUILD).
--
-- ## What this migration is for
--
-- Person mail (tips, feature news, security follow-ups, check-ins) is signed by a named member of
-- the TManage team; every other mail (codes, notifications, welcome, support) carries no person.
--
-- - `platform_mail_people` (GLOBAL, platform table): one row per person. `region` ('me' | 'west' |
--   'asia') and `topic` ('onboarding' | 'features' | 'news' | 'security' | 'success') say whom the
--   person writes to and about what; two people share each (region, topic). `languages` is 'en',
--   'ar' or 'en+ar'; Arabic mail uses `name_ar`. `address` is an alias on our own domain that
--   delivers into support@. Edited only by platform admins (audited). Seeded with the 30 people
--   below (INSERT IGNORE: re-running changes nothing).
-- - `mail_person_assignments` (TENANT): the person a user hears from on one topic, picked once
--   (the less-loaded of the pair) and kept, so the same person always writes to that user about
--   that subject.
-- - `mail_tip_log` (TENANT): each tip id is sent at most once per user, ever; `sent_at` also
--   answers the spacing rules (one person mail per 3 or 7 days).
--
-- Vocabularies are checked in code. No DELETE at runtime; the company erasure empties the two
-- tenant tables with every other tenant table.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns with literal defaults, DATETIME(3), no CHECK, no generated column, no JSON
-- function, no functional or partial index, no trigger. Additive only.

CREATE TABLE platform_mail_people (
  id          CHAR(36)     NOT NULL,
  name_en     VARCHAR(80)  NOT NULL,
  name_ar     VARCHAR(80)  NOT NULL,
  role_en     VARCHAR(80)  NOT NULL,
  role_ar     VARCHAR(80)  NOT NULL,
  address     VARCHAR(190) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  languages   VARCHAR(8)   NOT NULL DEFAULT 'en',
  region      VARCHAR(8)   NOT NULL,
  topic       VARCHAR(16)  NOT NULL,
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME(3)  NOT NULL,
  updated_at  DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_platform_mail_people_address (address),
  KEY ix_platform_mail_people_pick (region, topic, active)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE mail_person_assignments (
  organization_id CHAR(36)    NOT NULL,
  user_id         CHAR(36)    NOT NULL,
  topic           VARCHAR(16) NOT NULL,
  person_id       CHAR(36)    NOT NULL,
  assigned_at     DATETIME(3) NOT NULL,
  PRIMARY KEY (organization_id, user_id, topic),
  KEY ix_mail_person_assignments_person (person_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE mail_tip_log (
  organization_id CHAR(36)    NOT NULL,
  user_id         CHAR(36)    NOT NULL,
  tip_id          VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sent_at         DATETIME(3) NOT NULL,
  PRIMARY KEY (organization_id, user_id, tip_id),
  KEY ix_mail_tip_log_user_sent (organization_id, user_id, sent_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO platform_mail_people
  (id, name_en, name_ar, role_en, role_ar, address, languages, region, topic, active, created_at, updated_at)
VALUES
  ('2dbead98-c9ab-5e36-8ed3-a6531ed14554', 'Mariam', 'مريم', 'onboarding', 'تهيئة العملاء', 'mariam@tmanageapp.com', 'en+ar', 'me', 'onboarding', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('f3a19591-23c5-5a67-ad36-1855fe460a0c', 'Youssef', 'يوسف', 'onboarding', 'تهيئة العملاء', 'youssef@tmanageapp.com', 'en+ar', 'me', 'onboarding', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('939b9670-fb27-508f-84ef-03ef269f3425', 'Emma', 'إيما', 'onboarding', 'تهيئة العملاء', 'emma@tmanageapp.com', 'en', 'west', 'onboarding', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('5dcd450d-2ec0-5071-a34c-7b5448275e16', 'Daniel', 'دانيال', 'onboarding', 'تهيئة العملاء', 'daniel@tmanageapp.com', 'en', 'west', 'onboarding', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('6d9c6d21-fd4c-50c6-89c3-2fc46bddf2c0', 'Priya', 'بريا', 'onboarding', 'تهيئة العملاء', 'priya@tmanageapp.com', 'en', 'asia', 'onboarding', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('db84bfbf-121c-5bd9-a26f-7c1aafc171c6', 'Kenji', 'كينجي', 'onboarding', 'تهيئة العملاء', 'kenji@tmanageapp.com', 'en', 'asia', 'onboarding', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('28d9a9b5-ad6f-5c0f-abc4-7a93a369de48', 'Layla', 'ليلى', 'product specialist', 'أخصائي المنتج', 'layla@tmanageapp.com', 'en+ar', 'me', 'features', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('b723b250-55c5-51f4-a633-380110e1aeaa', 'Karim', 'كريم', 'product specialist', 'أخصائي المنتج', 'karim@tmanageapp.com', 'en+ar', 'me', 'features', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('7f16dae8-ab2e-54f2-98f7-6f8bcdbc4a94', 'Sophie', 'صوفي', 'product specialist', 'أخصائي المنتج', 'sophie@tmanageapp.com', 'en', 'west', 'features', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('91536424-f947-55de-84d6-d01c4487bcba', 'Lucas', 'لوكاس', 'product specialist', 'أخصائي المنتج', 'lucas@tmanageapp.com', 'en', 'west', 'features', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('d18113e1-e002-5801-a06b-cd4b03a87c8a', 'Mei', 'مي', 'product specialist', 'أخصائي المنتج', 'mei@tmanageapp.com', 'en', 'asia', 'features', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('b52a9fda-0636-5e68-b99c-0d8b71d00d87', 'Arjun', 'أرجون', 'product specialist', 'أخصائي المنتج', 'arjun@tmanageapp.com', 'en', 'asia', 'features', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('580533c4-d8a3-5c5b-aa9c-5be382a3f2ee', 'Nour', 'نور', 'product updates', 'مستجدات المنتج', 'nour@tmanageapp.com', 'en+ar', 'me', 'news', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('14a53285-d5b7-569e-accc-9361a7d02a42', 'Tarek', 'طارق', 'product updates', 'مستجدات المنتج', 'tarek@tmanageapp.com', 'en+ar', 'me', 'news', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('00718741-6404-5aad-9a2b-5b850965cd03', 'Olivia', 'أوليفيا', 'product updates', 'مستجدات المنتج', 'olivia@tmanageapp.com', 'en', 'west', 'news', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('d0468986-0a28-5518-8d03-c1cc9ae7acd7', 'James', 'جيمس', 'product updates', 'مستجدات المنتج', 'james@tmanageapp.com', 'en', 'west', 'news', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('5fc10128-31c6-5aca-a9ab-b70c95cd5f10', 'Aiko', 'أيكو', 'product updates', 'مستجدات المنتج', 'aiko@tmanageapp.com', 'en', 'asia', 'news', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('3038757c-b938-588f-981e-372890450de1', 'Rahul', 'راهول', 'product updates', 'مستجدات المنتج', 'rahul@tmanageapp.com', 'en', 'asia', 'news', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('a75b0333-5308-5cab-86d4-056cc6060361', 'Hana', 'هنا', 'account security', 'أمان الحسابات', 'hana@tmanageapp.com', 'en+ar', 'me', 'security', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('300dfbad-a33e-5b1b-a2df-88971818fc27', 'Omar', 'عمر', 'account security', 'أمان الحسابات', 'omar@tmanageapp.com', 'en+ar', 'me', 'security', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('51773621-f357-54ac-9674-cf6039122a00', 'Grace', 'غريس', 'account security', 'أمان الحسابات', 'grace@tmanageapp.com', 'en', 'west', 'security', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('72213092-e79d-5387-a599-2f9f7016f210', 'Liam', 'ليام', 'account security', 'أمان الحسابات', 'liam@tmanageapp.com', 'en', 'west', 'security', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('fe841b71-a178-5596-88e7-0880018c3a97', 'Ananya', 'أنانيا', 'account security', 'أمان الحسابات', 'ananya@tmanageapp.com', 'en', 'asia', 'security', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('cfa1a85c-6f2b-5b70-8152-76c411c6920a', 'Wei', 'وي', 'account security', 'أمان الحسابات', 'wei@tmanageapp.com', 'en', 'asia', 'security', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('3c11bf9e-6bd0-59c9-9f98-56f2aaa54399', 'Salma', 'سلمى', 'customer success', 'نجاح العملاء', 'salma@tmanageapp.com', 'en+ar', 'me', 'success', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('e73832d7-cd91-5bf8-9c7f-a3e61aa75899', 'Ziad', 'زياد', 'customer success', 'نجاح العملاء', 'ziad@tmanageapp.com', 'en+ar', 'me', 'success', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('cbbad6da-1726-5db6-b285-2f1f97a5ebc7', 'Chloe', 'كلوي', 'customer success', 'نجاح العملاء', 'chloe@tmanageapp.com', 'en', 'west', 'success', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('7113ea73-1bda-515f-b0cd-a4bafc3719e9', 'Mateo', 'ماتيو', 'customer success', 'نجاح العملاء', 'mateo@tmanageapp.com', 'en', 'west', 'success', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('25e56c13-d124-5a57-bc55-8ff592e716dc', 'Sana', 'سنا', 'customer success', 'نجاح العملاء', 'sana@tmanageapp.com', 'en', 'asia', 'success', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000'),
  ('ad9ca872-5c3e-5182-9a9b-b61a748ab239', 'Minh', 'مينه', 'customer success', 'نجاح العملاء', 'minh@tmanageapp.com', 'en', 'asia', 'success', 1, '2026-11-18 00:00:00.000', '2026-11-18 00:00:00.000');
