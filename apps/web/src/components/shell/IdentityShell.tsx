import type { ReactNode } from 'react';
import { LiveAnnouncer, SkipLink } from '@tmanage/ui';
import { Wordmark } from '../brand/Wordmark';

export interface IdentityShellProps {
  /**
   * The screen id, e.g. `ID-01`. Kept on the component so callers and the design export still
   * agree on which artboard a screen is, but **no longer rendered** (TXT-01): the codes read as
   * internal build labels to people signing in, so the eyebrow now shows only the human label.
   */
  screenId?: string;
  /** The eyebrow label, e.g. `Sign in`. Uppercased by CSS, not by the caller. */
  eyebrow: string;
  children: ReactNode;
  /** The privacy and support links `22-SCREEN-BY-SCREEN` §3 requires on ID-01. */
  footer?: ReactNode;
}

/**
 * The frame every identity screen sits in — ID-01 through ID-05.
 *
 * A single centred card on a dark ground, matching the export's identity artboards. It is a
 * separate shell from `AppShell` for a reason that is not visual: an identity screen has no
 * organization yet. There is no rail, no context rail and no tenant, because the person has
 * not chosen one — `ID-04` is the screen where they do. A shell that rendered navigation
 * here would have to invent a tenant to render it for.
 *
 * The landmarks are the shell's job rather than each screen's, so `A11Y-01` in
 * `27-TEST-CATALOG` — skip link, `<main>`, one `<h1>` — is satisfied structurally instead of
 * nine times by hand.
 */
export function IdentityShell({ eyebrow, children, footer }: IdentityShellProps) {
  return (
    <LiveAnnouncer>
      <div className="tm-identity">
        <SkipLink targetId="tm-main" />

        <div className="tm-identity__card">
          <header className="tm-identity__brand">
            <Wordmark />
            <p className="tm-identity__eyebrow tm-mono">{eyebrow}</p>
          </header>

          <main id="tm-main" className="tm-identity__body" tabIndex={-1}>
            {children}
          </main>

          {footer ? <footer className="tm-identity__footer">{footer}</footer> : null}
        </div>
      </div>
    </LiveAnnouncer>
  );
}
