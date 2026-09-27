-- 0141_insight_annotations — an explanatory note attached to an insight snapshot, so a frozen figure
-- carries the context that explains it (INS-01 "every score is explainable"; module map §Insights
-- "explainable, drills to source"; x271). Complements x211's `insight_snapshots` (0090).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Insights & reporting (every score is
-- explainable; a snapshot is live-only otherwise); 0084_project_update_comments.sql for the shape of
-- an append-only, parent- and tenant-scoped note with an author; 25-AUTHORIZATION-AND-TENANT-ISOLATION
-- §5-6 (composite tenant keys, scoped writes); 07-DATA-MODEL §9 (index prefixes lead with
-- organization_id); ADR-0001 layer 3.
--
-- ## Migration number
--
-- The pass-24 queue map reserves 0141 for x271. The migrator applies files in ascending numeric order
-- and a gap is not an error (it rejects only a NEW file numbered below an applied one), so 0141 on top
-- of the base is correct. If the integration renumbers the reservations, the integrator renumbers this
-- file with them.
--
-- ## Parent- and tenant-scoped
--
-- An annotation belongs to exactly one snapshot of one studio. `organization_id` scopes it to the
-- tenant the way every sibling table is scoped; the composite foreign key
-- `fk_insight_annotations_snapshot` binds `(organization_id, snapshot_id)` to
-- `insight_snapshots (organization_id, id)`, so an annotation can only ever name a snapshot of its own
-- tenant — a cross-tenant `snapshot_id` does not exist as a pair even when both ids exist
-- individually. That is the engine half of the trap the service also enforces in code: the snapshot is
-- resolved inside the tenant first, so a cross-tenant or unknown id is a 404 with no write (the soft
-- read of x211 degrades to 404 on an unknown snapshot). `author_membership_id` is bound composite to a
-- membership of the same tenant, so an annotation can never cite a membership in another studio.
--
-- ## Append-only, deletable by its author
--
-- An annotation is a record of what was said, when, by whom. It is inserted, read, and removed by its
-- author, never edited: the runtime credential is granted INSERT and DELETE and nothing else (see
-- `scripts/db/users.sql`), and the `BEFORE UPDATE` trigger refuses any amendment for every other
-- credential besides — the append-only posture `project_update_comments` (0084) carries, extended with
-- the author's own DELETE the way `focus_blocks` (0125) is granted DELETE. The delete resolves
-- `(organization_id, snapshot_id, id)` and then checks `author_membership_id = the acting membership`
-- in the service: another author's annotation is a 403 with no delete, and an unknown one a 404.
--
-- ## created_at is bound, not the connection clock
--
-- `created_at` is written from a value the application binds (a `Date` resolved in the service), NOT
-- `CURRENT_TIMESTAMP` — the admin-pool clock trap: the note's instant must be the moment the caller
-- posted it, not whatever the writing connection's clock reads. The list orders by it, so it is
-- NOT NULL; it has no server-clock default and the writer always supplies it.

CREATE TABLE insight_annotations (
  id                   CHAR(36)     NOT NULL,
  organization_id      CHAR(36)     NOT NULL,
  -- NOT NULL. The snapshot this note explains; the composite key below makes a cross-tenant
  -- snapshot_id a non-existent pair rather than a leak.
  snapshot_id          CHAR(36)     NOT NULL,
  -- The internal member who wrote the note. Bound composite to a membership of this same tenant; the
  -- author's own DELETE is resolved against this column, so one member cannot remove another's note.
  author_membership_id CHAR(36)     NOT NULL,
  -- Free text. TEXT rather than VARCHAR because a note is prose a person types, not a short handle
  -- (the choice `project_update_comments.body` made). The application enforces non-empty and a bounded
  -- length before insert; the store holds only well-formed rows.
  note                 TEXT         NOT NULL,
  -- The instant the note was posted, bound by the application (see the header). The list orders by it,
  -- so it is NOT NULL and has no server-clock default.
  created_at           DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (isolation corpus requires it), so
  -- a future child can reference this row without a cross-tenant path.
  UNIQUE KEY uq_insight_annotations_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the one read that exists — this tenant's annotations for one snapshot, newest
  -- first (created_at descending, id as the keyset tiebreak). Leads with organization_id.
  KEY ix_insight_annotations_org_snapshot_created (organization_id, snapshot_id, created_at, id),
  -- An annotation can only ever name a snapshot of its own tenant; the composite key is what makes a
  -- cross-tenant snapshot_id a non-existent pair rather than a leak.
  CONSTRAINT fk_insight_annotations_snapshot
    FOREIGN KEY (organization_id, snapshot_id) REFERENCES insight_snapshots (organization_id, id),
  -- The author, bound within its own tenant: the composite key refuses a membership id from outside
  -- this row's organization, so an annotation can never cite a membership in another studio.
  CONSTRAINT fk_insight_annotations_author
    FOREIGN KEY (organization_id, author_membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An annotation is append-only: once written it is neither re-parented, re-attributed nor edited (it
-- is removed whole by its author, never amended). The trigger holds that at the engine — ADR-0001
-- layers 3 and 4 are application-side and a direct SQL session bypasses both — for the credentials
-- that do hold UPDATE. The runtime credential holds INSERT and DELETE only (users.sql), so this is
-- defence in depth, the `project_update_comments` posture.
DELIMITER $$

CREATE TRIGGER trg_insight_annotations_immutable
BEFORE UPDATE ON insight_annotations FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'insight_annotations rows are append-only';
END$$

DELIMITER ;
