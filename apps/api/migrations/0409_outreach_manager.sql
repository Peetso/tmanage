-- 0409_outreach_manager — Platform admin -> Outreach as a campaign manager (owner 2026-11-23:
-- "view/edit the email, add new emails or remove or edit emails, add different campaigns and
-- more options to give me wide control over it").
--
-- ## What this migration is for
--
-- - `outreach_campaigns` gains its own settings: `languages` (comma list of site languages, the
--   first is the default), `sender_pool` (`auto` = every active person of E-mail people, split by
--   language; `chosen` = the rows of `outreach_campaign_senders`), the pace (`daily_cap` 1-20 per
--   mailbox, `warmup` 5 / 10 / then the cap), the optional follow-up (`followup_enabled`, off by
--   default; `followup_days` working days after the first mail) and `archived_at` (an archived
--   campaign is hidden from the active list and cannot start).
-- - `outreach_email_versions` (GLOBAL): every save of a campaign's e-mail is a new version, one
--   row per language (`kind` `intro` or `followup`). The worker sends the newest version at the
--   moment a mail leaves and stamps it on the recipient (`intro_version` / `followup_version`),
--   so a version that went out is never changed: a later save is a new number.
-- - `outreach_campaign_senders` (GLOBAL): the chosen sending people of a `chosen` campaign.
-- - `outreach_recipients` gains the follow-up state (`followup_status` NULL / sending / sent /
--   failed / skipped, `followup_sent_at`, `followup_version`, `followup_error`), the version of
--   the first mail (`intro_version`), `replied_at` (marked by an admin: replies land in the
--   sender's own mailbox, which TManage does not read) and `walkthrough_at` (stamped once by a
--   "Book a walkthrough" request that carries the recipient's signed invite).
-- - Every campaign that existed before gets the current default text (packages/mail
--   `DEFAULT_CAMPAIGN_EMAILS`, English and Arabic, introduction and follow-up) as version 1, so
--   "Decision-makers intro 2026-11" keeps working unchanged. `outreach-manager.test.ts` fails if
--   the text below and the package's default drift apart.
--
-- Grants (scripts/db/users.sql 0409 block): app INSERT on the versions; INSERT, DELETE on the
-- senders; DELETE on `outreach_recipients` (a recipient can be removed only while queued; the
-- address goes with the row). Worker SELECT on the versions and the senders.
--
-- ## MariaDB-safe (DA-5; live is MariaDB 11.8)
--
-- Plain columns with literal defaults, DATETIME(3), TEXT without a default, VARCHAR vocabularies
-- checked in code, no CHECK, no generated column, no JSON column, no functional index, no
-- trigger, no foreign key, no IF NOT EXISTS (0400's form). The ALTERs are online on both engines
-- (ALGORITHM=INPLACE, LOCK=NONE; DA-7) and expand only (DA-6). The seed statements are data
-- statements (one transaction each with the ledger counter) guarded by NOT EXISTS, so a re-run
-- after a kill inserts nothing twice (DA-8).

ALTER TABLE outreach_campaigns
  ADD COLUMN languages VARCHAR(64) NOT NULL DEFAULT 'en',
  ADD COLUMN sender_pool VARCHAR(16) NOT NULL DEFAULT 'auto',
  ADD COLUMN daily_cap TINYINT UNSIGNED NOT NULL DEFAULT 20,
  ADD COLUMN warmup TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN followup_enabled TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN followup_days TINYINT UNSIGNED NOT NULL DEFAULT 4,
  ADD COLUMN archived_at DATETIME(3) NULL,
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE outreach_recipients
  ADD COLUMN intro_version INT UNSIGNED NULL,
  ADD COLUMN followup_status VARCHAR(16) NULL,
  ADD COLUMN followup_sent_at DATETIME(3) NULL,
  ADD COLUMN followup_version INT UNSIGNED NULL,
  ADD COLUMN followup_error VARCHAR(64) NULL,
  ADD COLUMN replied_at DATETIME(3) NULL,
  ADD COLUMN walkthrough_at DATETIME(3) NULL,
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE outreach_recipients
  ADD KEY ix_outreach_recipients_followup (campaign_id, status, followup_status),
  ADD KEY ix_outreach_recipients_followup_sender (sender_person_id, followup_sent_at),
  ALGORITHM=INPLACE, LOCK=NONE;

CREATE TABLE outreach_email_versions (
  id           CHAR(36)     NOT NULL,
  campaign_id  CHAR(36)     NOT NULL,
  kind         VARCHAR(16)  NOT NULL,
  version      INT UNSIGNED NOT NULL,
  language     VARCHAR(8)   NOT NULL,
  subject      VARCHAR(200) NOT NULL,
  body         TEXT         NOT NULL,
  created_by   CHAR(36)     NULL,
  created_at   DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_outreach_email_versions (campaign_id, kind, version, language)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE outreach_campaign_senders (
  campaign_id  CHAR(36)     NOT NULL,
  person_id    CHAR(36)     NOT NULL,
  created_at   DATETIME(3)  NOT NULL,
  PRIMARY KEY (campaign_id, person_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Version 1 = the default text, for every campaign that already exists.

INSERT INTO outreach_email_versions
  (id, campaign_id, kind, version, language, subject, body, created_by, created_at)
SELECT UUID(), c.id, 'intro', 1, 'en',
  'Client approvals without the email chase',
  'Hi {first name},

I''m {sender name} from TManage. We build a project and client-approval tool for agencies and studios like {company}.

Most teams we talk to run projects in one tool, chat in another, and chase client sign-off by email. TManage puts it in one place:

- Clients approve each version in their own portal. Every approval is tied to the exact file, with a certificate.
- Tasks, timelines, workload and time tracking for the team.
- Team chat that turns any message into a task or a recorded decision.
- Invoices from tracked time.

- Fully localized: English, Arabic, French, Spanish, German, Portuguese, Chinese and Urdu.

Coming in the next 1-2 months:

- AI employees you invite like teammates, who take on tasks and hand in the work.
- A sales pipeline and contracts.
- A help desk for client requests.
- HR and purchasing.

It''s free while we''re in beta, and your team keeps it free for 3 more months after the beta ends. Your workspace is ready here, with no card needed:
{trial link}

If a 20-minute walkthrough would help, pick a time that suits you:
{walkthrough link}

Best,
{sender name}
TManage · tmanageapp.com',
  NULL, UTC_TIMESTAMP(3)
  FROM outreach_campaigns c
 WHERE NOT EXISTS (SELECT 1 FROM outreach_email_versions v
                    WHERE v.campaign_id = c.id AND v.kind = 'intro' AND v.language = 'en');

INSERT INTO outreach_email_versions
  (id, campaign_id, kind, version, language, subject, body, created_by, created_at)
SELECT UUID(), c.id, 'intro', 1, 'ar',
  'موافقات العملاء دون ملاحقة عبر البريد',
  'مرحباً {first name}،

أنا {sender name} من TManage. نحن نطوّر أداة لإدارة المشاريع وموافقات العملاء، مصممة للوكالات واستوديوهات التصميم وشركات البرمجة مثل {company}.

معظم الفرق التي نتحدث معها تدير مشاريعها في أداة، وتتواصل في أداة أخرى، وتلاحق موافقة العميل عبر البريد. يجمع TManage ذلك كله في مكان واحد:

- يعتمد العميل كل نسخة من بوابته الخاصة، وكل موافقة مرتبطة بالملف نفسه مع شهادة توثّقها.
- مهام وجداول زمنية وتوزيع للعمل وتتبع للوقت لفريقك.
- محادثات للفريق، يمكن تحويل أي رسالة فيها إلى مهمة أو قرار موثّق.
- فواتير من الوقت المسجّل.
- النظام مترجم بالكامل: العربية والإنجليزية والفرنسية والإسبانية والألمانية والبرتغالية والصينية والأردية.

قريباً، خلال الشهر أو الشهرين القادمين:

- موظفون بالذكاء الاصطناعي تدعونهم مثل أي عضو في الفريق، يستلمون المهام ويسلّمون العمل.
- مسار للمبيعات والعقود.
- مكتب دعم لطلبات العملاء.
- الموارد البشرية والمشتريات.

الاستخدام مجاني طوال الفترة التجريبية، ويبقى مجانياً لفريقكم 3 أشهر إضافية بعد انتهائها. مساحة عملكم جاهزة من هنا دون بطاقة دفع:
{trial link}

وإذا رغبتم في جولة تعريفية مدتها 20 دقيقة مع أحد أعضاء فريقنا، اختاروا الموعد المناسب:
{walkthrough link}

مع خالص التحية،
{sender name}
TManage · tmanageapp.com',
  NULL, UTC_TIMESTAMP(3)
  FROM outreach_campaigns c
 WHERE NOT EXISTS (SELECT 1 FROM outreach_email_versions v
                    WHERE v.campaign_id = c.id AND v.kind = 'intro' AND v.language = 'ar');

INSERT INTO outreach_email_versions
  (id, campaign_id, kind, version, language, subject, body, created_by, created_at)
SELECT UUID(), c.id, 'followup', 1, 'en',
  'Following up: client approvals at {company}',
  'Hi {first name},

A short follow-up to my note about TManage. If chasing client sign-off by email still slows {company} down, your workspace is ready here, with no card needed:
{trial link}

Or pick a time for a 20-minute walkthrough:
{walkthrough link}

Best,
{sender name}
TManage · tmanageapp.com',
  NULL, UTC_TIMESTAMP(3)
  FROM outreach_campaigns c
 WHERE NOT EXISTS (SELECT 1 FROM outreach_email_versions v
                    WHERE v.campaign_id = c.id AND v.kind = 'followup' AND v.language = 'en');

INSERT INTO outreach_email_versions
  (id, campaign_id, kind, version, language, subject, body, created_by, created_at)
SELECT UUID(), c.id, 'followup', 1, 'ar',
  'متابعة: موافقات العملاء في {company}',
  'مرحباً {first name}،

متابعة قصيرة لرسالتي عن TManage. إن كانت ملاحقة موافقة العميل عبر البريد ما زالت تؤخّر {company}، فمساحة عملكم جاهزة من هنا دون بطاقة دفع:
{trial link}

أو اختاروا موعداً لجولة تعريفية مدتها 20 دقيقة:
{walkthrough link}

مع خالص التحية،
{sender name}
TManage · tmanageapp.com',
  NULL, UTC_TIMESTAMP(3)
  FROM outreach_campaigns c
 WHERE NOT EXISTS (SELECT 1 FROM outreach_email_versions v
                    WHERE v.campaign_id = c.id AND v.kind = 'followup' AND v.language = 'ar');
