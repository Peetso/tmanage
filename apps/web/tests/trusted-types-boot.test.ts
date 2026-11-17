import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootScripts } from '../src/lib/boot-scripts';
import { inlineScriptBodies } from '../src/lib/csp';
import { localeBootScript } from '../src/lib/i18n/locale-boot';
import { createPrerenderedScriptHashes, sha256Source } from '../src/lib/prerendered-script-hashes';
import { trustedTypesBootScript } from '../src/lib/trusted-types-boot';
import {
  buildHashManifest,
  inlineScriptBodies as buildInlineScriptBodies,
  sha256Source as buildSha256Source,
} from '../scripts/write-csp-hashes.mjs';

/** r47 L2 — the Trusted Types default policy, and the build-time hashes (B18). */

type Rule = (value: string, type?: string, sink?: string) => string | null;
interface Rules {
  createHTML: Rule;
  createScriptURL: Rule;
  createScript: Rule;
}

/** Runs the exact boot-script string against a stand-in window; returns the policy it made. */
function install(development: boolean, inlineTexts: string[] = []): Rules {
  let made: { name: string; rules: Rules } | undefined;
  const fakeWindow = {
    trustedTypes: {
      defaultPolicy: null,
      createPolicy: (name: string, rules: Rules) => {
        made = { name, rules };
      },
    },
    URL,
    location: {
      href: 'https://tmanageapp.com/acme/home',
      origin: 'https://tmanageapp.com',
    },
    document: { scripts: inlineTexts.map((text) => ({ src: '', text })) },
  };
  new Function('window', trustedTypesBootScript(development))(fakeWindow);
  expect(made?.name).toBe('default');
  return made!.rules;
}

describe('the Trusted Types default policy', () => {
  it('passes markup that cannot run script and refuses markup that can', () => {
    const { createHTML } = install(false);
    for (const safe of ['', '&nbsp;', '<style>:host{display:block}</style><div part="x">a</div>']) {
      expect(createHTML(safe, 'TrustedHTML', 'Element innerHTML')).toBe(safe);
    }
    expect(createHTML('<script></script>')).toBe('<script></script>');
    for (const bad of [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<a href="javascript:alert(1)">x</a>',
      '<iframe srcdoc="x"></iframe>',
      '<object data="x"></object>',
    ]) {
      expect(createHTML(bad, 'TrustedHTML', 'Element innerHTML'), bad).toBeNull();
    }
    // DOMParser builds an inert document (the Basecamp import, the OOXML previews).
    const archive = '<p onclick="x()">hi</p>';
    expect(createHTML(archive, 'TrustedHTML', 'DOMParser parseFromString')).toBe(archive);
  });

  it('allows script URLs from this origin and the Google Picker loader only', () => {
    const { createScriptURL } = install(false);
    expect(createScriptURL('/_next/static/chunks/a.js')).toBe('/_next/static/chunks/a.js');
    expect(createScriptURL('/sw.js')).toBe('/sw.js');
    expect(createScriptURL('https://apis.google.com/js/api.js')).toBe(
      'https://apis.google.com/js/api.js',
    );
    expect(createScriptURL('https://evil.example/x.js')).toBeNull();
    expect(createScriptURL('https://apis.google.com.evil.example/js/x.js')).toBeNull();
  });

  it('refuses eval-style script text in production unless it is a script the page already has', () => {
    const boot = localeBootScript();
    const production = install(false, [boot]);
    expect(production.createScript('alert(1)')).toBeNull();
    expect(production.createScript(boot)).toBe(boot);
    expect(install(true).createScript('alert(1)')).toBe('alert(1)');
  });

  it('never contains a closing script tag and does nothing without trustedTypes', () => {
    for (const script of bootScripts(false)) expect(script).not.toMatch(/<\/script/i);
    expect(() => new Function('window', trustedTypesBootScript(false))({})).not.toThrow();
    expect(bootScripts(false)[1]).toBe(localeBootScript());
  });
});

describe('B18: inline-script hashes computed at build time', () => {
  const html =
    '<script>boot()</script><script src="/_next/static/chunks/a.js"></script>' +
    '<script>self.__next_f.push([1])</script>';
  const files: Record<string, string> = {
    'prerender-manifest.json': JSON.stringify({
      routes: {
        '/platform': { routeType: 'page', initialRevalidateSeconds: false },
        '/blog': { routeType: 'page', initialRevalidateSeconds: 60 },
      },
    }),
    'platform.html': html,
  };
  const read = (path: string) => {
    const text = files[basename(path)];
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  };

  it('the build script hashes exactly what the runtime would', () => {
    expect(buildInlineScriptBodies(html)).toEqual(inlineScriptBodies(html));
    expect(buildSha256Source('boot()')).toBe(sha256Source('boot()'));
    const { manifest, missing } = buildHashManifest('', read);
    expect(missing).toEqual([]);
    expect(manifest).toEqual({
      version: 1,
      routes: { '/platform': [sha256Source('boot()'), sha256Source('self.__next_f.push([1])')] },
    });
  });

  it('the proxy reads the build manifest and never re-hashes the HTML when it exists', () => {
    const manifest = { version: 1, routes: { '/platform': ['sha256-AAAA='], '/x': ['bad; *'] } };
    const reads: string[] = [];
    const lookup = createPrerenderedScriptHashes('', (path) => {
      reads.push(basename(path));
      if (basename(path) === 'csp-script-hashes.json') return JSON.stringify(manifest);
      return read(path);
    });
    expect(lookup('/platform')).toEqual(['sha256-AAAA=']);
    expect(lookup('/x')).toEqual([]);
    expect(lookup('/acme/home')).toBeUndefined();
    expect(reads).toEqual(['csp-script-hashes.json']);
  });
});
