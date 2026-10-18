'use client';

import { Badge, StateCapsule } from '@tmanage/ui';
import type { ReactNode } from 'react';
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
  title: string;
  body: string;
  peek: ReactNode;
}[] = [
  {
    icon: 'flag',
    title: 'One stage track',
    body: 'Where the project is, in plain words.',
    peek: <MiniStagePeek />,
  },
  {
    icon: 'pulse',
    title: 'One number that matters',
    body: 'Days to launch, or whatever you agree.',
    peek: <MiniMetricPeek />,
  },
  {
    icon: 'check',
    title: 'Only their actions',
    body: 'Reviews, files and answers they owe.',
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
  title: string;
  body: string;
  marker: 'internal' | 'client' | 'action';
}[] = [
  { icon: 'lock', title: 'Internal', body: 'Only your team can see this.', marker: 'internal' },
  {
    icon: 'portal',
    title: 'Client visible',
    body: 'Related client members can see this after publication.',
    marker: 'client',
  },
  {
    icon: 'bolt',
    title: 'Client action required',
    body: 'Selected client members will be asked to act.',
    marker: 'action',
  },
];

function AudienceMarker({ marker }: { marker: 'internal' | 'client' | 'action' }) {
  if (marker === 'internal') return <Badge>Internal</Badge>;
  if (marker === 'client') return <StateCapsule state="client">Client visible</StateCapsule>;
  return <StateCapsule state="waiting">Action required</StateCapsule>;
}

export function ClientPortalPage() {
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
            eyebrow="The client portal"
            title="Know what's moving, what's due, and what needs your approval."
            lede="Give clients one calm place for progress, reviews and files — generated from your work, never copied into it."
          >
            <div className="tm-cp-hero__actions">
              {/* No public demo portal route exists yet; the demo is booked from /contact. */}
              <ButtonLink href="/contact" tone="lime">
                See a live demo portal
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline-ink">
                Book a demo
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
          eyebrow="Thirty seconds"
          title="A view your client understands at a glance."
          lede="Every client portal opens the same way, so nobody has to learn it twice."
        />
        <div className="tm-cp-three">
          {THIRTY_SECONDS.map((item) => (
            <div key={item.title} className="tm-web-graph-card tm-cp-glance">
              <IconOrb icon={item.icon} tone="lime" />
              <h3 className="tm-web-graph-card__title">{item.title}</h3>
              <p className="tm-web-graph-card__body">{item.body}</p>
              <div className="tm-cp-glance__peek">{item.peek}</div>
            </div>
          ))}
        </div>
      </WebSection>

      {/* 4 · Approvals · 5 · Requests */}
      <WebSection spacing="compact" aria-label="Approvals and requests">
        <PortalFeatureRow
          eyebrow="Approvals"
          title="Approve in about ten minutes, on any device."
          body="Reviewers see the version, the criteria and earlier feedback. Approve, or request changes with a reason."
          link={{ label: 'How approvals work', href: '/features/knowledge' }}
          visual={<ApprovalScene />}
        />
        <PortalFeatureRow
          reverse
          eyebrow="Requests"
          title="Clients ask in the portal, not in five email threads."
          body="Every request gets a clear status. A desired date is recorded as a wish until your team commits."
          link={{ label: 'See work and requests', href: '/features/work' }}
          visual={<RequestsScene />}
        />
      </WebSection>

      {/* 6 · Invisible, not hidden (paper/150 band) */}
      <WebSection tone="sunken" aria-labelledby="cp-invisible-title">
        <div className="tm-cp-split">
          <SectionHeader
            id="cp-invisible-title"
            eyebrow="Invisible, not hidden"
            title={'Internal work is invisible to clients\u00a0— by construction.'}
            lede="The portal reads an allowlisted projection of your work. Internal comments, costs and other clients do not exist there."
            link={{ label: 'Security for clients', href: '/security' }}
          />
          <ul className="tm-cp-audiences">
            {AUDIENCES.map((audience) => (
              <li key={audience.title} className="tm-cp-audience">
                <IconOrb
                  icon={audience.icon}
                  tone={audience.marker === 'internal' ? 'outline' : 'lime'}
                />
                <span className="tm-cp-audience__text">
                  <span className="tm-cp-audience__title">{audience.title}</span>
                  <span className="tm-cp-audience__body">{audience.body}</span>
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
            <Eyebrow>Free for clients</Eyebrow>
            <h2 id="cp-free-title" className="tm-web-feature__title">
              Bring the whole client team, not just one contact.
            </h2>
            <Stat
              value="0"
              label="seats used by client users, on every plan"
              note="Invite sponsors, reviewers and viewers without counting seats."
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
              <span>English</span>
              <span aria-hidden="true">·</span>
              <span lang="ar">العربية</span>
            </Eyebrow>
            <h2 id="cp-arabic-title" className="tm-web-header__title tm-cp-arabic__title">
              Your client can use it in Arabic.
            </h2>
            <p className="tm-cp-arabic__body">
              Each client member picks their language. Stages, dates, actions and files mirror
              right-to-left properly — the same portal, not a translated copy.
            </p>
          </div>
          <div className="tm-cp-arabic__visual">
            <ArabicPortalScene />
          </div>
        </div>
      </WebSection>

      {/* 9 · CTA band */}
      <CtaBand
        title="Show your next client a portal they'll actually open."
        visual={<PortalCtaScene />}
      />
    </>
  );
}
