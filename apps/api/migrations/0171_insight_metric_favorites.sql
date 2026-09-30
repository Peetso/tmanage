-- 0171_insight_metric_favorites — a member's own starred insight metrics: the small set of known
-- insight numbers they want surfaced first (module 15 Insights, INS metric favorites, x303).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Insights (the insight tiles exist; a
-- per-user starred subset did not); 22-WHOLE-APP-SCREEN §INS; 25-AUTHORIZATION-AND-TENANT-ISOLATION
-- §5-6 (scoped writes, composite `(organization_id, id)` foreign keys); 07-DATA-MODEL §9 (every
-- composite index begins with organization_id); ADR-0001 (MySQL has no row-level security; layers
-- 3-5 replace it). Distinct from x302's dashboard layout (which orders every tile): this is a small
-- starred set, not a full ordering, and it never leaves the tenant.
--
-- ## Migration number
--
-- The pass-25 queue map reserves 0171 for x303. The highest migration present on this slice's base
-- (master 5b3fcf0) is 0115; 0116-0170 are reserved by sibling pass-16..25 branches not yet
-- integrated. The migrator applies files in ascending numeric order and a gap is not an error (it
-- rejects only a NEW file numbered below an applied one), so 0171 on top of 0115 is correct on this
-- base. If the integration renumbers the reservations, the integrator renumbers this file with them.
--
-- ## Favorites are per membership, and are created and removed, never edited
--
-- One `insight_metric_favorites` row is the fact "this membership starred this metric". A favorite
-- belongs to exactly one membership in one tenant. The only writes are INSERT (star) and DELETE
-- (unstar): there is no UPDATE path in the repository and no UPDATE grant in scripts/db/users.sql, so
-- the withheld privilege is the control (no immutability trigger, none needed — the `doc_bookmarks`
-- (0114) posture). `uq_insight_metric_favorites_star` makes a repeated star a collision at the
-- engine; the service treats that collision as success, so a repeated PUT is idempotent rather than a
-- second row.
--
-- ## `metric_key` is validated against a fixed allowlist by the application
--
-- The column stores a metric id from a small closed vocabulary — the known insight tiles the app
-- renders (`INSIGHT_METRIC_KEYS` in schema.ts). A key outside the allowlist is a 400 and nothing is
-- written (`metric-favorites.controller.ts`), the same division `home_widget_prefs.widget_order_json`
-- (0115) and `work_forms.fields_json` (0052) use — the store never holds a key the app cannot render.
--
-- ## Tenant-scoped, and a favorite can never reference another tenant's membership
--
-- The composite foreign key `(organization_id, membership_id)` binds the row to a membership of this
-- same organization; a cross-tenant membership id does not exist as a pair even when both ids exist
-- individually. The read and every write are scoped by `membership_id` = the acting context's
-- membership, so one member never sees or removes another's favorites even inside the same tenant.

CREATE TABLE insight_metric_favorites (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- The membership whose favorites this row belongs to. Private to it: the list and the unstar are
  -- both scoped by membership_id = the acting context's membership. The composite FK below binds it
  -- to a membership of this same organization.
  membership_id     CHAR(36)      NOT NULL,
  -- A metric id from the fixed allowlist the application validates against before inserting; stored
  -- as a short string, never a foreign key — the vocabulary is code, not a table.
  metric_key        VARCHAR(64)   NOT NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_insight_metric_favorites_org_id (organization_id, id),
  -- Idempotency guard: the same membership starring the same metric twice collides here rather than
  -- creating a second row. Leads with organization_id per 07-DATA-MODEL §9.
  UNIQUE KEY uq_insight_metric_favorites_star (organization_id, membership_id, metric_key),
  -- 07-DATA-MODEL §9: the one read that exists — a membership's favorites, newest first, id breaking
  -- ties for a total order.
  KEY ix_insight_metric_favorites_org_membership (organization_id, membership_id, created_at, id),
  CONSTRAINT fk_insight_metric_favorites_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
