-- 0398_memberships_kind — a membership is a person or an AI employee (plan 60 v2, 60-02, M1).
--
-- Plan 60 v2 §4.1: "An AI employee = a `memberships` row with `kind = 'ai'` + a credential-less
-- `users` row + an `ai_employees` companion row." Assignees, comments, mentions, grants, keys,
-- files and audit already point at `memberships`; this one column carries the difference, and the
-- doors that must refuse an AI employee read it (`policies/ai-employees/doors.ts`, 60-04).
--
-- `kind`: `human` (every existing row, by the default) or `ai`. VARCHAR, not ENUM, so a later
-- kind is an additive change; the stored value is parsed once by `parseMembershipKind` (IP-2) and
-- an unreadable value is refused at every door (deny by default).
--
-- Triggers checked first: `trg_memberships_org_immutable` (0001) compares `organization_id` only,
-- so the new column does not touch it.
--
-- MariaDB-safe (live is MariaDB 11.8, DA-5): one plain ADD COLUMN with a literal default, no
-- generated column, no CHECK, no IF NOT EXISTS. Online on both engines (DA-7: ALGORITHM=INPLACE,
-- LOCK=NONE). Expand only (DA-6): the previous release ignores the column and every row it writes
-- gets `human`. No new grant: the existing table grants on `memberships` cover it.

ALTER TABLE memberships
  ADD COLUMN kind VARCHAR(8) NOT NULL DEFAULT 'human' AFTER role,
  ALGORITHM=INPLACE, LOCK=NONE;
