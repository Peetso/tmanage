-- 0344_figma_refresh_and_wait — Figma pictures that never arrived on live (persona UX test of
-- 69836a13, 2026-11-15: "Taking the snapshot" after 26 s, "Refresh from Figma" answered "Figma is
-- busy" the first time it was pressed).
--
-- figma_links
--   refresh_claimed_at  when "Refresh from Figma" was last started for this link. The few-minute
--                       cooldown is claimed on this column with one conditional UPDATE (security
--                       review M2). It used to be claimed on synced_at, which attaching the link
--                       also writes, so the first refresh after attaching was refused.
--   figma_wait_until    Figma refused the link creator's token with 429 (too many requests):
--                       TManage asks Figma again only after this time. Every process reads it, the
--                       team's screen says when pictures resume, and a refresh in the meantime is
--                       answered with that time instead of "busy".
--
-- MariaDB-safe: plain ADD COLUMN DATETIME(3) NULL.

ALTER TABLE figma_links
  ADD COLUMN refresh_claimed_at DATETIME(3) NULL,
  ADD COLUMN figma_wait_until DATETIME(3) NULL;
