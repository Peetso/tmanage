-- 0129_inbox_snoozes — a member's own inbox-bundle snoozes (module INBOX, IN-01/IN-02, x259).
--
-- Governing sources: 09-MVP-PRD inbox actions ("complete, snooze, reprioritize, dismiss reason");
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys, scoped writes); 07-DATA-MODEL §9
-- (every composite index prefix begins with organization_id); ADR-0001 (MySQL has no row-level
-- security; the application layers replace it, and the withheld privilege is a control).
--
-- ## What this migration is for
--
-- INBOX-001 (0-migration; the inbox is a read projection over `notifications`) gives a member a
-- bundled inbox. This slice lets a member snooze one bundle until a chosen time so it drops out of
-- their active inbox until then. One `inbox_snoozes` row is the fact "this membership snoozed this
-- bundle until this instant". A member snoozes only a bundle they can already see (the service
-- resolves the bundle's object tenant-scoped and relation-checks BEFORE the write), and the snoozes
-- a member reads are only their own rows.
--
-- ## A bundle id is `objectType:objectId`, not a foreign key
--
-- A bundle is identified the way `markBundleRead` takes it — `work_item:<uuid>` or
-- `client_request:<uuid>` — so `bundle_id` is that opaque string, not a column with a single foreign
-- key: the object it names lives in `work_items` or `client_requests` depending on the prefix. The
-- tenant safety is therefore not an FK on the bundle (the `home_pinned_items` target_id posture,
-- 0050): it is that the service resolves the object under an `organization_id = context` predicate
-- before writing, so a snooze can never be created for a bundle whose object belongs to another
-- studio, and an unresolvable id is a 404 with no row.
--
-- ## Snoozes are per membership, keyed for upsert, identity immutable
--
-- A row is one membership's snooze of one bundle in one studio, keyed `(organization_id,
-- membership_id, bundle_id)`. It is keyed to `membership_id`, not the global `user_id`: a snooze is
-- scoped to who the caller is *in this studio* and never leaves the tenant, and the composite foreign
-- key binds the row to a membership of this same organization. The write is one
-- `INSERT ... ON DUPLICATE KEY UPDATE snoozed_until` against that unique key, so re-snoozing the same
-- bundle moves the time in place rather than creating a second row; a member un-snoozes by DELETE.
-- `organization_id`, `membership_id` and `bundle_id` are what a row *is*; only `snoozed_until` and
-- `updated_at` change, and the BEFORE UPDATE trigger pins identity at the engine (ADR-0001 layers 3
-- and 4 are application-side and a direct SQL session bypasses both). This slice grants the app
-- INSERT, UPDATE (the upsert) and DELETE (the un-snooze).

CREATE TABLE inbox_snoozes (
  id              CHAR(36)      NOT NULL,
  organization_id CHAR(36)      NOT NULL,
  -- The membership whose snoozes this row holds. Private to it: the read, the upsert and the delete
  -- are all scoped by membership_id = the acting context's membership, so one member never sees,
  -- moves or removes another's snoozes even inside the same tenant. The composite FK below binds it to
  -- a membership of this same organization.
  membership_id   CHAR(36)      NOT NULL,
  -- The inbox bundle this snooze names, as `objectType:objectId` (e.g. `work_item:<uuid>`). No foreign
  -- key: the object lives in a different table per prefix, so the tenant boundary is the service's
  -- tenant-scoped resolve of the object before the write, not an FK here (the home_pinned_items
  -- target_id posture).
  bundle_id       VARCHAR(120)  NOT NULL,
  -- The instant the bundle stays snoozed until. A client filtering the active inbox excludes bundles
  -- whose snoozed_until is in the future, compared against a bound Date — never the database clock, so
  -- the admin connection's CURRENT_TIMESTAMP can never leak into the comparison.
  snoozed_until   DATETIME(3)   NOT NULL,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, the target of the composite FKs
  -- that bind child rows within one tenant (and the isolation corpus requires it).
  UNIQUE KEY uq_inbox_snoozes_org_id (organization_id, id),
  -- One row per member per bundle per studio. This is the upsert key: the service writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second snooze of the same bundle updates in
  -- place. Leads with organization_id per 07-DATA-MODEL §9.
  UNIQUE KEY uq_inbox_snoozes_pin (organization_id, membership_id, bundle_id),
  -- 07-DATA-MODEL §9: the one read that exists — a membership's snoozes, by when they end then id for
  -- a total, deterministic order.
  KEY ix_inbox_snoozes_org_membership (organization_id, membership_id, snoozed_until, id),
  CONSTRAINT fk_inbox_snoozes_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The membership, bound within its own tenant: the composite key refuses a membership id from
  -- outside this row's organization, so a snooze can never cite a membership in another studio.
  CONSTRAINT fk_inbox_snoozes_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant, membership and bundle are what it is and are immutable; only snoozed_until and
-- updated_at change. The trigger holds identity at the engine, the reason every other identity
-- trigger in this schema exists.
DELIMITER $$

CREATE TRIGGER trg_inbox_snoozes_immutable
BEFORE UPDATE ON inbox_snoozes FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'inbox_snoozes.organization_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'inbox_snoozes.membership_id is immutable';
  END IF;
  IF NEW.bundle_id <> OLD.bundle_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'inbox_snoozes.bundle_id is immutable';
  END IF;
END$$

DELIMITER ;
