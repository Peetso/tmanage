// B9 (SEO plan T6) — tell the IndexNow engines (Bing and the others that share the protocol) which
// public addresses changed, right after a deploy:
//
//   INDEXNOW_KEY=<key> node scripts/indexnow-ping.mjs [--since YYYY-MM-DD] [--site https://host] [--send]
//
// It reads the live `sitemap.xml` and keeps the addresses whose `<lastmod>` is on or after
// `--since` (default: today, UTC — the deploy day). Without `--send` it only prints the request it
// would make. With `--send` it first checks that the site serves the same key at
// `/indexnow-key.txt`, then posts the list once to api.indexnow.org.
//
// The key comes from the INDEXNOW_KEY environment variable (`src/lib/indexnow.ts`), never from the
// code; the server needs the same variable so the key route can answer. `--site` defaults to
// TMANAGE_SITE_URL, else https://tmanageapp.com (`src/lib/site-origin.ts`).
import { pathToFileURL } from 'node:url';
import { INDEXNOW_KEY_ENV, INDEXNOW_KEY_PATH, indexNowKey } from '../src/lib/indexnow.ts';
import { siteOrigin } from '../src/lib/site-origin.ts';

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/** The protocol's limit on addresses per request. */
export const MAX_URLS = 10_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The command line as options. Throws on anything it does not know, so a typo never sends.
 *
 * @param {readonly string[]} argv the arguments after the script name
 * @param {string} today `YYYY-MM-DD`
 * @returns {{ send: boolean, since: string, site: string }}
 */
export function parseArgs(argv, today) {
  const options = { send: false, since: today, site: siteOrigin() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--send') {
      options.send = true;
    } else if (arg === '--since' || arg === '--site') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!ISO_DATE.test(options.since)) throw new Error('--since must be YYYY-MM-DD');
  const site = new URL(options.site);
  if (site.protocol !== 'https:') throw new Error('--site must be an https:// origin');
  options.site = site.origin;
  return options;
}

/** @param {string} text */
function xmlText(text) {
  return text
    .trim()
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Each `<url>` of a sitemap: its `<loc>` and, when it has one, the `YYYY-MM-DD` of its `<lastmod>`.
 *
 * @param {string} xml
 * @returns {{ url: string, lastModified: string | undefined }[]}
 */
export function sitemapEntries(xml) {
  const entries = [];
  for (const [, block = ''] of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>([\s\S]*?)<\/loc>/.exec(block)?.[1];
    if (loc === undefined) continue;
    const lastmod = /<lastmod>([\s\S]*?)<\/lastmod>/.exec(block)?.[1];
    entries.push({ url: xmlText(loc), lastModified: lastmod?.trim().slice(0, 10) });
  }
  return entries;
}

/**
 * The addresses on `site` that changed on or after `since`, once each, at most {@link MAX_URLS}.
 * An entry without a date is left out: nothing says it changed.
 *
 * @param {readonly { url: string, lastModified: string | undefined }[]} entries
 * @param {string} since `YYYY-MM-DD`
 * @param {string} site the origin, `https://host`
 * @returns {string[]}
 */
export function changedUrls(entries, since, site) {
  const urls = new Set();
  for (const entry of entries) {
    if (entry.lastModified === undefined || entry.lastModified < since) continue;
    if (!URL.canParse(entry.url) || new URL(entry.url).origin !== site) continue;
    urls.add(entry.url);
  }
  return [...urls].slice(0, MAX_URLS);
}

/**
 * The JSON body IndexNow takes: the host, the key, where the key is served, and the addresses.
 *
 * @param {{ site: string, key: string, urls: readonly string[] }} input
 */
export function indexNowPayload({ site, key, urls }) {
  return {
    host: new URL(site).host,
    key,
    keyLocation: `${site}${INDEXNOW_KEY_PATH}`,
    urlList: [...urls],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2), new Date().toISOString().slice(0, 10));
  const key = indexNowKey(process.env[INDEXNOW_KEY_ENV]);
  if (key === undefined && options.send) {
    throw new Error(`${INDEXNOW_KEY_ENV} is missing or not 8-128 letters, digits and dashes`);
  }
  const sitemap = await fetch(`${options.site}/sitemap.xml`);
  if (!sitemap.ok) throw new Error(`sitemap.xml answered ${sitemap.status}`);
  const urls = changedUrls(sitemapEntries(await sitemap.text()), options.since, options.site);
  const payload = indexNowPayload({
    site: options.site,
    key: key ?? `<${INDEXNOW_KEY_ENV}>`,
    urls,
  });
  console.log(`${urls.length} address(es) changed on or after ${options.since}.`);
  console.log(JSON.stringify(payload, null, 2));
  if (!options.send) {
    console.log('Dry run: nothing sent. Add --send to post this to IndexNow.');
    return;
  }
  if (urls.length === 0) return;
  const served = await fetch(payload.keyLocation);
  if (!served.ok || (await served.text()).trim() !== key) {
    throw new Error(`${payload.keyLocation} does not serve this key; nothing sent`);
  }
  const response = await fetch(INDEXNOW_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  console.log(`IndexNow answered ${response.status} ${response.statusText}`);
  if (!response.ok) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
