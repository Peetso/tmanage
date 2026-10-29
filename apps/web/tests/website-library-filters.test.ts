import { describe, expect, it } from 'vitest';
import {
  INTEGRATIONS,
  cardsOf,
  integrationRequestMessage,
} from '../src/components/website/pages/integrations/integrations-data';
import {
  ARTICLES,
  filterResources,
} from '../src/components/website/pages/resources/resources-data';

/** 54-02 / WEB-15: the honest Integrations groups and the Resources library filter. */
describe('website library filters', () => {
  it('Integrations (54-02): only true lines are listed; Planned requests are tagged leads', () => {
    const names = INTEGRATIONS.map((i) => i.name.toLowerCase());
    expect(names.some((n) => n.includes('dropbox') || n.includes('deploy hook'))).toBe(false);
    const claimed = [...cardsOf('today'), ...cardsOf('own-account')].map((i) => i.id);
    expect(claimed).not.toContain('saml-sso');
    expect(claimed).not.toContain('scim');
    expect(cardsOf('own-account', [{ ...INTEGRATIONS[7]!, shipped: false }])).toEqual([]);
    expect(integrationRequestMessage('scim')).toBe('integration_request:scim');
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
