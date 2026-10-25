import { ApiError } from '../../common/http/errors.js';
import { validateValue, type OrgSettingKey } from './org-settings.allowlist.js';

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
  // The web app serves the Arabic public website at /ar (/ar/pricing, …) beside [orgSlug].
  'ar',
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
]);

export interface ValidatedOrganizationInput {
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly defaultLocale: string;
  /** `org_settings.working_week`, when the caller chose one. */
  readonly workingWeek?: string;
  /** `org_settings.operating_template`, when the caller chose one. */
  readonly operatingTemplate?: string;
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
        readonly workingWeek?: unknown;
        readonly operatingTemplate?: unknown;
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
  const slugMessage = slugProblem(slug);
  if (slugMessage !== undefined) details.push({ field: 'slug', message: slugMessage });

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

  // ON-02's working week and ON-01's work type (as the starting template). Both optional, because
  // first-owner setup posts neither; both validated by the settings allowlist that stores them.
  const workingWeek = optionalSetting(body?.workingWeek, 'working_week', 'workingWeek', details);
  const operatingTemplate = optionalSetting(
    body?.operatingTemplate,
    'operating_template',
    'operatingTemplate',
    details,
  );

  if (details.length > 0) {
    throw new ApiError(422, 'validation_failed', 'That organization cannot be created.', details);
  }

  return {
    slug,
    name,
    timezone,
    defaultLocale,
    ...(workingWeek === undefined ? {} : { workingWeek }),
    ...(operatingTemplate === undefined ? {} : { operatingTemplate }),
  };
}

/**
 * What is wrong with a workspace address, or `undefined` when it is well formed and not reserved.
 *
 * Shared by the create route and the live availability check, so the field can never be told
 * "available" for an address the create route would then refuse.
 */
export function slugProblem(slug: string): string | undefined {
  if (slug === '') return 'Enter a web link for your workspace.';
  if (slug.length > MAX_SLUG_LENGTH) {
    return `Keep the web link to ${MAX_SLUG_LENGTH} characters.`;
  }
  if (!SLUG_PATTERN.test(slug)) {
    return 'Use lowercase letters, numbers and single dashes between them.';
  }
  if (RESERVED_SLUGS.has(slug)) return 'That web link is reserved. Choose a different one.';
  return undefined;
}

/** An optional allowlisted setting from the body: absent is fine, present must validate. */
function optionalSetting(
  raw: unknown,
  key: OrgSettingKey,
  field: string,
  details: { field: string; message: string }[],
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const verdict = typeof raw === 'string' ? validateValue(key, raw) : undefined;
  if (verdict?.ok === true) return verdict.value;
  details.push({ field, message: verdict?.message ?? 'That value is not allowed.' });
  return undefined;
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
