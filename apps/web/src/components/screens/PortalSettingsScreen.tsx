'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  PORTAL_ACCENT_PALETTE,
  getPortalSettings,
  updatePortalSettings,
} from '../../lib/api/portal-settings';
import type { PortalSettingsView } from '../../lib/api/portal-settings';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

type Translate = ReturnType<typeof useT>;

export interface PortalSettingsScreenProps {
  organizationSlug: string;
  organizationName: string;
  projectId: string;
  client?: ApiClient;
}

/** The defaults an unconfigured project reads by; the same values the API's `DEFAULT_PORTAL_SETTINGS` holds. */
const DEFAULTS = {
  welcomeMessage: '',
  accentColor: PORTAL_ACCENT_PALETTE[0],
  showTeam: true,
  showTimeline: true,
} as const;

/**
 * **Client portal settings (module 13 Client portal, x238).**
 *
 * `38-MODULE-MAP` §Client Portal. The audit found the portal built but no per-project portal
 * configuration; this is the screen that adds it. A manager sets the client-facing welcome message,
 * picks an accent colour from a fixed palette, and toggles whether the team and the timeline are shown
 * on the client portal, then saves — persisted behind `project.manage`, tenant-scoped by the server.
 * The client-facing portal reads only these presentation fields (never who last edited them).
 */
export function PortalSettingsScreen({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: PortalSettingsScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();

  const settings = useQuery({
    queryKey: ['portal-settings', organizationSlug, projectId],
    queryFn: () => getPortalSettings(api, organizationSlug, projectId),
  });

  const [welcomeMessage, setWelcomeMessage] = useState<string>(DEFAULTS.welcomeMessage);
  const [accentColor, setAccentColor] = useState<string>(DEFAULTS.accentColor);
  const [showTeam, setShowTeam] = useState<boolean>(DEFAULTS.showTeam);
  const [showTimeline, setShowTimeline] = useState<boolean>(DEFAULTS.showTimeline);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    setWelcomeMessage(settings.data.welcomeMessage ?? '');
    setAccentColor(settings.data.accentColor);
    setShowTeam(settings.data.showTeam);
    setShowTimeline(settings.data.showTimeline);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (): Promise<PortalSettingsView> =>
      updatePortalSettings(api, organizationSlug, projectId, {
        welcomeMessage: welcomeMessage.trim() === '' ? null : welcomeMessage.trim(),
        accentColor,
        showTeam,
        showTimeline,
      }),
    onSuccess: (result) => {
      queries.setQueryData(['portal-settings', organizationSlug, projectId], result);
      setSaved(true);
    },
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={t('PortalSettingsScreen.title')}
      description={t('PortalSettingsScreen.description')}
    >
      {settings.isPending ? (
        <LoadingRegion label={t('PortalSettingsScreen.loadingSettings')}>
          <Skeleton />
        </LoadingRegion>
      ) : settings.isError ? (
        <InlineAlert tone="danger" title={t('PortalSettingsScreen.couldNotLoad')}>
          {errorMessage(settings.error, t)}
        </InlineAlert>
      ) : (
        <form
          noValidate
          className="tm-panel tm-stack"
          aria-labelledby="tm-portal-settings-heading"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            save.mutate();
          }}
        >
          <h2 id="tm-portal-settings-heading" className="tm-eyebrow">
            {t('PortalSettingsScreen.brandingHeading')}
          </h2>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-portal-welcome">
              {t('PortalSettingsScreen.welcomeLabel')}
            </label>
            <textarea
              id="tm-portal-welcome"
              className="tm-field__control"
              rows={3}
              maxLength={2000}
              value={welcomeMessage}
              placeholder={t('PortalSettingsScreen.welcomePlaceholder')}
              onChange={(event) => setWelcomeMessage(event.target.value)}
            />
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-portal-accent">
              {t('PortalSettingsScreen.accentLabel')}
            </label>
            <select
              id="tm-portal-accent"
              className="tm-field__control"
              value={accentColor}
              onChange={(event) => setAccentColor(event.target.value)}
            >
              {PORTAL_ACCENT_PALETTE.map((color) => (
                <option key={color} value={color}>
                  {color}
                </option>
              ))}
            </select>
          </div>

          <div className="tm-field tm-field--inline">
            <input
              id="tm-portal-show-team"
              className="tm-field__control"
              type="checkbox"
              checked={showTeam}
              onChange={(event) => setShowTeam(event.target.checked)}
            />
            <label className="tm-field__label" htmlFor="tm-portal-show-team">
              {t('PortalSettingsScreen.showTeamLabel')}
            </label>
          </div>

          <div className="tm-field tm-field--inline">
            <input
              id="tm-portal-show-timeline"
              className="tm-field__control"
              type="checkbox"
              checked={showTimeline}
              onChange={(event) => setShowTimeline(event.target.checked)}
            />
            <label className="tm-field__label" htmlFor="tm-portal-show-timeline">
              {t('PortalSettingsScreen.showTimelineLabel')}
            </label>
          </div>

          {save.isError ? (
            <InlineAlert tone="danger" title={t('PortalSettingsScreen.couldNotSave')}>
              {errorMessage(save.error, t)}
            </InlineAlert>
          ) : null}

          {saved && !save.isPending && !save.isError ? (
            <InlineAlert tone="success" title={t('PortalSettingsScreen.saved')}>
              {t('PortalSettingsScreen.savedBody')}
            </InlineAlert>
          ) : null}

          <div>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending
                ? t('PortalSettingsScreen.saving')
                : t('PortalSettingsScreen.saveButton')}
            </Button>
          </div>
        </form>
      )}
    </AppShell>
  );
}

function errorMessage(error: unknown, t: Translate): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return t('PortalSettingsScreen.genericError');
}
