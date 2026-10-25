// Gives the prerendered Arabic public pages `<html lang="ar" dir="rtl">` (NFR-02, audit gap 5).
//
// Runs after `next build` (package.json "build"). The root layout reads no request, so it renders
// `<html lang="en" dir="ltr">` for every route, the Arabic pages under app/ar included; their text
// and title are already Arabic (src/lib/i18n/public-locale-routes.ts). This rewrites only that one
// opening tag in .next/server/app/ar.html and ar/**/*.html, the files `next start` serves, so a
// browser and a crawler get the Arabic language and direction in the HTML itself while the pages
// stay static and CDN-cached. React leaves the attributes alone at hydration (`<html>` carries
// suppressHydrationWarning) and the locale boot sets the same values. A page whose tag is not the
// expected one stops the build rather than ship a half-localized site.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENGLISH_TAG = /<html lang="en" dir="ltr"(?=[\s>])/;
const ARABIC_TAG = '<html lang="ar" dir="rtl"';
const ALREADY_ARABIC = /<html lang="ar" dir="rtl"(?=[\s>])/;

/**
 * `html` with its `<html>` tag in Arabic, or `undefined` when the document has neither the English
 * nor the Arabic tag the root layout renders.
 *
 * @param {string} html
 * @returns {string | undefined}
 */
export function localizeHtml(html) {
  if (ALREADY_ARABIC.test(html)) return html;
  if (!ENGLISH_TAG.test(html)) return undefined;
  return html.replace(ENGLISH_TAG, ARABIC_TAG);
}

function htmlFilesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return htmlFilesUnder(path);
    return name.endsWith('.html') ? [path] : [];
  });
}

/**
 * The prerendered Arabic pages of a build: `server/app/ar.html` and every `.html` under
 * `server/app/ar/`.
 *
 * @param {string} distDir  the Next build directory (`.next`)
 * @returns {string[]}
 */
export function arabicHtmlFiles(distDir) {
  const app = join(distDir, 'server', 'app');
  const home = join(app, 'ar.html');
  return [...(existsSync(home) ? [home] : []), ...htmlFilesUnder(join(app, 'ar'))];
}

/**
 * Localize every Arabic page of the build in `distDir`; throws when there is none or one cannot be.
 *
 * @param {string} distDir
 * @returns {string[]} the files rewritten
 */
export function localizePrerenderedHtml(distDir) {
  const files = arabicHtmlFiles(distDir);
  if (files.length === 0) {
    throw new Error(`no prerendered Arabic pages under ${join(distDir, 'server', 'app', 'ar')}`);
  }
  const problems = [];
  for (const file of files) {
    const html = readFileSync(file, 'utf8');
    const localized = localizeHtml(html);
    if (localized === undefined) problems.push(relative(distDir, file));
    else if (localized !== html) writeFileSync(file, localized);
  }
  if (problems.length > 0) {
    throw new Error(`no <html lang="en" dir="ltr"> tag to localize in: ${problems.join(', ')}`);
  }
  return files;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const distDir = resolve(web, process.env['TMANAGE_NEXT_DIST_DIR'] ?? '.next');
  const files = localizePrerenderedHtml(distDir);
  process.stdout.write(`localized ${files.length} Arabic public pages (lang="ar" dir="rtl")\n`);
}
