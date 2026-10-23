import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import {
  CalloutPin,
  CtaBand,
  DeliveryRiskScene,
  FaqRow,
  FeatureRow,
  GraphCard,
  IconOrb,
  LinkCard,
  LogoStrip,
  MegaMenuPanel,
  MenuItem,
  ObjectCardStack,
  PlayCapsule,
  PRODUCT_FACT_STATS,
  PRODUCT_MENU,
  RESOURCES_MENU,
  SOLUTIONS_MENU,
  SectionHeader,
  Stat,
  StatBand,
  TestimonialCard,
  WebIcon,
  WebNav,
  type WebIconName,
} from '../../../components/website';

export const metadata: Metadata = {
  // Production answers this route with a 404 (below), so the tab must not name the dev gallery.
  title: process.env.NODE_ENV === 'production' ? 'Page not found' : 'Website components',
  robots: { index: false, follow: false },
};

const ICONS: readonly WebIconName[] = [
  'chevron-down',
  'menu',
  'play',
  'work',
  'flag',
  'bolt',
  'chat',
  'calendar',
  'doc',
  'portal',
  'chart',
  'grid',
  'briefcase',
  'building',
  'trend',
  'person',
  'list',
  'book',
  'layers',
  'pencil',
  'help',
  'pulse',
  'shield',
  'linkedin',
  'video',
  'mail',
  'plus',
  'arrow-right',
  'search',
  'check',
  'quote',
  'globe',
  'lock',
  'id',
];

function Block({
  n,
  title,
  note,
  children,
}: {
  n: string;
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section className="tm-web-kit__block" aria-label={title}>
      <p className="tm-web-eyebrow">
        {n} · {title}
      </p>
      <p className="tm-web-kit__note">{note}</p>
      <div className="tm-web-kit__body">{children}</div>
    </section>
  );
}

/**
 * The website component sheet, rendered from code — the counterpart of the Figma frame
 * "Website components" (shots/components.png), for side-by-side comparison. Development only.
 */
export default function WebsiteKitPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <div className="tm-web-container tm-web-kit">
      <h1 className="tm-web-kit__title">Website components — instance these on every page</h1>

      <Block
        n="00"
        title="Web primitives — icons, icon orb, play capsule, menu item"
        note="Website-only components built from TManage tokens. Icons on the 16 px grid in currentColor."
      >
        <div className="tm-web-kit__row">
          {ICONS.map((icon) => (
            <WebIcon key={icon} name={icon} />
          ))}
        </div>
        <div className="tm-web-kit__row">
          <IconOrb icon="menu" tone="outline" />
          <IconOrb icon="menu" tone="ink" />
          <IconOrb icon="menu" tone="lime" />
          <PlayCapsule href="/product#work-story">Watch the work story</PlayCapsule>
          <PlayCapsule href="/product#work-story" tone="paper">
            Watch the work story
          </PlayCapsule>
          <MenuItem
            href="/features/work"
            icon="work"
            label="Work & requests"
            hint="Every ask becomes owned work"
          />
        </div>
      </Block>

      <Block n="01" title="Web/Nav — paper and ink" note="Top bar on the 1248 column.">
        <div className="tm-web-kit__frame">
          <WebNav sticky={false} />
        </div>
        <div className="tm-web-kit__frame tm-web-kit__frame--ink">
          <WebNav theme="ink" sticky={false} />
        </div>
      </Block>

      <Block
        n="02"
        title="Web/Mega menu — product, solutions, resources"
        note="Floating dropdown on Elevation/High, 8 px under the nav."
      >
        <MegaMenuPanel menu={PRODUCT_MENU} />
        <MegaMenuPanel menu={SOLUTIONS_MENU} />
        <MegaMenuPanel menu={RESOURCES_MENU} />
      </Block>

      <Block
        n="04"
        title="Web/Section header — left and centre"
        note="Mono eyebrow with the lime dot, Heading/Page headline, Body/LG subhead, text link."
      >
        <SectionHeader
          eyebrow="Section eyebrow"
          title="A clear, calm section headline"
          lede="One or two sentences that explain the consequence for the reader, in plain business language."
          link={{ label: 'Learn more', href: '/product' }}
        />
        <SectionHeader
          align="center"
          eyebrow="Section eyebrow"
          title="A clear, calm section headline"
          lede="One or two sentences that explain the consequence for the reader, in plain business language."
          link={{ label: 'Learn more', href: '/product' }}
        />
      </Block>

      <Block
        n="05"
        title="Web/Stat and Web/Stat row"
        note="Product facts only — never invented performance numbers."
      >
        <Stat {...PRODUCT_FACT_STATS[0]!} />
        <StatBand />
      </Block>

      <Block
        n="06"
        title="Web/Logo strip — design-partner slots"
        note="Honest placeholders until partners approve their logos."
      >
        <LogoStrip />
        <LogoStrip
          variant="detailed"
          label="Design partners · logos appear only with written consent"
        />
      </Block>

      <Block
        n="07"
        title="Web/Product visual — shared product-visual block"
        note="Token-bound product scenes, never screenshots."
      >
        <div className="tm-web-kit__visuals">
          <DeliveryRiskScene />
          <ObjectCardStack />
        </div>
      </Block>

      <Block
        n="08"
        title="Web/CTA band"
        note="Closing call to action: lime Start free + paper play capsule, with a product-visual crop."
      >
        <div />
      </Block>
      <CtaBand />

      <Block
        n="10"
        title="Call-out pin, graph card, question row, link card"
        note="Small parts the pages compose."
      >
        <CalloutPin n={1} />
        <div className="tm-web-kit__grid3">
          <GraphCard title="Identity" body="A stable ID and a home project." />
          <GraphCard
            icon="person"
            title="Responsibility"
            body="One owner, named collaborators, clear authority."
          />
          <GraphCard
            icon="calendar"
            title="Time"
            body="Desired, committed and forecast dates kept apart."
          />
        </div>
        <FaqRow question="Question" answer="Answer" defaultOpen />
        <div className="tm-web-kit__grid3">
          <LinkCard
            title="Work & requests"
            hint="Every ask becomes owned work"
            href="/features/work"
          />
        </div>
      </Block>

      <Block
        n="11"
        title="Testimonial card"
        note="Placeholder quotes, marked until a consented one exists."
      >
        <div className="tm-web-kit__grid3">
          <TestimonialCard
            quote="The client opens the portal before they think of calling us."
            author="Studio lead"
            org="Agency · Design partner"
          />
          <TestimonialCard
            tone="ink"
            quote="Every approval points at one version. Nobody asks which file anymore."
            author="Delivery director"
            org="Consultancy · Design partner"
          />
          <TestimonialCard
            quote="Requests finally have an owner from the moment they arrive."
            author="Operations manager"
            org="In-house team · Design partner"
          />
        </div>
      </Block>

      <Block
        n="12"
        title="Feature row — text + product visual, alternating"
        note="Visual swaps sides row by row."
      >
        <FeatureRow
          step={1}
          label="Team workspace"
          title="Dense enough to actually run delivery."
          body="Chat, work, docs, files and approvals on one model, with lists, boards and timelines over the same items."
          link={{ label: 'Explore work & requests', href: '/features/work' }}
          visual={<DeliveryRiskScene />}
        />
        <FeatureRow
          reverse
          step={2}
          label="Client portal"
          title="Simpler, warmer, action-first."
          body="Clients see overview, their actions, timeline, deliverables, updates, files and people. Nothing else."
          link={{ label: 'Explore the client portal', href: '/client-portal' }}
          visual={<ObjectCardStack />}
        />
      </Block>
    </div>
  );
}
