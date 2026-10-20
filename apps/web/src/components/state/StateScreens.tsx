'use client';

import { useCallback, useId, useState, type ReactNode } from 'react';
import { LiveAnnouncer, SkipLink } from '@tmanage/ui';
import { Wordmark } from '../brand/Wordmark';
import { STATE_COPY, type StateKey } from './state-copy';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';

/**
 * The standard platform-state matrix as shared, presentational components.
 *
 * `38-MODULE-MAP` §Platform states asks for one consistent set of state views — forbidden
 * (403), not found (404), server error (500), empty and loading — rather than each screen
 * improvising its own. These are that set. Every one of them:
 *
 * - takes its copy from `state-copy.ts`, so the words match wherever the state appears, and a
 *   caller may still override `title`/`description` for a state that needs to be specific;
 * - is a labelled `region` landmark (a `<section>` named by its heading), so it satisfies
 *   axe's `region` rule whether it stands alone as a route page or sits inside a screen's
 *   `<main>` as an empty state;
 * - fetches nothing and reads no capability. They are pure presentation: the decision that a
 *   person may not see a page, or that a page is empty, is made by the caller and rendered
 *   here.
 *
 * ## Focus
 *
 * `40-DESIGN-SYSTEM` §10 (WCAG 2.2 AA) wants a keyboard user landed somewhere useful. The
 * states that carry a single primary action — forbidden, not found, server error — move focus
 * to it on mount, so a person who arrives on a full-page state can act without hunting for the
 * one control. Focus is moved through a callback ref rather than the `autoFocus` attribute,
 * which `jsx-a11y/no-autofocus` forbids and which fires before hydration. Empty and loading do
 * not steal focus: an empty region is usually embedded beside other content, and a loading
 * region is a wait.
 *
 * ## Why the actions are native elements, not `@tmanage/ui`'s `Button`
 *
 * The primary control is a plain `<a>` or `<button>` wearing the design system's `tm-button`
 * classes — the same reuse `DocumentExportButton` and the `.tm-button` anchors across the app
 * already rely on. `Button` does not forward a ref, and a full-page state's whole point is to
 * put focus on its one action, which needs one. Restyling here changes nothing a person sees;
 * it only keeps the ref this component owns.
 */

type HeadingLevel = 1 | 2 | 3;

const HEADING_TAG: Record<HeadingLevel, 'h1' | 'h2' | 'h3'> = {
  1: 'h1',
  2: 'h2',
  3: 'h3',
};

/**
 * The mono eyebrow above a state's headline (SYS-06: "NOT FOUND", "UNEXPECTED ERROR"). The
 * error eyebrow carries the danger square in CSS, so it reads by shape as well as by colour.
 * Hidden from assistive technology: the heading already says the same thing.
 */
const EYEBROW_KEY: Record<StateKey, MessageKey> = {
  forbidden: 'StateScreens.eyebrowForbidden',
  notFound: 'StateScreens.eyebrowNotFound',
  serverError: 'StateScreens.eyebrowServerError',
  empty: 'StateScreens.eyebrowEmpty',
  loading: 'StateScreens.eyebrowLoading',
};

/** The glyph each state shows. Decorative — the heading carries the meaning. */
const GLYPH: Record<StateKey, string> = {
  forbidden: '⦸',
  notFound: '?',
  serverError: '!',
  empty: '∅',
  loading: '…',
};

interface StatePanelProps {
  /** Which state this is — selects the glyph and the default copy. */
  state: StateKey;
  /** Heading level for the title. 1 for a full-page state, 2+ when embedded under one. */
  headingLevel: HeadingLevel;
  title: string;
  description: ReactNode;
  /** The primary action, already built by the specific state component. */
  action?: ReactNode;
  // `| undefined` is explicit because the workspace runs `exactOptionalPropertyTypes`: the
  // specific state components hold these as `string | undefined` and pass them straight
  // through, so the panel's optional props must accept an explicit `undefined`.
  className?: string | undefined;
  /** Marks the region busy for assistive tech — the loading state only. */
  busy?: boolean | undefined;
  /** Supporting detail between the text and the actions — SYS-06's reference card. */
  detail?: ReactNode;
}

