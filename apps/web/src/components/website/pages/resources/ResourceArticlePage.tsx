'use client';

import Link from 'next/link';
import { Badge } from '@tmanage/ui';
import { ArrowLink, ButtonLink, IconOrb } from '../../primitives';
import { CtaBand, SectionHeader, WebSection } from '../../sections';
import { ResourceCard } from './ResourceCard';
import { ALL_RESOURCES, CATEGORY_ICON, CATEGORY_LABEL, type Resource } from './resources-data';
import './resources.css';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';

/**
 * WEB-15 article page (`/resources/[slug]`) for every card on the Resources index. Same visual
 * language as the index: paper hero with the category badge, an ink "what you'll take away" panel,
 * then three more articles to keep reading. Tokens and packages/ui parts only.
 */
export function ResourceArticlePage({ item }: { item: Resource }) {
  const label = CATEGORY_LABEL[item.category];
  const more = [
    ...ALL_RESOURCES.filter((r) => r.slug !== item.slug && r.category === item.category),
    ...ALL_RESOURCES.filter((r) => r.slug !== item.slug && r.category !== item.category),
  ].slice(0, 3);

  return (
    <>
      <WebSection className="tm-web-res-article" aria-labelledby="res-article-title">
        <nav className="tm-web-res-article__crumbs" aria-label="Breadcrumb">
          <Link href="/resources">Resources</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{label}</span>
        </nav>
        <div className="tm-web-res-article__grid">
          <SectionHeader
            as="h1"
            size="page"
            id="res-article-title"
            eyebrow={label.toUpperCase()}
            title={item.title}
            lede={item.line}
          >
            <p className="tm-web-res-article__meta">
              <span>{item.meta}</span>
              <span aria-hidden="true"> · </span>
              <span>Written by the TManage team</span>
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
              What you’ll take away
            </h2>
            <ol className="tm-web-res-takeaways__list">
              {item.points.map((point, i) => (
                <li key={point}>
                  <span className="tm-web-res-takeaways__n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span>{point}</span>
                </li>
              ))}
            </ol>
            <p className="tm-web-res-takeaways__note">
              The full piece goes out with the next issue of the newsletter.
            </p>
            <div className="tm-web-res-guide__actions">
              <ButtonLink href="/resources#res-newsletter" tone="lime" size="accessible">
                Get it by email
              </ButtonLink>
              <ArrowLink href="/resources" tone="ink">
                All resources
              </ArrowLink>
            </div>
          </aside>
        </div>
      </WebSection>

      <WebSection tone="sunken" className="tm-web-res-more" aria-labelledby="res-more-title">
        <SectionHeader id="res-more-title" title="Keep reading" />
        <ul className="tm-web-res-grid">
          {more.map((r) => (
            <li key={r.slug}>
              <ResourceCard item={r} />
            </li>
          ))}
        </ul>
      </WebSection>

      <CtaBand
        title="Bring the next client project into one story."
        lede="Start free with your team. Invite your client when the first deliverable is ready."
        primary={{ label: 'Start free', href: SIGN_UP_HREF }}
        secondary={{ label: 'Book a demo', href: '/contact' }}
        note="No credit card · Client users are always free"
        visual={null}
      />
    </>
  );
}
