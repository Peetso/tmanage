/**
 * The workspace address (`organizations.slug`): the first path segment of every workspace
 * screen (`/{slug}/home`) and the tenant identifier the API resolves.
 *
 * One rule, read by both sides: the API refuses a slug that breaks it when an organization is
 * created (`apps/api/src/modules/tenancy/organization-input.ts`), and the web app answers a real
 * 404 for a first path segment that breaks it (`apps/web/src/lib/workspace-gate.ts`), so a
 * scanner's `/wp-admin` or `/elmah.axd` is never served the workspace shell (SOFT404,
 * 2026-11-15).
 *
 * The width is `organizations.slug`'s own: `varchar(63)`, which is also the DNS label limit.
 */
export const MAX_WORKSPACE_SLUG_LENGTH = 63;

/** Lowercase ASCII letters and digits, single hyphens between them. No dot, no underscore. */
export const WORKSPACE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * Slugs the product needs for itself, or that only a scanner asks for.
 *
 * A person who registered `api` or `admin` would take a path this application may want later,
 * and taking it back would break every link they had shared. The list is additive: a slug
 * reserved later is refused on create from then on.
 */
export const RESERVED_WORKSPACE_SLUGS: ReadonlySet<string> = new Set([
  // The public website's top-level paths (A22): a static route wins over [orgSlug], so an
  // organisation holding one of these could never be reached at its own address.
  'about',
  'accessibility',
  'changelog',
  'client-portal',
  'communication',
  'contact',
  'customers',
  'developers',
  'download',
  'faq',
  'features',
  'integrations',
  'pricing',
  // The public compare pages (/compare, /compare/{tool}, 57-06).
  'compare',
  'product',
  'resources',
  'solutions',
  // The public "switch from X" pages (/switch/{tool}, 54-29).
  'switch',
  // The public "X alternative" pages and the facts page (/alternatives/{tool}, /facts, SEOF).
  'alternatives',
  'facts',
  'terms',
  'website-kit',
  // The web app's own top-level routes beside [orgSlug].
  'a',
  'connect',
  'f',
  'forbidden',
  'invitations',
  'offline',
  'onboarding',
  'organizations',
  'portal-sign-in',
  'q',
  'recover',
  // The public approval-record check (/verify, 52-19).
  'verify',
  // The link in the address-confirmation mail (/confirm-email/{token}, VERIFYMAIL).
  'confirm-email',
  // The message catalogs, served per language and page part at /i18n/{catalog} (CATSPLIT).
  'i18n',
  'sessions',
  'admin',
  'api',
  'app',
  // The web app serves the Arabic public website at /ar (/ar/pricing, …) beside [orgSlug].
  'ar',
  // The English website is the root; /en is not a workspace either.
  'en',
  'assets',
  'auth',
  'billing',
  'blog',
  'cdn',
  'dashboard',
  'docs',
  'help',
  'legal',
  'login',
  'mail',
  // The web app serves the public pages' Markdown versions at /md (/md/pricing, AGENTREADY).
  'md',
  // The web app serves Platform admin (the TManage operator) at /platform.
  'platform',
  'portal',
  'privacy',
  'security',
  'settings',
  // The web app serves the first-owner setup screen at /setup.
  'setup',
  'signin',
  'signup',
  // The web app serves /sign-in and /sign-up as static routes beside [orgSlug].
  'sign-in',
  'sign-up',
  'static',
  'status',
  'support',
  'system',
  'tmanage',
  'www',
  // What vulnerability scanners probe for. Never a workspace, so the web app answers 404.
  'v1',
  'v2',
  'well-known',
  'actuator',
  'administrator',
  'autodiscover',
  'cgi-bin',
  'debug',
  'elmah',
  'graphql',
  'phpmyadmin',
  'server-info',
  'server-status',
  'swagger',
  'swagger-ui',
  'telescope',
  'wp-admin',
  'wp-content',
  'wp-includes',
  'wp-json',
  'wp-login',
  'xmlrpc',
]);

/** True when `slug` has the workspace-address shape and is not reserved. */
export function isAddressableWorkspaceSlug(slug: string): boolean {
  return (
    slug.length <= MAX_WORKSPACE_SLUG_LENGTH &&
    WORKSPACE_SLUG_PATTERN.test(slug) &&
    !RESERVED_WORKSPACE_SLUGS.has(slug)
  );
}
