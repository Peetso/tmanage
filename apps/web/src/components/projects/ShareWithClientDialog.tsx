'use client';

import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Avatar, Button, Checkbox, InlineAlert, Select, Switch } from '@tmanage/ui';
import {
  getPortalSettings,
  listClientOrganizationOptions,
  listClientPeople,
  setProjectClient,
  updatePortalSettings,
} from '../../lib/api/project-client';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';

/**
 * The `ProjectClient.*` keys (Q2). They live in the wave's i18n fragment until the committer merges
 * them into `en.json` / `ar.json`, hence the one cast here rather than at every call site.
 */
export type ProjectClientKey =
  | 'ProjectClient.clientLabel'
  | 'ProjectClient.clientPlaceholder'
  | 'ProjectClient.noClientOption'
  | 'ProjectClient.addClientOption'
  | 'ProjectClient.newClientNameLabel'
  | 'ProjectClient.newClientNameHint'
  | 'ProjectClient.newClientNameRequired'
  | 'ProjectClient.noMatches'
  | 'ProjectClient.shareAfterFirstUpdate'
  | 'ProjectClient.shareAfterFirstUpdateHint'
  | 'ProjectClient.optionsLoadError'
  | 'ProjectClient.accessHeading'
  | 'ProjectClient.currentClientLabel'
  | 'ProjectClient.internalProject'
  | 'ProjectClient.accessHint'
  | 'ProjectClient.shareButton'
  | 'ProjectClient.dialogTitle'
  | 'ProjectClient.peopleHeading'
  | 'ProjectClient.peopleEmpty'
  | 'ProjectClient.peopleUnavailable'
  | 'ProjectClient.peopleWholeCompany'
  | 'ProjectClient.seeHeading'
  | 'ProjectClient.seeTimeline'
  | 'ProjectClient.seeDeliverables'
  | 'ProjectClient.seeForecast'
  | 'ProjectClient.privacyNote'
  | 'ProjectClient.cancel'
  | 'ProjectClient.submit'
  | 'ProjectClient.sharing'
  | 'ProjectClient.shareFailed'
  | 'ProjectClient.errorNetwork'
  | 'ProjectClient.errorGeneric'
  | 'ProjectClient.roleClientAdmin'
  | 'ProjectClient.roleClientReviewer'
  | 'ProjectClient.roleClientMember'
  | 'ProjectClient.roleClientViewer';

export function useProjectClientT(): (key: ProjectClientKey) => string {
  const t = useT();
  return (key) => t(key as MessageKey);
}

const ROLE_KEY: Readonly<Record<string, ProjectClientKey>> = {
  client_admin: 'ProjectClient.roleClientAdmin',
  client_reviewer: 'ProjectClient.roleClientReviewer',
  client_member: 'ProjectClient.roleClientMember',
  client_viewer: 'ProjectClient.roleClientViewer',
};

/** A thrown value as a sentence a person can act on. Never a stack or a cause. */
export function describeProjectClientError(
  error: unknown,
  t: (key: ProjectClientKey) => string,
): string {
  if (error instanceof ApiRequestError) {
    return error.fieldErrors().get('clientOrganizationId') ?? error.message;
  }
  if (error instanceof NetworkError) return t('ProjectClient.errorNetwork');
  return t('ProjectClient.errorGeneric');
}

export interface ShareWithClientDialogProps {
  api: ApiClient;
  organizationSlug: string;
  projectId: string;
  projectName: string;
  /** The client the project is shared with now, preselected. */
  currentClientOrganizationId?: string;
  onClose: () => void;
  onShared: () => void;
}

/**
 * **Share with client (BK1, Figma t5-d, 370:3970 EN / 370:4295 AR).**
 *
 * Client select, the people who get access, what they will see, the privacy note, Cancel / Share.
 *
 * The API shares a project with a whole client company (`PUT projects/:id/client`), not with chosen
 * people, so the people list is read-only: every active person of that company is listed checked and
 * disabled. Of the three "what they will see" toggles only the timeline has a setting behind it
 * (`portal-settings.showTimeline`); deliverables are always shown to the client and internal forecast
 * dates never are, so those two are drawn in their fixed state and disabled.
 */
