'use client';

import { Avatar, Badge, StateCapsule, StatusDot } from '@tmanage/ui';
import { WebIcon } from '../../WebIcon';
import { ArrowLink, IconOrb } from '../../primitives';
import { CtaBand, GraphCard, ProductVisualFrame, SectionHeader, WebSection } from '../../sections';
import {
  HOW_WE_BUILD,
  ONE_THREAD,
  PRINCIPLES,
  SCATTERED,
  TEAM_ROLES,
  WHY_PARAGRAPHS,
} from './about-data';
import './about.css';

/**
 * WEB-16 About (`/about`). No Figma frame yet: designed in code from SITE-SPEC "PAGE: About" in
 * the visual language of the designed pages (Customers hero tray + ink featured panel, Security
 * principle cards). Every value is a Limeframe token; product visuals are packages/ui parts.
 */
export function AboutPage() {
  return (
    <div className="tm-web-about">
      <Hero />
      <WhyWeExist />
      <Principles />
      <HowWeBuild />
      <Team />
      <CompanyCards />
      <CtaBand visual={<ApprovedScene />} />
    </div>
  );
}

/* ── 2 · Hero (editorial) ─────────────────────────────────────────────────── */

function Hero() {
  return (
    <WebSection className="tm-web-about__hero" aria-labelledby="about-title">
      <div className="tm-web-about__hero-grid">
        <SectionHeader
          as="h1"
          size="hero"
          id="about-title"
          eyebrow="About TManage"
          title="We think delivery should feel connected, not chased."
          lede="TManage is built for the teams who do the work and the clients who wait on it."
        />
        <ThreadScene />
      </div>
    </WebSection>
  );
}

/** One thread: the client's ask, the committed work and the version waiting for sign-off. */
function ThreadScene() {
  return (
    <ProductVisualFrame className="tm-web-about__thread-frame">
      <div
        className="tm-web-about__thread"
        role="img"
        aria-label="One thread in Atlas Website Relaunch: Salma's request became Omar's task, and Homepage Concept v2 waits for Youssef's approval."
      >
        <p className="tm-web-scene__mono">One thread · Atlas Website Relaunch</p>

        <div className="tm-web-about__thread-row">
          <Avatar name="Salma Riad" audience="client" decorative />
          <div className="tm-web-about__thread-text">
            <p className="tm-web-about__thread-who">Salma Riad · Atlas Hospitality</p>
            <p className="tm-web-about__bubble">Can we add an Arabic FAQ before launch?</p>
          </div>
          <StateCapsule state="done">Request created</StateCapsule>
        </div>

        <span className="tm-web-about__thread-link" aria-hidden="true" />

        <div className="tm-web-about__thread-row">
          <Avatar name="Omar Adel" decorative />
          <div className="tm-web-about__thread-text">
            <p className="tm-web-about__thread-title">Arabic FAQ page</p>
            <p className="tm-web-about__thread-meta">Omar Adel · committed for 24 Aug</p>
          </div>
          <StateCapsule state="current">In progress</StateCapsule>
        </div>

        <span className="tm-web-about__thread-link" aria-hidden="true" />

        <div className="tm-web-about__thread-row">
          <Avatar name="Youssef Kamal" audience="client" decorative />
          <div className="tm-web-about__thread-text">
            <p className="tm-web-about__thread-title">
              Homepage Concept v2 <Badge mono>v2</Badge>
            </p>
            <p className="tm-web-about__thread-meta">Client review · Youssef Kamal</p>
          </div>
          <StateCapsule state="client">Waiting for Youssef</StateCapsule>
        </div>

        <p className="tm-web-about__thread-foot">
          <StatusDot tone="live">Same thread</StatusDot>
          <span>Nothing retyped between the ask and the sign-off</span>
        </p>
      </div>
    </ProductVisualFrame>
  );
}

/* ── 3 · Why we exist (2 columns text, then the before / after) ───────────── */

