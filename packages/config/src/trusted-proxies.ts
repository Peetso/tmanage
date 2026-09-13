import { isIP } from 'node:net';

/**
 * Which peers may speak for somebody else: `TRUSTED_PROXY_ADDRESSES`, parsed.
 *
 * Review finding D09 (2026-09-05) — `main.ts` passed Fastify `trustProxy: true`, so every
 * `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto` header was believed no matter
 * who sent it. A client could therefore choose the address every address-keyed control counts
 * against, and D08's sign-in abuse budgets rotated with it: one host could present as any
 * number of addresses, and could spend the global budget and refuse everybody's sign-in.
 *
 * ## The format
 *
 *     TRUSTED_PROXY_ADDRESSES=203.0.113.7,10.0.0.0/8,2001:db8::/32
 *
 * A comma-separated list of IPv4/IPv6 addresses and CIDR ranges: the peers whose forwarding
 * headers are believed, and nobody else's. Unset or blank is **trust nobody**, which is the
 * safe default the finding asks for — with no proxy in front of the origin, the socket peer
 * is the truth and is free.
 *
 * ## Why this shape, and not a hop count
 *
 * Fastify accepts a boolean, a hop count, an address list, or a predicate function. This
 * parser produces exactly two of those forms — `false`, or `string[]` — so what the operator
 * writes is what Fastify is handed, with no second notion of trust in between that could
 * drift from this one. A hop count is deliberately not offered: it asserts the *shape* of a
 * topology rather than its *identity*, and a request that arrives with extra forwarded hops
 * moves the address it selects, which is the same defect in a different spelling.
 *
 * ## It refuses rather than repairs
 *
 * A name instead of an address, a stray comma, a `/33`: each one would otherwise become a
 * silent "trust nobody" at boot and a proxy deployment whose controls all count the edge's
 * own address, or — worse, if the repair went the other way — trust the wrong peer. Boot
 * fails and names the entry.
 *
 * Range keywords (`loopback`, `linklocal`, `uniquelocal`) that `proxy-addr` would accept are
 * refused here too. They read as addresses without being any particular one, and an operator
 * who means the host's own loopback can write `127.0.0.1,::1` and be read literally.
 *
 * One thing this parser passes through without honouring: an IPv6 zone index. `fe80::1%eth0`
 * is a valid address to `node:net`, and `@fastify/proxy-addr` matches `fe80::1` arriving on
 * any interface, with or without the zone. The entry is therefore as trusting as the address
 * alone — never more — but it does not mean "only over eth0", and an operator writing one
 * should know that the interface is not part of the comparison.
 */

/**
 * What Fastify is handed. `false` is trust nobody; a list is the peers whose forwarding
 * headers are believed. Mutable because Fastify's `trustProxy` option takes `string[]` —
 * a `readonly` array here would need a copy at the boundary, which is the translation layer
 * this type exists to avoid.
 */
export type TrustedProxies = false | string[];

/** A prefix length is a plain decimal integer: no sign, no leading zero, no `/08`. */
const PREFIX = /^(?:0|[1-9]\d*)$/;

function parseEntry(entry: string, index: number): string {
  const where = `entry ${index + 1}`;
  const text = entry.trim();
  if (text === '') {
    throw new TypeError(`${where} is empty: entries are separated by "," with none trailing`);
  }

  const slash = text.indexOf('/');
  const address = slash === -1 ? text : text.slice(0, slash);

  // `node:net` rather than a regular expression of our own: it is strict about the forms
  // that matter here — `999.1.1.1` and `010.0.0.1` are both refused, and a dotted quad with
  // a leading zero is exactly the entry that means two different networks to two different
  // parsers.
  const family = isIP(address);
  if (family === 0) {
    throw new TypeError(
      `${where} ("${text}") is not an IPv4 or IPv6 address or CIDR range: "${address}" is not an IPv4 or IPv6 address`,
    );
  }

  if (slash === -1) return text;

  const prefix = text.slice(slash + 1);
  // IPv4 has 32 bits of address, IPv6 has 128; a prefix may name all of them, down to one.
  //
  // `/0` is refused at the bottom, for two reasons that agree. It matches every address, so
  // it is `trustProxy: true` spelled as a range — the configuration this whole setting exists
  // to remove. And `@fastify/proxy-addr`'s `parseipNotation` throws `invalid range on
  // address` for a zero prefix, so accepting it here would mean a configuration that passes
  // validation and then kills boot from inside a dependency, with nothing naming
  // `TRUSTED_PROXY_ADDRESSES` — the failure this parser exists to prevent.
  const bits = family === 4 ? 32 : 128;
  const length = Number(prefix);
  if (!PREFIX.test(prefix) || length < 1 || length > bits) {
    throw new TypeError(
      `${where} ("${text}") has no usable prefix length: expected /1 to /${bits} after the address`,
    );
  }
  return text;
}

/**
 * Parse `TRUSTED_PROXY_ADDRESSES` into the value Fastify's `trustProxy` receives.
 *
 * @throws TypeError naming the offending entry. `env.ts` turns that into a boot failure that
 * also names the variable.
 */
export function parseTrustedProxies(raw: string): TrustedProxies {
  const text = raw.trim();
  // Absent and blank are the same statement — there is no proxy in front of this origin —
  // and neither is a fallback from something that failed: nothing was configured, so nothing
  // is trusted. An empty *element* inside a list is a different thing and is refused above.
  if (text === '') return false;
  return text.split(',').map(parseEntry);
}
