import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildContentSecurityPolicy,
  HSTS_VALUE,
  hstsHeaderRules,
  inlineScriptBodies,
  isEmbeddablePath,
  nonceFromBytes,
  policyHeaders,
  resolveCspMode,
} from '../src/lib/csp';
import { createPrerenderedScriptHashes, sha256Source } from '../src/lib/prerendered-script-hashes';

/** 56-01 — the pure policy builder `src/proxy.ts` calls on every page request. */

const directive = (policy: string, name: string) =>
  policy.split('; ').find((part) => part.startsWith(`${name} `)) ?? '';

describe('the browser security policy', () => {
  it('nonces scripts with strict-dynamic, never unsafe-inline, and allows the boot script by hash', () => {
    const policy = buildContentSecurityPolicy({
      nonce: 'abc123==',
      host: 'tmanageapp.com',
      development: false,
      scriptHashes: ['sha256-xyz='],
    });
    const scripts = directive(policy, 'script-src');
    expect(scripts).toBe("script-src 'self' 'nonce-abc123==' 'strict-dynamic' 'sha256-xyz='");
    expect(directive(policy, 'connect-src')).toContain('wss://tmanageapp.com');
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain('report-uri /csp-report');
    expect(policy).not.toContain('unsafe-eval');
  });

  it('lets the viewer embed Figma frames (R4 slice 13) and nothing else from Figma', () => {
    const policy = buildContentSecurityPolicy({
      nonce: 'abc123==',
      host: 'tmanageapp.com',
      development: false,
    });
    const frames = directive(policy, 'frame-src');
    expect(frames).toContain('https://embed.figma.com');
    expect(frames).toContain('https://www.figma.com');
    expect(directive(policy, 'script-src')).not.toContain('figma');
    expect(directive(policy, 'connect-src')).not.toContain('figma');
    expect(directive(policy, 'img-src')).not.toContain('figma');
  });

  it('lets the viewer frame a blob it made (sandboxed HTML preview) but never a data: URL', () => {
    const policy = buildContentSecurityPolicy({
      nonce: 'abc123==',
      host: 'tmanageapp.com',
      development: false,
    });
    const frames = directive(policy, 'frame-src');
    expect(frames).toContain('blob:');
    expect(frames).not.toContain('data:');
    expect(directive(policy, 'script-src')).not.toContain('blob:');
    expect(directive(policy, 'object-src')).toBe("object-src 'none'");
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

  it('enforces by default in production; report-only only on CSP_MODE=report (or in dev)', () => {
    expect(resolveCspMode(undefined, true)).toBe('enforce');
    expect(resolveCspMode('reprot', true)).toBe('enforce');
    expect(resolveCspMode(' Report ', true)).toBe('report-only');
    expect(resolveCspMode('report-only', true)).toBe('report-only');
    expect(resolveCspMode(undefined, false)).toBe('report-only');
    expect(resolveCspMode('enforce', false)).toBe('enforce');
  });

  it('report mode: whole policy report-only, frame-ancestors still enforced, Reporting-Endpoints', () => {
    const soak = policyHeaders({ nonce: 'n', mode: 'report-only', development: false });
    expect(soak.request['x-nonce']).toBe('n');
    expect(soak.request['content-security-policy-report-only']).toContain("'nonce-n'");
    expect(soak.response).toContainEqual(['content-security-policy', "frame-ancestors 'none'"]);
    expect(soak.response).toContainEqual(['reporting-endpoints', 'csp-endpoint="/csp-report"']);
  });

  it('enforce mode: one enforced policy carrying Trusted Types and both report channels', () => {
    const enforced = policyHeaders({ nonce: 'n', mode: 'enforce', development: false });
    const policy = enforced.request['content-security-policy'] ?? '';
    expect(policy).toContain("'nonce-n'");
    expect(directive(policy, 'require-trusted-types-for')).toBe(
      "require-trusted-types-for 'script'",
    );
    expect(directive(policy, 'trusted-types')).toBe('trusted-types default nextjs nextjs#bundler');
    expect(policy).toContain('report-uri /csp-report');
    expect(policy).toContain('report-to csp-endpoint');
    expect(directive(policy, 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
    expect(directive(policy, 'script-src')).not.toContain('unsafe-inline');
    expect(enforced.response.map(([name]) => name)).toEqual([
      'content-security-policy',
      'reporting-endpoints',
    ]);
  });

  it('frame-ancestors none on every route but the public form embed /f/[slug]', () => {
    for (const path of ['/', '/sign-in', '/connect/x', '/acme/ai/approve/1', '/f/a/b', '/f']) {
      expect(isEmbeddablePath(path), path).toBe(false);
    }
    expect(isEmbeddablePath('/f/contact-us')).toBe(true);
    const form = policyHeaders({
      nonce: 'n',
      mode: 'enforce',
      development: false,
      embeddable: true,
    });
    expect(form.request['content-security-policy']).toContain("frame-ancestors 'self' https:");
    const page = policyHeaders({ nonce: 'n', mode: 'report-only', development: false });
    expect(page.response).toContainEqual(['content-security-policy', "frame-ancestors 'none'"]);
  });

  it('HSTS: two years, includeSubDomains, preload, only on X-Forwarded-Proto https', () => {
    expect(HSTS_VALUE).toBe('max-age=63072000; includeSubDomains; preload');
    const [rule] = hstsHeaderRules();
    expect(rule?.headers).toEqual([{ key: 'Strict-Transport-Security', value: HSTS_VALUE }]);
    const condition = rule?.has[0];
    expect(condition?.key).toBe('x-forwarded-proto');
    // Next matches `has` values as `^value$`.
    const matches = (value: string) => new RegExp(`^${condition?.value ?? ''}$`).test(value);
    expect(matches('https')).toBe(true);
    expect(matches('https, http')).toBe(true);
    expect(matches('http')).toBe(false);
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