export function ShareWithClientDialog({
  api,
  organizationSlug,
  projectId,
  projectName,
  currentClientOrganizationId,
  onClose,
  onShared,
}: ShareWithClientDialogProps) {
  const t = useProjectClientT();
  const titleId = useId();

  const options = useQuery({
    queryKey: ['client-organization-options', organizationSlug],
    queryFn: () => listClientOrganizationOptions(api, organizationSlug),
  });

  const settings = useQuery({
    queryKey: ['portal-settings', organizationSlug, projectId],
    queryFn: () => getPortalSettings(api, organizationSlug, projectId),
  });

  const [picked, setPicked] = useState(currentClientOrganizationId ?? '');
  const chosen = picked !== '' ? picked : (options.data?.[0]?.id ?? '');

  const people = useQuery({
    queryKey: ['client-people', organizationSlug, chosen],
    queryFn: () => listClientPeople(api, organizationSlug, chosen),
    enabled: chosen !== '',
  });

  const [showTimeline, setShowTimeline] = useState<boolean | undefined>(undefined);
  const timeline = showTimeline ?? settings.data?.showTimeline ?? true;

  const share = useMutation({
    mutationFn: async () => {
      await setProjectClient(api, organizationSlug, projectId, chosen);
      const current = settings.data;
      if (current !== undefined && timeline !== current.showTimeline) {
        await updatePortalSettings(api, organizationSlug, projectId, {
          welcomeMessage: current.welcomeMessage,
          accentColor: current.accentColor,
          showTeam: current.showTeam,
          showTimeline: timeline,
        });
      }
    },
    onSuccess: onShared,
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canShare = chosen !== '' && !share.isPending;

  return (
    <div className="tm-command-palette__backdrop">
      <style href="tm-share-client" precedence="default">
        {SHARE_CSS}
      </style>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="tm-card tm-stack tm-share-client"
      >
        <h2 id={titleId} className="tm-heading-2">
          {t('ProjectClient.dialogTitle').replace('{project}', projectName)}
        </h2>

        <form
          noValidate
          className="tm-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (canShare) share.mutate();
          }}
        >
          <Select
            label={t('ProjectClient.clientLabel')}
            name="clientOrganizationId"
            value={chosen}
            onChange={(event) => setPicked(event.target.value)}
            disabled={options.isPending}
            required
          >
            {(options.data ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </Select>
          {options.isError ? (
            <InlineAlert tone="danger" title={t('ProjectClient.optionsLoadError')} live>
              {describeProjectClientError(options.error, t)}
            </InlineAlert>
          ) : null}

          <fieldset className="tm-fieldset tm-stack tm-stack--tight">
            <legend className="tm-field__label">{t('ProjectClient.peopleHeading')}</legend>
            {people.isError ? (
              <p className="tm-field__hint">{t('ProjectClient.peopleUnavailable')}</p>
            ) : null}
            {people.isSuccess && people.data.length === 0 ? (
              <p className="tm-field__hint">{t('ProjectClient.peopleEmpty')}</p>
            ) : null}
            {people.isSuccess && people.data.length > 0 ? (
              <ul className="tm-share-client__people">
                {people.data.map((person) => {
                  const roleKey = ROLE_KEY[person.role];
                  return (
                    <li key={person.id}>
                      <Checkbox
                        checked
                        disabled
                        readOnly
                        label={
                          <span className="tm-share-client__person">
                            <Avatar name={person.userId} audience="client" decorative />
                            <span className="tm-prj-people__who">
                              <span className="tm-prj-people__name">{person.userId}</span>
                              <span className="tm-prj-people__role">
                                {roleKey ? t(roleKey) : person.role}
                              </span>
                            </span>
                          </span>
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {people.isSuccess && people.data.length > 0 ? (
              <p className="tm-field__hint">{t('ProjectClient.peopleWholeCompany')}</p>
            ) : null}
          </fieldset>

          <fieldset className="tm-fieldset tm-stack tm-stack--tight">
            <legend className="tm-field__label">{t('ProjectClient.seeHeading')}</legend>
            <Switch
              label={t('ProjectClient.seeTimeline')}
              name="showTimeline"
              checked={timeline}
              disabled={settings.isPending}
              onChange={(event) => setShowTimeline(event.target.checked)}
            />
            <Switch label={t('ProjectClient.seeDeliverables')} checked disabled readOnly />
            <Switch label={t('ProjectClient.seeForecast')} checked={false} disabled readOnly />
          </fieldset>

          <InlineAlert tone="client">{t('ProjectClient.privacyNote')}</InlineAlert>

          {share.isError ? (
            <InlineAlert tone="danger" title={t('ProjectClient.shareFailed')} live>
              {describeProjectClientError(share.error, t)}
            </InlineAlert>
          ) : null}

          <div className="tm-row tm-row--end">
            <Button type="button" tone="outline" size="accessible" onClick={onClose}>
              {t('ProjectClient.cancel')}
            </Button>
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              disabled={!canShare}
              loading={share.isPending}
              loadingLabel={t('ProjectClient.sharing')}
            >
              {t('ProjectClient.submit')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

const SHARE_CSS = `
.tm-share-client {
  inline-size: min(560px, 100%); max-block-size: calc(100dvh - var(--s6) * 2); overflow-y: auto;
  border-radius: var(--r-sheet); padding: var(--s6); background: var(--paper-0);
}
.tm-share-client__people {
  display: flex; flex-direction: column; gap: var(--s3); margin: 0; padding: 0; list-style: none;
}
.tm-share-client__person { display: inline-flex; align-items: center; gap: var(--s3); }
`;
