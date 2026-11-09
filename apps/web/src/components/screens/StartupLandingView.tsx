'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { useT } from '../../lib/i18n/use-t';
import { browserApiClient } from '../../lib/api/browser-client';
import { getStartupPref, updateStartupPref, LANDING_KEYS } from '../../lib/api/startup-prefs';
import type { LandingKey, StartupPrefView } from '../../lib/api/startup-prefs';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/preferences.css';

export interface StartupLandingViewProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** The default an unsaved account routes by; the same value the API's `DEFAULT_LANDING_KEY` holds. */
const DEFAULT_LANDING_KEY: LandingKey = 'home';

/**
 * **Default startup landing view (module 20 Preferences & accessibility, PREF-STARTUP, x287).**
 *
 * `22-SCREEN-INVENTORY` §PRF; `10-SCREENS-FLOWS` §post-login routing. The audit found appearance,
 * accessibility and quiet-hours preferences built but no choice of which screen the app opens to on
 * sign-in; this is the screen that adds it. A member reads their own preference (the default `home`
 * when never saved), picks one destination, and saves — persisted behind `work.read`, scoped to the
 * caller's own membership by the server, so the shell can route there after sign-in.
 */
export function StartupLandingView({
  organizationSlug,
  organizationName,
  client,
}: StartupLandingViewProps) {
  const errorMessage = useDescribeApiError(OFFLINE_LINES);
  const t = useT();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  /** Human labels for each landing destination, in the order they are offered. */
  const destinationLabels: Readonly<Record<LandingKey, string>> = {
    home: t('StartupLandingView.destHome'),
    inbox: t('StartupLandingView.destInbox'),
    'my-work': t('StartupLandingView.destMyWork'),
    calendar: t('StartupLandingView.destCalendar'),
  };

  const preference = useQuery({
    queryKey: ['startup-pref', organizationSlug],
    queryFn: () => getStartupPref(api, organizationSlug),
  });

  const [landingKey, setLandingKey] = useState<LandingKey>(DEFAULT_LANDING_KEY);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!preference.data) return;
    setLandingKey(preference.data.landingKey);
  }, [preference.data]);

  const save = useMutation({
    mutationFn: (): Promise<StartupPrefView> =>
      updateStartupPref(api, organizationSlug, landingKey),
    onSuccess: (result) => {
      queries.setQueryData(['startup-pref', organizationSlug], result);
      setSaved(true);
    },
  });

  return (
    <SettingsShell
      section="startup"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={t('StartupLandingView.eyebrow')}
      title={t('StartupLandingView.title')}
    >
      {preference.isPending ? (
        <LoadingRegion label={t('StartupLandingView.loading')}>
          <Skeleton />
        </LoadingRegion>
      ) : preference.isError ? (
        <InlineAlert tone="danger" title={t('StartupLandingView.loadError')}>
          {errorMessage(preference.error)}
        </InlineAlert>
      ) : (
        <div className="tm-prefs tm-prefs--a11y">
          <div className="tm-prefs__main">
            <form
              className="tm-prefs-card"
              aria-labelledby="tm-startup-heading"
              onSubmit={(event) => {
                event.preventDefault();
                setSaved(false);
                save.mutate();
              }}
            >
              <h2 id="tm-startup-heading" className="tm-visually-hidden">
                {t('StartupLandingView.openTo')}
              </h2>

              <fieldset className="tm-prefs-section">
                <legend className="tm-prefs-eyebrow">{t('StartupLandingView.legend')}</legend>
                <div className="tm-prefs-choices">
                  {LANDING_KEYS.map((key) => (
                    <label className="tm-prefs-choice" key={key}>
                      <input
                        id={`tm-startup-${key}`}
                        type="radio"
                        name="tm-startup-landing"
                        value={key}
                        checked={landingKey === key}
                        onChange={() => setLandingKey(key)}
                      />
                      {destinationLabels[key]}
                    </label>
                  ))}
                </div>
                <p className="tm-prefs-card__note">{t('StartupLandingView.note')}</p>
              </fieldset>

              {save.isError ? (
                <InlineAlert tone="danger" title={t('StartupLandingView.saveError')}>
                  {errorMessage(save.error)}
                </InlineAlert>
              ) : null}

              {saved && !save.isPending && !save.isError ? (
                <InlineAlert tone="success" title={t('StartupLandingView.savedTitle')}>
                  {t('StartupLandingView.savedBody')}
                </InlineAlert>
              ) : null}

              <div>
                <button
                  type="submit"
                  className="tm-prefs-capsule tm-prefs-capsule--ink"
                  disabled={save.isPending}
                >
                  {save.isPending
                    ? t('StartupLandingView.saving')
                    : t('StartupLandingView.saveButton')}
                </button>
              </div>
            </form>
          </div>

          <aside className="tm-prefs__side" aria-labelledby="tm-startup-summary">
            <div className="tm-prefs-card tm-prefs-card--paper tm-prefs-card--grow">
              <h2 id="tm-startup-summary" className="tm-prefs-eyebrow">
                {t('StartupLandingView.summaryHeading')}
              </h2>
              <p className="tm-prefs-card__lead">
                {t('StartupLandingView.opensOnPrefix')}
                {destinationLabels[landingKey]}
                {t('StartupLandingView.opensOnSuffix')}
              </p>
            </div>
          </aside>
        </div>
      )}
    </SettingsShell>
  );
}
