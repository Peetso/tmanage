import { ApiError } from '../../common/http/errors.js';

/**
 * The organization fields shared by `POST /v1/organizations` and the first-owner setup route.
 *
 * Both create an organization, so both must refuse exactly the same names, slugs, timezones and
 * locales. Keeping one validator is what stops the two paths drifting apart.
 */

/**
 * The slug rules, restated on the server.
 *
 * `apps/web/src/lib/slug.ts` derives and checks the same shape in the browser, and that copy
 * exists to give the person immediate feedback — not to be the control. This one is the
 * control. They are two implementations of one rule and will drift; the direction that
 * matters is that a slug the browser would reject can still be posted directly, and this is
 * what refuses it.
 *
 * The width is `organizations.slug`'s own: `varchar(63)`, which is also the DNS label limit.
 */
export const MAX_SLUG_LENGTH = 63;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const MAX_NAME_LENGTH = 190;
export const MAX_TIMEZONE_LENGTH = 64;
export const MAX_LOCALE_LENGTH = 35;

/**
 * Slugs the product needs for itself.
 *
 * A person who registered `api` or `admin` would take a path this application may want later,
 * and taking it back would break every link they had shared. The list is short and additive:
 * a slug that becomes reserved later stays owned by whoever holds it, because a reservation
 * that evicted an existing customer would be worse than the collision it prevented.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
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
  'portal',
  'privacy',
  'security',
  'settings',
  // The web app serves the first-owner setup screen at /setup.
  'setup',
  'signin',
  'signup',
  'static',
  'status',
  'support',
  'system',
  'tmanage',
  'www',
]);

export interface ValidatedOrganizationInput {
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly defaultLocale: string;
}

/**
 * Check the body, reporting every problem rather than the first.
 *
 * Specific messages, for the same reason `POST /v1/auth/password/set` is specific: the caller
 * is authenticated and the subject is their own input. Nothing here is about whether some
 * other account or organization exists.
 */
export function validateOrganizationInput(
  body:
    | {
        readonly name?: unknown;
        readonly slug?: unknown;
        readonly timezone?: unknown;
        readonly defaultLocale?: unknown;
      }
    | undefined,
): ValidatedOrganizationInput {
  const details: { field: string; message: string }[] = [];

  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name === '') {
    details.push({ field: 'name', message: 'An organization name is required.' });
  } else if (name.length > MAX_NAME_LENGTH) {
    details.push({ field: 'name', message: `Keep the name to ${MAX_NAME_LENGTH} characters.` });
  }

  // Trimmed but **not** lower-cased. Silently folding the case would mean the address a
  // person sees confirmed is not the one they typed, and the slug is the most visible string
  // this product has — it is in every link they will send. A refusal they can act on is
  // better than a transformation they did not ask for.
  const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
  if (slug === '') {
    details.push({ field: 'slug', message: 'A workspace address is required.' });
  } else if (slug.length > MAX_SLUG_LENGTH) {
    details.push({
      field: 'slug',
      message: `Keep the workspace address to ${MAX_SLUG_LENGTH} characters.`,
    });
  } else if (!SLUG_PATTERN.test(slug)) {
    details.push({
      field: 'slug',
      message: 'Use lowercase letters, numbers and single hyphens between them.',
    });
  } else if (RESERVED_SLUGS.has(slug)) {
    details.push({ field: 'slug', message: 'That workspace address is reserved.' });
  }

  const timezone = typeof body?.timezone === 'string' ? body.timezone.trim() : 'UTC';
  if (timezone.length > MAX_TIMEZONE_LENGTH || !isKnownTimezone(timezone)) {
    details.push({ field: 'timezone', message: 'That is not a timezone we recognise.' });
  }

  const defaultLocale =
    typeof body?.defaultLocale === 'string' && body.defaultLocale.trim() !== ''
      ? body.defaultLocale.trim()
      : 'en';
  if (defaultLocale.length > MAX_LOCALE_LENGTH || !/^[A-Za-z][A-Za-z0-9-]*$/.test(defaultLocale)) {
    details.push({ field: 'defaultLocale', message: 'That is not a language tag we recognise.' });
  }

  if (details.length > 0) {
    throw new ApiError(422, 'validation_failed', 'That organization cannot be created.', details);
  }

  return { slug, name, timezone, defaultLocale };
}

/**
 * Whether the runtime recognises this timezone.
 *
 * Asked of `Intl` rather than checked against a bundled list, because a bundled list is a copy
 * of the IANA database that goes stale — and because the value has to be one *this* process
 * can resolve, since every deadline in the product will be rendered through it. A name Node
 * cannot resolve would be accepted by a list and then throw the first time a date was
 * formatted.
 */
function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
