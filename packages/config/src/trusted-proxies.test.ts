import { describe, expect, it } from 'vitest';
import { parseTrustedProxies } from './trusted-proxies.js';

/**
 * D09. The parser behind `TRUSTED_PROXY_ADDRESSES`. `env.test.ts` holds the boot behaviour —
 * the default, and that a refusal names the variable — and this file holds the grammar,
 * where one case per mistake is worth more than one case per variable.
 */
describe('parseTrustedProxies', () => {
  describe('trust nobody', () => {
    it('reads an absent setting as false: the socket peer is the client address', () => {
      expect(parseTrustedProxies('')).toBe(false);
    });

    it('reads a blank setting as false rather than as an empty allowlist', () => {
      expect(parseTrustedProxies('   ')).toBe(false);
    });
  });

  describe('an allowlist', () => {
    it('accepts one IPv4 address', () => {
      expect(parseTrustedProxies('203.0.113.7')).toEqual(['203.0.113.7']);
    });

    it('accepts one IPv6 address', () => {
      expect(parseTrustedProxies('2001:db8::1')).toEqual(['2001:db8::1']);
    });

    it('accepts several addresses and keeps the operator’s order', () => {
      expect(parseTrustedProxies('203.0.113.7,198.51.100.4,::1')).toEqual([
        '203.0.113.7',
        '198.51.100.4',
        '::1',
      ]);
    });

    it('accepts an IPv4 CIDR range', () => {
      expect(parseTrustedProxies('10.0.0.0/8')).toEqual(['10.0.0.0/8']);
    });

    it('accepts an IPv6 CIDR range', () => {
      expect(parseTrustedProxies('2001:db8::/32')).toEqual(['2001:db8::/32']);
    });

    it('accepts the widest and narrowest prefix lengths a proxy can be named by', () => {
      expect(parseTrustedProxies('128.0.0.0/1,10.1.2.3/32,2001:db8::/1,2001:db8::1/128')).toEqual([
        '128.0.0.0/1',
        '10.1.2.3/32',
        '2001:db8::/1',
        '2001:db8::1/128',
      ]);
    });

    it('tolerates whitespace around the separators, which a wrapped .env line produces', () => {
      expect(parseTrustedProxies(' 203.0.113.7 , 10.0.0.0/8 ')).toEqual([
        '203.0.113.7',
        '10.0.0.0/8',
      ]);
    });
  });

  describe('refusals — a wrong list is refused, never repaired', () => {
    it('refuses an empty element: a stray or trailing comma is a typo, not "everything"', () => {
      expect(() => parseTrustedProxies('203.0.113.7,,198.51.100.4')).toThrow(/entry 2 is empty/);
      expect(() => parseTrustedProxies('203.0.113.7,')).toThrow(/entry 2 is empty/);
      expect(() => parseTrustedProxies(',')).toThrow(/entry 1 is empty/);
    });

    it('refuses something that is not an address at all', () => {
      expect(() => parseTrustedProxies('edge.tmanage.example')).toThrow(
        /not an IPv4 or IPv6 address/,
      );
      expect(() => parseTrustedProxies('not-an-address')).toThrow(/not an IPv4 or IPv6 address/);
    });

    it('refuses a hop count: a number is not an address, and a guessed hop count is not the fix', () => {
      expect(() => parseTrustedProxies('1')).toThrow(/not an IPv4 or IPv6 address/);
    });

    it('refuses a proxy-addr range keyword — the list is addresses, not names', () => {
      expect(() => parseTrustedProxies('loopback')).toThrow(/not an IPv4 or IPv6 address/);
      expect(() => parseTrustedProxies('uniquelocal')).toThrow(/not an IPv4 or IPv6 address/);
    });

    it('refuses true and false: the setting stopped being a boolean', () => {
      expect(() => parseTrustedProxies('true')).toThrow(/not an IPv4 or IPv6 address/);
      expect(() => parseTrustedProxies('false')).toThrow(/not an IPv4 or IPv6 address/);
    });

    it('refuses an octet out of range, and a dotted quad with a leading zero', () => {
      expect(() => parseTrustedProxies('999.1.1.1')).toThrow(/not an IPv4 or IPv6 address/);
      // 010.0.0.1 is 8.0.0.1 to a parser that reads it as octal and 10.0.0.1 to one that
      // does not; an allowlist may not depend on which.
      expect(() => parseTrustedProxies('010.0.0.1')).toThrow(/not an IPv4 or IPv6 address/);
    });

    it('refuses a prefix length outside its family', () => {
      expect(() => parseTrustedProxies('10.0.0.0/33')).toThrow(/prefix length/);
      expect(() => parseTrustedProxies('2001:db8::/129')).toThrow(/prefix length/);
    });

    it('refuses /0, which is trust-all spelled as a range — and which Fastify will not take', () => {
      // `@fastify/proxy-addr`'s `parseipNotation` throws `invalid range on address` for a
      // zero prefix, so an accepted `/0` would pass validation here and then kill boot from
      // inside a dependency, with nothing naming `TRUSTED_PROXY_ADDRESSES`. It is also the
      // configuration this whole slice exists to remove.
      expect(() => parseTrustedProxies('0.0.0.0/0')).toThrow(/prefix length/);
      expect(() => parseTrustedProxies('::/0')).toThrow(/prefix length/);
    });

    it('refuses a slash with nothing, or nonsense, after it', () => {
      expect(() => parseTrustedProxies('10.0.0.0/')).toThrow(/prefix length/);
      expect(() => parseTrustedProxies('10.0.0.0/eight')).toThrow(/prefix length/);
      expect(() => parseTrustedProxies('10.0.0.0/8/8')).toThrow(/prefix length/);
    });

    it('refuses a CIDR whose address half is not an address', () => {
      expect(() => parseTrustedProxies('edge.tmanage.example/24')).toThrow(
        /not an IPv4 or IPv6 address/,
      );
    });

    it('names the offending entry’s position and text, so a long list is fixable', () => {
      expect(() => parseTrustedProxies('203.0.113.7,10.0.0.0/33,::1')).toThrow(
        /entry 2 \("10\.0\.0\.0\/33"\)/,
      );
    });
  });
});
