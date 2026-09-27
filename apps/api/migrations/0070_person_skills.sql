-- 0070_person_skills — a member's declared skills / tags (People module 14, x172).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §People ("skills" — member skills
-- for matching); AUDIT-2026-09-27 rank #4 (People Missing → skills); 07-DATA-MODEL §9 (index
-- prefixes lead with `organization_id`); 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant
-- keys).
--
-- ## Migration number
--
-- Pass 21 reserves 0060–0080 in slice-id order; x172's reservation is 0070 (NEXT-SCOPES-13 header).
-- The highest migration present on this slice's base (master bcfe397) is 0052; 0053–0069 are
-- reserved by sibling pass-21 branches not yet integrated, so 0070 sits above every reservation.
-- The migrator applies files in ascending numeric order and a gap is not an error (it rejects only a
-- NEW file numbered *below* an applied one), so 0070 on top of 0052 is correct on this base. If the
-- integration renumbers the reservations, the integrator renumbers this file with them; nothing here
-- depends on the literal 0070 beyond the filename.
--
-- ## What this migration is for
--
-- People has a member directory and a profile, but no record of *what a member can do*. This is the
-- smallest useful unit that adds one — a **member skill**: a label (e.g. "TypeScript", "Copywriting")
-- and a proficiency level, hung off a `memberships` row so it names a person *within* one tenant.
-- Skills exist to make members findable for matching; that read side is a later slice — this table
-- carries only what a skill *is* at rest, added and removed, never edited.
--
-- ## Tenant-scoped, membership-owned
--
-- A skill belongs to a `memberships` row, and a membership belongs to an organization, so the tenant
-- key is `organization_id` and the owner key is `membership_id`. The composite FK to
-- `memberships (organization_id, id)` keeps a skill inside its member's own tenant — a skill can
-- never point at a membership in another organization. Deleting the member takes their skills with
-- them (`ON DELETE CASCADE`): a skill has no meaning without the person it describes.
--
-- ## One skill per (member, label)
--
-- A member declaring the same label twice is a mistake, not two skills, so `(organization_id,
-- membership_id, label)` is UNIQUE. The controller turns the duplicate-key violation into a 409.
--
-- ## `level` is a bounded enum
--
-- Proficiency is one of three fixed rungs — `basic`, `proficient`, `expert` — so it is a MySQL enum,
-- not a free string: the set is the contract, and a bad value is refused at the engine as well as by
-- the application's validator.
--
-- ## Identity is immutable
--
-- `organization_id`, `membership_id` and `label` are what a skill *is*; a re-label is a delete and a
-- re-add, not an update. This slice grants the app INSERT and DELETE only (no UPDATE), and the
-- `BEFORE UPDATE` trigger holds identity at the engine for the level-edit slice that may come later
-- (ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses both).

CREATE TABLE person_skills (
  id              CHAR(36)    NOT NULL,
  organization_id CHAR(36)    NOT NULL,
  -- The member this skill describes. Composite FK to `memberships (organization_id, id)` keeps it in
  -- the member's own tenant.
  membership_id   CHAR(36)    NOT NULL,
  -- The skill's short label, normalised (trimmed, single-spaced) by the application before insert.
  label           VARCHAR(80) NOT NULL,
  -- One of three fixed proficiency rungs. The enum is the contract.
  level           ENUM('basic', 'proficient', 'expert') NOT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_person_skills_org_id (organization_id, id),
  -- One skill per (member, label): a duplicate label is a 409, not a second row.
  UNIQUE KEY uq_person_skills_member_label (organization_id, membership_id, label),
  -- The index a member's skills are listed by: this member's skills in label order. Leads with
  -- `organization_id` then `membership_id` per 07-DATA-MODEL §9.
  KEY ix_person_skills_member_label (organization_id, membership_id, label, id),
  CONSTRAINT fk_person_skills_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The owning member, in the same tenant. Deleting the member removes their skills.
  CONSTRAINT fk_person_skills_member
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A skill's tenant, member and label are immutable — a re-label is a delete and re-add. `level` is
-- left editable at the engine for a future level-edit slice; identity is not.
DELIMITER $$

CREATE TRIGGER trg_person_skills_immutable
BEFORE UPDATE ON person_skills FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'person_skills.organization_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'person_skills.membership_id is immutable';
  END IF;
  IF NEW.label <> OLD.label THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'person_skills.label is immutable';
  END IF;
END$$

DELIMITER ;
