'use client';

import { Badge, StateCapsule } from '@tmanage/ui';
import type { ReactNode } from 'react';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';
import { ArrowLink, ButtonLink, Eyebrow, cx } from '../../primitives';
import { CtaBand, ProductVisualFrame, SectionHeader, Stat, WebSection } from '../../sections';
import {
  ApprovalScene,
  ArabicPortalScene,
  PortalOverviewScene,
  RequestsScene,
} from './PortalScenes';
import './client-portal.css';

/**
 * WEB-07 · Client portal, matching the round-2 Figma frame (node 308:32): centred ink hero with
 * the portal overview cropped below it, three numbered "thirty seconds" cards, the approvals and
 * requests rows, the audience list on a sunken band, the "always free" stat, the bilingual card
 * and the standard CTA band with the Delivery risk crop.
 */

const THIRTY_SECONDS: readonly { titleKey: MessageKey; bodyKey: MessageKey }[] = [
  { titleKey: 'ClientPortalPage.thirtyStageTitle', bodyKey: 'ClientPortalPage.thirtyStageBody' },
  { titleKey: 'ClientPortalPage.thirtyMetricTitle', bodyKey: 'ClientPortalPage.thirtyMetricBody' },
  {
    titleKey: 'ClientPortalPage.thirtyActionsTitle',
    bodyKey: 'ClientPortalPage.thirtyActionsBody',
  },
];

/**
 * A feature row in the page's own eyebrow style (Geist Mono + lime dot, like every other
 * section here). Same `tm-web-feature` grid as the shared FeatureRow, so the zig-zag mirrors.
 */
function PortalFeatureRow({
  eyebrow,
  title,
  body,
  link,
  visual,
  reverse = false,
}: {
  eyebrow: string;
  title: string;
  body: string;
  link: { label: string; href: string };
  visual: ReactNode;
  reverse?: boolean;
}) {
  return (
    <div className={cx('tm-web-feature', 'tm-cp-feature', reverse && 'tm-web-feature--reverse')}>
      <div className="tm-web-feature__text">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h3 className="tm-web-feature__title">{title}</h3>
        <p className="tm-web-feature__body">{body}</p>
        <ArrowLink href={link.href} underline={false}>
          {link.label}
        </ArrowLink>
      </div>
      <ProductVisualFrame>{visual}</ProductVisualFrame>
    </div>
  );
}

const AUDIENCES: readonly {
  titleKey: MessageKey;
  bodyKey: MessageKey;
  marker: 'internal' | 'client' | 'action';
}[] = [
  {
    titleKey: 'ClientPortalPage.audienceInternalTitle',
    bodyKey: 'ClientPortalPage.audienceInternalBody',
    marker: 'internal',
  },
  {
    titleKey: 'ClientPortalPage.audienceClientTitle',
    bodyKey: 'ClientPortalPage.audienceClientBody',
    marker: 'client',
  },
  {
    titleKey: 'ClientPortalPage.audienceActionTitle',
    bodyKey: 'ClientPortalPage.audienceActionBody',
    marker: 'action',
  },
];

function AudienceMarker({ marker }: { marker: 'internal' | 'client' | 'action' }) {
  const t = useT();
  if (marker === 'internal') return <Badge>{t('ClientPortalPage.markerInternal')}</Badge>;
  if (marker === 'client')
    return <StateCapsule state="client">{t('ClientPortalPage.markerClientVisible')}</StateCapsule>;
  return <StateCapsule state="waiting">{t('ClientPortalPage.markerActionRequired')}</StateCapsule>;
}

