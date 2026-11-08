'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, StateCapsule, Switch, VisuallyHidden } from '@tmanage/ui';
import { SEVERITIES } from '@tmanage/domain';
import type { IncidentSeverity } from '@tmanage/domain';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { ApiRequestError } from '../../../lib/api/errors';
import {
  INCIDENT_STATUS_ORDER,
  PLATFORM_INCIDENTS_QUERY_KEY,
  createPlatformIncident,
  fetchPlatformIncidents,
  incidentCapsule,
  nextOpenClock,
  platformIncidentAction,
  updatePlatformIncident,
} from '../../../lib/api/incidents';
import type {
  IncidentStatus,
  PlatformIncidentInput,
  PlatformIncidentView,
} from '../../../lib/api/incidents';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { INCIDENT_STATUS_TEXT, incidentMoment } from '../../screens/AdminIncidentsScreen';
import { ChipGroup, fromLocalInput, toLocalInput } from '../settings/settings-kit';
import { PlatformGate } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { ReasonDialog, platformErrorText } from '../shared/ReasonDialog';
import { PLATFORM_ME_QUERY_KEY, missingPlatformPermission } from '../shared/usePlatformPermissions';
import { useT } from '../../../lib/i18n/use-t';
// The write-up textarea reuses the content editor's styling (tokens only).
import '../content/content.css';

/**
 * A17 · **Incidents register** (`/platform/incidents`, Figma R31 L09 frames "Incidents register ·
 * platform · list / new incident"). Every route needs `platform.settings.edit`; the API computes
 * the notice clocks and refuses to resolve while a notice is owed (422 `clock_open`), which the
 * screen shows as the API's own sentence.
 */

const PERMISSION = 'platform.settings.edit';

/** Comma/space separated text → a trimmed, de-duplicated list. */
export function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function PlatformIncidentsScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const [editing, setEditing] = useState<PlatformIncidentView | 'new' | null>(null);
  return (
    <PlatformGate
      api={api}
      section="settings"
      crumbs={[tOr('Incidents.crumbPlatform', 'Settings'), tOr('Incidents.title', 'Incidents')]}
      title={tOr('Incidents.title', 'Incidents')}
      description={tOr(
        'Incidents.registerDescription',
        'The incident register: record what happened, who it touched, and send the notices the law asks for.',
      )}
      actions={(me) =>
        me.permissions.includes(PERMISSION) ? (
          <Button type="button" tone="ink" onClick={() => setEditing('new')}>
            {tOr('Incidents.new', 'New incident')}
          </Button>
        ) : null
      }
    >
      {(me) => <RegisterBody api={api} me={me} editing={editing} setEditing={setEditing} />}
    </PlatformGate>
  );
}

