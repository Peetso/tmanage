import { describe, expect, it } from 'vitest';
import {
  INTEGRATIONS,
  filterIntegrations,
} from '../src/components/website/pages/integrations/integrations-data';
import {
  ARTICLES,
  filterResources,
} from '../src/components/website/pages/resources/resources-data';

/** WEB-13 / WEB-15: the filter + search behind the Integrations grid and the Resources library. */
describe('website library filters', () => {
  it('Integrations: a category chip narrows the grid, and every card stays honestly Planned', () => {
    expect(filterIntegrations(INTEGRATIONS, 'all', '', () => [])).toHaveLength(12);
    expect(filterIntegrations(INTEGRATIONS, 'files', '', () => []).map((i) => i.name)).toEqual([
      'Google Drive',
      'OneDrive',
      'Dropbox',
    ]);
    expect(INTEGRATIONS.every((i) => i.status === 'planned')).toBe(true);
  });

  it('Integrations: search matches the translated text the reader sees, and the brand name', () => {
    const arabic = (item: (typeof INTEGRATIONS)[number]) =>
      item.id === 'inbound-email' ? ['البريد الوارد'] : [];
    expect(filterIntegrations(INTEGRATIONS, 'all', 'البريد', arabic).map((i) => i.id)).toEqual([
      'inbound-email',
    ]);
    expect(filterIntegrations(INTEGRATIONS, 'identity', '  scim ', () => [])).toHaveLength(1);
    expect(filterIntegrations(INTEGRATIONS, 'calendar', 'dropbox', () => [])).toEqual([]);
  });

  it('Resources: a tab and a query combine over the nine library articles', () => {
    expect(filterResources(ARTICLES, 'all', '', () => [])).toHaveLength(9);
    expect(filterResources(ARTICLES, 'update', '', () => []).map((a) => a.slug)).toEqual([
      'arabic-first-product-language',
      'what-a-governed-version-is',
    ]);
    expect(filterResources(ARTICLES, 'guide', 'RETAINERS', () => [])).toHaveLength(1);
    expect(filterResources(ARTICLES, 'blog', 'retainers', () => [])).toEqual([]);
  });
});
