'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert } from '@tmanage/ui';
import { describe, Loading, PlatformGate, ReasonAction } from './shared/platform-kit';
import type { ScreenProps } from './shared/platform-kit';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import type { ApiClient } from '../../lib/api/client';
import { fetchPlatformSettings, setPlatformPublicSignup } from '../../lib/api/platform-admin';

// ── Settings ────────────────────────────────────────────────────────────────

export function PlatformSettingsScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <PlatformGate
      api={api}
      section="settings"
      crumbs={[t('PlatformAdminScreens.settingsCrumb')]}
      title={t('PlatformAdminScreens.settingsTitle')}
    >
      {() => <SettingsBody api={api} />}
    </PlatformGate>
  );
}

function SettingsBody({ api }: { api: ApiClient }) {
  const t = useT();
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['platform', 'settings'],
    queryFn: () => fetchPlatformSettings(api),
  });
  if (settings.isPending) return <Loading label={t('PlatformAdminScreens.loadingSettings')} />;
  if (settings.isError) {
    return (
      <InlineAlert tone="danger" title={t('PlatformAdminScreens.couldNotLoadSettings')} live>
        {describe(settings.error, t)}
      </InlineAlert>
    );
  }
  const signup = settings.data.publicSignup;
  return (
    <section className="tm-cc-card" aria-labelledby="tm-platform-signup-heading">
      <div className="tm-cc-card__head">
        <h2 id="tm-platform-signup-heading" className="tm-cc-card__title">
          {t('PlatformAdminScreens.publicSignupIs')}{' '}
          {signup.open ? t('PlatformAdminScreens.open') : t('PlatformAdminScreens.closed')}
        </h2>
        <ReasonAction
          label={
            signup.open
              ? t('PlatformAdminScreens.closeSignup')
              : t('PlatformAdminScreens.openSignup')
          }
          confirmLabel={
            signup.open
              ? t('PlatformAdminScreens.closeConfirm')
              : t('PlatformAdminScreens.openConfirm')
          }
          tone={signup.open ? 'destructive' : 'ink'}
          onConfirm={async (reason) => {
            await setPlatformPublicSignup(api, !signup.open, reason);
            await queryClient.invalidateQueries({ queryKey: ['platform', 'settings'] });
          }}
        />
      </div>
      <p className="tm-cc-note">
        {signup.open
          ? t('PlatformAdminScreens.signupOpenBody')
          : t('PlatformAdminScreens.signupClosedBody')}{' '}
        {signup.source === 'environment'
          ? `${t('PlatformAdminScreens.followingServerSetting')} (${signup.environmentDefault ? t('PlatformAdminScreens.on') : t('PlatformAdminScreens.off')}).`
          : `${t('PlatformAdminScreens.setHereOverrides')} (${signup.environmentDefault ? t('PlatformAdminScreens.on') : t('PlatformAdminScreens.off')}).`}
      </p>
    </section>
  );
}