function RegisterBody({
  api,
  me,
  editing,
  setEditing,
}: {
  api: ApiClient;
  me: PlatformMeView;
  editing: PlatformIncidentView | 'new' | null;
  setEditing: (next: PlatformIncidentView | 'new' | null) => void;
}) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const queryClient = useQueryClient();
  const [resolving, setResolving] = useState<PlatformIncidentView | null>(null);
  const list = useQuery({
    queryKey: PLATFORM_INCIDENTS_QUERY_KEY,
    queryFn: () => fetchPlatformIncidents(api),
    refetchInterval: 60_000,
  });
  const canEdit = me.permissions.includes(PERMISSION);

  if (list.isPending) {
    return (
      <PlatformPageState
        state="loading"
        loadingLabel={tOr('Incidents.loading', 'Loading incidents')}
      />
    );
  }
  if (list.isError) {
    const missing = missingPlatformPermission(list.error);
    return missing !== null ? (
      <PlatformPageState state="forbidden" permission={missing} preset={me.preset} />
    ) : (
      <PlatformPageState state="error" error={list.error} onRetry={() => void list.refetch()} />
    );
  }

  const rows = list.data;
  return (
    <div className="tm-stack">
      {rows.length === 0 && editing === null ? (
        <PlatformPageState
          state="empty"
          title={tOr('Incidents.registerEmptyTitle', 'No incidents recorded')}
          body={tOr(
            'Incidents.registerEmptyBody',
            'Record an incident as soon as you know about it: the notice clocks start when it is detected.',
          )}
        />
      ) : (
        <section className="tm-cc-card tm-stack" aria-labelledby="tm-incidents-register">
          <h2 id="tm-incidents-register" className="tm-visually-hidden">
            {tOr('Incidents.title', 'Incidents')}
          </h2>
          <ul className="tm-cc-rows">
            {rows.map((incident) => (
              <RegisterRow
                key={incident.id}
                incident={incident}
                locale={locale}
                canEdit={canEdit}
                onEdit={() => setEditing(incident)}
                onResolve={() => setResolving(incident)}
              />
            ))}
          </ul>
          <InlineAlert tone="warning">
            {tOr(
              'Incidents.resolveRule',
              'An incident cannot be resolved while a notice is still owed.',
            )}
          </InlineAlert>
        </section>
      )}
      {editing !== null ? (
        <IncidentEditor
          key={editing === 'new' ? 'new' : editing.id}
          api={api}
          existing={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      ) : null}
      {resolving ? (
        <ReasonDialog
          title={`${tOr('Incidents.resolve', 'Resolve')} · ${resolving.title}`}
          body={tOr(
            'Incidents.resolveBody',
            'The incident is marked resolved now and the status page shows it as over.',
          )}
          reasonRequired={false}
          confirmLabel={tOr('Incidents.resolve', 'Resolve')}
          onConfirm={(reason) => platformIncidentAction(api, resolving.id, 'resolve', reason)}
          onClose={(done) => {
            setResolving(null);
            if (done)
              void queryClient.invalidateQueries({ queryKey: PLATFORM_INCIDENTS_QUERY_KEY });
          }}
        />
      ) : null}
    </div>
  );
}

