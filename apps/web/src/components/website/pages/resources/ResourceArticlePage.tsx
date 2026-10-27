'use client';

import Link from '../../WebLink';
import { Badge } from '@tmanage/ui';
import { ArrowLink, ButtonLink, IconOrb } from '../../primitives';
import { CtaBand, SectionHeader, WebSection } from '../../sections';
import { ResourceCard } from './ResourceCard';
import { ALL_RESOURCES, CATEGORY_BADGE_KEY, CATEGORY_ICON, type Resource } from './resources-data';
import { pointsIn } from './resources-data-ar';
import './resources.css';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';
import { useT } from '../../../../lib/i18n/use-t';
import { useActiveLocale } from '../../../../lib/i18n/use-active-locale';
import { languageOf } from '../../../../lib/i18n/route-locale';

/**
 * WEB-15 article page (`/resources/[slug]`) for every card on the Resources index. Same visual
 * language as the index: paper hero with the category badge, an ink "what you'll take away" panel,
 * then three more articles to keep reading. Tokens and packages/ui parts only. Every word comes
 * from the catalog or the takeaways in the reader's language, so `/ar/resources/<slug>` (Figma
 * `426:13485`) is the same page in Arabic.
 */
export function ResourceArticlePage({ item }: { item: Resource }) {
  const t = useT();
  const label = t(CATEGORY_BADGE_KEY[item.category]);
  const points = pointsIn(item, languageOf(useActiveLocale()));
  const more = [
    ...ALL_RESOURCES.filter((r) => r.slug !== item.slug && r.category === item.category),
    ...ALL_RESOURCES.filter((r) => r.slug !== item.slug && r.category !== item.category),
  ].slice(0, 3);

  return (
    <>
      <WebSection className="tm-web-res-article" aria-labelledby="res-article-title">
        <nav
          className="tm-web-res-article__crumbs"
          aria-label={t('ResourceArticlePage.breadcrumbLabel')}
        >
          <Link href="/resources">{t('ResourceArticlePage.resources')}</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{label}</span>
        </nav>
        <div className="tm-web-res-article__grid">
          <SectionHeader
            as="h1"
            size="page"
            id="res-article-title"
            eyebrow={label.toUpperCase()}
            title={t(item.titleKey)}
            lede={t(item.lineKey)}
          >
            <p className="tm-web-res-article__meta">
              <span>{t(item.metaKey)}</span>
              <span aria-hidden="true"> · </span>
              <span>{t('ResourceArticlePage.writtenBy')}</span>
            </p>
          </SectionHeader>
          <aside className="tm-web-res-takeaways" aria-labelledby="res-takeaways-title">
            <div className="tm-web-res-takeaways__head">
              <IconOrb icon={CATEGORY_ICON[item.category]} tone="lime" />
              <Badge mono className="tm-web-res-guide__badge">
                {label.toUpperCase()}
              </Badge>
            </div>
            <h2 id="res-takeaways-title" className="tm-web-res-takeaways__title">
              {t('ResourceArticlePage.takeaways')}
            </h2>
            <ol className="tm-web-res-takeaways__list">
              {points.map((point, i) => (
                <li key={point}>
                  <span className="tm-web-res-takeaways__n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span>{point}</span>
                </li>
              ))}
            </ol>
            <p className="tm-web-res-takeaways__note">{t('ResourceArticlePage.note')}</p>
            <div className="tm-web-res-guide__actions">
              <ButtonLink href="/resources#res-newsletter" tone="lime" size="accessible">
                {t('ResourceArticlePage.getByEmail')}
              </ButtonLink>
              <ArrowLink href="/resources" tone="ink">
                {t('ResourceArticlePage.allResources')}
              </ArrowLink>
            </div>
          </aside>
        </div>
      </WebSection>

      <WebSection tone="sunken" className="tm-web-res-more" aria-labelledby="res-more-title">
        <SectionHeader id="res-more-title" title={t('ResourceArticlePage.keepReading')} />
        <ul className="tm-web-res-grid">
          {more.map((r) => (
            <li key={r.slug}>
              <ResourceCard item={r} />
            </li>
          ))}
        </ul>
      </WebSection>

      <CtaBand
        title={t('ResourceArticlePage.ctaTitle')}
        lede={t('ResourceArticlePage.ctaLede')}
        primary={{ label: t('ResourceArticlePage.ctaStartFree'), href: SIGN_UP_HREF }}
        secondary={{ label: t('ResourceArticlePage.ctaBookDemo'), href: '/contact' }}
        note={t('ResourceArticlePage.ctaNote')}
        visual={null}
      />
    </>
  );
}
