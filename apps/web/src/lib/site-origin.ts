/**
 * The public website's own origin, for the absolute URLs `robots.txt` and `sitemap.xml` must
 * carry. `TMANAGE_SITE_URL` overrides it (a staging host); the default is the live host.
 */
export function siteOrigin(value: string | undefined = process.env['TMANAGE_SITE_URL']): string {
  const configured = value?.trim();
  return (
    configured === undefined || configured === '' ? 'https://tmanage.peetrix.com' : configured
  ).replace(/\/+$/, '');
}
