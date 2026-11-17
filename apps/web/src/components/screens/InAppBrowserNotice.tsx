'use client';

import { useEffect, useState } from 'react';
import { Button } from '@tmanage/ui';
import { androidIntentUrl, detectInAppBrowser, type InAppBrowser } from '../../lib/in-app-browser';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';

const NOT_IN_APP: InAppBrowser = { inApp: false, android: false };

/**
 * Whether this page runs inside an in-app browser (Facebook, Instagram, TikTok, LINE, Android
 * WebView). Read after hydration, so the server render and the first client render agree.
 */
export function useInAppBrowser(): InAppBrowser {
  const [state, setState] = useState<InAppBrowser>(NOT_IN_APP);
  useEffect(() => {
    setState(detectInAppBrowser(window.navigator.userAgent));
  }, []);
  return state;
}

export interface InAppBrowserNoticeProps {
  google: boolean;
  microsoft: boolean;
  android: boolean;
}

/**
 * Shown in place of "Continue with Google / Microsoft" inside an in-app browser, where the
 * provider refuses the sign-in: one calm line, "Copy link" and, on Android, "Open in browser".
 * When the clipboard is refused the address itself is shown, so the button is never dead.
 */
export function InAppBrowserNotice({ google, microsoft, android }: InAppBrowserNoticeProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState<string | undefined>(undefined);
  const [intent, setIntent] = useState<string | undefined>(undefined);

  useEffect(() => {
    setIntent(android ? androidIntentUrl(window.location.href) : undefined);
  }, [android]);

  if (!google && !microsoft) return null;
  const line: MessageKey =
    google && microsoft
      ? 'InAppBrowser.noticeBoth'
      : google
        ? 'InAppBrowser.noticeGoogle'
        : 'InAppBrowser.noticeMicrosoft';

  async function copy() {
    const href = window.location.href;
    try {
      await window.navigator.clipboard.writeText(href);
      setCopied(true);
      setManual(undefined);
    } catch {
      setCopied(false);
      setManual(href);
    }
  }

  return (
    <div className="tm-id-methods" data-testid="in-app-browser-notice">
      <p className="tm-id-lede">{t(line)}</p>
      <div className="tm-id-action-row">
        <Button type="button" tone="outline" size="accessible" onClick={() => void copy()}>
          {t('InAppBrowser.copyLink')}
        </Button>
        {intent === undefined ? null : (
          <a className="tm-id-link" href={intent}>
            {t('InAppBrowser.openInBrowser')}
          </a>
        )}
        <span role="status">{copied ? t('InAppBrowser.copied') : null}</span>
      </div>
      {manual === undefined ? null : (
        <p className="tm-id-lede">
          {t('InAppBrowser.copyManual')} <span dir="ltr">{manual}</span>
        </p>
      )}
    </div>
  );
}
