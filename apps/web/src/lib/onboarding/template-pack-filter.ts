import type { PackRole, TemplatePackView } from '../api/template-packs';

/**
 * 55-02 / 54-23. The starter-pack filter shared by the template-packs gallery and the onboarding
 * wizard: narrow to a role (null keeps every pack), and in an Arabic interface put the Arabic
 * agency packs first. The order is otherwise the catalog's, so the list never jumps around.
 */
export function filterTemplatePacks(
  packs: readonly TemplatePackView[],
  role: PackRole | null,
  locale: string,
): readonly TemplatePackView[] {
  const matching = role === null ? packs : packs.filter((pack) => pack.roles.includes(role));
  if (!locale.toLowerCase().startsWith('ar')) return matching;
  return [
    ...matching.filter((pack) => pack.language === 'ar'),
    ...matching.filter((pack) => pack.language !== 'ar'),
  ];
}
