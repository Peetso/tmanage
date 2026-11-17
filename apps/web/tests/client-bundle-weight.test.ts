import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type JSZipType from 'jszip';
import { describe, expect, it } from 'vitest';
import { LocaleStore, type CatalogAccess } from '../src/lib/i18n/locale-store';

/**
 * DOMAINIMPORT2. Two things once made every browser bundle heavy or noisy:
 * - all seven non-English catalogs (about 9 MB) sat in the root layout's chunk, for every visitor;
 * - JSZip's Node entry pulled the Node stream/util stand-ins into the Office viewers and the
 *   import reader, and util's `Function("return function*() {}")` tripped Trusted Types.
 * These cases fail if either comes back.
 */
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const CATALOG_IMPORT = /^import\s+\w+\s+from\s+'\.\/messages\/(?!en\.json)[^']+\.json'/m;

describe('client bundle weight guards', () => {
  it('the browser resolves the catalogs lazily and t.ts bundles English only', () => {
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
    arrive();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get()).toBe('fr-FR');
    expect(seen).toEqual(['fr-FR']);
  });
});
