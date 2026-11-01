'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient, IdleState } from '../../lib/api/client';
import { signOut } from '../../lib/api/session';
import { authBoundary } from '../../lib/auth-boundary';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/idle-signout.css';

/** Real use of the page. A pointer merely passing over it is not. */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
/** The warning opens this long before the idle limit runs out (R3: one minute). */
export const IDLE_WARNING_MS = 60_000;

/**
 * R3 — idle sign-out (Figma "R3 Idle sign-out", 480:28783 / 480:28795).
 *
 * Tells the API client about real activity (so only a person, never a background poll, keeps a
 * session alive), and one minute before the company's "Sign out after inactivity" limit runs out
 * shows "You will be signed out soon". "Stay signed in" refreshes the session; "Sign out", or the
 * limit running out, ends it and goes to sign-in. The timer here only redraws the dialog: it never
 * refreshes anything.
 */
export function IdleSignOutWarning({ client }: { client?: ApiClient }) {
  const t = useT();
  const titleId = useId();
  const [api] = useState(() => client ?? browserApiClient());
  const [idle, setIdle] = useState<IdleState>(() => api.idleState());
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const open = idle.deadline !== null && now >= idle.deadline - IDLE_WARNING_MS;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => api.subscribeIdle(setIdle), [api]);

  // The warning takes focus on "Stay signed in", so a keyboard user can answer at once.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) dialogRef.current?.querySelector<HTMLButtonElement>('button:last-of-type')?.focus();
  }, [open]);

  useEffect(() => {
    // While the warning is open only its buttons decide; a stray key does not refresh.
    const onActivity = () => {
      if (!openRef.current) api.noteActivity();
    };
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, onActivity, { passive: true, capture: true });
    }
    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity, true);
    };
  }, [api]);

  useEffect(() => {
    if (idle.deadline === null) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [idle.deadline]);

  const ended = useRef(false);
  useEffect(() => {
    if (idle.deadline === null || now < idle.deadline || ended.current) return;
    ended.current = true;
    void signOut(api)
      .catch(() => undefined)
      .finally(() => authBoundary.announce('session-ended'));
  }, [api, idle.deadline, now]);

  if (!open || ended.current) return null;

  return (
    <div className="tm-command-palette__backdrop tm-idle-backdrop">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="tm-idle-dialog"
        ref={dialogRef}
      >
        <h2 id={titleId} className="tm-idle-dialog__title">
          {t('IdleSignOut.title')}
        </h2>
        <p className="tm-idle-dialog__lead">{t('IdleSignOut.body')}</p>
        <div className="tm-idle-dialog__actions">
          <Button
            type="button"
            tone="outline"
            size="accessible"
            disabled={busy}
            onClick={() => {
              ended.current = true;
              setBusy(true);
              void signOut(api)
                .catch(() => undefined)
                .finally(() => authBoundary.announce('session-ended'));
            }}
          >
            {t('IdleSignOut.signOut')}
          </Button>
          <Button
            type="button"
            tone="ink"
            size="accessible"
            loading={busy}
            loadingLabel={t('IdleSignOut.staying')}
            onClick={() => {
              setBusy(true);
              void api.staySignedIn().finally(() => setBusy(false));
            }}
          >
            {t('IdleSignOut.stay')}
          </Button>
        </div>
      </div>
    </div>
  );
}
