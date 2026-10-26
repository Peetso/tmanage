'use client';

import Link from '../../WebLink';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';
import {
  ButtonLink,
  CalloutPin,
  FeatureRow,
  GraphCard,
  LinkCard,
  ProductVisualFrame,
  SectionHeader,
  WebSection,
  type WebIconName,
} from '../../index';
import {
  AdminScene,
  AppShellScene,
  BilingualScene,
  InboxScene,
  PortalScene,
  WorkListScene,
} from './ProductPageScenes';
import { DesktopAppSection } from './DesktopAppSection';
import './product.css';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';

/**
 * WEB-02 · Product overview (`/product`). Copy is SITE-SPEC.md "PAGE: Product overview"; the
 * layout follows the approved Figma frame (shots/product.png). Every section is composed from
 * the shared website layer; the product visuals are mini TManage screens, not screenshots.
 */

const MODES: readonly { id: string; labelKey: MessageKey; captionKey: MessageKey }[] = [
  {
    id: 'team-workspace',
    labelKey: 'ProductPage.modeTeamLabel',
    captionKey: 'ProductPage.modeTeamCaption',
  },
  {
    id: 'focus-space',
    labelKey: 'ProductPage.modeFocusLabel',
    captionKey: 'ProductPage.modeFocusCaption',
  },
  {
    id: 'client-portal',
    labelKey: 'ProductPage.modeClientLabel',
    captionKey: 'ProductPage.modeClientCaption',
  },
  {
    id: 'control-center',
    labelKey: 'ProductPage.modeControlLabel',
    captionKey: 'ProductPage.modeControlCaption',
  },
];

const GRAPH: readonly { icon: WebIconName; titleKey: MessageKey; bodyKey: MessageKey }[] = [
  {
    icon: 'id',
    titleKey: 'ProductPage.graphIdentityTitle',
    bodyKey: 'ProductPage.graphIdentityBody',
  },
  {
    icon: 'person',
    titleKey: 'ProductPage.graphResponsibilityTitle',
    bodyKey: 'ProductPage.graphResponsibilityBody',
  },
  {
    icon: 'calendar',
    titleKey: 'ProductPage.graphTimeTitle',
    bodyKey: 'ProductPage.graphTimeBody',
  },
  {
    icon: 'globe',
    titleKey: 'ProductPage.graphAudienceTitle',
    bodyKey: 'ProductPage.graphAudienceBody',
  },
  {
    icon: 'link',
    titleKey: 'ProductPage.graphContextTitle',
    bodyKey: 'ProductPage.graphContextBody',
  },
  {
    icon: 'check',
    titleKey: 'ProductPage.graphEvidenceTitle',
    bodyKey: 'ProductPage.graphEvidenceBody',
  },
];

const REPLACED: readonly MessageKey[] = [
  'ProductPage.replacedMeetings',
  'ProductPage.replacedScreenshots',
  'ProductPage.replacedVersion',
  'ProductPage.replacedRetyping',
];

const FEATURE_INDEX: readonly { titleKey: MessageKey; hintKey: MessageKey; href: string }[] = [
  {
    titleKey: 'ProductPage.fiWorkTitle',
    hintKey: 'ProductPage.fiWorkHint',
    href: '/features/work',
  },
  {
    titleKey: 'ProductPage.fiProjectsTitle',
    hintKey: 'ProductPage.fiProjectsHint',
    href: '/features/work#projects',
  },
  {
    titleKey: 'ProductPage.fiChatTitle',
    hintKey: 'ProductPage.fiChatHint',
    href: '/features/communication',
  },
  {
    titleKey: 'ProductPage.fiCalendarTitle',
    hintKey: 'ProductPage.fiCalendarHint',
    href: '/features/communication#calendar',
  },
  {
    titleKey: 'ProductPage.fiDocsTitle',
    hintKey: 'ProductPage.fiDocsHint',
    href: '/features/knowledge',
  },
  {
    titleKey: 'ProductPage.fiApprovalsTitle',
    hintKey: 'ProductPage.fiApprovalsHint',
    href: '/features/knowledge#approvals',
  },
  {
    titleKey: 'ProductPage.fiPortalTitle',
    hintKey: 'ProductPage.fiPortalHint',
    href: '/client-portal',
  },
  {
    titleKey: 'ProductPage.fiInsightsTitle',
    hintKey: 'ProductPage.fiInsightsHint',
    href: '/features/insights',
  },
  {
    titleKey: 'ProductPage.fiAutomationsTitle',
    hintKey: 'ProductPage.fiAutomationsHint',
    href: '/features/insights#automations',
  },
];

/**
 * Web/CTA band as specified (SITE-SPEC "Web/CTA band", 02-product): the centred text-only ink
 * panel with "Start free" (Lime) and "Book a demo" (Outline on ink). Composed from the shared
 * band classes and ButtonLink, because the shared CtaBand's secondary slot is a play capsule.
 */
