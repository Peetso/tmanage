'use client';

import { useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import { LiveAnnouncer, SkipLink } from '@tmanage/ui';
import { Wordmark } from '../brand/Wordmark';
import { CONTROL_CENTER_NAVIGATION, INTERNAL_NAVIGATION } from './navigation';
import { NavIcon } from '../icons/phone';
import { MobilePrimaryNav } from './MobilePrimaryNav';
import { PhoneHeaderActions } from './PhoneHeaderActions';
import { MaintenanceBanner } from '../screens/MaintenanceBanner';
import { CommandPalette, OPEN_COMMAND_PALETTE_EVENT } from '../screens/CommandPalette';
import { InboxNotificationBridge } from '../pwa/InboxNotificationBridge';
import { browserApiClient } from '../../lib/api/browser-client';
import { listOrganizations } from '../../lib/api/organizations';
import { useOrganizationName } from '../../lib/use-organization-names';
import { roleMayUse } from '../../lib/role-capability';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { HelpTip } from '../help/HelpTip';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { PlatformAdminLink } from '../platform/PlatformAdminLink';
import { WorkspaceSuspendedGate } from '../platform/WorkspaceSuspendedGate';
import { MembershipGoneGate } from './MembershipGoneGate';
// ---- platform-admin v2 · PA-05 ----
import { ShellBanners } from './ShellBanners';
import { GettingStartedLauncher } from '../onboarding/GettingStartedCard';
import { SupportSessionEndedGate } from '../platform/support/SupportSessionEndedGate';
import { AccountMenu } from './AccountMenu';
import { AiPanelLauncher } from '../ai-panel/AiPanelLauncher';
import { HelpContextLink } from '../help/HelpContextLink';
import { SupportLauncher } from '../support/SupportLauncher';
import { RunningTimerPill } from '../time/TimerControls';
import { BetaTag } from './BetaTag';
import { ThemeSync } from './ThemeSync';
import { KeyboardShortcutLayer } from './KeyboardShortcutLayer';
import { NewMenu } from './NewMenu';

export interface AppShellProps {
  /**
   * The organization the person is working in, as it appears in a URL.
   *
   * Every rail destination lives under it — `INTERNAL_NAVIGATION` carries the suffix and this
   * supplies the prefix — for the reason `ClientPortalShell` gives: every screen is
   * tenant-scoped, and the slug in the path is the claim the API's `TenantContextGuard`
   * resolves against a membership row.
   */
  organizationSlug: string;
  /** The organization the person is working in. Always visible — `22` §1 requires it. */
  organizationName: string;
  /** The id of the rail destination that is current, e.g. `work`. */
  activeNavigationId?: string;
  /** The screen title. Rendered as the one `<h1>` of the document. */
  title: string;
  /**
   * `page` (default) is the design's `heading.page` (36/42, weight 500) used by list and detail
   * screens (WK-02 "Delivery risk"); `display` is the 64px uppercase display headline HOME-01
   * draws ("MY DAY").
   */
  titleVariant?: 'page' | 'display';
  /**
   * The eyebrow after the organization name — "Client delivery", "Saved view". The organization
   * name always leads it, so no screen can omit the tenant.
   */
  eyebrow?: ReactNode;
  /** Small text after the title on the same line, e.g. the item count ("214 items"). */
  titleMeta?: ReactNode;
  /** Optional supporting line beneath the title. */
  description?: ReactNode;
  /** Actions belonging to the whole screen. */
  actions?: ReactNode;
  /**
   * `end` (default) pushes the actions to the end of the title row (WK-02's view switch and
   * "New work"); `inline` sets them right after the title (HOME-01's "New work" capsule).
   */
  actionsPlacement?: 'end' | 'inline';
  /** The header's trailing block — HOME-01's three metrics. */
  headerAside?: ReactNode;
  /** The black day capsule above the header (HOME-01 only). Pass a `<DayPulseBar />`. */
  topBar?: ReactNode;
  /** The contextual sidebar — saved views, channels, admin sections. */
  contextRail?: ReactNode;
  children: ReactNode;
  /** The optional detail pane, the "context lens" in the design language. */
  lens?: ReactNode;
  /** The signed-in person's initials for the account orb at the foot of the rail. */
  accountInitials?: string;
  /** The signed-in person's name and email for the account menu's header (Figma t2-a). */
  accountName?: string;
  accountEmail?: string;
}

/** The phone avatar's letters: the given initials, else the first letters of the name (one in Arabic). */
function phoneInitials(initials: string | undefined, name: string | undefined): string {
  if (initials) return initials;
  if (!name) return '';
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const count = /\p{Script=Arabic}/u.test(name) ? 1 : 2;
  return parts
    .slice(0, count)
    .map((part) => Array.from(part)[0] ?? '')
    .join('')
    .toUpperCase();
}

/**
 * Owner and org admin reach the Control Center; `sitemap-and-role-navigation.md` hides it otherwise.
 * A custom role reaches it when its own set holds `org.manage` (H1).
 */
const CONTROL_CENTER_ROLES = new Set(['owner', 'org_admin', 'admin']);

/**
 * The Control Center orb. It reads the caller's role for this organization from the session's
 * organization list (the same read `ID-04` makes) and renders nothing until the role is known to
 * be owner or admin — the rail never offers a destination the person would be refused.
 *
 * Mounted only when a `QueryClient` is in the tree, so a test that renders the bare shell does not
 * need one (the same rule `CommandPalette` follows).
 */
function ControlCenterOrb({
  organizationSlug,
  current,
}: {
  organizationSlug: string;
  current: boolean;
}) {
  const organizations = useQuery({
    queryKey: ['shell', 'organizations'],
    queryFn: () => listOrganizations(browserApiClient()),
    staleTime: 5 * 60_000,
  });
  const t = useT();
  const membership = organizations.data?.find((org) => org.slug === organizationSlug);
  const role = membership?.role;
  // H1: a custom role holding `org.manage` reaches the Control Center too (its pages already
  // judge a custom role by its loaded capabilities), so the rail offers it the orb as well.
  const mayControl =
    role !== undefined &&
    (CONTROL_CENTER_ROLES.has(role) || roleMayUse(role, membership?.capabilities, 'org.manage'));
  if (!mayControl) return null;
  return (
    <HelpTip tip={t('NavHelp.admin' as MessageKey)} placement="end" block>
      <Link
        href={`/${organizationSlug}${CONTROL_CENTER_NAVIGATION.href}`}
        className="tm-rail__item"
        {...(current ? { 'aria-current': 'page' as const } : {})}
      >
        <span className="tm-rail__orb" aria-hidden="true">
          <NavIcon name={CONTROL_CENTER_NAVIGATION.icon} />
        </span>
        <span className="tm-rail__label">{t(CONTROL_CENTER_NAVIGATION.messageKey)}</span>
      </Link>
    </HelpTip>
  );
}

function RailFoot({
  organizationSlug,
  activeNavigationId,
  account,
}: {
  organizationSlug: string;
  activeNavigationId: string | undefined;
  account: { initials?: string; name?: string; email?: string };
}) {
  const queryClient = useContext(QueryClientContext);
  return (
    <div className="tm-rail__foot">
      {queryClient ? (
        <ControlCenterOrb
          organizationSlug={organizationSlug}
          current={activeNavigationId === CONTROL_CENTER_NAVIGATION.id}
        />
      ) : null}
      {/* Only for the TManage operator (PLATFORM_ADMIN_EMAILS); nothing for anyone else. */}
      {queryClient ? <PlatformAdminLink /> : null}
      <AccountMenu organizationSlug={organizationSlug} placement="rail" {...account} />
    </div>
  );
}

/**
 * The internal shell: orbital rail, page header, canvas, optional context rail and lens.
 *
 * Drawn from HOME-01 / WK-02 / SR-01 in the design handoff: an 88px rail on `--paper-350` with a
 * black brand orb, a rule, and 44px navigation orbs (white with a quiet line; the current one
 * inked), then a canvas on `--paper-150` whose header is a mono eyebrow, the title and the
 * screen's actions.
 *
 * Three decisions worth stating:
 *
 * 1. **The rail is a `<nav>` with a list, and every destination is a real `<a>`.** The orb is the
 *    appearance, the link is the element.
 * 2. **The organization name is in the shell, not in each screen** — it leads the eyebrow.
 * 3. **`aria-current="page"`** marks the active destination rather than a class alone.
 */
export function AppShell({
  organizationSlug,
  organizationName,
  activeNavigationId,
  title,
  titleVariant = 'page',
  eyebrow,
  titleMeta,
  description,
  actions,
  actionsPlacement = 'end',
  headerAside,
  topBar,
  contextRail,
  children,
  lens,
  accountInitials,
  accountName,
  accountEmail,
}: AppShellProps) {
  // The page hands in the design's sample name until a per-organization read exists; the
  // session's own organization list says what this organization is really called.
  const displayedOrganizationName = useOrganizationName(organizationSlug, organizationName);
  const queryClient = useContext(QueryClientContext);
  const t = useT();
  const shell = (
    <LiveAnnouncer label={t('Shell.liveAnnouncements')}>
      <div className="tm-app">
        <SkipLink targetId="tm-main">{t('Shell.skipLink')}</SkipLink>

        {/* Platform admin v2 (PA-05): the Support mode banner and the platform announcement, above
            the top bar so the canvas shrinks under them. */}
        {queryClient ? (
          <ShellBanners
            organizationSlug={organizationSlug}
            organizationName={displayedOrganizationName}
          />
        ) : null}
        {/* Platform states (SYS-04): the maintenance / degraded-mode banner across the whole
            window. Renders nothing unless a window is active. */}
        <MaintenanceBanner />
        {/* PREF-02: the member's saved light / dark / system theme on <html data-theme>. */}
        {queryClient ? <ThemeSync organizationSlug={organizationSlug} /> : null}
        {/* SR-01 / 55-06 command palette v2: Ctrl/Cmd-K, grouped navigation, actions, live search. */}
        <CommandPalette organizationSlug={organizationSlug} />
        {/* Slice 55-12: global shortcuts (? g h g p g w c /) and the cheat sheet dialog. */}
        <KeyboardShortcutLayer organizationSlug={organizationSlug} />
        {/* Desktop companion: mirrors new inbox notices as local notifications once opted in. */}
        <InboxNotificationBridge organizationSlug={organizationSlug} />

        <div className="tm-app__frame">
          <nav className="tm-rail" aria-label={t('shell.rail.primary')}>
            <Link href={`/${organizationSlug}/home`} className="tm-rail__brand">
              <Wordmark variant="icon" label={t('shell.brand.home')} />
            </Link>
            {/* Open beta (Figma 419:9992): the tag sits with the logo. */}
            <BetaTag placement="rail" />
            <span className="tm-rail__rule" aria-hidden="true" />

            <ul className="tm-rail__list">
              {INTERNAL_NAVIGATION.map((item) => {
                const current = item.id === activeNavigationId;
                return (
                  <li key={item.id}>
                    <HelpTip tip={t(`NavHelp.${item.id}` as MessageKey)} placement="end" block>
                      <Link
                        href={`/${organizationSlug}${item.href}`}
                        className="tm-rail__item"
                        {...(current ? { 'aria-current': 'page' as const } : {})}
                      >
                        <span className="tm-rail__orb" aria-hidden="true">
                          <NavIcon name={item.icon} />
                        </span>
                        <span className="tm-rail__label">{t(item.messageKey)}</span>
                      </Link>
                    </HelpTip>
                  </li>
                );
              })}
            </ul>

            <RailFoot
              organizationSlug={organizationSlug}
              activeNavigationId={activeNavigationId}
              account={{
                ...(accountInitials ? { initials: accountInitials } : {}),
                ...(accountName ? { name: accountName } : {}),
                ...(accountEmail ? { email: accountEmail } : {}),
              }}
            />
          </nav>

          <div className="tm-app__body">
            {/* Phone top bar: the bell and avatar orbs at the end of the organization line. Hidden
                above the dock breakpoint, where the rail's account orb is the one on screen. */}
            <PhoneHeaderActions
              organizationSlug={organizationSlug}
              initials={phoneInitials(accountInitials, accountName)}
            />
            {topBar ? <div className="tm-app__topbar">{topBar}</div> : null}

            <header
              className="tm-canvas-header"
              data-title-variant={titleVariant}
              data-actions={actionsPlacement}
            >
              <div className="tm-canvas-header__titles">
                <p className="tm-canvas-header__context">
                  <BetaTag placement="phone" />
                  <span className="tm-canvas-header__org">{displayedOrganizationName}</span>
                  {eyebrow ? (
                    <>
                      <span aria-hidden="true"> · </span>
                      <span>{eyebrow}</span>
                    </>
                  ) : null}
                </p>
                <div className="tm-canvas-header__title-row">
                  <h1 className="tm-canvas-header__title">{title}</h1>
                  {titleMeta ? <span className="tm-canvas-header__meta">{titleMeta}</span> : null}
                  {actions || queryClient ? (
                    <div className="tm-canvas-header__actions">
                      {actions}
                      {/* Row 55-05: the global "+ New" menu, filtered by role (needs the query
                          client for the role read). */}
                      {queryClient ? <NewMenu organizationSlug={organizationSlug} /> : null}
                      {/* 52-01: the running-timer pill, only while a timer runs (needs the
                          query client). */}
                      {queryClient ? (
                        <RunningTimerPill organizationSlug={organizationSlug} />
                      ) : null}
                      {/* Row 55-11: the getting-started checklist, until dismissed or done. */}
                      {queryClient ? (
                        <GettingStartedLauncher organizationSlug={organizationSlug} />
                      ) : null}
                      {/* Row 55-16: the Help centre article for this screen. FIX3 item 10: with a
                          query client it is the first entry of the Help menu below, so "?" and
                          "Help" are one button; the bare "?" stays only where that menu cannot. */}
                      {queryClient ? null : <HelpContextLink />}
                      {/* Row 55-17: the help menu with "Contact support" (needs the query client). */}
                      {queryClient ? <SupportLauncher organizationSlug={organizationSlug} /> : null}
                      {/* "Let AI do the job" (Figma 400:5399): needs the query client. */}
                      {queryClient ? <AiPanelLauncher organizationSlug={organizationSlug} /> : null}
                    </div>
                  ) : null}
                </div>
                {description ? (
                  <p className="tm-canvas-header__description">{description}</p>
                ) : null}
              </div>
              {headerAside ? <div className="tm-canvas-header__aside">{headerAside}</div> : null}
            </header>

            <div className="tm-app__columns">
              {contextRail ? (
                <nav className="tm-context-rail" aria-label={t('shell.rail.sectionNav')}>
                  {contextRail}
                </nav>
              ) : null}

              <main id="tm-main" className="tm-canvas" tabIndex={-1}>
                {children}
              </main>

              {lens ? (
                <aside className="tm-lens" aria-label={t('shell.lens.details')}>
                  {lens}
                </aside>
              ) : null}
            </div>
          </div>
        </div>

        {/* Phone shell (Figma ph-tabbar / ph-more): below ~900px the rail is hidden and this
            dock takes its place — My Day, Inbox, Chat, Work and More (which opens the More
            sheet), plus the lime "+" quick-capture orb. */}
        <MobilePrimaryNav
          organizationSlug={organizationSlug}
          {...(activeNavigationId ? { activeNavigationId } : {})}
        />
      </div>
    </LiveAnnouncer>
  );
  // A removed member sees one no-access page instead of the sample-company header and raw errors
  // (ACC-14); a company the platform operator suspended shows its members one page instead of the app.
  return queryClient ? (
    <SupportSessionEndedGate organizationSlug={organizationSlug}>
      <MembershipGoneGate organizationSlug={organizationSlug}>
        <WorkspaceSuspendedGate organizationSlug={organizationSlug}>{shell}</WorkspaceSuspendedGate>
      </MembershipGoneGate>
    </SupportSessionEndedGate>
  ) : (
    shell
  );
}

/** One slot in the day capsule. `state` decides the paint: done is muted, now is lime. */
export interface DayPulseItem {
  readonly id: string;
  /** The local time the slot starts, already formatted (e.g. `14:00`). */
  readonly time: string;
  readonly label: string;
  readonly state: 'done' | 'now' | 'next' | 'later';
  /** Initials of the people in a `now` slot, drawn as overlapping orbs. */
  readonly people?: readonly string[];
  readonly href?: string;
}

export interface DayPulseBarProps {
  organizationSlug: string;
  /** Today's slots from the caller's real calendar data. Never invent placeholder events. */
  items?: readonly DayPulseItem[];
  /** The `NOW` capsule's text when no slot is `now` (e.g. the next thing that needs you). */
  nowLabel?: ReactNode;
  /** Test seam: a fixed clock. */
  now?: Date;
}

function useClock(fixed: Date | undefined): Date | null {
  const [now, setNow] = useState<Date | null>(fixed ?? null);
  useEffect(() => {
    if (fixed) return;
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, [fixed]);
  return now;
}

/**
 * HOME-01's day capsule: a black pill holding today's date orb, the day's slots and the live
 * `NOW` capsule in lime, an arrow out to the calendar, and — beside it — the search orb that opens
 * the command surface. The clock is read on the client after mount so the server render and the
 * first client render agree.
 */
export function DayPulseBar({
  organizationSlug,
  items = [],
  nowLabel,
  now: fixed,
}: DayPulseBarProps) {
  const t = useT();
  const locale = useActiveLocale();
  const now = useClock(fixed);
  const day = now ? String(now.getDate()).padStart(2, '0') : '··';
  // The day in the reader's language, Latin digits in Arabic as the Arabic frames write them.
  const dateTag = locale.toLowerCase().startsWith('ar') ? 'ar-u-nu-latn' : 'en-GB';
  const date = now
    ? now.toLocaleDateString(dateTag, { weekday: 'short', day: 'numeric', month: 'short' })
    : '';
  const time = now
    ? now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
    : '';
  const nowItem = items.find((item) => item.state === 'now');
  const before = items.filter((item) => item.state === 'done');
  const after = items.filter((item) => item.state === 'next' || item.state === 'later');

  return (
    <div className="tm-day-pulse">
      <div className="tm-day-pulse__capsule" role="group" aria-label={t('shell.dayPulse.today')}>
        <div className="tm-day-pulse__date">
          <span className="tm-day-pulse__day" aria-hidden="true">
            {day}
          </span>
          <span className="tm-day-pulse__date-label">
            {t('shell.dayPulse.today')}
            {date ? ` · ${date.replace(',', '')}` : ''}
          </span>
        </div>
        {before.map((item) => (
          <DayPulseSlot key={item.id} item={item} />
        ))}
        <div className="tm-day-pulse__now">
          <span className="tm-day-pulse__now-time">
            {t('shell.dayPulse.now')}
            {time ? ` ${time}` : ''}
          </span>
          <span className="tm-day-pulse__now-label">{nowItem ? nowItem.label : nowLabel}</span>
          {nowItem?.people && nowItem.people.length > 0 ? (
            <span className="tm-day-pulse__people" aria-hidden="true">
              {nowItem.people.map((initials) => (
                <span key={initials} className="tm-day-pulse__person">
                  {initials}
                </span>
              ))}
            </span>
          ) : null}
        </div>
        {after.map((item) => (
          <DayPulseSlot key={item.id} item={item} />
        ))}
        <Link
          href={`/${organizationSlug}/calendar`}
          className="tm-day-pulse__out"
          aria-label={t('shell.dayPulse.openCalendar')}
        >
          <span aria-hidden="true">↗</span>
        </Link>
      </div>
      <button
        type="button"
        className="tm-day-pulse__search"
        aria-label={t('shell.dayPulse.search')}
        onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))}
      >
        <span aria-hidden="true">⌕</span>
      </button>
    </div>
  );
}

function DayPulseSlot({ item }: { item: DayPulseItem }) {
  const t = useT();
  const body = (
    <>
      <span className="tm-day-pulse__slot-time">{item.time}</span>
      <span className="tm-day-pulse__slot-label">{item.label}</span>
      {item.state === 'done' ? (
        <span className="tm-day-pulse__slot-done">
          <span aria-hidden="true">✓</span>
          <span className="tm-visually-hidden">{t('shell.dayPulse.done')}</span>
        </span>
      ) : null}
    </>
  );
  return item.href ? (
    <Link href={item.href} className="tm-day-pulse__slot" data-state={item.state}>
      {body}
    </Link>
  ) : (
    <span className="tm-day-pulse__slot" data-state={item.state}>
      {body}
    </span>
  );
}
