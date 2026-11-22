import { describe, expect, it } from 'vitest';
import { parseCidrValue, parseIpRange, rangesOverlap } from './ip-ranges.js';

const range = (text: string) => {
  const parsed = parseIpRange(text);
  if (parsed === null) throw new Error(`not a range: ${text}`);
  return parsed;
};

describe('rangesOverlap (the sign-in door overlap rule, SEC-TRACKER)', () => {
  it.each([
    ['203.0.113.7/32', '203.0.113.0/24', true],
    ['203.0.113.0/24', '203.0.113.7', true],
    ['203.0.113.0/24', '203.0.114.0/24', false],
    ['203.0.113.255', '203.0.114.0', false],
    ['160.79.104.0/21', '160.79.106.10/32', true],
    ['2001:db8::/48', '2001:db8:0:1::1', true],
    ['2001:db8::/48', '2001:db9::1', false],
    // IPv4 is mapped into ::ffff:0:0/96, so the two families never collide by accident.
    ['203.0.113.7', '2001:db8::1', false],
  ])('%s and %s overlap: %s', (a, b, expected) => {
    expect(rangesOverlap(range(a), range(b))).toBe(expected);
    expect(rangesOverlap(range(b), range(a))).toBe(expected);
  });
});

describe('parseCidrValue (one spelling for the block list and the source labels)', () => {
  it('stores a bare address as a /32 or /128 and keeps a network CIDR', () => {
    expect(parseCidrValue(' 48.47.63.166 ')?.value).toBe('48.47.63.166/32');
    expect(parseCidrValue('203.0.113.0/24')).toMatchObject({ value: '203.0.113.0/24', bits: 24 });
    expect(parseCidrValue('2001:DB8::/48')).toMatchObject({
      value: '2001:db8::/48',
      family: 6,
      bits: 48,
    });
    expect(parseCidrValue('010.0.0.1')?.value).toBe('10.0.0.1/32');
  });

  it('refuses host bits, junk and impossible prefixes', () => {
    expect(parseCidrValue('203.0.113.7/24')).toBeNull();
    expect(parseCidrValue('203.0.113.0/33')).toBeNull();
    expect(parseCidrValue('203.0.113.0/24/1')).toBeNull();
    expect(parseCidrValue('AS13335')).toBeNull();
    expect(parseCidrValue('')).toBeNull();
    expect(parseCidrValue('1.2.3.4 #x')).toBeNull();
  });
});
