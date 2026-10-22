'use client';

import { Badge, StateCapsule, StatusDot } from '@tmanage/ui';
import { ArrowLink, ButtonLink } from '../../primitives';
import { FeatureRow, SectionHeader, WebSection } from '../../sections';
import { ApprovalScene, AuditLogScene, OffboardingScene, PublicationScene } from './SecurityScenes';
import './security.css';
import { useT } from '../../../../lib/i18n/use-t';

/**
 * Security & trust (`/security`, SITE-SPEC "PAGE: Security & trust", Figma 12-security).
 * Ink hero, six guarantees, three alternating product rows, the documents list with status and
 * disclosure cards, and the security CTA band. Copy is the spec's, word for word.
 */

/*
 * No document is a public file yet: each one goes out with the security pack, so the actions say
 * "Request" and open the contact form. Only the privacy terms are a live page. The `id`s are the
 * anchors the footer's Trust column links to.
 */
const PACK_REQUEST = '/contact#book-demo-form';

/**
 * Where vulnerability reports go. The support mailbox is the only one that is live today; the
 * catalog sentence carries an `{email}` placeholder so a dedicated security@ address can replace
 * this constant later without touching either translation.
 */
export const SECURITY_DISCLOSURE_EMAIL = 'tm-support@peetrix.com';
const EMAIL_PLACEHOLDER = '{email}';

/** The disclosure sentence with the address as a real mailto link, in either language. */
export function DisclosureText({ text }: { text: string }) {
  const link = (
    <a href={`mailto:${SECURITY_DISCLOSURE_EMAIL}`} dir="ltr">
      {SECURITY_DISCLOSURE_EMAIL}
    </a>
  );
  const at = text.indexOf(EMAIL_PLACEHOLDER);
  if (at === -1) {
    // A catalog without the placeholder still gets a working address after the sentence.
    return (
      <>
        {text} {link}
      </>
    );
  }
  return (
    <>
      {text.slice(0, at)}
      {link}
      {text.slice(at + EMAIL_PLACEHOLDER.length)}
    </>
  );
}

