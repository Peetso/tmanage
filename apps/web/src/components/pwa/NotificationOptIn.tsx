'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, InlineAlert, Switch } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';
import {
  isNotificationSupported,
  readNotificationPermission,
  readOptInChoice,
  requestNotificationPermission,
  writeOptInChoice,
  type NotificationPermissionState,
} from './notifications';

/**
 * **Desktop notifications opt-in (module 22).**
 *
 * The user-initiated control, surfaced inside the Preferences hub. It never prompts on mount:
 * the browser permission is requested **only** when the person turns the switch on, which is the
 * one gesture the platform treats as a genuine opt-in. Local notifications only — there is no
 * web-push subscription behind this (push is a Needs-Peter item), so turning it on mirrors the
 * inbox notices this window already reads, nothing more.
 *
 * When the Notifications API is absent the whole control degrades to a short, honest line and
 * requests nothing — `isNotificationSupported()` guards every browser call.
 */
export function NotificationOptIn() {
  const t = useT();
  // Resolved after mount so the server render and the first client render agree (no API on the
  // server); until then the control shows its neutral, not-yet-known state.
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermissionState>('default');
  const [optedIn, setOptedIn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const isSupported = isNotificationSupported();
    setSupported(isSupported);
    setPermission(readNotificationPermission());
    setOptedIn(isSupported && readOptInChoice() && readNotificationPermission() === 'granted');
  }, []);

  const enable = useCallback(async () => {
    setBusy(true);
    try {
      const result = await requestNotificationPermission();
      setPermission(result);
      const granted = result === 'granted';
      setOptedIn(granted);
      writeOptInChoice(granted);
    } finally {
      setBusy(false);
    }
  }, []);

  const disable = useCallback(() => {
    setOptedIn(false);
    writeOptInChoice(false);
  }, []);

  const onToggle = useCallback(
    (next: boolean) => {
      if (next) {
        void enable();
      } else {
        disable();
      }
    },
    [enable, disable],
  );

  if (!supported) {
    return (
      <section className="tm-stack" aria-labelledby="tm-notifications-heading">
        <h2 id="tm-notifications-heading" className="tm-eyebrow">
          {t('NotificationOptIn.heading')}
        </h2>
        <InlineAlert tone="neutral" title={t('NotificationOptIn.unsupportedTitle')}>
          {t('NotificationOptIn.unsupportedBody')}
        </InlineAlert>
      </section>
    );
  }

  return (
    <section className="tm-stack" aria-labelledby="tm-notifications-heading">
      <h2 id="tm-notifications-heading" className="tm-eyebrow">
        {t('NotificationOptIn.heading')}
      </h2>

      {permission === 'denied' ? (
        // The browser will not re-prompt once blocked; the switch cannot change this, so it is
        // disabled and the only honest next step is the browser's own site settings.
        <>
          <InlineAlert tone="warning" title={t('NotificationOptIn.blockedTitle')} live>
            {t('NotificationOptIn.blockedBody')}
          </InlineAlert>
          <Switch
            label={t('NotificationOptIn.switchLabel')}
            hint={t('NotificationOptIn.blockedHint')}
            checked={false}
            disabled
            readOnly
          />
        </>
      ) : (
        <Switch
          label={t('NotificationOptIn.switchLabel')}
          hint={t('NotificationOptIn.switchHint')}
          checked={optedIn}
          disabled={busy}
          onChange={(event) => onToggle(event.target.checked)}
        />
      )}

      {optedIn && permission === 'granted' ? (
        <InlineAlert tone="success" title={t('NotificationOptIn.onTitle')} live>
          {t('NotificationOptIn.onBody')}
        </InlineAlert>
      ) : null}

      {permission === 'default' && !busy ? (
        <div className="tm-row">
          <Button type="button" tone="outline" size="accessible" onClick={() => void enable()}>
            {t('NotificationOptIn.enableButton')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
