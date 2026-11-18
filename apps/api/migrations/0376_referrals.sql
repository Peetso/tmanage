-- 0376_referrals — workspace invite links and partner (agency reseller) codes (57-08, REFERRAL).
--
-- ## What this migration is for
--
-- Each workspace owner gets one invite link (Settings › People › Invite agencies). A sign-up that
-- arrives through it is recorded against the inviting workspace. The owner sees only the agencies
-- that signed up (the new workspace's name and the date), never an e-mail address, never a count of
-- people the link was sent to (a link cannot know that). The TManage team can also issue partner
-- codes (an agency that resells TManage); a partner's sign-ups form its own list on the Platform
-- admin Growth page.
--
-- - `referral_codes` (TENANT): one code per workspace (`uq_referral_codes_org`), globally unique
--   (`uq_referral_codes_code`). Created by the owner; never edited, never re-issued.
-- - `referral_signups` (TENANT, the INVITING workspace's rows): one row per new workspace
--   (`uq_referral_signups_referred`, so a workspace is credited to at most one link).
--   `referred_name` is the new workspace's name at sign-up (a snapshot, so the inviting workspace
--   never reads another tenant's `organizations` row). `outcome`: 'counted', 'self',
--   'same_domain' or 'rate_limited' (vocabulary checked in code); only 'counted' rows are shown
--   to the owner. `reward_kind` / `reward_state`: 'account_credit' / 'recorded' on a counted row,
--   NULL otherwise. A reward is recorded only: nothing pays it out, and while `beta_free` it is
--   never shown.
-- - `referral_partners` (PLATFORM, non-tenant): a partner's code and display name, created by a
--   Platform admin (audited in platform_admin_audit_events).
-- - `referral_partner_signups` (PLATFORM, non-tenant): one row per new workspace that signed up
--   through a partner code; same outcome vocabulary (a partner has no e-mail, so only
--   'counted' and 'rate_limited' occur).
--
-- `referred_organization_id` carries no foreign key on purpose: deleting a referred workspace must
-- never be blocked by another workspace's referral row.
--
-- Grants (scripts/db/users.sql): api SELECT, INSERT on all four tables (no UPDATE, no DELETE).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- New tables only. Plain columns, DATETIME(3), no CHECK, no generated column, no functional or
-- partial index, no trigger. No earlier migration is edited.

CREATE TABLE referral_codes (
  id                       CHAR(36)    NOT NULL,
  organization_id          CHAR(36)    NOT NULL,
  code                     VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_by_membership_id CHAR(36)    NOT NULL,
  created_at               DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_referral_codes_org_id (organization_id, id),
  UNIQUE KEY uq_referral_codes_org (organization_id),
  UNIQUE KEY uq_referral_codes_code (code),
  CONSTRAINT fk_referral_codes_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_referral_codes_membership_tenant
    FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE referral_signups (
  id                       CHAR(36)     NOT NULL,
  organization_id          CHAR(36)     NOT NULL,
  referral_code_id         CHAR(36)     NOT NULL,
  referred_organization_id CHAR(36)     NOT NULL,
  referred_name            VARCHAR(190) NOT NULL,
  outcome                  VARCHAR(16)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reward_kind              VARCHAR(16)  CHARACTER SET ascii COLLATE ascii_bin NULL,
  reward_state             VARCHAR(16)  CHARACTER SET ascii COLLATE ascii_bin NULL,
  signed_up_at             DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_referral_signups_org_id (organization_id, id),
  UNIQUE KEY uq_referral_signups_referred (referred_organization_id),
  KEY ix_referral_signups_org_signed_up (organization_id, signed_up_at),
  CONSTRAINT fk_referral_signups_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_referral_signups_code_tenant
    FOREIGN KEY (organization_id, referral_code_id)
    REFERENCES referral_codes (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE referral_partners (
  id                 CHAR(36)     NOT NULL,
  code               VARCHAR(40)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name               VARCHAR(120) NOT NULL,
  created_by_user_id CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_referral_partners_code (code),
  CONSTRAINT fk_referral_partners_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE referral_partner_signups (
  id                       CHAR(36)     NOT NULL,
  partner_id               CHAR(36)     NOT NULL,
  referred_organization_id CHAR(36)     NOT NULL,
  referred_name            VARCHAR(190) NOT NULL,
  outcome                  VARCHAR(16)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  signed_up_at             DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_referral_partner_signups_referred (referred_organization_id),
  KEY ix_referral_partner_signups_partner (partner_id, signed_up_at),
  CONSTRAINT fk_referral_partner_signups_partner
    FOREIGN KEY (partner_id) REFERENCES referral_partners (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
