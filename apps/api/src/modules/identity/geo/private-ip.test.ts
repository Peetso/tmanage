import { describe, expect, it } from 'vitest';
import { isPrivateIp } from './private-ip.js';

const LOCAL =
  '127.0.0.1 10.1.2.3 172.16.0.1 172.31.9.9 192.168.1.1 169.254.1.1 100.64.0.1 ::1 fd12::1 fe80::1';
const PUBLIC = '8.8.8.8 172.32.0.1 2001:4860::8888 ::ffff:8.8.8.8 not-an-ip';

describe('R12 private addresses', () => {
  it('marks loopback, RFC 1918, CGNAT, link-local and ULA as local, and nothing else', () => {
    expect(`${LOCAL} ::ffff:10.0.0.1`.split(' ').filter((ip) => !isPrivateIp(ip))).toEqual([]);
    expect(PUBLIC.split(' ').filter(isPrivateIp)).toEqual([]);
  });
});