function StatePanel({
  state,
  headingLevel,
  title,
  description,
  action,
  className,
  busy,
  detail,
}: StatePanelProps) {
  const t = useT();
  const headingId = useId();
  const Heading = HEADING_TAG[headingLevel];
  const classes = ['tm-state', className].filter(Boolean).join(' ');

  return (
    <section
      className={classes}
      aria-labelledby={headingId}
      aria-busy={busy || undefined}
      data-state={state}
    >
      <div className="tm-state__panel">
        <span className="tm-state__glyph" aria-hidden="true">
          {GLYPH[state]}
        </span>
        <div className="tm-state__text">
          <p className="tm-state__eyebrow" aria-hidden="true">
            {t(EYEBROW_KEY[state])}
          </p>
          <Heading id={headingId} className="tm-state__title">
            {title}
          </Heading>
          <p className="tm-state__description">{description}</p>
        </div>
        {detail}
        {action ? <div className="tm-state__actions">{action}</div> : null}
      </div>
    </section>
  );
}

/**
 * A callback ref that moves focus to its node once it mounts, when `enabled`.
 *
 * A callback ref rather than an effect against a `useRef`, so one hook can attach to either an
 * `<a>` or a `<button>` — the server-error state renders one or the other — without a
 * per-element ref type. Memoised on `enabled` so it fires on mount and not on every render.
 */
function useFocusOnMount(enabled: boolean) {
  return useCallback(
    (node: HTMLElement | null) => {
      if (enabled && node) {
        node.focus();
      }
    },
    [enabled],
  );
}

interface NavStateProps {
  /** Override the shared title for a state that needs to be specific. */
  title?: string;
  /** Override the shared description. */
  description?: ReactNode;
  /** Where the primary action sends a person. Defaults to the app root. */
  homeHref?: string;
  /** Override the shared action label. */
  actionLabel?: string;
  /** Heading level. 1 (default) for a route page; raise it when embedded. */
  headingLevel?: HeadingLevel;
  /** Move focus to the action on mount. Default true. */
  autoFocusAction?: boolean;
  className?: string;
}

/**
 * 403 — the person is signed in but this account may not open the page.
 *
 * A link home rather than a sign-in prompt: they are already authenticated, so the honest next
 * step is to leave for somewhere they can go, or to ask an administrator.
 */
export function ForbiddenState({
  title,
  description,
  homeHref = '/',
  actionLabel,
  headingLevel = 1,
  autoFocusAction = true,
  className,
}: NavStateProps) {
  const focusRef = useFocusOnMount(autoFocusAction);
  const copy = STATE_COPY.forbidden;
  return (
    <StatePanel
      state="forbidden"
      headingLevel={headingLevel}
      title={title ?? copy.title}
      description={description ?? copy.description}
      className={className}
      action={
        <a
          ref={focusRef}
          className="tm-button tm-button--ink tm-button--accessible"
          href={homeHref}
        >
          {actionLabel ?? copy.action}
        </a>
      }
    />
  );
}

/** 404 — the address does not resolve. A link home is the only honest action. */
export function NotFoundState({
  title,
  description,
  homeHref = '/',
  actionLabel,
  headingLevel = 1,
  autoFocusAction = true,
  className,
}: NavStateProps) {
  const focusRef = useFocusOnMount(autoFocusAction);
  const copy = STATE_COPY.notFound;
  return (
    <StatePanel
      state="notFound"
      headingLevel={headingLevel}
      title={title ?? copy.title}
      description={description ?? copy.description}
      className={className}
      action={
        <a
          ref={focusRef}
          className="tm-button tm-button--ink tm-button--accessible"
          href={homeHref}
        >
          {actionLabel ?? copy.action}
        </a>
      }
    />
  );
}

interface ServerErrorStateProps {
  title?: string;
  description?: ReactNode;
  /**
   * Retry handler. Next's `error.tsx` passes its `reset`, which re-renders the failed segment.
   * When present the primary action is a "Try again" button; when absent it falls back to a
   * link home, so the state is never a dead end.
   */
  onRetry?: () => void;
  actionLabel?: string;
  /** Where the fallback link goes when there is no retry. Defaults to the app root. */
  homeHref?: string;
  headingLevel?: HeadingLevel;
  autoFocusAction?: boolean;
  className?: string;
  /** The error's reference (Next's `digest`), shown so a person can quote it. */
  reference?: string | undefined;
}

