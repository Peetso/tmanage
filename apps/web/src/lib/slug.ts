/**
 * The workspace address a new organization gets.
 *
 * `ON-01` shows it as `northstar` `.tmanage.app`, derived from the organization name while
 * the person types. The derivation is here, not in the screen, because it has to agree with
 * what the server will accept: `organizations.slug` is the tenant identifier that
 * `MembershipResolver` resolves and that appears in every URL.
 *
 * ## Why the rules are what they are
 *
 * - **Lowercase ASCII, digits and single hyphens.** A slug is a hostname label and part of a
 *   path. Uppercase would make two organizations that differ only in case collide on a
 *   case-insensitive comparison, and non-ASCII would need punycode to be a subdomain.
 * - **Never leading or trailing hyphen.** Not a valid hostname label.
 * - **Bounded at 63 characters**, the DNS label limit, so a slug that works as a path can
 *   also work as a subdomain if the deployment ever moves that way.
 *
 * This is a *suggestion*, not a guarantee. Availability is the server's answer, and this
 * function cannot know it. `ON-01` says so on the screen rather than showing a green tick
 * that nothing checked.
 */

/**
 * The DNS label limit — and, not by coincidence, the width of `organizations.slug`, which is
 * `varchar(63)` in `0001_tenancy.sql` and in `schema.ts`. A slug this function produced that
 * the column could not hold would be a truncation, so the two numbers are the same number.
 */
export const MAX_SLUG_LENGTH = 63;

/** `organizations.name` is `varchar(190)`. Stated here so a form can stop before the column does. */
export const MAX_ORGANIZATION_NAME_LENGTH = 190;

export function slugify(name: string): string {
  const lowered = name
    .normalize('NFKD')
    // Strip combining marks so "Café" becomes "cafe" rather than "caf".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const hyphenated = lowered
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  return hyphenated.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '');
}

export type SlugProblem = 'empty' | 'too-long' | 'invalid-characters' | 'edge-hyphen';

/**
 * Check a slug the person typed themselves.
 *
 * Returns every problem rather than the first, so a field can say what is wrong once instead
 * of making the person fix one thing at a time.
 */
export function slugProblems(slug: string): readonly SlugProblem[] {
  const problems: SlugProblem[] = [];
  if (slug === '') problems.push('empty');
  if (slug.length > MAX_SLUG_LENGTH) problems.push('too-long');
  if (slug !== '' && !/^[a-z0-9-]+$/.test(slug)) problems.push('invalid-characters');
  if (slug !== '' && (slug.startsWith('-') || slug.endsWith('-'))) problems.push('edge-hyphen');
  return problems;
}

/** One sentence per problem, in the order they should be read. */
export function describeSlugProblems(problems: readonly SlugProblem[]): string | undefined {
  if (problems.length === 0) return undefined;
  const sentences: string[] = [];
  if (problems.includes('empty')) sentences.push('Enter a workspace address.');
  if (problems.includes('invalid-characters'))
    sentences.push('Use lowercase letters, numbers and hyphens only.');
  if (problems.includes('edge-hyphen')) sentences.push('It cannot start or end with a hyphen.');
  if (problems.includes('too-long'))
    sentences.push(`Keep it to ${MAX_SLUG_LENGTH} characters or fewer.`);
  return sentences.join(' ');
}
