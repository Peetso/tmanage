'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getStartupPref, updateStartupPref, LANDING_KEYS } from '../../lib/api/startup-prefs';
import type { LandingKey, StartupPrefView } from '../../lib/api/startup-prefs';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface StartupLandingViewProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** The default an unsaved account routes by; the same value the API's `DEFAULT_LANDING_KEY` holds. */
const DEFAULT_LANDING_KEY: LandingKey = 'home';

/** Human labels for each landing destination, in the order they are offered. */
const DESTINATION_LABELS: Readonly<Record<LandingKey, string>> = {
  home: 'Home',
  inbox: 'Inbox',
  'my-work': 'My Work',
  calendar: 'Calendar',
};

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
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

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
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Startup view"
      description="Choose which screen opens first when you sign in."
    >
      {preference.isPending ? (
        <LoadingRegion label="Loading your startup view">
          <Skeleton />
        </LoadingRegion>
      ) : preference.isError ? (
        <InlineAlert tone="danger" title="We could not load your startup view">
          {errorMessage(preference.error)}
        </InlineAlert>
      ) : (
        <form
          className="tm-panel tm-stack"
          aria-labelledby="tm-startup-heading"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            save.mutate();
          }}
        >
          <h2 id="tm-startup-heading" className="tm-eyebrow">
            Open to
          </h2>

          <fieldset className="tm-fieldset tm-stack">
            <legend className="tm-field__label">Landing screen on sign-in</legend>
            {LANDING_KEYS.map((key) => (
              <div className="tm-field tm-field--inline" key={key}>
                <input
                  id={`tm-startup-${key}`}
                  className="tm-field__control"
                  type="radio"
                  name="tm-startup-landing"
                  value={key}
                  checked={landingKey === key}
                  onChange={() => setLandingKey(key)}
                />
                <label className="tm-field__label" htmlFor={`tm-startup-${key}`}>
                  {DESTINATION_LABELS[key]}
                </label>
              </div>
            ))}
          </fieldset>

          {save.isError ? (
            <InlineAlert tone="danger" title="We could not save your startup view">
              {errorMessage(save.error)}
            </InlineAlert>
          ) : null}

          {saved && !save.isPending && !save.isError ? (
            <InlineAlert tone="success" title="Saved">
              Your startup view has been saved.
            </InlineAlert>
          ) : null}

          <div>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save startup view'}
            </Button>
          </div>
        </form>
      )}
    </AppShell>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
