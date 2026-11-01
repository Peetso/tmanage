import { describe, expect, it } from 'vitest';
import { firstLinkOf, isRefusedAddress, parseOpenGraph, unfurl } from './link-previews.js';
import type { HopFetcher, Resolver } from './link-previews.js';

const publicDns: Resolver = async (host) => [
  { address: host === 'inner.example' ? '10.1.2.3' : '93.184.216.34', family: 4 },
];
const page = '<title>Plain</title><meta property="og:title" content="Tom &amp; Co">';

describe('link previews — SSRF guard', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '169.254.169.254',
    '192.168.1.1',
    '::1',
    '[::1]',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0.0.0.0',
  ])('refuses %s', (address) => expect(isRefusedAddress(address)).toBe(true));
  it('admits a public address', () => expect(isRefusedAddress('93.184.216.34')).toBe(false));

  it.each([
    ['http://127.0.0.1/', null],
    ['http://[::1]/', null],
    ['http://example.com:8080/', null],
    ['ftp://example.com/', null],
    ['http://user:pw@example.com/', null],
  ])('refuses %s before any fetch', async (url) => {
    const hop: HopFetcher = async () => {
      throw new Error('fetched');
    };
    expect(await unfurl(url, { resolve: publicDns, hop })).toBeNull();
  });

  it('re-checks a redirect and refuses one to a private host', async () => {
    const hop: HopFetcher = async () => ({ kind: 'redirect', location: 'http://inner.example/' });
    expect(await unfurl('https://example.com/', { resolve: publicDns, hop })).toBeNull();
  });

  it('follows a public redirect to the page', async () => {
    const hop: HopFetcher = async (url) =>
      url.pathname === '/a' ? { kind: 'redirect', location: '/b' } : { kind: 'html', body: page };
    expect((await unfurl('https://example.com/a', { resolve: publicDns, hop }))?.title).toBe(
      'Tom & Co',
    );
  });
});

describe('link previews — parsing', () => {
  it('reads og tags, falls back to <title>, resolves the image', () => {
    const html =
      '<meta content=\'Desc\' property=\'og:description\'><meta property="og:image" content="/i.png">' +
      '<meta property="og:site_name" content="Site"><title> Fallback </title>';
    expect(parseOpenGraph(html, 'https://example.com/x')).toEqual({
      title: 'Fallback',
      description: 'Desc',
      imageUrl: 'https://example.com/i.png',
      siteName: 'Site',
    });
  });

  it('finds the first link and trims punctuation', () => {
    expect(firstLinkOf('see (https://example.com/a?b=1). and http://x.y')).toBe(
      'https://example.com/a?b=1',
    );
    expect(firstLinkOf('no link here')).toBeNull();
  });
});
