-- 0014_notifications_recipient_id_index — the index the inbox read actually uses.
--
-- Governing sources: contracts/tmanage-core.dbml (the notifications table and its two
-- indexes), 28-SPRINT-TICKETS §11 INBOX-001, 24-EVENT-CATALOG.md §6 (the read path resolves
-- objects at display time — so the read path is a hot one).
--
-- ## What 0010 declared, and what INBOX-001 reads
--
-- `ix_notifications_recipient_time (organization_id, recipient_user_id, created_at)` is
-- the contract's own "inbox read" index. The inbox that shipped in INBOX-001 does not sort
-- by `created_at`: ids are UUIDv7, so id order is creation order, and the keyset cursor is
-- `id < before` with `ORDER BY id DESC` — one column, no tie-break, no composite cursor to
-- encode. That is the right read; it just has no index. With only the 0010 indexes, MySQL
-- must either walk the recipient's rows by `created_at` and filesort them by id, or walk
-- the primary key backwards discarding every other recipient's rows. Both are fine at ten
-- rows and neither is fine at a year of them, and notifications are never deleted. Found
-- by the review fleet reading the commit, 2026-09-02, before any page had been slow.
--
-- ## A divergence inside the pack, recorded rather than resolved
--
-- The dbml draws two indexes on this table; this adds a third. 0011's and 0013's rule
-- applies: the running read wins, the addition keeps the house shape, and the dbml can adopt
-- it verbatim when it catches up. `ix_notifications_recipient_time` is kept — it is the
-- contract's, and a `created_at`-ordered read may yet want it.

ALTER TABLE notifications
  ADD KEY ix_notifications_recipient_id (organization_id, recipient_user_id, id);
