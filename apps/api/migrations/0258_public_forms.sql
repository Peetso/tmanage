-- 0258_public_forms — public intake forms, backend half (52-20, spec 52 §52-20).
--
-- ## What this migration is for
--
-- `work_forms` (0052) is an internal, session-gated intake definition. 52-20 gives a form a public
-- door: a random 10-character slug a visitor without an account opens at `/f/<slug>`, and a place
-- to keep what the visitor sent until a person triages it.
--
-- ## `work_forms` gains its public columns
--
-- - `public_slug` — the random slug (`public-forms.validate.ts`, 50 bits), globally unique: the
--   public door finds the form by slug on `bootstrapRead(['work_forms'])` and takes the
--   organization from the row, never from the request. NULL until first published; kept on
--   unpublish so a re-publish keeps the printed link.
-- - `public_enabled` — 0/1. An unpublished slug answers the same 404 as an unknown one.
-- - `published_at`, `updated_at` — when the switch last moved.
--
-- The 0052 identity trigger still pins `organization_id` and `created_by`; these columns are the
-- first ones the app may UPDATE (users.sql).
--
-- ## `form_submissions` (TENANT)
--
-- One row per accepted public submission. `values_json` holds the visitor's values keyed by the
-- form's field labels, already typed and length-capped by the door. `reference` (`REQ-XXXXXX`) is
-- the only thing the visitor gets back, unique per organization. `state` new | converting |
-- converted | spam — a closed list checked in code. `risk_decision`/`risk_score`/`risk_reasons`
-- are 52-21's verdict (allow | hold | spam), copied so the triage tray can show "Likely spam"
-- without joining the global telemetry. No IP and no user agent are stored here (minimisation:
-- 52-21's `public_abuse_events` keeps the abuse signal for 30 days). `created_work_item_id` is
-- set by a conversion. Composite foreign key to `work_forms (organization_id, id)`.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, closed lists checked in code, no generated columns, no CHECK, no functional
-- indexes, utf8mb4_unicode_ci. Additive only.

ALTER TABLE work_forms
  ADD COLUMN public_slug    VARCHAR(16)  NULL,
  ADD COLUMN public_enabled TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN published_at   DATETIME(3)  NULL,
  ADD COLUMN updated_at     DATETIME(3)  NULL,
  ADD UNIQUE KEY uq_work_forms_public_slug (public_slug);

CREATE TABLE form_submissions (
  id                   CHAR(36)      NOT NULL,
  organization_id      CHAR(36)      NOT NULL,
  form_id              CHAR(36)      NOT NULL,
  reference            VARCHAR(12)   NOT NULL,
  values_json          TEXT          NOT NULL,
  language             VARCHAR(5)    NULL,
  state                VARCHAR(12)   NOT NULL DEFAULT 'new',
  risk_decision        VARCHAR(12)   NOT NULL DEFAULT 'allow',
  risk_score           INT           NOT NULL DEFAULT 0,
  risk_reasons         VARCHAR(255)  NULL,
  created_work_item_id CHAR(36)      NULL,
  converted_by         CHAR(36)      NULL,
  converted_at         DATETIME(3)   NULL,
  spam_marked_by       CHAR(36)      NULL,
  created_at           DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_form_submissions_org_id (organization_id, id),
  UNIQUE KEY uq_form_submissions_reference (organization_id, reference),
  KEY ix_form_submissions_form (organization_id, form_id, created_at, id),
  CONSTRAINT fk_form_submissions_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_form_submissions_form
    FOREIGN KEY (organization_id, form_id) REFERENCES work_forms (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
