'use client';

import { useMemo, useState } from 'react';
import { SearchField, StateCapsule } from '@tmanage/ui';
import { useT } from '../../../../lib/i18n/use-t';
import { ArrowLink, IconOrb, cx } from '../../primitives';
import { CtaBand, LinkCard, SectionHeader, WebSection } from '../../sections';
import {
  CATEGORY_LABEL_KEY,
  CATEGORY_LINE_KEY,
  CONNECTION_STEPS,
  DEVELOPER_LINKS,
  INTEGRATIONS,
  INTEGRATION_FILTERS,
  filterIntegrations,
  type Integration,
  type IntegrationFilter,
} from './integrations-data';
import './integrations.css';

/** Where "Read the developer guide" and the developer link cards lead. */
const DEVELOPER_GUIDE_HREF = '/resources';

/**
 * WEB-13 Integrations (`/integrations`), built to the round-2 Figma frame 308:38: a centred hero
 * with search, the filter bar, a 3 × 4 grid of honest "Planned" cards, the ink "how connections
 * work" panel, the developer links and the CTA band. Every value is a TManage token.
 */
export function IntegrationsPage() {
  const t = useT();
  const [filter, setFilter] = useState<IntegrationFilter['id']>('all');
  const [query, setQuery] = useState('');

  const nameOf = (item: Integration) => (item.nameKey ? t(item.nameKey) : item.name);
  const visible = useMemo(
    () =>
      filterIntegrations(INTEGRATIONS, filter, query, (item) => [
        item.nameKey ? t(item.nameKey) : item.name,
        t(CATEGORY_LINE_KEY[item.category]),
        t(CATEGORY_LABEL_KEY[item.category]),
      ]),
    [filter, query, t],
  );
  const total = INTEGRATIONS.length;

  return (
    <>
      <WebSection className="tm-web-int-hero" aria-labelledby="int-hero-title">
        <div className="tm-web-int-hero__inner">
          <SectionHeader
            as="h1"
            size="page"
            align="center"
            id="int-hero-title"
            eyebrow={t('IntegrationsPage.heroEyebrow')}
            title={t('IntegrationsPage.heroTitle')}
            lede={t('IntegrationsPage.heroLede')}
          />
          <form
            className="tm-web-int-search"
            role="search"
            onSubmit={(event) => event.preventDefault()}
          >
            <SearchField
              label={t('IntegrationsPage.searchLabel')}
              placeholder={t('IntegrationsPage.searchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-controls="int-grid"
            />
          </form>
        </div>
      </WebSection>

      <WebSection spacing="flush" className="tm-web-int-catalogue" aria-labelledby="int-grid-title">
        <h2 id="int-grid-title" className="tm-visually-hidden">
          {t('IntegrationsPage.gridHeading')}
        </h2>
        <div className="tm-web-int-filters">
          <div
            className="tm-web-int-filters__chips"
            role="group"
            aria-label={t('IntegrationsPage.filterAria')}
          >
            {INTEGRATION_FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cx(
                  'tm-web-chip',
                  'tm-web-int-chip',
                  filter === item.id && 'tm-web-chip--on',
                )}
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {t(item.labelKey)}
              </button>
            ))}
          </div>
          <p className="tm-web-int-filters__count" aria-live="polite">
            {visible.length === total
              ? `${total} ${t('IntegrationsPage.integrationsWord')} · ${t('IntegrationsPage.countNote')}`
              : `${visible.length} ${t('IntegrationsPage.ofWord')} ${total} ${t('IntegrationsPage.integrationsWord')}`}
          </p>
        </div>

        {visible.length > 0 ? (
          <ul className="tm-web-int-grid" id="int-grid">
            {visible.map((item) => (
              <li key={item.id}>
                <article className="tm-web-int-card">
                  <div className="tm-web-int-card__head">
                    <IconOrb icon="plus" tone="tint" size="compact" />
                    <StateCapsule state={item.status === 'available' ? 'done' : 'future'}>
                      {item.status === 'available'
                        ? t('IntegrationsPage.cardAvailable')
                        : t('IntegrationsPage.cardPlanned')}
                    </StateCapsule>
                  </div>
                  <p className="tm-web-int-card__category">
                    {t(CATEGORY_LABEL_KEY[item.category])}
                  </p>
                  <h3 className="tm-web-int-card__name">{nameOf(item)}</h3>
                  <p className="tm-web-int-card__line">{t(CATEGORY_LINE_KEY[item.category])}</p>
                </article>
              </li>
            ))}
          </ul>
        ) : (
          <div className="tm-web-int-empty" id="int-grid">
            <IconOrb icon="search" tone="tint" />
            <p className="tm-web-int-empty__title">
              {t('IntegrationsPage.emptyTitlePre')} “{query.trim()}”.
            </p>
            <p className="tm-web-int-empty__body">{t('IntegrationsPage.emptyBody')}</p>
            <ArrowLink href="/contact">{t('IntegrationsPage.suggestLink')}</ArrowLink>
          </div>
        )}
      </WebSection>

      <WebSection className="tm-web-int-how-section" aria-labelledby="int-how-title">
        <div className="tm-web-int-how">
          <SectionHeader
            tone="ink"
            id="int-how-title"
            eyebrow={t('IntegrationsPage.howEyebrow')}
            title={t('IntegrationsPage.howTitleR2')}
          />
          <ol className="tm-web-int-steps">
            {CONNECTION_STEPS.map((step, index) => (
              <li key={step.titleKey} className="tm-web-int-step">
                <span className="tm-web-int-step__marker">
                  <span className="tm-web-int-step__orb" aria-hidden="true">
                    +
                  </span>
                  <span className="tm-web-int-step__label">
                    {t('IntegrationsPage.stepWord')} {index + 1}
                    {index < CONNECTION_STEPS.length - 1 ? (
                      <span className="tm-web-int-step__arrow" aria-hidden="true">
                        {' '}
                        →
                      </span>
                    ) : null}
                  </span>
                </span>
                <h3 className="tm-web-int-step__title">{t(step.titleKey)}</h3>
                <p className="tm-web-int-step__body">{t(step.bodyKey)}</p>
              </li>
            ))}
          </ol>
        </div>
      </WebSection>

      <WebSection spacing="flush" className="tm-web-int-build" aria-labelledby="int-build-title">
        <div className="tm-web-int-build__row">
          <SectionHeader
            id="int-build-title"
            eyebrow={t('IntegrationsPage.buildEyebrow')}
            title={t('IntegrationsPage.buildTitle')}
            lede={t('IntegrationsPage.buildLedeR2')}
            link={{ label: t('IntegrationsPage.buildLink'), href: DEVELOPER_GUIDE_HREF }}
          />
          <div className="tm-web-int-build__links">
            {DEVELOPER_LINKS.map((link) => (
              <LinkCard
                key={link.title}
                title={link.titleKey ? t(link.titleKey) : link.title}
                hint={t(link.hintKey)}
                href={DEVELOPER_GUIDE_HREF}
              />
            ))}
          </div>
        </div>
      </WebSection>

      <CtaBand title={t('IntegrationsPage.ctaTitle')} lede={t('IntegrationsPage.ctaLede')} />
    </>
  );
}
