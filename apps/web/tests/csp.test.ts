import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildContentSecurityPolicy,
  inlineScriptBodies,
  nonceFromBytes,
  policyHeaders,
  resolveCspMode,
  TRUSTED_TYPES_REPORT_ONLY,
} from '../src/lib/csp';
import { createPrerenderedScriptHashes, sha256Source } from '../src/lib/prerendered-script-hashes';

/** 56-01 — the pure policy builder `src/proxy.ts` calls on every page request. */

const directive = (policy: string, name: string) =>
  policy.split('; ').find((part) => part.startsWith(`${name} `)) ?? '';

describe('the browser security policy', () => {
  it('nonces scripts with strict-dynamic, never unsafe-inline, and allows the boot script by hash', () => {
    const policy = buildContentSecurityPolicy({
      nonce: 'abc123==',
      host: 'tmanage.peetrix.com',
      development: false,
      scriptHashes: ['sha256-xyz='],
    });
    const scripts = directive(policy, 'script-src');
    expect(scripts).toBe("script-src 'self' 'nonce-abc123==' 'strict-dynamic' 'sha256-xyz='");
    expect(directive(policy, 'connect-src')).toContain('wss://tmanage.peetrix.com');
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain('report-uri /csp-report');
    expect(policy).not.toContain('unsafe-eval');
  });

  it('lets the viewer embed Figma frames (R4 slice 13) and nothing else from Figma', () => {
    const policy = buildContentSecurityPolicy({
      nonce: 'abc123==',
      host: 'tmanage.peetrix.com',
      development: false,
    });
    const frames = directive(policy, 'frame-src');
    expect(frames).toContain('https://embed.figma.com');
    expect(frames).toContain('https://www.figma.com');
    expect(directive(policy, 'script-src')).not.toContain('figma');
    expect(directive(policy, 'connect-src')).not.toContain('figma');
    expect(directive(policy, 'img-src')).not.toContain('figma');
  });

  it('admits a cross-origin API (dev, e2e) and refuses a Host header that is not a host', () => {
    const policy = buildContentSecurityPolicy({
      nonce: 'n',
      host: 'evil.example; script-src *',
      apiBaseUrl: 'http://localhost:3101',
      development: true,
    });
    expect(directive(policy, 'connect-src')).toContain('http://localhost:3101 ws://localhost:3101');
    expect(directive(policy, 'connect-src')).not.toContain('evil');
    expect(directive(policy, 'script-src')).toContain("'unsafe-eval'");
    expect(
      buildContentSecurityPolicy({ nonce: 'n', apiBaseUrl: 'same-origin', development: false }),
    ).not.toContain('localhost');
  });

  it('report-only by default; enforce only on the exact word; Trusted Types always report-only', () => {
    expect(resolveCspMode(undefined)).toBe('report-only');
    expect(resolveCspMode('enforced')).toBe('report-only');
    expect(resolveCspMode(' Enforce ')).toBe('enforce');

    const soak = policyHeaders({ nonce: 'n', mode: 'report-only', development: false });
    expect(soak.request['x-nonce']).toBe('n');
    expect(soak.request['content-security-policy-report-only']).toContain("'nonce-n'");
    expect(soak.response).toContainEqual(['content-security-policy', "frame-ancestors 'none'"]);
    expect(soak.response).toContainEqual([
      'content-security-policy-report-only',
      TRUSTED_TYPES_REPORT_ONLY,
    ]);

    const enforced = policyHeaders({ nonce: 'n', mode: 'enforce', development: false });
    expect(enforced.request['content-security-policy']).toContain("'nonce-n'");
    expect(enforced.response.map(([name]) => name)).toEqual([
      'content-security-policy',
      'content-security-policy-report-only',
    ]);
  });

  it('B18: a prerendered page gets self plus its inline-script hashes, no nonce, no unsafe-inline', () => {
    const html =
      '<script>boot()</script><script src="/_next/static/chunks/a.js" async=""></script>' +
      '<script>self.__next_f.push([1])</script>';
    expect(inlineScriptBodies(html)).toEqual(['boot()', 'self.__next_f.push([1])']);
    const files: Record<string, string> = {
      'prerender-manifest.json': JSON.stringify({
        routes: {
          '/platform': { routeType: 'page', initialRevalidateSeconds: false },
          '/robots.txt': { routeType: 'route', initialRevalidateSeconds: false },
        },
      }),
      'platform.html': html,
    };
    const lookup = createPrerenderedScriptHashes('', (path) => {
      const text = files[basename(path)];
      if (text === undefined) throw new Error(`missing ${path}`);
      return text;
    });
    expect(lookup('/acme/home')).toBeUndefined();
    expect(lookup('/robots.txt')).toBeUndefined();
    const hashes = lookup('/platform') ?? [];
    expect(hashes).toEqual([sha256Source('boot()'), sha256Source('self.__next_f.push([1])')]);

    const scripts = directive(
      buildContentSecurityPolicy({
        nonce: 'abc123==',
        development: false,
        prerendered: true,
        scriptHashes: ['sha256-boot=', 'sha256-boot=', ...hashes],
      }),
      'script-src',
    );
    expect(scripts).toBe(
      `script-src 'self' 'sha256-boot=' ${hashes.map((h) => `'${h}'`).join(' ')}`,
    );
    expect(scripts).not.toMatch(/nonce|strict-dynamic|unsafe-inline/);
  });

  it('encodes 16 bytes as a 24-character base64 nonce', () => {
    expect(nonceFromBytes(new Uint8Array(16).fill(255))).toBe('/////////////////////w==');
  });
});
