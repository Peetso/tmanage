'use client';

import { Badge, StateCapsule, StatusDot } from '@tmanage/ui';
import { ArrowLink, ButtonLink } from '../../primitives';
import { FeatureRow, SectionHeader, WebSection } from '../../sections';
import { ApprovalScene, AuditLogScene, OffboardingScene, PublicationScene } from './SecurityScenes';
import './security.css';

/**
 * Security & trust (`/security`, SITE-SPEC "PAGE: Security & trust", Figma 12-security).
 * Ink hero, six guarantees, three alternating product rows, the documents list with status and
 * disclosure cards, and the security CTA band. Copy is the spec's, word for word.
 */

const GUARANTEES: readonly { title: string; body: string }[] = [
  { title: 'Tenancy', body: 'Row-level isolation on every query.' },
  {
    title: 'Client access',
    body: 'Clients read a computed projection, never the internal record.',
  },
  { title: 'Files', body: 'Malware-scanned, short-lived signed links.' },
  { title: 'Identity', body: 'Passkeys, MFA, SSO and session revocation.' },
  { title: 'Evidence', body: 'Append-only audit for approvals, publications and access.' },
  { title: 'AI boundary', body: 'Cites sources. Cannot publish, approve, invite or delete.' },
];

/*
 * No document is a public file yet: each one goes out with the security pack, so the actions say
 * "Request" and open the contact form. Only the privacy terms are a live page. The `id`s are the
 * anchors the footer's Trust column links to.
 */
const PACK_REQUEST = '/contact#book-demo-form';

const DOCUMENTS: readonly {
  id: string;
  title: string;
  body: string;
  badge: string;
  action?: { label: string; href: string };
}[] = [
  {
    id: 'security-overview',
    title: 'Security overview',
    body: 'Architecture, isolation model and controls in one document.',
    badge: 'PDF',
    action: { label: 'Request PDF', href: PACK_REQUEST },
  },
  {
    id: 'sub-processors',
    title: 'Sub-processors',
    body: 'Every service that touches customer data, kept current.',
    badge: 'Live list',
    action: { label: 'Request list', href: PACK_REQUEST },
  },
  {
    id: 'privacy-terms',
    title: 'DPA & privacy terms',
    body: 'Data processing agreement and privacy commitments.',
    badge: 'PDF',
    action: { label: 'Read privacy terms', href: '/legal/privacy' },
  },
  {
    id: 'accessibility',
    title: 'Accessibility report',
    body: 'Conformance for the product and the client portal.',
    badge: 'WCAG 2.2 AA',
    action: { label: 'Request report', href: PACK_REQUEST },
  },
  {
    id: 'independent-audit',
    title: 'Independent audit',
    body: 'A third-party assessment of our controls.',
    badge: 'Planned',
  },
];

export function SecurityPage() {
  return (
    <div className="tm-sec">
      <WebSection tone="ink" className="tm-sec-hero" aria-labelledby="security-title">
        <SectionHeader
          as="h1"
          id="security-title"
          size="hero"
          align="center"
          tone="ink"
          eyebrow="Security & trust"
          title="Internal by default. Client-ready when you choose."
          lede="Isolation is enforced in the database, not the interface. Every list, lookup, search, file link and notification is scoped to your organization."
        >
          <div className="tm-sec-hero__actions">
            <ButtonLink href={PACK_REQUEST} tone="lime">
              Request the security pack
            </ButtonLink>
            <ButtonLink href="#guarantees" tone="outline-ink">
              Read the architecture overview
            </ButtonLink>
          </div>
        </SectionHeader>
      </WebSection>

      <WebSection id="guarantees" aria-labelledby="guarantees-title">
        <SectionHeader
          id="guarantees-title"
          eyebrow="Six guarantees"
          title="Security that lives in the architecture, not in a settings page."
          lede="These hold for every organization, on every plan, from the first day."
        />
        <ol className="tm-sec-pillars">
          {GUARANTEES.map((item, index) => (
            <li
              key={item.title}
              id={item.title === 'Client access' ? 'clients' : undefined}
              className="tm-sec-pillar"
            >
              <span className="tm-web-orb tm-web-orb--lime tm-web-orb--default tm-sec-pillar__n">
                {index + 1}
              </span>
              <h3 className="tm-sec-pillar__title">{item.title}</h3>
              <p className="tm-sec-pillar__body">{item.body}</p>
            </li>
          ))}
        </ol>
      </WebSection>

      <WebSection spacing="compact" className="tm-sec-rows" aria-label="How the guarantees work">
        <FeatureRow
          label="Offboarding"
          title="Offboarding without loose ends."
          body="Suspend, revoke sessions and tokens, transfer ownership and review external shares in one guided flow."
          link={{ label: 'See the offboarding flow', href: '/product#control-center' }}
          visual={<OffboardingScene />}
        />
        <FeatureRow
          reverse
          label="Audit"
          title="Know who did what."
          body="Approvals, publications, permission changes and exports land in an append-only log you can filter, read and export."
          link={{ label: 'Explore the audit log', href: '/product#control-center' }}
          visual={<AuditLogScene />}
        />
        <FeatureRow
          label="Publication"
          title="See before you share."
          body="Before anything reaches a client, a preview shows exactly what they will see and what stays internal."
          link={{ label: 'How publishing works', href: '/client-portal' }}
          visual={<PublicationScene />}
        />
      </WebSection>

      <WebSection tone="sunken" aria-labelledby="documents-title">
        <SectionHeader
          id="documents-title"
          eyebrow="Documents"
          title="Everything your reviewer will ask for."
          lede="Request the pack once. We keep it current as the product changes."
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
            <p className="tm-sec-note__label">System status</p>
            <StatusDot tone="live">All systems operational</StatusDot>
            <ArrowLink href="/status" underline={false}>
              Open status page
            </ArrowLink>
          </div>
          <div className="tm-sec-note">
            <p className="tm-sec-note__label">Responsible disclosure</p>
            <p className="tm-sec-note__text">
              Found a vulnerability? Write to security@ — we respond within two business days.
            </p>
          </div>
        </div>
      </WebSection>

      <section className="tm-web-cta-section" aria-labelledby="security-cta-title">
        <div className="tm-web-container">
          <div className="tm-web-cta tm-sec-cta">
            <div className="tm-web-cta__text">
              <h2 className="tm-web-cta__title" id="security-cta-title">
                Questions from your security team? We’ll answer them in writing.
              </h2>
              <p className="tm-web-cta__lede">
                Send your questionnaire and get written answers with links to the evidence behind
                them.
              </p>
              <div className="tm-web-cta__actions">
                <ButtonLink href={PACK_REQUEST} tone="lime">
                  Request the security pack
                </ButtonLink>
                <ButtonLink href="/contact" tone="outline-ink">
                  Book a call
                </ButtonLink>
              </div>
              <p className="tm-web-cta__note">
                Security overview · Sub-processors · DPA · Accessibility report
              </p>
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