function WhyWeExist() {
  return (
    <WebSection tone="surface" aria-labelledby="about-why-title">
      <SectionHeader
        id="about-why-title"
        eyebrow="Why we exist"
        title="Service work deserves one story, not five tools."
      />
      <div className="tm-web-about__why-text">
        {WHY_PARAGRAPHS.map((paragraph) => (
          <p key={paragraph} className="tm-web-about__why-para">
            {paragraph}
          </p>
        ))}
      </div>
      <ProductVisualFrame className="tm-web-about__why-visual">
        <div
          className="tm-web-about__scatter"
          role="img"
          aria-label="Before: the request in email, the plan in a spreadsheet, the file in a drive, the approval in a call. With TManage: request, work, version and approval in one thread."
        >
          <div className="tm-web-about__scatter-side">
            <p className="tm-web-scene__mono">Before · five tools</p>
            <ul className="tm-web-about__scatter-list">
              {SCATTERED.map((item) => (
                <li key={item.label} className="tm-web-about__scatter-tile">
                  <IconOrb icon={item.icon} tone="outline" size="compact" />
                  <span className="tm-web-about__scatter-text">
                    <span className="tm-web-about__scatter-label">{item.label}</span>
                    <span className="tm-web-about__scatter-where">{item.where}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <span className="tm-web-about__scatter-arrow" aria-hidden="true">
            <WebIcon name="arrow-right" size={16} />
          </span>
          <div className="tm-web-about__scatter-side">
            <p className="tm-web-scene__mono">With TManage · one thread</p>
            <ol className="tm-web-about__track">
              {ONE_THREAD.map((step) => (
                <li key={step.label} className="tm-web-about__track-row">
                  <span className="tm-web-about__scatter-label">{step.label}</span>
                  <StateCapsule state={step.state}>{step.status}</StateCapsule>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </ProductVisualFrame>
    </WebSection>
  );
}

/* ── 4 · Principles ───────────────────────────────────────────────────────── */

function Principles() {
  return (
    <WebSection tone="sunken" aria-labelledby="about-principles-title">
      <SectionHeader
        id="about-principles-title"
        align="center"
        eyebrow="Principles"
        title="Four things we will not trade away."
        lede="They decide what we build, and just as often what we leave out."
      />
      <ul className="tm-web-about__principles">
        {PRINCIPLES.map((principle) => (
          <li key={principle.title}>
            <GraphCard icon={principle.icon} title={principle.title} body={principle.body} />
          </li>
        ))}
      </ul>
    </WebSection>
  );
}

/* ── 5 · How we build (ink panel, bilingual visual) ───────────────────────── */

function HowWeBuild() {
  return (
    <WebSection aria-labelledby="about-build-title">
      <div className="tm-web-about__build">
        <div className="tm-web-about__build-text">
          <SectionHeader
            id="about-build-title"
            tone="ink"
            eyebrow="How we build"
            title="Built carefully, in two languages, for everyone."
          />
          <ul className="tm-web-about__build-list">
            {HOW_WE_BUILD.map((item) => (
              <li key={item.title}>
                <IconOrb icon={item.icon} tone="lime" />
                <span>
                  <span className="tm-web-about__build-item">{item.title}</span>
                  <span className="tm-web-about__build-body">{item.body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <BilingualScene />
      </div>
    </WebSection>
  );
}

/** The same approval card in English and mirrored Arabic. */
function BilingualScene() {
  return (
    <div
      className="tm-web-about__lang"
      aria-label="The same approval card in English and in Arabic, mirrored right to left."
      role="img"
    >
      <div className="tm-web-about__lang-card" lang="en" dir="ltr">
        <p className="tm-web-scene__mono">English · LTR</p>
        <p className="tm-web-about__lang-title">Homepage Concept v2</p>
        <p className="tm-web-about__lang-meta">Atlas Hospitality · client review</p>
        <div className="tm-web-about__lang-foot">
          <Avatar name="Youssef Kamal" audience="client" decorative />
          <StateCapsule state="client">Waiting for Youssef</StateCapsule>
        </div>
      </div>
      <div className="tm-web-about__lang-card tm-web-about__lang-card--ar" lang="ar" dir="rtl">
        <p className="tm-web-scene__mono">العربية · RTL</p>
        <p className="tm-web-about__lang-title">مفهوم الصفحة الرئيسية — الإصدار ٢</p>
        <p className="tm-web-about__lang-meta">أطلس للضيافة · مراجعة العميل</p>
        <div className="tm-web-about__lang-foot">
          <Avatar name="يوسف كمال" audience="client" decorative />
          <StateCapsule state="client">بانتظار يوسف</StateCapsule>
        </div>
      </div>
    </div>
  );
}

/* ── 6 · Team (placeholder: roles, one "photos coming soon" line) ──────────── */

function Team() {
  return (
    <WebSection spacing="compact" aria-labelledby="about-team-title">
      <SectionHeader
        id="about-team-title"
        eyebrow="Team"
        title="The people behind TManage."
        lede="A small team that has run client delivery from both sides of the table."
      />
      <ul className="tm-web-about__team">
        {TEAM_ROLES.map((member) => (
          <li
            key={member.role}
            className={`tm-web-about__member tm-web-about__member--${member.tone}`}
          >
            <Avatar name={member.role} size="feature" decorative />
            <span className="tm-web-about__member-role">{member.role}</span>
            <span className="tm-web-about__member-focus">{member.focus}</span>
          </li>
        ))}
      </ul>
      <p className="tm-web-about__team-note">
        <StatusDot tone="neutral">Team photos coming soon.</StatusDot>
      </p>
    </WebSection>
  );
}

/* ── 7 · Careers / press ──────────────────────────────────────────────────── */

function CompanyCards() {
  return (
    <WebSection spacing="flush" className="tm-web-about__company" aria-label="Careers and press">
      <div className="tm-web-about__cards">
        <article id="careers" className="tm-web-about__card">
          <IconOrb icon="briefcase" tone="lime" />
          <div className="tm-web-about__card-text">
            <h2 className="tm-web-about__card-title">Work with us</h2>
            <p className="tm-web-about__card-body">
              We hire people who care how work feels for the team and for the client. Tell us what
              you would build.
            </p>
          </div>
          <ArrowLink href="/contact?topic=careers">Careers</ArrowLink>
        </article>
        <article id="press" className="tm-web-about__card">
          <IconOrb icon="pencil" tone="lime" />
          <div className="tm-web-about__card-text">
            <h2 className="tm-web-about__card-title">Press &amp; brand</h2>
            <p className="tm-web-about__card-body">
              The TManage mark, product views and the story in brief. Ask, and we will send the kit.
            </p>
          </div>
          <ArrowLink href="/contact?topic=press">Press kit</ArrowLink>
        </article>
      </div>
    </WebSection>
  );
}

/* ── 8 · CTA visual: the thread, signed off (fits its card, never clipped) ── */

function ApprovedScene() {
  return (
    <div
      className="tm-web-scene tm-web-about__cta-scene"
      role="img"
      aria-label="Homepage Concept v2 approved by Youssef Kamal; the Arabic FAQ page is in progress for 24 Aug."
    >
      <div className="tm-web-about__cta-card">
        <p className="tm-web-scene__mono">Client portal · Atlas Hospitality</p>
        <p className="tm-web-about__lang-title">
          Homepage Concept v2 <Badge mono>v2</Badge>
        </p>
        <p className="tm-web-about__lang-meta">Approved by Youssef Kamal · 18 Aug</p>
        <div className="tm-web-about__lang-foot">
          <Avatar name="Youssef Kamal" audience="client" decorative />
          <StateCapsule state="done">Approved</StateCapsule>
        </div>
      </div>
      <div className="tm-web-about__cta-card">
        <p className="tm-web-about__lang-title">Arabic FAQ page</p>
        <p className="tm-web-about__lang-meta">Asked in chat · committed for 24 Aug</p>
        <div className="tm-web-about__lang-foot">
          <Avatar name="Omar Adel" decorative />
          <StateCapsule state="current">In progress</StateCapsule>
        </div>
      </div>
    </div>
  );
}
