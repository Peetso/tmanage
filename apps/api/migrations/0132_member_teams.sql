-- 0132_member_teams — named people teams and their members (x262, People module 14).
--
-- Governing sources: 38-MODULE-MAP §People ("Directory, teams, profile" — the untouched "teams"
-- surface; x168 built the directory, x216-x218 the profile/org-chart/availability), planning PEO-03
-- "Team detail" (members, active work, capacity, contacts), 23-ERD-AND-STATE-MACHINES §2
-- (tenant-scoped, parent-owned records), 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- The People module has a directory (x168) and a per-member profile (x169/x216) but no way to gather
-- members into a named team and read that team's roster. This is that object at its smallest useful
-- size: define a named team once per studio, then assign / unassign org members to it, and read one
-- team with its members.
--
-- ## One table, two row kinds (the x233 `work_item_labels` pattern)
--
-- `member_teams` holds both halves in one table, distinguished by nullability:
--
--   * A **definition** row carries `name`, with `team_id` and `membership_id` NULL. It is the team.
--     `name` is unique per tenant (`uq_member_teams_org_name`); the many NULL names on assignment
--     rows do not collide because a UNIQUE index treats NULLs as distinct — a duplicate team name is
--     a 409.
--   * An **assignment** row carries `team_id` (pointing at a definition row) + `membership_id`, with
--     `name` NULL. `(organization_id, team_id, membership_id)` is unique so assigning is idempotent —
--     a second identical assign is a no-op, not a duplicate row.
--
-- ## Parent- and tenant-scoped
--
-- Everything belongs to one studio. `organization_id` scopes every row. Two composite foreign keys
-- make a cross-tenant reference a non-existent pair rather than a leak: the self-referential
-- `fk_member_teams_team` binds `(organization_id, team_id)` to this table's own `(organization_id,
-- id)`, and `fk_member_teams_member` binds `(organization_id, membership_id)` to `memberships
-- (organization_id, id)`. That is the engine half of the trap the service also enforces in code: a
-- cross-tenant team id, or an assignment of a membership that is not a member of this studio, is a
-- 404 with no write, never a row against someone else's org.
--
-- ## Identity is immutable
--
-- `organization_id` is what a row *is* — moving it to another studio is not an edit. The
-- `BEFORE UPDATE` trigger holds that at the engine, the way `work_item_labels` (0105) does; ADR-0001
-- layers 3 and 4 are application-side and a direct SQL session bypasses both.

CREATE TABLE member_teams (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  -- Set on ASSIGNMENT rows (the definition row this points at); NULL on DEFINITION rows.
  team_id          CHAR(36)     NULL,
  -- Set on ASSIGNMENT rows (the assigned member's membership); NULL on DEFINITION rows.
  membership_id    CHAR(36)     NULL,
  -- Set on DEFINITION rows (the team's display name, unique per tenant); NULL on ASSIGNMENT rows.
  name             VARCHAR(120) NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries; also the target of the
  -- self-referential team foreign key below.
  UNIQUE KEY uq_member_teams_org_id (organization_id, id),
  -- A team's name is unique per studio. Assignment rows carry a NULL name and a UNIQUE index treats
  -- NULLs as distinct, so they never collide here.
  UNIQUE KEY uq_member_teams_org_name (organization_id, name),
  -- Assigning is idempotent: one (team, membership) pair once. Definition rows carry NULLs in both
  -- columns and so are exempt from this constraint.
  UNIQUE KEY uq_member_teams_assignment (organization_id, team_id, membership_id),
  -- The index a team's roster is read by: this tenant's assignment rows for one team.
  KEY ix_member_teams_team (organization_id, team_id, id),
  -- An assignment can only ever name a team definition of its own tenant.
  CONSTRAINT fk_member_teams_team
    FOREIGN KEY (organization_id, team_id) REFERENCES member_teams (organization_id, id),
  -- An assignment can only ever name a membership of its own tenant.
  CONSTRAINT fk_member_teams_member
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A team row's tenant is immutable, for the reason `work_item_labels`' trigger gives: moving it to
-- another studio would change what it is, silently.
DELIMITER $$

CREATE TRIGGER trg_member_teams_immutable
BEFORE UPDATE ON member_teams FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'member_teams.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