function ProductCtaBand() {
  const t = useT();
  return (
    <section className="tm-web-cta-section tm-pp-cta" aria-labelledby="pp-cta-title">
      <div className="tm-web-container">
        <div className="tm-web-cta tm-web-cta--text">
          <div className="tm-web-cta__text">
            <h2 id="pp-cta-title" className="tm-web-cta__title">
              {t('ProductPage.ctaTitle')}
            </h2>
            <p className="tm-web-cta__lede">{t('ProductPage.ctaLede')}</p>
            <div className="tm-web-cta__actions">
              <ButtonLink href={SIGN_UP_HREF} tone="lime">
                {t('ProductPage.startFree')}
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline-ink">
                {t('ProductPage.bookDemo')}
              </ButtonLink>
            </div>
            <p className="tm-web-cta__note">{t('ProductPage.ctaNote')}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function ProductPage() {
  const t = useT();
  return (
    <div className="tm-pp">
      {/* 2–3 · Hero and the big product visual */}
      <WebSection className="tm-pp-hero" aria-labelledby="pp-hero-title">
        <SectionHeader
          as="h1"
          size="page"
          align="center"
          id="pp-hero-title"
          eyebrow={t('ProductPage.heroEyebrow')}
          title={t('ProductPage.heroTitle')}
          lede={t('ProductPage.heroLede')}
        >
          <div className="tm-pp-hero__actions">
            <ButtonLink href={SIGN_UP_HREF} tone="lime">
              {t('ProductPage.startFree')}
            </ButtonLink>
            <ButtonLink href="/contact" tone="outline">
              {t('ProductPage.bookDemo')}
            </ButtonLink>
          </div>
        </SectionHeader>
        <nav className="tm-pp-anchors" aria-label={t('ProductPage.anchorsAria')}>
          <ul className="tm-pp-anchors__list">
            {MODES.map((mode, index) => (
              <li key={mode.id}>
                <Link href={`#${mode.id}`} className="tm-pp-anchor">
                  <CalloutPin n={index + 1} />
                  <span>{t(mode.labelKey)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <ProductVisualFrame tone="ink" className="tm-pp-stage">
          <AppShellScene />
        </ProductVisualFrame>
        <ol className="tm-pp-captions">
          {MODES.map((mode, index) => (
            <li key={mode.id} className="tm-pp-caption">
              <CalloutPin n={index + 1} />
              <span>{t(mode.captionKey)}</span>
            </li>
          ))}
        </ol>
      </WebSection>

      {/* 4 · The work graph */}
      <WebSection aria-labelledby="pp-graph-title">
        <SectionHeader
          id="pp-graph-title"
          eyebrow={t('ProductPage.graphEyebrow')}
          title={t('ProductPage.graphTitle')}
          lede={t('ProductPage.graphLede')}
        />
        <div className="tm-pp-graph">
          {GRAPH.map((item) => (
            <GraphCard
              key={item.titleKey}
              icon={item.icon}
              title={t(item.titleKey)}
              body={t(item.bodyKey)}
            />
          ))}
        </div>
      </WebSection>

      {/* 5 · Four modes */}
      <WebSection aria-labelledby="pp-modes-title" className="tm-pp-modes">
        <SectionHeader
          id="pp-modes-title"
          align="center"
          eyebrow={t('ProductPage.modesEyebrow')}
          title={t('ProductPage.modesTitle')}
          lede={t('ProductPage.modesLede')}
        />
        <FeatureRow
          id="team-workspace"
          step={1}
          label={t('ProductPage.modeTeamLabel')}
          title={t('ProductPage.teamTitle')}
          body={t('ProductPage.teamBody')}
          link={{ label: t('ProductPage.teamLink'), href: '/features/work' }}
          visual={<WorkListScene />}
        />
        <FeatureRow
          id="focus-space"
          step={2}
          label={t('ProductPage.modeFocusLabel')}
          title={t('ProductPage.focusTitle')}
          body={t('ProductPage.focusBody')}
          link={{ label: t('ProductPage.focusLink'), href: '/features/communication' }}
          visual={<InboxScene />}
          reverse
        />
        <FeatureRow
          id="client-portal"
          step={3}
          label={t('ProductPage.modeClientLabel')}
          title={t('ProductPage.clientTitle')}
          body={t('ProductPage.clientBody')}
          link={{ label: t('ProductPage.clientLink'), href: '/client-portal' }}
          visual={<PortalScene />}
        />
        <FeatureRow
          id="control-center"
          step={4}
          label={t('ProductPage.modeControlLabel')}
          title={t('ProductPage.controlTitle')}
          body={t('ProductPage.controlBody')}
          link={{ label: t('ProductPage.controlLink'), href: '/security' }}
          visual={<AdminScene />}
          reverse
        />
      </WebSection>

      {/* 6 · What it replaces */}
      <WebSection tone="sunken" spacing="compact" aria-labelledby="pp-replaces-title">
        <SectionHeader
          id="pp-replaces-title"
          align="center"
          title={t('ProductPage.replacesTitle')}
          lede={t('ProductPage.replacesLede')}
        />
        <ul className="tm-pp-replaced">
          {REPLACED.map((item) => (
            <li key={item} className="tm-web-chip tm-pp-replaced__chip">
              <s>{t(item)}</s>
            </li>
          ))}
        </ul>
      </WebSection>

      {/* 7 · Feature index */}
      <WebSection aria-labelledby="pp-index-title">
        <SectionHeader
          id="pp-index-title"
          eyebrow={t('ProductPage.indexEyebrow')}
          title={t('ProductPage.indexTitle')}
          lede={t('ProductPage.indexLede')}
        />
        <div className="tm-pp-index">
          {FEATURE_INDEX.map((item) => (
            <LinkCard
              key={item.titleKey}
              title={t(item.titleKey)}
              hint={t(item.hintKey)}
              href={item.href}
            />
          ))}
        </div>
      </WebSection>

      {/* 8 · Bilingual band */}
      <WebSection spacing="flush" className="tm-pp-bilingual-section">
        <FeatureRow
          label={t('ProductPage.bilingualLabel')}
          title={t('ProductPage.bilingualTitle')}
          body={t('ProductPage.bilingualBody')}
          visual={<BilingualScene />}
        />
      </WebSection>

      {/* 8b · TManage for Windows (Figma 409:6602) */}
      <DesktopAppSection />

      {/* 9 · CTA band (10 · footer comes from the website layout) */}
      <ProductCtaBand />
    </div>
  );
}
