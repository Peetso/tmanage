'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { getPrivacyPreferences, setPrivacyPreferences } from '../../lib/api/presence';
import { useT } from '../../lib/i18n/use-t';
import { PreferenceToggle } from '../screens/PreferencesScreen';

/**
 * R7 (F4) — the "Show last seen and online" toggle on the profile preferences screen. Default on.
 * Off hides both from everyone else (the API answers offline with no last-seen time).
 */
export function PrivacyPrefs({
  organizationSlug,
  client,
}: {
  readonly organizationSlug: string;
  readonly client?: ApiClient;
}) {
  const t = useT();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const key = ['privacy-preferences', organizationSlug] as const;
  const prefs = useQuery({
    queryKey: key,
    queryFn: () => getPrivacyPreferences(api, organizationSlug),
  });
  const save = useMutation({
    mutationFn: (showLastSeen: boolean) =>
      setPrivacyPreferences(api, organizationSlug, { showLastSeen }),
    onSuccess: (view) => queryClient.setQueryData(key, view),
  });
  const checked = save.isPending ? Boolean(save.variables) : (prefs.data?.showLastSeen ?? true);

  return (
    <section aria-labelledby="tm-profile-privacy" className="tm-prefs-group">
      <h2 id="tm-profile-privacy" className="tm-prefs-heading">
        {t('Preferences.privacy.title')}
      </h2>
      <PreferenceToggle
        label={t('Preferences.privacy.showLastSeen')}
        hint={t('Preferences.privacy.showLastSeenHint')}
        checked={checked}
        disabled={prefs.isPending || save.isPending}
        onChange={(event) => save.mutate(event.target.checked)}
      />
      {save.isError ? (
        <InlineAlert tone="danger" title={t('Preferences.privacy.saveError')} live>
          {null}
        </InlineAlert>
      ) : null}
    </section>
  );
}
