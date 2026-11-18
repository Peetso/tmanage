import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type JSZipType from 'jszip';
import { describe, expect, it } from 'vitest';
import { appNamespaces } from '../../../scripts/i18n/site-namespaces.mjs';
import { APP_NAMESPACES } from '../src/lib/i18n/catalog-app-namespaces';
import { partOfKey } from '../src/lib/i18n/catalog-part';
import { catalogPartResponse } from '../src/lib/i18n/catalog-part-response';
import { CATALOG_VERSION } from '../src/lib/i18n/catalog-part-path';
import { LocaleStore, type CatalogAccess } from '../src/lib/i18n/locale-store';
import en from '../src/lib/i18n/messages/en.json';
import ur from '../src/lib/i18n/messages/ur.json';

/**
 * DOMAINIMPORT2. Two things once made every browser bundle heavy or noisy:
 * - all seven non-English catalogs (about 9 MB) sat in the root layout's chunk, for every visitor;
 * - JSZip's Node entry pulled the Node stream/util stand-ins into the Office viewers and the
 *   import reader, and util's `Function("return function*() {}")` tripped Trusted Types.
 * These cases fail if either comes back.
 */
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
/** A value import of any catalog (CATSPLIT: not even English is bundled). */
const CATALOG_IMPORT = /^import\s+\w+\s+from\s+'\.\/messages\/[^']+\.json'/m;

describe('client bundle weight guards', () => {
  it('the browser resolves the catalogs lazily and t.ts bundles none', () => {
    const pkg = JSON.parse(read('../package.json')) as {
      imports: Record<string, { browser: string; default: string }>;
    };
    expect(pkg.imports['#i18n-catalogs']).toEqual({
      browser: './src/lib/i18n/catalogs-lazy.ts',
      default: './src/lib/i18n/catalogs-all.ts',
    });
    expect(read('../src/lib/i18n/t.ts')).not.toMatch(CATALOG_IMPORT);
    expect(read('../src/lib/i18n/catalogs-lazy.ts')).not.toMatch(CATALOG_IMPORT);
  });

  it('the browser gets JSZip’s self-contained build, which carries no Node stand-in', () => {
    const config = read('../next.config.ts');
    expect(config).toMatch(
      /resolveAlias:\s*\{\s*jszip:\s*\{\s*browser:\s*'jszip\/dist\/jszip\.min\.js'/,
    );
    const require = createRequire(import.meta.url);
    const browserBuild = readFileSync(require.resolve('jszip/dist/jszip.min.js'), 'utf8');
    expect(browserBuild).not.toContain('return function*() {}');
    // Its only outside name is `stream`, probed inside try/catch and left undefined (`void 0`).
    expect([...browserBuild.matchAll(/\{([a-z-]+):void 0\}/g)].map((m) => m[1])).toEqual([
      'stream',
    ]);
  });

  it('JSZip’s browser build opens an Office package as the viewers do', async () => {
    const require = createRequire(import.meta.url);
    const JSZip = require('jszip/dist/jszip.min.js') as typeof JSZipType;
    const docx = new JSZip();
    docx.file('word/document.xml', '<w:document><w:body><w:p>Hello</w:p></w:body></w:document>');
    const bytes = await docx.generateAsync({ type: 'uint8array' });
    const opened = await JSZip.loadAsync(bytes);
    expect(await opened.file('word/document.xml')?.async('string')).toContain('Hello');
  });

  it('a language switch is published once its catalog has arrived, never before', async () => {
    let arrive: () => void = () => undefined;
    const loaded = new Set<string>(['en']);
    const catalogs: CatalogAccess = {
      ready: (locale) => loaded.has(locale.split('-')[0] ?? ''),
      load: () =>
        new Promise<void>((resolve) => {
          arrive = () => {
            loaded.add('fr');
            resolve();
          };
        }),
    };
    const store = new LocaleStore('en-US', undefined, catalogs);
    const seen: string[] = [];
    store.subscribe((locale) => seen.push(locale));

    store.set('fr-FR');
    expect(store.get()).toBe('en-US');
    // Saved at once, so a page the switch navigates to boots in French.
    expect(document.cookie).toContain('tmanage_locale=fr-FR');
    arrive();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get()).toBe('fr-FR');
    expect(seen).toEqual(['fr-FR']);
  });
});

/** A path in the last `next build`'s output (vitest runs in apps/web). */
const built = (path: string): string => join(process.cwd(), '.next', path);

/** The JavaScript a prerendered page names in its HTML, in bytes (raw), from the last `next build`. */
function firstLoadJs(htmlFile: string): number {
  const html = readFileSync(built(`server/app/${htmlFile}`), 'utf8');
  const sources = new Set(
    [...html.matchAll(/<script[^>]+src="\/_next\/(static\/[^"?]+\.js)/g)].map((m) => m[1]),
  );
  return [...sources].reduce((total, file) => total + statSync(built(file ?? '')).size, 0);
}

/** Raw bytes. CATSPLIT build: / 957 747, /ar 1 351 937 (before: 2 168 903 and about 2 563 000). */
const FIRST_LOAD_BUDGET = { '/': 1_050_000, '/ar': 1_490_000 } as const;

const BUILT = existsSync(built('server/app/index.html'));

describe('catalog parts (CATSPLIT)', () => {
  it('the website reaches no namespace of the app part', () => {
    // A website file that starts using an app namespace would show its keys: rerun
    // scripts/i18n/site-namespaces.mjs. A new namespace not listed yet is in `site` (safe).
    const unreached = new Set(appNamespaces(en));
    const present = new Set(Object.keys(en).map((key) => key.split('.')[0]));
    expect(APP_NAMESPACES.filter((ns) => present.has(ns) && !unreached.has(ns))).toEqual([]);
  });

  it('a part holds every key of its part, English where the language has none', async () => {
    const response = catalogPartResponse('ur.site.json', CATALOG_VERSION);
    expect(response.headers.get('cache-control')).toContain('immutable');
    const part: Record<string, string> = JSON.parse(await response.text());
    const own: Record<string, string> = ur;
    const english: Record<string, string> = en;
    const siteKeys = Object.keys(english).filter((key) => partOfKey(key) === 'site');
    expect(Object.keys(part)).toEqual(siteKeys);
    const missing = siteKeys.find((key) => own[key] === undefined);
    if (missing !== undefined) expect(part[missing]).toBe(english[missing]);
    expect(catalogPartResponse('xx.site.json', CATALOG_VERSION).status).toBe(404);
    expect(catalogPartResponse('en.site.json', 'old').headers.get('cache-control')).toBe(
      'no-cache',
    );
  });

  it('the website layouts narrow the scope to the site part', () => {
    for (const layout of ['../src/app/(website)/layout.tsx', '../src/app/ar/(site)/layout.tsx']) {
      expect(read(layout)).toContain('<CatalogScope scope="site">');
    }
    expect(read('../src/app/layout.tsx')).toContain(
      '<CatalogScope scope="app">{children}</CatalogScope>',
    );
  });

  // Budgets from the CATSPLIT build (measured / about 10 % headroom); checked after `next build`.
  it.skipIf(!BUILT)('first-load JS of / and /ar stays within budget', () => {
    expect(firstLoadJs('index.html')).toBeLessThan(FIRST_LOAD_BUDGET['/']);
    expect(firstLoadJs('ar.html')).toBeLessThan(FIRST_LOAD_BUDGET['/ar']);
  });
});
