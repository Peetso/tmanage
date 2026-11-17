/**
 * The public website's own origin, for the absolute URLs `robots.txt`, `sitemap.xml`, `llms.txt`,
 * canonical links and structured data must carry. `TMANAGE_SITE_URL` overrides it (a staging
 * host); the default is the live host.
 */
export function siteOrigin(value: string | undefined = process.env['TMANAGE_SITE_URL']): string {
  const configured = value?.trim();
  return (
    configured === undefined || configured === '' ? 'https://tmanageapp.com' : configured
  ).replace(/\/+$/, '');
}

/** A site path as an absolute URL (`/` → `https://host/`, `/pricing` → `https://host/pricing`). */
export function absoluteSiteUrl(path: string, origin: string = siteOrigin()): string {
  return path === '/' ? `${origin}/` : `${origin}${path}`;
}