export function ClientPortalPage() {
  const t = useT();
  return (
    <>
      {/* 2 · Hero (ink) */}
      <WebSection tone="ink" id="demo" className="tm-cp-hero" aria-labelledby="cp-hero-title">
        <div className="tm-cp-hero__stack">
          <SectionHeader
            as="h1"
            size="page"
            tone="ink"
            align="center"
            id="cp-hero-title"
            eyebrow={t('ClientPortalPage.heroEyebrow')}
            title={t('ClientPortalPage.heroTitle')}
            lede={t('ClientPortalPage.heroLede')}
          >
            <div className="tm-cp-hero__actions">
              {/* No public demo portal route exists yet; the demo is booked from /contact. */}
              <ButtonLink href="/contact" tone="lime">
                {t('ClientPortalPage.heroDemoCta')}
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline-ink">
                {t('ClientPortalPage.heroBookCta')}
              </ButtonLink>
            </div>
          </SectionHeader>
          <ProductVisualFrame className="tm-cp-hero__visual">
            <PortalOverviewScene />
          </ProductVisualFrame>
        </div>
      </WebSection>

      {/* 3 · Thirty seconds */}
      <WebSection aria-labelledby="cp-thirty-title">
        <SectionHeader
          align="center"
          id="cp-thirty-title"
          eyebrow={t('ClientPortalPage.thirtyEyebrow')}
          title={t('ClientPortalPage.thirtyTitleDesign')}
          lede={t('ClientPortalPage.thirtyLedeDesign')}
        />
        <ol className="tm-cp-three">
          {THIRTY_SECONDS.map((item, index) => (
            <li key={item.titleKey} className="tm-web-graph-card tm-cp-glance">
              <span className="tm-cp-step" aria-hidden="true">
                {index + 1}
              </span>
              <h3 className="tm-web-graph-card__title">{t(item.titleKey)}</h3>
              <p className="tm-web-graph-card__body">{t(item.bodyKey)}</p>
            </li>
          ))}
        </ol>
      </WebSection>

      {/* 4 · Approvals · 5 · Requests */}
      <WebSection spacing="compact" aria-label={t('ClientPortalPage.approvalsRequestsAria')}>
        <PortalFeatureRow
          eyebrow={t('ClientPortalPage.approvalsEyebrow')}
          title={t('ClientPortalPage.approvalsTitle')}
          body={t('ClientPortalPage.approvalsBody')}
          link={{ label: t('ClientPortalPage.approvalsLink'), href: '/features/knowledge' }}
          visual={<ApprovalScene />}
        />
        <PortalFeatureRow
          reverse
          eyebrow={t('ClientPortalPage.requestsEyebrow')}
          title={t('ClientPortalPage.requestsTitle')}
          body={t('ClientPortalPage.requestsBody')}
          link={{ label: t('ClientPortalPage.requestsLink'), href: '/features/work' }}
          visual={<RequestsScene />}
        />
      </WebSection>

      {/* 6 · Invisible, not hidden (paper/150 band) */}
      <WebSection tone="sunken" aria-labelledby="cp-invisible-title">
        <div className="tm-cp-split">
          <SectionHeader
            id="cp-invisible-title"
            eyebrow={t('ClientPortalPage.invisibleEyebrow')}
            title={t('ClientPortalPage.invisibleTitle')}
            lede={t('ClientPortalPage.invisibleLede')}
            link={{ label: t('ClientPortalPage.invisibleLink'), href: '/security' }}
          />
          <ul className="tm-cp-audiences">
            {AUDIENCES.map((audience) => (
              <li key={audience.titleKey} className="tm-cp-audience">
                <span className="tm-cp-audience__text">
                  <span className="tm-cp-audience__title">{t(audience.titleKey)}</span>
                  <span className="tm-cp-audience__body">{t(audience.bodyKey)}</span>
                </span>
                <AudienceMarker marker={audience.marker} />
              </li>
            ))}
          </ul>
        </div>
      </WebSection>

      {/* 7 · Free for clients */}
      <WebSection aria-labelledby="cp-free-title">
        <div className="tm-cp-free">
          <div className="tm-cp-free__text">
            <Eyebrow>{t('ClientPortalPage.freeEyebrow')}</Eyebrow>
            <h2 id="cp-free-title" className="tm-web-feature__title">
              {t('ClientPortalPage.freeTitleDesign')}
            </h2>
            <p className="tm-web-feature__body">{t('ClientPortalPage.freeStatNote')}</p>
            <ArrowLink href="/pricing" underline={false}>
              {t('ClientPortalPage.freePricingLink')}
            </ArrowLink>
          </div>
          <Stat
            value="0"
            label={t('ClientPortalPage.freeStatLabel')}
            note={t('ClientPortalPage.freeStatRoles')}
          />
        </div>
      </WebSection>

      {/* 8 · Bilingual card */}
      <WebSection spacing="flush" aria-labelledby="cp-arabic-title">
        <div className="tm-cp-arabic">
          <div className="tm-cp-arabic__text">
            <Eyebrow>{t('ClientPortalPage.arabicEyebrow')}</Eyebrow>
            <h2 id="cp-arabic-title" className="tm-web-header__title tm-cp-arabic__title">
              {t('ClientPortalPage.arabicTitle')}
            </h2>
            <p className="tm-cp-arabic__body">{t('ClientPortalPage.arabicBodyDesign')}</p>
            {/* No public Arabic demo portal exists yet; a demo is booked from /contact. */}
            <ArrowLink href="/contact" underline={false}>
              {t('ClientPortalPage.arabicLink')}
            </ArrowLink>
          </div>
          <ProductVisualFrame className="tm-cp-arabic__visual">
            <ArabicPortalScene />
          </ProductVisualFrame>
        </div>
      </WebSection>

      {/* 9 · CTA band */}
      <CtaBand title={t('ClientPortalPage.ctaTitle')} />
    </>
  );
}
