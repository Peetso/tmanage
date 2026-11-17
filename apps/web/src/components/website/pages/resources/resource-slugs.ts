/**
 * The slugs of the library articles (`/resources/<slug>`), featured ones first, without their
 * content (SEOE, 2026-11-17): the Arabic twin table reads these, so the library stays out of every
 * public page's bundle. `compare-slugs.test.tsx` keeps them equal to the slugs of `ALL_RESOURCES`.
 */
export const RESOURCE_SLUGS = [
  'client-approval-playbook',
  'three-dates-three-meanings',
  'website-relaunch-template',
  'client-review-in-ten-minutes',
  'requests-your-team-can-commit-to',
  'offboarding-a-contractor-safely',
  'no-individual-productivity-scores',
  'portal-clients-actually-open',
  'arabic-first-product-language',
  'meeting-notes-to-owned-actions',
  'retainers-without-the-chaos',
  'what-a-governed-version-is',
] as const;