/** SYS-06's reference card: the id in mono beside a Copy button. */
function ReferenceCard({ reference }: { reference: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="tm-state__reference">
      <div className="tm-state__reference-text">
        <span className="tm-state__reference-label">{t('StateScreens.reference')}</span>
        <code className="tm-state__reference-value">{reference}</code>
      </div>
      <button
        type="button"
        className="tm-button tm-button--outline tm-button--compact"
        onClick={() => {
          navigator.clipboard
            ?.writeText(reference)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? t('StateScreens.copied') : t('StateScreens.copy')}
      </button>
    </div>
  );
}

/** 500 — an error here, not anything the person did. Offer a retry, then a way out. */
export function ServerErrorState({
  title,
  description,
  onRetry,
  actionLabel,
  homeHref = '/',
  headingLevel = 1,
  autoFocusAction = true,
  className,
  reference,
}: ServerErrorStateProps) {
  const t = useT();
  const focusRef = useFocusOnMount(autoFocusAction);
  const copy = STATE_COPY.serverError;
  return (
    <StatePanel
      state="serverError"
      headingLevel={headingLevel}
      title={title ?? copy.title}
      description={description ?? copy.description}
      className={className}
      detail={reference ? <ReferenceCard reference={reference} /> : undefined}
      action={
        onRetry ? (
          <button
            ref={focusRef}
            type="button"
            className="tm-button tm-button--ink tm-button--accessible"
            onClick={onRetry}
          >
            {actionLabel ?? copy.action}
          </button>
        ) : (
          <a
            ref={focusRef}
            className="tm-button tm-button--ink tm-button--accessible"
            href={homeHref}
          >
            {t('StateScreens.backToHome')}
          </a>
        )
      }
    />
  );
}

interface EmptyStateProps {
  /** Override the shared "Nothing here yet" title with something the screen can be specific about. */
  title?: string;
  description?: ReactNode;
  /**
   * The screen's own call to action, if any — a "Create the first…" button or link. The empty
   * state does not invent one, because only the screen knows what is missing and how to add it.
   */
  action?: ReactNode;
  headingLevel?: HeadingLevel;
  className?: string;
}

/**
 * A region a screen shows in place of a list that is empty.
 *
 * Embedded, so its heading defaults to level 2 (it sits under the screen's `<h1>`) and it
 * never moves focus.
 */
export function EmptyState({
  title,
  description,
  action,
  headingLevel = 2,
  className,
}: EmptyStateProps) {
  const copy = STATE_COPY.empty;
  return (
    <StatePanel
      state="empty"
      headingLevel={headingLevel}
      title={title ?? copy.title}
      description={description ?? copy.description}
      action={action}
      className={className}
    />
  );
}

interface LoadingStateProps {
  title?: string;
  description?: ReactNode;
  headingLevel?: HeadingLevel;
  className?: string;
}

/**
 * A wait, marked busy for assistive technology.
 *
 * `aria-busy` sits on the region so a screen reader knows the content is not yet settled. The
 * glyph is decorative; the visible title and description say the same thing in words for
 * everyone else. No action, and no stolen focus.
 */
export function LoadingState({
  title,
  description,
  headingLevel = 2,
  className,
}: LoadingStateProps) {
  const copy = STATE_COPY.loading;
  return (
    <StatePanel
      state="loading"
      headingLevel={headingLevel}
      title={title ?? copy.title}
      description={description ?? copy.description}
      busy
      className={className}
    />
  );
}

/**
 * The page frame a full-screen state sits in — a skip link, one `<main>`, and the ambient
 * live-region announcer.
 *
 * The root `layout.tsx` renders no landmark of its own (each screen brings its own, exactly as
 * `IdentityShell` does), so a route page that renders a bare state would have no skip link and
 * no `<main>`. This frame gives the error routes those without every route page repeating them,
 * and satisfies `A11Y-01`'s skip-link / main / heading requirement structurally. The state's
 * own `<section>` region and `<h1>` nest inside the `<main>`.
 */
export function StateScreen({ children, label }: { children: ReactNode; label?: string }) {
  const t = useT();
  return (
    <LiveAnnouncer>
      <div className="tm-state-screen">
        <SkipLink targetId="tm-main" />
        {/* SYS-06: a quiet bar with the brand orb and the state's name in mono. */}
        <header className="tm-state-screen__bar">
          <a href="/" className="tm-state-screen__mark">
            <Wordmark variant="icon" label={t('StateScreens.brandHome')} />
          </a>
          {label ? <p className="tm-state-screen__label">{label}</p> : null}
        </header>
        <main id="tm-main" className="tm-state-screen__main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </LiveAnnouncer>
  );
}