function RegisterRow({
  incident,
  locale,
  canEdit,
  onEdit,
  onResolve,
}: {
  incident: PlatformIncidentView;
  locale: string;
  canEdit: boolean;
  onEdit: () => void;
  onResolve: () => void;
}) {
  const tOr = useTOr();
  const [key, english] = INCIDENT_STATUS_TEXT[incident.status];
  const due = nextOpenClock(incident);
  const when =
    incident.resolvedAt === null
      ? `${tOr('Incidents.started', 'started')} ${incidentMoment(incident.startedAt, locale)}`
      : `${incidentMoment(incident.startedAt, locale)} – ${incidentMoment(incident.resolvedAt, locale)}`;
  const workspaces = incident.affectedOrgIds.length;
  const notices =
    due !== null
      ? `${tOr('Incidents.noticeDue', 'Notice due')} ${incidentMoment(due, locale)}`
      : tOr('Incidents.noNoticeOwed', 'No notice owed');
  const published = incident.published
    ? tOr('Incidents.published', 'published')
    : tOr('Incidents.draft', 'not published');
  return (
    <li>
      <div className="tm-cc-rows__text tm-cc-rows__grow">
        <p className="tm-cc-rows__title">{incident.title}</p>
        <span className="tm-cc-rows__sub">
          <bdi>{incident.severity}</bdi> · <bdi>{incident.component}</bdi> · {when}
          {workspaces > 0
            ? ` · ${workspaces} ${tOr('Incidents.workspacesCount', 'workspaces')}`
            : ''}
        </span>
        <span className="tm-cc-rows__sub">
          {notices} · {published}
        </span>
      </div>
      <StateCapsule state={incidentCapsule(incident.status)}>{tOr(key, english)}</StateCapsule>
      {canEdit ? (
        <div className="tm-cc-hero__actions">
          <Button type="button" tone="text" size="compact" onClick={onEdit}>
            {tOr('Incidents.edit', 'Edit')}
          </Button>
          {incident.status !== 'resolved' ? (
            <Button type="button" tone="text" size="compact" onClick={onResolve}>
              {tOr('Incidents.resolve', 'Resolve')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

interface Draft {
  title: string;
  component: string;
  body: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  personalData: boolean;
  countries: string;
  affectedOrgIds: string;
  notifiedAuthorityAt: string;
  notifiedCustomersAt: string;
  reason: string;
}

function draftOf(existing: PlatformIncidentView | null): Draft {
  return {
    title: existing?.title ?? '',
    component: existing?.component ?? '',
    body: existing?.body ?? '',
    severity: existing?.severity ?? 'SEV3',
    status: existing?.status ?? 'investigating',
    personalData: existing?.personalData ?? false,
    countries: existing?.countries.join(', ') ?? '',
    affectedOrgIds: existing?.affectedOrgIds.join(', ') ?? '',
    notifiedAuthorityAt: toLocalInput(existing?.notifiedAuthorityAt ?? null),
    notifiedCustomersAt: toLocalInput(existing?.notifiedCustomersAt ?? null),
    reason: '',
  };
}

function IncidentEditor({
  api,
  existing,
  onDone,
}: {
  api: ApiClient;
  existing: PlatformIncidentView | null;
  onDone: () => void;
}) {
  const t = useT();
  const tOr = useTOr();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(existing));
  const [tried, setTried] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const errors = {
    title: draft.title.trim() === '',
    component: draft.component.trim() === '',
    body: draft.body.trim() === '',
  };
  const invalid = Object.values(errors).some(Boolean);
  const required = tOr('Incidents.required', 'Fill in this field.');

  const refresh = async (error?: unknown) => {
    if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
      await queryClient.invalidateQueries({ queryKey: PLATFORM_ME_QUERY_KEY });
    }
    await queryClient.invalidateQueries({ queryKey: PLATFORM_INCIDENTS_QUERY_KEY });
  };

  const save = useMutation({
    mutationFn: async () => {
      const input: PlatformIncidentInput = {
        title: draft.title.trim(),
        component: draft.component.trim(),
        body: draft.body.trim(),
        severity: draft.severity,
        status: draft.status,
        personalData: draft.personalData,
        countries: splitList(draft.countries).map((code) => code.toUpperCase()),
        affectedOrgIds: splitList(draft.affectedOrgIds),
        notifiedAuthorityAt: fromLocalInput(draft.notifiedAuthorityAt),
        notifiedCustomersAt: fromLocalInput(draft.notifiedCustomersAt),
        ...(draft.reason.trim() !== '' ? { reason: draft.reason.trim() } : {}),
      };
      if (existing === null) await createPlatformIncident(api, input);
      else await updatePlatformIncident(api, existing.id, input);
    },
    onSuccess: async () => {
      await refresh();
      onDone();
    },
    onError: (error) => refresh(error),
  });

  const publish = useMutation({
    mutationFn: (next: 'publish' | 'unpublish') =>
      platformIncidentAction(api, existing?.id ?? '', next, null),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
    onError: (error) => refresh(error),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (!invalid) save.mutate();
  }

  const failure = save.error ?? publish.error;
  return (
    <section className="tm-cc-card tm-stack" aria-labelledby="tm-incident-editor">
      <div className="tm-stack tm-stack--tight">
        <h2 id="tm-incident-editor" className="tm-cc-card__title">
          {existing ? existing.title : tOr('Incidents.new', 'New incident')}
        </h2>
        <p className="tm-cc-note">
          {tOr(
            'Incidents.publicFieldsNote',
            'Only the title, component, status and write-up are ever shown on the public status page.',
          )}
        </p>
      </div>
      <form className="tm-stack" onSubmit={submit} noValidate>
        <div className="tm-cc-split tm-cc-split--even">
          <Field
            label={tOr('Incidents.fieldTitle', 'Title')}
            hint={tOr('Incidents.fieldTitleHint', 'Say what people notice, not the cause.')}
            value={draft.title}
            maxLength={300}
            onChange={(event) => set('title', event.target.value)}
            {...(tried && errors.title ? { error: required } : {})}
          />
          <Field
            label={tOr('Incidents.fieldComponent', 'Component')}
            value={draft.component}
            maxLength={190}
            onChange={(event) => set('component', event.target.value)}
            {...(tried && errors.component ? { error: required } : {})}
          />
        </div>
        <label className="tm-content-textarea">
          <span className="tm-content-textarea__label">
            {tOr('Incidents.fieldBody', 'Public write-up')}
          </span>
          <textarea
            value={draft.body}
            rows={4}
            maxLength={20_000}
            aria-invalid={tried && errors.body}
            onChange={(event) => set('body', event.target.value)}
          />
          {tried && errors.body ? <span className="tm-cc-note">{required}</span> : null}
        </label>
        <ChipGroup<IncidentSeverity>
          label={tOr('Incidents.fieldSeverity', 'Severity')}
          value={draft.severity}
          onChange={(value) => set('severity', value)}
          options={SEVERITIES.map((value) => ({ value, label: value }))}
        />
        <ChipGroup<IncidentStatus>
          label={tOr('Incidents.fieldStatus', 'Status')}
          value={draft.status}
          onChange={(value) => set('status', value)}
          options={INCIDENT_STATUS_ORDER.map((value) => ({
            value,
            label: tOr(INCIDENT_STATUS_TEXT[value][0], INCIDENT_STATUS_TEXT[value][1]),
          }))}
        />
        <div className="tm-cc-card__head">
          <span className="tm-cc-cell-title">
            {tOr('Incidents.fieldPersonalData', 'Personal data is involved')}
          </span>
          <Switch
            label={
              <VisuallyHidden>
                {tOr('Incidents.fieldPersonalData', 'Personal data is involved')}
              </VisuallyHidden>
            }
            checked={draft.personalData}
            onChange={(event) => set('personalData', event.target.checked)}
          />
        </div>
        <div className="tm-cc-split tm-cc-split--even">
          <Field
            label={tOr('Incidents.fieldCountries', 'Customer countries')}
            hint={tOr('Incidents.fieldCountriesHint', 'Two-letter codes, like EG, SA, AE.')}
            value={draft.countries}
            onChange={(event) => set('countries', event.target.value)}
          />
          <Field
            label={tOr('Incidents.fieldWorkspaces', 'Affected workspace ids')}
            hint={tOr('Incidents.fieldWorkspacesHint', 'Separate ids with commas.')}
            value={draft.affectedOrgIds}
            onChange={(event) => set('affectedOrgIds', event.target.value)}
          />
        </div>
        <div className="tm-cc-split tm-cc-split--even">
          <Field
            label={tOr('Incidents.fieldNotifiedCustomers', 'Customers notified')}
            type="datetime-local"
            value={draft.notifiedCustomersAt}
            onChange={(event) => set('notifiedCustomersAt', event.target.value)}
          />
          <Field
            label={tOr('Incidents.fieldNotifiedAuthority', 'Authority notified')}
            type="datetime-local"
            value={draft.notifiedAuthorityAt}
            onChange={(event) => set('notifiedAuthorityAt', event.target.value)}
          />
        </div>
        <p className="tm-cc-note">
          {tOr(
            'Incidents.resolveHint',
            'Resolving needs the customer and authority notices sent first.',
          )}
        </p>
        <Field
          label={t('PlatformSettings.reasonOptionalLabel')}
          hint={t('PlatformSettings.reasonAuditHint')}
          value={draft.reason}
          maxLength={1000}
          onChange={(event) => set('reason', event.target.value)}
        />
        {failure ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(failure, t)}
          </InlineAlert>
        ) : null}
        <div className="tm-cc-hero__actions">
          <Button type="button" tone="outline" onClick={onDone}>
            {t('PlatformShared.cancel')}
          </Button>
          {existing ? (
            <Button
              type="button"
              tone="outline"
              loading={publish.isPending}
              loadingLabel={t('PlatformShared.working')}
              onClick={() => publish.mutate(existing.published ? 'unpublish' : 'publish')}
            >
              {existing.published
                ? tOr('Incidents.unpublish', 'Remove from status page')
                : tOr('Incidents.publish', 'Show on status page')}
            </Button>
          ) : null}
          <Button
            type="submit"
            tone="ink"
            loading={save.isPending}
            loadingLabel={t('PlatformShared.working')}
          >
            {tOr('Incidents.save', 'Save incident')}
          </Button>
        </div>
      </form>
    </section>
  );
}
