'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';
import { PlatformDialog, PlatformDialogActions } from '../platform/shared/ReasonDialog';

/**
 * platform-admin v2 · PA-04 — "Leave without saving?" (Figma D7 `439:21130`).
 *
 * While `when` is true, a click on any in-app link is held and this dialog asks first: "Stay on
 * this page" keeps the edit, "Discard and leave" follows the link. Closing the tab or reloading
 * gets the browser's own prompt. The dialog lists what would be lost.
 */
export interface UnsavedChangesGuardProps {
  readonly when: boolean;
  /** The sentence under the title ("You changed 3 boxes in Delivery lead. …"). */
  readonly body: string;
  /** One line per change ("+ Work items · delete"). */
  readonly changes: readonly string[];
  /** Called after the person chose to discard, before the navigation. */
  readonly onDiscard?: () => void;
}

/** Whether a click on this anchor leaves the page inside the app (same origin, new path). */
export function isInAppNavigation(anchor: HTMLAnchorElement, current: Location): boolean {
  if (anchor.target && anchor.target !== '_self') return false;
  if (anchor.hasAttribute('download')) return false;
  const href = anchor.getAttribute('href');
  if (href === null || href.startsWith('#')) return false;
  const url = new URL(anchor.href, current.href);
  if (url.origin !== current.origin) return false;
  return url.pathname !== current.pathname || url.search !== current.search;
}

export function UnsavedChangesGuard({ when, body, changes, onDiscard }: UnsavedChangesGuardProps) {
  const t = useT();
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!when) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older engines show the prompt only when a value is set.
      event.returnValue = '';
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (!isInAppNavigation(anchor, window.location)) return;
      event.preventDefault();
      event.stopPropagation();
      const url = new URL(anchor.href, window.location.href);
      setPending(`${url.pathname}${url.search}${url.hash}`);
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [when]);

  if (pending === null) return null;
  return (
    <PlatformDialog
      eyebrow={t('PermissionEditor.guard.eyebrow')}
      title={t('PermissionEditor.guard.title')}
      width={480}
      onClose={() => setPending(null)}
    >
      <p className="tm-cc-card__body">{body}</p>
      {changes.length > 0 ? (
        <ul className="tm-pe-guard__changes" data-testid="unsaved-guard-changes">
          {changes.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <PlatformDialogActions>
        <Button type="button" tone="outline" onClick={() => setPending(null)}>
          {t('PermissionEditor.guard.stay')}
        </Button>
        <Button
          type="button"
          tone="destructive"
          onClick={() => {
            const target = pending;
            setPending(null);
            onDiscard?.();
            router.push(target);
          }}
        >
          {t('PermissionEditor.guard.leave')}
        </Button>
      </PlatformDialogActions>
    </PlatformDialog>
  );
}
