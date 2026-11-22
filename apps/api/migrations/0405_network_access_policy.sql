-- 0405_network_access_policy — refuse sign-in from VPN, proxy, Tor and data-centre addresses
-- (SEC-ALERTS item 7, Peter 2026-11-22: "don't accept any VPN").
--
-- Three GLOBAL tables (an address belongs to no company):
--
-- - `network_block_lists` — one row per free block list (`x4b_vpn`, `x4b_datacenter`,
--   `tor_exit`, `ip2proxy_px1`): where it comes from, its licence, the version now in force, when
--   it was last fetched and the last error (text without secrets: the IP2Proxy token is never
--   stored or logged). Written by the worker's daily refresh beside the ip-lookup sweep.
-- - `network_block_ranges` — the ranges of each list version as 32-hex-character keys (IPv4 mapped
--   into ::ffff:0:0/96, `packages/domain/src/security/ip-ranges.ts`). A refresh writes a new
--   version, switches `active_version`, then deletes the old version's rows, so a reader never sees
--   a half-written list. The API loads the active versions into memory.
-- - `network_access_allowlist` — addresses, CIDRs and ASNs that are never refused (our own
--   testers). Written by platform admins (`/v1/platform/security/network-allowlist`, audited) and
--   seeded below with the two sources Peter named: the Instinct tester and Anthropic's range
--   (Claude's checks). Neither is a secret. No person id is kept: who added or removed an entry is
--   in the platform audit trail (`platform.network_allowlist_added` / `_removed`).
--   `kind` is `cidr` (an address is a /32 or /128) or `asn` (the decimal AS number).
--
-- The policy switch is `platform_settings['security.anonymous_networks']`: `refuse` (default when
-- the row is absent) or `allow`.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, CHAR/VARCHAR/DATETIME(3), no JSON type, no generated column, no CHECK, no
-- functional index. INSERT IGNORE seeds: idempotent. Additive only.

CREATE TABLE network_block_lists (
  list_key        VARCHAR(32)   NOT NULL,
  source_url      VARCHAR(255)  NOT NULL,
  licence         VARCHAR(190)  NOT NULL,
  active_version  CHAR(16)      NULL,
  range_count     INT           NOT NULL DEFAULT 0,
  fetched_at      DATETIME(3)   NULL,
  last_attempt_at DATETIME(3)   NULL,
  last_error      VARCHAR(255)  NULL,
  PRIMARY KEY (list_key)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE network_block_ranges (
  list_key    VARCHAR(32) NOT NULL,
  version     CHAR(16)    NOT NULL,
  range_start CHAR(32)    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  range_end   CHAR(32)    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (list_key, version, range_start)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE network_access_allowlist (
  id          CHAR(36)     NOT NULL,
  kind        VARCHAR(8)   NOT NULL,
  value       VARCHAR(64)  NOT NULL,
  note        VARCHAR(190) NULL,
  created_at  DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_network_access_allowlist_value (kind, value)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO network_block_lists (list_key, source_url, licence)
VALUES
  ('x4b_vpn', 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/', 'MIT (X4BNet/lists_vpn README); built partly from IPLocate data, CC BY-SA 4.0'),
  ('x4b_datacenter', 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/', 'MIT (X4BNet/lists_vpn README); built partly from IPLocate data, CC BY-SA 4.0'),
  ('tor_exit', 'https://check.torproject.org/torbulkexitlist', 'Tor Project public exit list'),
  ('ip2proxy_px1', 'https://www.ip2location.com/download', 'IP2Proxy LITE, free with attribution: "TManage uses the IP2Proxy LITE database for proxy and VPN detection."');

INSERT IGNORE INTO network_access_allowlist (id, kind, value, note, created_at)
VALUES
  ('0193b5a0-0000-7000-8000-00000000a101', 'cidr', '48.47.63.166/32', 'Instinct AI tester (Peter, 2026-11-22)', CURRENT_TIMESTAMP(3)),
  ('0193b5a0-0000-7000-8000-00000000a102', 'cidr', '160.79.104.0/21', 'Anthropic, Claude checks (Peter, 2026-11-22)', CURRENT_TIMESTAMP(3));
