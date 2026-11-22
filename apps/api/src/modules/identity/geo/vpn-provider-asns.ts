/**
 * SEC-ALERTS item 7, layer A — networks that sell VPN exits (consumer VPNs rent their exit
 * servers from these carriers). An address announced by one of them is refused like a data-centre
 * address. Each ASN was checked against its registry name on Hurricane Electric's BGP toolkit
 * (https://bgp.he.net/AS<n>) on 2026-11-22. The registry names are verified; the "why" column is
 * the public reputation of each carrier as a VPN exit host and is NOT independently verified:
 *
 * | ASN    | Registered to       | Why listed                                              |
 * | ------ | ------------------- | ------------------------------------------------------- |
 * | 9009   | M247 Europe SRL     | hosts exits of many consumer VPNs (also in HOSTING_ASNS) |
 * | 60068  | Datacamp Limited    | CDN77 / Datacamp, a common VPN exit carrier              |
 * | 212238 | Datacamp Limited    | second Datacamp ASN                                      |
 * | 147049 | PacketHub S.A.      | PacketHub, the network behind NordVPN's exits            |
 * | 136787 | PacketHub S.A.      | second PacketHub ASN                                     |
 * | 207137 | PacketHub S.A.      | third PacketHub ASN                                      |
 * | 62240  | Clouvider Limited   | UK hosting, a common VPN exit carrier                    |
 * | 39351  | 31173 Services AB   | the network behind Mullvad's exits                       |
 *
 * The X4BNet lists (`network_block_lists`) carry the same carriers by range and many more; this
 * list still matters when the ASN database knows an address the range lists do not yet.
 */
export const VPN_PROVIDER_ASNS: ReadonlySet<number> = new Set([
  9009, 60068, 212238, 147049, 136787, 207137, 62240, 39351,
]);
