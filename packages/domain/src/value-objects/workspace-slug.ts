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
  // The page behind every mail's "Unsubscribe" link (/unsubscribe/{token}, PERSONMAIL).
  'unsubscribe',
  // The message catalogs, served per language and page part at /i18n/{catalog} (CATSPLIT).
  'i18n',
  // The Arabic-first product page and its use cases (/arabic, /arabic/{slug}, 57-07 MENA).
  'arabic',
  // The "Invite a company" page (/referral, 57-08 REFERRAL).
  'referral',
  // The "Book a walkthrough" page (/walkthrough, WEB-38 LANE-Q).
  'walkthrough',
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

/** Arabic-script letters by their plain Latin spelling (Arabic, with the Urdu/Persian extras). */
const ARABIC_SCRIPT_LATIN: Readonly<Record<string, string>> = {
  ا: 'a',
  أ: 'a',
  إ: 'i',
  آ: 'a',
  ٱ: 'a',
  ب: 'b',
  پ: 'p',
  ت: 't',
  ٹ: 't',
  ث: 'th',
  ج: 'j',
  چ: 'ch',
  ح: 'h',
  خ: 'kh',
  د: 'd',
  ڈ: 'd',
  ذ: 'dh',
  ر: 'r',
  ڑ: 'r',
  ز: 'z',
  ژ: 'zh',
  س: 's',
  ش: 'sh',
  ص: 's',
  ض: 'd',
  ط: 't',
  ظ: 'z',
  ع: 'a',
  غ: 'gh',
  ف: 'f',
  ق: 'q',
  ك: 'k',
  ک: 'k',
  گ: 'g',
  ل: 'l',
  م: 'm',
  ن: 'n',
  ں: 'n',
  ه: 'h',
  ہ: 'h',
  ھ: 'h',
  ة: 'a',
  ۃ: 'a',
  ؤ: 'u',
  ى: 'a',
  ئ: 'i',
  ے: 'e',
  ء: '',
};

/** و and ي (and Urdu ی) are consonants at the start of a word and vowels inside it. */
const ARABIC_SCRIPT_GLIDES: Readonly<Record<string, readonly [start: string, inside: string]>> = {
  و: ['w', 'u'],
  ي: ['y', 'i'],
  ی: ['y', 'i'],
};

/** Harakat, the superscript alef and the tatweel: marks with no letter of their own. */
const ARABIC_SCRIPT_MARKS = /[\u064B-\u0652\u0670\u0640]/u;

function isArabicScriptLetter(char: string | undefined): boolean {
  return char !== undefined && (char in ARABIC_SCRIPT_LATIN || char in ARABIC_SCRIPT_GLIDES);
}

/**
 * TESTUX P1 11 — `text` with its Arabic-script letters and digits spelled in Latin, so a workspace
 * named "شركة النيل" gets the address `shrka-alnil` instead of the bare `workspace` a Latin-only
 * slug rule leaves it. Everything else is returned as it is; the caller still applies the slug
 * rule. A spelling, not a translation: short vowels are not written in Arabic, so they are not
 * guessed here either.
 */
export function latinForSlug(text: string): string {
  let out = '';
  let previous: string | undefined;
  for (const char of text) {
    if (ARABIC_SCRIPT_MARKS.test(char)) continue;
    const digit = '٠١٢٣٤٥٦٧٨٩'.indexOf(char);
    const persianDigit = '۰۱۲۳۴۵۶۷۸۹'.indexOf(char);
    const glide = ARABIC_SCRIPT_GLIDES[char];
    if (digit >= 0 || persianDigit >= 0) out += String(Math.max(digit, persianDigit));
    else if (glide !== undefined) out += isArabicScriptLetter(previous) ? glide[1] : glide[0];
    else out += ARABIC_SCRIPT_LATIN[char] ?? char;
    previous = char;
  }
  return out;
}
