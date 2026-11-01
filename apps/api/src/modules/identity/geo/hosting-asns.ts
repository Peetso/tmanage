/**
 * R12 (R1). Is a network a data centre (hosting / cloud) rather than a home or mobile line, and
 * might it be a VPN or proxy? A static list and owner keywords — a hint, never a verdict: the
 * screens say "possible", never "certain".
 */
export const HOSTING_ASNS: ReadonlySet<number> = new Set([
  // AWS, Google Cloud, Microsoft Azure, Oracle, IBM
  16509, 14618, 15169, 396982, 8075, 8068, 31898, 36351,
  // DigitalOcean, Linode/Akamai, Vultr, OVH, Hetzner, Scaleway, Contabo, Leaseweb
  14061, 63949, 20473, 16276, 24940, 12876, 51167, 60781, 28753,
  // Alibaba, Tencent, Cloudflare, Fastly, Hostinger, GoDaddy, M247, Choopa
  45102, 132203, 13335, 54113, 47583, 26496, 9009, 64515,
]);

const HOSTING_KEYWORDS = [
  'hosting',
  'cloud',
  'data center',
  'datacenter',
  'server',
  'colocation',
  'amazon',
  'google',
  'microsoft',
  'digitalocean',
  'linode',
  'ovh',
  'hetzner',
];

const VPN_KEYWORDS = ['vpn', 'proxy', 'anonymous', 'private internet access', 'nord', 'mullvad'];

export function isHostingNetwork(
  asn: number | null | undefined,
  owner: string | null | undefined,
): boolean {
  if (typeof asn === 'number' && HOSTING_ASNS.has(asn)) return true;
  const name = (owner ?? '').toLowerCase();
  return name !== '' && HOSTING_KEYWORDS.some((keyword) => name.includes(keyword));
}

export function hasVpnKeyword(owner: string | null | undefined): boolean {
  const name = (owner ?? '').toLowerCase();
  return name !== '' && VPN_KEYWORDS.some((keyword) => name.includes(keyword));
}
