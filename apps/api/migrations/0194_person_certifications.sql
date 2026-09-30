-- 0194_person_certifications — a person's dated credentials / qualifications (People module 14, x326).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §People & capacity ("qualifications");
-- 22-SCREEN §Person detail; 07-DATA-MODEL §9 (index prefixes lead with `organization_id`); §Dates
-- (calendar days are `DATE`, not instants); 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite
-- tenant keys).
--
-- ## Migration number
--
-- Pass 26 reserves 0174–0201 in slice-id order; x326's reservation is 0194 (pass26-queue header map).
-- The migrator applies files in ascending numeric order and a gap is not an error, so 0194 on top of
-- the base is correct. Nothing in the application depends on the literal 0194 beyond the filename; if
-- the integration renumbers the reservations the integrator renumbers this file with them.
--
-- ## What this migration is for
--
-- People records what a member can do (person_skills, 0070) but not the dated credentials they hold —
-- a certification with an issuer, an issued date and an optional expiry. This is that store: one row
-- per certification, hung off a member by `person_user_id`, added and removed, never edited. It is
-- deliberately distinct from `person_skills` (0070, proficiency tags): a certification is a dated
-- credential, not a self-assessed skill level.
--
-- ## Tenant-scoped, member-owned
--
-- A certification belongs to a person within one studio, so the tenant key is `organization_id` and
-- the owner key is `person_user_id`. The composite FK to `memberships (organization_id, user_id)`
-- keeps a certification inside the person's own tenant — it can never point at a person in another
-- organization, and an unknown person is refused at the engine (the controller resolves the person
-- first so an unknown/cross-tenant id is a 404, never a foreign-key 500). Deleting the membership
-- takes the person's certifications with it (`ON DELETE CASCADE`): a credential has no meaning
-- without the person it describes.
--
-- ## Expiry is data, computed read-side
--
-- `expires_on` is nullable — a credential may never expire. Whether a certification is *expired* is
-- not stored: it is `expires_on < today` computed on read against the process clock, so the same row
-- reads "expired" the day after it lapses without a write. The stored fact is only the date.
--
-- ## Identity is immutable by grant
--
-- The application holds INSERT and DELETE only (no UPDATE): a certification is recorded and removed,
-- never amended, so a correction is a delete and re-add. Withholding UPDATE is the immutability
-- control; there is no editable column and therefore no BEFORE UPDATE trigger to add.

CREATE TABLE person_certifications (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The person this certification describes. Composite FK to `memberships (organization_id, user_id)`
  -- keeps it in the person's own tenant.
  person_user_id  CHAR(36)     NOT NULL,
  -- The credential's name, e.g. "AWS Solutions Architect". Trimmed by the application before insert.
  name            VARCHAR(200) NOT NULL,
  -- Who issued it, e.g. "Amazon Web Services". Trimmed by the application before insert.
  issuer          VARCHAR(200) NOT NULL,
  -- The day it was issued, a calendar day (07-DATA-MODEL §Dates).
  issued_on       DATE         NOT NULL,
  -- The day it expires, or NULL when the credential does not expire. Expiry is computed read-side.
  expires_on      DATE         NULL,
  -- The member who recorded it (the acting user). Denormalised for display; not a tenant key.
  created_by      CHAR(36)     NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_person_certifications_org_id (organization_id, id),
  -- The index a person's certifications are listed by: this person's credentials, newest issue first.
  -- Leads with `organization_id` then `person_user_id` per 07-DATA-MODEL §9.
  KEY ix_person_certifications_person (organization_id, person_user_id, issued_on, id),
  CONSTRAINT fk_person_certifications_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The owning person, in the same tenant. Deleting the membership removes their certifications.
  CONSTRAINT fk_person_certifications_person
    FOREIGN KEY (organization_id, person_user_id) REFERENCES memberships (organization_id, user_id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
