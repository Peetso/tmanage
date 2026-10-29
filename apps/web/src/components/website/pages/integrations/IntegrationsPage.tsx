'use client';

import { Badge } from '@tmanage/ui';
import { useTOr } from '../../../../lib/i18n/use-t-or';
import { SectionHeader, WebSection } from '../../sections';
import { INTEGRATION_GROUPS, cardsOf, type IntegrationGroup } from './integrations-data';
import { IntegrationRequest } from './IntegrationRequest';
import './integrations.css';

const K = 'IntegrationsPage.truth.';

/**
 * 54-02 Integrations (`/integrations`, and `/ar/integrations` through the Arabic route table),
 * built to Figma 443:20507 (EN) / 443:20899 (AR): a centred hero, then the three honest groups —
 * Works today, Connect with your own account (only connectors that have shipped), Planned (each
 * with "Tell us you need it"). A group with no card to show is left out. Every value is a token.
 */
export function IntegrationsPage() {
  const tOr = useTOr();

  return (
    <>
      <WebSection className="tm-web-int-hero" aria-labelledby="int-hero-title">
        <SectionHeader
          as="h1"
          size="page"
          align="center"
          id="int-hero-title"
          eyebrow={tOr(`${K}heroEyebrow`, 'INTEGRATIONS')}
          title={tOr(`${K}heroTitle`, 'Integrations that work today.')}
          lede={tOr(
            `${K}heroLede`,
            'Every status on this page matches the product. If a card says Available, you can use it now.',
          )}
        />
      </WebSection>

      <WebSection spacing="flush" className="tm-web-int-groups">
        {INTEGRATION_GROUPS.map((group) => (
          <IntegrationGroupSection key={group.id} group={group} />
        ))}
      </WebSection>
    </>
  );
}

function IntegrationGroupSection({ group }: { group: IntegrationGroup }) {
  const tOr = useTOr();
  const cards = cardsOf(group.id);
  if (cards.length === 0) return null;
  const titleId = `int-group-${group.id}`;
  const badge = tOr(group.badge.key, group.badge.text);

  return (
    <section className="tm-web-int-group" aria-labelledby={titleId}>
      <header className="tm-web-int-group__header">
        <h2 id={titleId} className="tm-web-int-group__title">
          {tOr(group.titleKey, group.title)}
        </h2>
        <p className="tm-web-int-group__lede">{tOr(group.ledeKey, group.lede)}</p>
      </header>
      <ul className="tm-web-int-grid">
        {cards.map((item) => {
          const name = item.nameKey ? tOr(item.nameKey, item.name) : item.name;
          return (
            <li key={item.id}>
              <article className="tm-web-int-card">
                <Badge
                  tone={group.badge.tone === 'client' ? 'client' : 'neutral'}
                  mono={group.badge.tone === 'mono'}
                  className="tm-web-int-card__badge"
                >
                  {badge}
                </Badge>
                <h3 className="tm-web-int-card__name">{name}</h3>
                <p className="tm-web-int-card__line">{tOr(item.lineKey, item.line)}</p>
                {group.id === 'planned' ? (
                  <IntegrationRequest integrationId={item.id} integrationName={name} />
                ) : null}
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
