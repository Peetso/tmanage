/**
 * The workspace name step 2 of sign-up suggests (SIGNUP2): from the e-mail domain for a company
 * address (`omar@northstar.studio` -> "Northstar Studio"), from the person's name for a free mail
 * provider (`mona@gmail.com` + "Mona Adel" -> "Mona Adel"). Only a suggestion: the field stays
 * editable and the API validates whatever is sent.
 */

/** Free mail providers, by exact domain. Short on purpose: an unknown one reads as a company. */
const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.de',
  'web.de',
  'yandex.com',
  'yandex.ru',
  'mail.ru',
  'zoho.com',
  'hey.com',
  'qq.com',
  '163.com',
]);

/** Providers that run the same free service under many country domains (`yahoo.co.uk`). */
const FREE_MAIL_BRANDS: ReadonlySet<string> = new Set(['hotmail', 'outlook', 'live', 'yahoo']);

/** Domain endings that say nothing about the company (`.com`, `.co.uk`); any two letters too. */
const GENERIC_SUFFIXES: ReadonlySet<string> = new Set([
  'com',
  'net',
  'org',
  'io',
  'co',
  'ai',
  'app',
  'dev',
  'biz',
  'info',
  'gov',
  'edu',
  'ac',
  'mail',
  'email',
  // TESTUX P2 28: the reserved test and local names (RFC 2606, RFC 6761) name no company either.
  'example',
  'test',
  'invalid',
  'localhost',
  'local',
]);

const MAX_NAME = 190;

function isGeneric(label: string): boolean {
  return label.length === 2 || GENERIC_SUFFIXES.has(label);
}

function domainOf(email: string): string | undefined {
  const at = email.trim().lastIndexOf('@');
  if (at < 1) return undefined;
  const domain = email
    .trim()
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : undefined;
}

export function isFreeMailDomain(domain: string): boolean {
  const lower = domain.toLowerCase();
  if (FREE_MAIL_DOMAINS.has(lower)) return true;
  const brand = lower.split('.')[0];
  return brand !== undefined && FREE_MAIL_BRANDS.has(brand);
}

/**
 * A label's words, title-cased. A run of four or more digits at its end (`cedarlogistics1731`, an
 * address made unique by a date or a counter) is not part of the name; a short one (`studio42`) is.
 */
function titleCase(word: string): string {
  return word
    .replace(/[-_]?\d{4,}$/, '')
    .split(/[-_]+/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** The company words of a domain: `northstar.studio` -> ["northstar", "studio"]. */
function companyWords(domain: string): string[] {
  const labels = domain.split('.');
  const last = labels[labels.length - 1] ?? '';
  // A descriptive ending (`.studio`, `.agency`) is part of the name, as the design reads it.
  if (!isGeneric(last) && labels.length >= 2) return [labels[labels.length - 2] ?? '', last];
  let end = labels.length;
  while (end > 1 && isGeneric(labels[end - 1] ?? '')) end -= 1;
  return [labels[end - 1] ?? ''];
}

export function suggestWorkspaceName(email: string, displayName: string): string {
  const domain = domainOf(email);
  const name = displayName.trim().replace(/\s+/g, ' ');
  if (domain === undefined || isFreeMailDomain(domain)) return name.slice(0, MAX_NAME);
  const words = companyWords(domain)
    .map(titleCase)
    .filter((word) => word !== '');
  return (words.length > 0 ? words.join(' ') : name).slice(0, MAX_NAME);
}
