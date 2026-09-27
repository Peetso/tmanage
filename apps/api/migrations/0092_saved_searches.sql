-- 0092_saved_searches — saved & recent searches (Search module 16, SRCH saved/recent, x214).
--
-- Governing sources: 38-MODULE-MAP §Search, command & AI (saved + recent searches on top of the
-- SRCH-01 global search x111 and the SRCH ranking x148); 25-AUTHORIZATION-AND-TENANT-ISOLATION §6
-- (composite tenant keys, `(organization_id, id)` on every tenant table); 07-DATA-MODEL §9 (index
-- prefixes lead with `organization_id`); ADR-0001 (MySQL has no row-level security; the withheld
-- privilege and the tenant/owner predicates are the control).
--
-- ## Migration number
--
-- Pass 22 reserves 0081-0093 in slice-id order; x214's reservation is 0092 (NEXT-SCOPES-14 header).
-- The highest migration present on this slice's base (origin/master after pass 21) is lower — the
-- sibling pass-21/22 branches land the intervening numbers from branches not yet integrated here.
-- The migrator applies files in ascending numeric order and a gap is legitimate (it rejects only a
-- NEW file numbered *below* an applied one), so 0092 on this base is correct; nothing here depends
-- on the literal 0092 beyond the filename, and the integrator renumbers with the reservations if
-- they move.
--
-- ## What this is
--
-- The Search module can run a query but cannot remember one: the audit names Search built (search +
-- ranking + command palette) with no saved or recent searches. This is the smallest useful unit
-- that adds both, in ONE table, keyed by `kind`:
--
--   * `kind = 'saved'` — an explicitly-named search the owner keeps: `name` is set, `query_text`
--     and `filters` are what it re-runs. Created, listed and deleted by its owner.
--   * `kind = 'recent'` — a query the owner recently ran, recorded as a side effect of the global
--     search. `name` is NULL. The owner's most-recent N are kept; older recents are pruned.
--
-- Both rows are **private to one user in one studio**: every read, the delete and the prune are
-- scoped by `organization_id = the acting tenant` AND `user_id = the acting user`, so one member
-- never sees or removes another's saved or recent searches even inside the same studio, and a
-- cross-tenant or other-user id resolves to nothing (the service answers 404).
--
-- ## Grants and immutability
--
-- The runtime credential is granted INSERT and DELETE and **no UPDATE**: a saved search is created
-- and deleted (there is no rename/edit endpoint this slice), and a recent is inserted and pruned —
-- so the missing UPDATE privilege is the control that keeps a row's identity and body fixed (the
-- `saved_context`/`home_pinned_items` posture), and no immutability trigger is needed because no
-- credential may UPDATE at all.

CREATE TABLE saved_searches (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The owner. References users (id) without organization_id because a user is not tenant-owned —
  -- the shape `saved_views.owner_user_id` (0034) and `org_settings.updated_by` (0058) use.
  user_id         CHAR(36)     NOT NULL,
  -- 'saved' (a named, kept search) or 'recent' (a recorded recent query). The discriminator that
  -- lets one table carry both without a second table for recents.
  kind            ENUM('saved','recent') NOT NULL,
  -- The saved search's name. Required for a 'saved' row (the application enforces it), NULL for a
  -- 'recent' row. VARCHAR(300) matches the title columns search ranges over.
  name            VARCHAR(300) NULL,
  -- The query the search re-runs / the query the caller ran. VARCHAR(300) — the same bound the
  -- SRCH-01 controller enforces on `q` (the title columns are VARCHAR(300)).
  query_text      VARCHAR(300) NOT NULL,
  -- The saved filters, as a validated, bounded JSON array of { field, value } short strings. `[]`
  -- for a recent (a recent remembers the query, not a filter set). The application validates and
  -- bounds it before the write, so the column only ever holds a small, well-formed array.
  filters         JSON         NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (25-AUTH §6), so a future child
  -- can reference this row without a cross-tenant path and the isolation corpus is satisfied.
  UNIQUE KEY uq_saved_searches_org_id (organization_id, id),
  -- The listing index: one owner's rows of one kind, newest first. Leads with `organization_id`
  -- per 07-DATA-MODEL §9, then `user_id` and `kind` (the equality predicates), then `created_at`
  -- and `id` (the order). Serves the saved list, the recent list and the recent prune.
  KEY ix_saved_searches_org_user_kind (organization_id, user_id, kind, created_at, id),
  CONSTRAINT fk_saved_searches_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_saved_searches_user
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