export function SecurityPage() {
  const t = useT();

  const GUARANTEES: readonly { k: string; title: string; body: string; anchor?: string }[] = [
    {
      k: 'tenancy',
      title: t('SecurityPage.guaranteeTenancyTitle'),
      body: t('SecurityPage.guaranteeTenancyBody'),
    },
    {
      k: 'clientAccess',
      title: t('SecurityPage.guaranteeClientAccessTitle'),
      body: t('SecurityPage.guaranteeClientAccessBody'),
      anchor: 'clients',
    },
    {
      k: 'files',
      title: t('SecurityPage.guaranteeFilesTitle'),
      body: t('SecurityPage.guaranteeFilesBody'),
    },
    {
      k: 'identity',
      title: t('SecurityPage.guaranteeIdentityTitle'),
      body: t('SecurityPage.guaranteeIdentityBody'),
    },
    {
      k: 'evidence',
      title: t('SecurityPage.guaranteeEvidenceTitle'),
      body: t('SecurityPage.guaranteeEvidenceBody'),
    },
    {
      k: 'aiBoundary',
      title: t('SecurityPage.guaranteeAiBoundaryTitle'),
      body: t('SecurityPage.guaranteeAiBoundaryBody'),
    },
  ];

  const DOCUMENTS: readonly {
    id: string;
    title: string;
    body: string;
    badge: string;
    action?: { label: string; href: string };
  }[] = [
    {
      id: 'security-overview',
      title: t('SecurityPage.docOverviewTitle'),
      body: t('SecurityPage.docOverviewBody'),
      badge: t('SecurityPage.docOverviewBadge'),
      action: { label: t('SecurityPage.docOverviewAction'), href: PACK_REQUEST },
    },
    {
      id: 'sub-processors',
      title: t('SecurityPage.docSubProcessorsTitle'),
      body: t('SecurityPage.docSubProcessorsBody'),
      badge: t('SecurityPage.docSubProcessorsBadge'),
      action: { label: t('SecurityPage.docSubProcessorsAction'), href: PACK_REQUEST },
    },
    {
      id: 'privacy-terms',
      title: t('SecurityPage.docPrivacyTitle'),
      body: t('SecurityPage.docPrivacyBody'),
      badge: t('SecurityPage.docPrivacyBadge'),
      action: { label: t('SecurityPage.docPrivacyAction'), href: '/legal/privacy' },
    },
    {
      id: 'accessibility',
      title: t('SecurityPage.docAccessibilityTitle'),
      body: t('SecurityPage.docAccessibilityBody'),
      badge: t('SecurityPage.docAccessibilityBadge'),
      action: { label: t('SecurityPage.docAccessibilityAction'), href: PACK_REQUEST },
    },
    {
      id: 'independent-audit',
      title: t('SecurityPage.docAuditTitle'),
      body: t('SecurityPage.docAuditBody'),
      badge: t('SecurityPage.docAuditBadge'),
    },
  ];

  return (
    <div className="tm-sec">
      <WebSection tone="ink" className="tm-sec-hero" aria-labelledby="security-title">
        <SectionHeader
          as="h1"
          id="security-title"
          size="hero"
          align="center"
          tone="ink"
          eyebrow={t('SecurityPage.heroEyebrow')}
          title={t('SecurityPage.heroTitle')}
          lede={t('SecurityPage.heroLede')}
        >
          <div className="tm-sec-hero__actions">
            <ButtonLink href={PACK_REQUEST} tone="lime">
              {t('SecurityPage.heroRequestPack')}
            </ButtonLink>
            <ButtonLink href="#guarantees" tone="outline-ink">
              {t('SecurityPage.heroReadArchitecture')}
            </ButtonLink>
          </div>
        </SectionHeader>
      </WebSection>

      <WebSection id="guarantees" aria-labelledby="guarantees-title">
        <SectionHeader
          id="guarantees-title"
          eyebrow={t('SecurityPage.guaranteesEyebrow')}
          title={t('SecurityPage.guaranteesTitle')}
          lede={t('SecurityPage.guaranteesLede')}
        />
        <ol className="tm-sec-pillars">
          {GUARANTEES.map((item, index) => (
            <li key={item.k} id={item.anchor} className="tm-sec-pillar">
              <span className="tm-web-orb tm-web-orb--lime tm-web-orb--default tm-sec-pillar__n">
                {index + 1}
              </span>
              <h3 className="tm-sec-pillar__title">{item.title}</h3>
              <p className="tm-sec-pillar__body">{item.body}</p>
            </li>
          ))}
        </ol>
      </WebSection>

      <WebSection
        spacing="compact"
        className="tm-sec-rows"
        aria-label={t('SecurityPage.rowsLabel')}
      >
        <FeatureRow
          label={t('SecurityPage.rowOffboardingLabel')}
          title={t('SecurityPage.rowOffboardingTitle')}
          body={t('SecurityPage.rowOffboardingBody')}
          link={{ label: t('SecurityPage.rowOffboardingLink'), href: '/product#control-center' }}
          visual={<OffboardingScene />}
        />
        <FeatureRow
          reverse
          label={t('SecurityPage.rowAuditLabel')}
          title={t('SecurityPage.rowAuditTitle')}
          body={t('SecurityPage.rowAuditBody')}
          link={{ label: t('SecurityPage.rowAuditLink'), href: '/product#control-center' }}
          visual={<AuditLogScene />}
        />
        <FeatureRow
          label={t('SecurityPage.rowPublicationLabel')}
          title={t('SecurityPage.rowPublicationTitle')}
          body={t('SecurityPage.rowPublicationBody')}
          link={{ label: t('SecurityPage.rowPublicationLink'), href: '/client-portal' }}
          visual={<PublicationScene />}
        />
      </WebSection>

      <WebSection tone="sunken" aria-labelledby="documents-title">
        <SectionHeader
          id="documents-title"
          eyebrow={t('SecurityPage.documentsEyebrow')}
          title={t('SecurityPage.documentsTitle')}
          lede={t('SecurityPage.documentsLede')}
        />
        <ul className="tm-sec-docs">
          {DOCUMENTS.map((doc) => (
            <li key={doc.title} id={doc.id} className="tm-sec-doc">
              <span className="tm-sec-doc__text">
                <span className="tm-sec-doc__title">{doc.title}</span>
                <span className="tm-sec-doc__body">{doc.body}</span>
              </span>
              <span className="tm-sec-doc__end">
                {doc.action ? (
                  <>
                    <Badge>{doc.badge}</Badge>
                    <ArrowLink href={doc.action.href} underline={false}>
                      {doc.action.label}
                    </ArrowLink>
                  </>
                ) : (
                  <StateCapsule state="future">{doc.badge}</StateCapsule>
                )}
              </span>
            </li>
          ))}
        </ul>
        <div className="tm-sec-notes">
          <div className="tm-sec-note">
            <p className="tm-sec-note__label">{t('SecurityPage.systemStatus')}</p>
            <StatusDot tone="live">{t('SecurityPage.allOperational')}</StatusDot>
            <ArrowLink href="/status" underline={false}>
              {t('SecurityPage.openStatus')}
            </ArrowLink>
          </div>
          <div className="tm-sec-note">
            <p className="tm-sec-note__label">{t('SecurityPage.disclosureLabel')}</p>
            <p className="tm-sec-note__text">
              <DisclosureText text={t('SecurityPage.disclosureText')} />
            </p>
          </div>
        </div>
      </WebSection>

      <section className="tm-web-cta-section" aria-labelledby="security-cta-title">
        <div className="tm-web-container">
          <div className="tm-web-cta tm-sec-cta">
            <div className="tm-web-cta__text">
              <h2 className="tm-web-cta__title" id="security-cta-title">
                {t('SecurityPage.ctaTitle')}
              </h2>
              <p className="tm-web-cta__lede">{t('SecurityPage.ctaLede')}</p>
              <div className="tm-web-cta__actions">
                <ButtonLink href={PACK_REQUEST} tone="lime">
                  {t('SecurityPage.ctaRequestPack')}
                </ButtonLink>
                <ButtonLink href="/contact" tone="outline-ink">
                  {t('SecurityPage.ctaBookCall')}
                </ButtonLink>
              </div>
              <p className="tm-web-cta__note">{t('SecurityPage.ctaNote')}</p>
            </div>
            <div className="tm-web-cta__visual">
              <ApprovalScene />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
