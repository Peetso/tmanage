import { isIP } from 'node:net';

/**
 * R12 (R1). Is this an address no location database can place — loopback, RFC 1918, CGNAT,
 * link-local, IPv6 ULA / link-local / loopback, or the unspecified address? These are stamped
 * `network_kind = 'local'` and never looked up.
 */
export function isPrivateIp(raw: string): boolean {
  const ip = raw.trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped?.[1]) return isPrivateIp(mapped[1]);
  const family = isIP(ip);
  if (family === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (family === 6) {
    return (
      ip === '::1' || ip === '::' || /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip)
    );
  }
  return false;
}
