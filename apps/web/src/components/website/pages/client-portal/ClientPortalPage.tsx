'use client';

import { Badge, StateCapsule } from '@tmanage/ui';
import type { ReactNode } from 'react';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';
import { ArrowLink, ButtonLink, Eyebrow, IconOrb, cx } from '../../primitives';
import { CtaBand, ProductVisualFrame, SectionHeader, Stat, WebSection } from '../../sections';
import type { WebIconName } from '../../WebIcon';
import {
  ApprovalScene,
  ArabicPortalScene,
  ClientSeatsScene,
  MiniActionPeek,
  MiniMetricPeek,
  MiniStagePeek,
  PortalCtaScene,
  PortalOverviewScene,
  RequestsScene,
} from './PortalScenes';
import './client-portal.css';

/**
 * WEB-07 · Client portal. No Figma frame exists for this page yet, so it is composed in code
 * from SITE-SPEC.md in the visual language of the designed pages (Features · Docs & approvals,
 * Solutions): ink hero, centred section header over three cards, alternating feature rows,
 * a sunken band, a stat with a product scene, a lime feature card, then the ink CTA band.
 */

const THIRTY_SECONDS: readonly {
  icon: WebIconName;
  titleKey: MessageKey;
  bodyKey: MessageKey;
  peek: ReactNode;
}[] = [
  {
    icon: 'flag',
    titleKey: 'ClientPortalPage.thirtyStageTitle',
    bodyKey: 'ClientPortalPage.thirtyStageBody',
    peek: <MiniStagePeek />,
  },
  {
    icon: 'pulse',
    titleKey: 'ClientPortalPage.thirtyMetricTitle',
    bodyKey: 'ClientPortalPage.thirtyMetricBody',
    peek: <MiniMetricPeek />,
  },
  {
    icon: 'check',
    titleKey: 'ClientPortalPage.thirtyActionsTitle',
    bodyKey: 'ClientPortalPage.thirtyActionsBody',
    peek: <MiniActionPeek />,
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
  icon: WebIconName;
  titleKey: MessageKey;
  bodyKey: MessageKey;
  marker: 'internal' | 'client' | 'action';
}[] = [
  {
    icon: 'lock',
    titleKey: 'ClientPortalPage.audienceInternalTitle',
    bodyKey: 'ClientPortalPage.audienceInternalBody',
    marker: 'internal',
  },
  {
    icon: 'portal',
    titleKey: 'ClientPortalPage.audienceClientTitle',
    bodyKey: 'ClientPortalPage.audienceClientBody',
    marker: 'client',
  },
  {
    icon: 'bolt',
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
        <div className="tm-cp-hero__grid">
          <SectionHeader
            as="h1"
            size="page"
            tone="ink"
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
          <div className="tm-cp-hero__visual">
            <PortalOverviewScene />
          </div>
        </div>
      </WebSection>

      {/* 3 · Thirty seconds */}
      <WebSection aria-labelledby="cp-thirty-title">
        <SectionHeader
          align="center"
          id="cp-thirty-title"
          eyebrow={t('ClientPortalPage.thirtyEyebrow')}
          title={t('ClientPortalPage.thirtyTitle')}
          lede={t('ClientPortalPage.thirtyLede')}
        />
        <div className="tm-cp-three">
          {THIRTY_SECONDS.map((item) => (
            <div key={item.titleKey} className="tm-web-graph-card tm-cp-glance">
              <IconOrb icon={item.icon} tone="lime" />
              <h3 className="tm-web-graph-card__title">{t(item.titleKey)}</h3>
              <p className="tm-web-graph-card__body">{t(item.bodyKey)}</p>
              <div className="tm-cp-glance__peek">{item.peek}</div>
            </div>
          ))}
        </div>
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
                <IconOrb
                  icon={audience.icon}
                  tone={audience.marker === 'internal' ? 'outline' : 'lime'}
                />
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
              {t('ClientPortalPage.freeTitle')}
            </h2>
            <Stat
              value="0"
              label={t('ClientPortalPage.freeStatLabel')}
              note={t('ClientPortalPage.freeStatNote')}
            />
          </div>
          <ProductVisualFrame>
            <ClientSeatsScene />
          </ProductVisualFrame>
        </div>
      </WebSection>

      {/* 8 · Bilingual card */}
      <WebSection spacing="flush" aria-labelledby="cp-arabic-title">
        <div className="tm-cp-arabic">
          <div className="tm-cp-arabic__text">
            <Eyebrow>
              <span>{t('ClientPortalPage.arabicEyebrowEnglish')}</span>
              <span aria-hidden="true">·</span>
              <span lang="ar">العربية</span>
            </Eyebrow>
            <h2 id="cp-arabic-title" className="tm-web-header__title tm-cp-arabic__title">
              {t('ClientPortalPage.arabicTitle')}
            </h2>
            <p className="tm-cp-arabic__body">{t('ClientPortalPage.arabicBody')}</p>
          </div>
          <div className="tm-cp-arabic__visual">
            <ArabicPortalScene />
          </div>
        </div>
      </WebSection>

      {/* 9 · CTA band */}
      <CtaBand title={t('ClientPortalPage.ctaTitle')} visual={<PortalCtaScene />} />
    </>
  );
}
