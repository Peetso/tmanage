-- 0142_saved_search_shares — saved-search sharing (Search module, SRCH saved search sharing, x272).
--
-- Governing sources: 38-MODULE-MAP §Search (saved searches on top of the SRCH-01 global search); the
-- planning SR-04 "Saved search" (sharing half — alert/digest stays Needs-Peter, out of scope);
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys, `(organization_id, id)` on every
-- tenant table); 07-DATA-MODEL §9 (index prefixes lead with `organization_id`); ADR-0001 (MySQL has
-- no row-level security; the withheld privilege and the tenant predicate are the control).
--
-- ## Migration number
--
-- Pass 24 reserves 0118-0144 in slice-id order; x272's reservation is 0142 (queue header map). The
-- migrator applies files in ascending numeric order and a gap on this base is legitimate (it rejects
-- only a NEW file numbered *below* an applied one), so 0142 here is correct; nothing depends on the
-- literal number beyond the filename, and the integrator renumbers if the reservations move.
--
-- ## What this is
--
-- x214 (0092) gave each member private, per-user saved searches (create/list/delete) but no way to
-- share one. This is the sharing half: a member shares one of their own saved searches with the whole
-- studio so teammates can run it, and unshares it again. ONE row per shared saved search:
--
--   * A row's presence means "this saved search is shared with the org". PUT is idempotent (the
--     unique key collapses a repeat share to the same row); DELETE removes it (204).
--   * Only the **owning member** may share or unshare. The authoritative owner is resolved from
--     `saved_searches` at request time (a read-only lookup), so a non-owner is a 403 and an unknown
--     saved search is a 404 — the row's existence is never disclosed to a non-owner.
--
-- Every row is tenant-owned: `organization_id` scopes the tenant, and every read, the idempotent
-- share and the unshare carry `organization_id = the acting tenant`, so one studio never sees or
-- toggles another's shares.
--
-- ## Soft dependency on x214 (no foreign key to saved_searches)
--
-- The dependency on `saved_searches` is a *soft read*: the service resolves the saved search by
-- `(organization_id, id)` and answers 404 when it is absent, rather than binding the two tables with
-- a foreign key. There is deliberately no `fk_saved_search_shares_saved`: the sharing slice must not
-- hard-couple its schema to x214's, and an orphaned share (should its saved search be deleted) simply
-- resolves to a 404 and is inert. The only foreign key is to `organizations`.
--
-- ## Grants and immutability
--
-- The runtime credential is granted INSERT and DELETE and **no UPDATE**: a share is created and
-- removed, never edited, so the missing UPDATE privilege is the control that keeps a share a plain
-- present/absent toggle (the `saved_searches`/`saved_context` posture), and no immutability trigger is
-- needed because no credential may UPDATE at all.

CREATE TABLE saved_search_shares (
  id                       CHAR(36)    NOT NULL,
  organization_id          CHAR(36)    NOT NULL,
  -- The shared saved search. References `saved_searches (id)` by value only — there is intentionally
  -- no foreign key (the soft dependency on x214 above); the service resolves it and answers 404 when
  -- it is absent.
  saved_search_id          CHAR(36)    NOT NULL,
  -- The membership that shared it, recorded for provenance. The authoritative owner check is against
  -- `saved_searches.user_id`, resolved at request time, not this column.
  shared_by_membership_id  CHAR(36)    NOT NULL,
  created_at               DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (25-AUTH §6).
  UNIQUE KEY uq_saved_search_shares_org_id (organization_id, id),
  -- One share per saved search per studio: makes PUT idempotent (a repeat share collapses to the same
  -- row) and is the lookup for the unshare and the shared-list join. Leads with `organization_id`
  -- per 07-DATA-MODEL §9.
  UNIQUE KEY uq_saved_search_shares_org_saved (organization_id, saved_search_id),
  CONSTRAINT fk_saved_search_shares_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
