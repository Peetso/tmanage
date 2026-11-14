'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import {
  CAPABILITIES,
  MATRIX_AREAS,
  capabilityCell,
  isInternalOnlyCapability,
} from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { fetchPersonProfile } from '../../lib/api/person-profile';
import {
  readEffectivePermissions,
  readMemberOverrides,
  readRolesMatrix,
  replaceMemberOverrides,
} from '../../lib/api/permission-matrix';
import type { EffectivePermissions, MemberOverrideInput } from '../../lib/api/permission-matrix';
import {
  fetchPlatformMemberPermissions,
  replacePlatformMemberOverrides,
} from '../../lib/api/platform-permissions';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { PlatformGate } from '../platform/shared/platform-kit';
import { PlatformPageState } from '../platform/shared/PlatformPageState';
import { missingPlatformPermission } from '../platform/shared/usePlatformPermissions';
import { EffectivePermissionsPanel } from './EffectivePermissionsPanel';
import { capabilitySentence } from './PermissionMatrix';
import { capabilityCellLabel, fill, roleLabel } from './RoleMatrixEditor';
import '../../styles/screens/permission-editor.css';

/**
 * platform-admin v2 · PA-04 — D8 member permission overrides + "what can this person do"
 * (Figma `439:22016`; owner state `439:22713`).
 *
 * Left: the effective matrix (read only, coloured by why), with "Simulate on project". Right: the
 * person's overrides — capability, allow/deny, reason, expiry, who; expired ones greyed — and
 * "Add override" (permission by area, allow/deny, optional end date, reason). "Save overrides"
 * replaces the set in one call; the server re-checks every rule. An owner takes no overrides; a
 * client contact sees no internal-only cells and takes none either.
 */

type T = ReturnType<typeof useT>;

export interface OverrideRow {
  readonly id: string;
  readonly capability: Capability;
  readonly effect: 'allow' | 'deny';
  readonly reason: string | null;
  readonly expiresAt: string | null;
  readonly createdByName?: string | null;
  readonly createdAt?: string;
  readonly live: boolean;
}

export interface MemberPerson {
  readonly displayName: string;
  readonly roleName: string;
  readonly custom: boolean;
  readonly scope: 'org' | 'workspace' | 'projects';
  readonly kind: 'internal' | 'client';
  readonly isOwner: boolean;
}

export interface MemberOverridesBodyProps {
  readonly person: MemberPerson;
  readonly overrides: readonly OverrideRow[];
  readonly effective: EffectivePermissions;
  readonly projectOptions: readonly { readonly id: string; readonly name: string }[];
  readonly projectId: string | null;
  readonly onSimulate: (projectId: string | null) => void;
  readonly withReason: boolean;
  readonly saving: boolean;
  readonly saveError: unknown;
  readonly onSave: (overrides: readonly MemberOverrideInput[], reason: string) => Promise<unknown>;
  /** The viewer may look but not change (no edit permission). */
  readonly readOnly?: boolean;
}

/** "Role: Delivery lead (custom) · Scope: projects they are on · 3 live overrides, 1 expired". */
export function memberSubtitle(t: T, person: MemberPerson, rows: readonly OverrideRow[]): string {
  const live = rows.filter((row) => row.live).length;
  const expired = rows.length - live;
  const role = person.custom
    ? fill(t('PermissionEditor.member.customRole'), { role: person.roleName })
    : roleLabel(t, person.roleName);
  const parts = [
    fill(t('PermissionEditor.member.role'), { role }),
    t(`PermissionEditor.member.scope.${person.scope}` as MessageKey),
  ];
  if (person.isOwner) parts.push(t('PermissionEditor.member.ownerNote'));
  else if (person.kind === 'internal') {
    parts.push(
      expired > 0
        ? fill(t('PermissionEditor.member.liveExpired'), { live, expired })
        : fill(t('PermissionEditor.member.live'), { live }),
    );
  }
  return parts.join(' · ');
}

function dateLabel(iso: string | null, locale: string): string | null {
  if (iso === null) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(at);
}

/** The end of the chosen day, in the viewer's zone, as an ISO instant. */
export function endOfDayIso(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const at = new Date(`${day}T23:59:59`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** The overrides the save sends: every live row, as the server knows it. */
export function toInputs(rows: readonly OverrideRow[]): MemberOverrideInput[] {
  return rows
    .filter((row) => row.live)
    .map((row) => ({
      capability: row.capability,
      effect: row.effect,
      reason: row.reason,
      expiresAt: row.expiresAt,
    }));
}

export function MemberOverridesBody({
  person,
  overrides,
  effective,
  projectOptions,
  projectId,
  onSimulate,
  withReason,
  saving,
  saveError,
  onSave,
  readOnly = false,
}: MemberOverridesBodyProps) {
  const t = useT();
  const locale = useActiveLocale();
  const [draft, setDraft] = useState<readonly OverrideRow[]>(overrides);
  const [capability, setCapability] = useState<Capability | ''>('');
  const [effect, setEffect] = useState<'allow' | 'deny'>('allow');
  const [ends, setEnds] = useState('');
  const [rowReason, setRowReason] = useState('');
  const [saveReason, setSaveReason] = useState('');

  useEffect(() => setDraft(overrides), [overrides]);

  const editable = !readOnly && !person.isOwner && person.kind === 'internal';
  const dirty =
    JSON.stringify(toInputs(draft)) !== JSON.stringify(toInputs(overrides)) ||
    draft.length !== overrides.length;
  const liveCount = draft.filter((row) => row.live).length;

  const options = useMemo(
    () =>
      MATRIX_AREAS.map((area) => ({
        area,
        capabilities: CAPABILITIES.filter(
          (cap) =>
            capabilityCell(cap)?.area === area &&
            (person.kind === 'internal' || !isInternalOnlyCapability(cap)),
        ),
      })).filter((group) => group.capabilities.length > 0),
    [person.kind],
  );

  const add = () => {
    if (capability === '') return;
    const expiresAt = ends === '' ? null : endOfDayIso(ends);
    const row: OverrideRow = {
      id: `new:${capability}`,
      capability,
      effect,
      reason: rowReason.trim() === '' ? null : rowReason.trim(),
      expiresAt,
      createdByName: null,
      live: true,
    };
    setDraft((current) => [...current.filter((entry) => entry.capability !== capability), row]);
    setCapability('');
    setEnds('');
    setRowReason('');
  };

  const meta = (row: OverrideRow) => {
    const bits: string[] = [capabilitySentence(t, row.capability)];
    if (row.reason) bits.push(`“${row.reason}”`);
    const end = dateLabel(row.expiresAt, locale);
    if (!row.live) bits.push(fill(t('PermissionEditor.overrides.expiredOn'), { date: end ?? '' }));
    else
      bits.push(
        end
          ? fill(t('PermissionEditor.overrides.until'), { date: end })
          : t('PermissionEditor.overrides.noEnd'),
      );
    if (row.createdByName) bits.push(row.createdByName);
    return bits.join(' · ');
  };

  return (
    <div className="tm-pe">
      {person.isOwner ? (
        <InlineAlert tone="warning" title={t('PermissionEditor.owner.title')}>
          {t('PermissionEditor.owner.body')}
        </InlineAlert>
      ) : null}
      {person.kind === 'client' ? (
        <InlineAlert tone="neutral" title={t('PermissionEditor.client.title')}>
          {t('PermissionEditor.client.body')}
        </InlineAlert>
      ) : null}

      <div className="tm-pe__layout">
        <EffectivePermissionsPanel
          effective={effective.permissions}
          projectOptions={projectOptions}
          projectId={projectId}
          onSimulate={onSimulate}
          roleName={person.custom ? person.roleName : roleLabel(t, person.roleName)}
        />

        <div className="tm-pe__aside">
          <section className="tm-cc-card tm-stack" aria-labelledby="tm-pe-overrides-title">
            <h2 id="tm-pe-overrides-title" className="tm-cc-card__title">
              {editable
                ? fill(t('PermissionEditor.overrides.title'), { count: liveCount })
                : t('PermissionEditor.overrides.titlePlain')}
            </h2>
            <p className="tm-cc-card__body">
              {person.isOwner
                ? t('PermissionEditor.overrides.ownerSub')
                : t('PermissionEditor.overrides.sub')}
            </p>
            {draft.length === 0 ? (
              <p className="tm-cc-note">
                {person.isOwner
                  ? t('PermissionEditor.overrides.ownerEmpty')
                  : t('PermissionEditor.overrides.empty')}
              </p>
            ) : (
              <ul className="tm-pe__diff" data-testid="override-list">
                {draft.map((row) => (
                  <li
                    key={row.id}
                    className="tm-pe__override"
                    data-expired={row.live ? undefined : 'true'}
                    data-capability={row.capability}
                    data-effect={row.effect}
                  >
                    <div className="tm-pe__override-head">
                      <span
                        className={`tm-pe__dot tm-pe__dot--${row.live ? row.effect : 'expired'}`}
                        aria-hidden="true"
                      />
                      <span className="tm-pe__effect">
                        {row.live
                          ? t(`PermissionEditor.overrides.${row.effect}` as MessageKey)
                          : t('PermissionEditor.overrides.expired')}
                      </span>
                      <span>{capabilityCellLabel(t, row.capability)}</span>
                      {editable ? (
                        <Button
                          type="button"
                          tone="text"
                          size="compact"
                          aria-label={fill(t('PermissionEditor.overrides.removeLabel'), {
                            permission: capabilityCellLabel(t, row.capability),
                          })}
                          onClick={() =>
                            setDraft((current) => current.filter((entry) => entry.id !== row.id))
                          }
                        >
                          {row.live
                            ? t('PermissionEditor.overrides.remove')
                            : t('PermissionEditor.overrides.clear')}
                        </Button>
                      ) : null}
                    </div>
                    <p className="tm-pe__override-meta">
                      <bdi>{meta(row)}</bdi>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section
            className={`tm-cc-card tm-stack${editable ? '' : ' tm-pe__disabled'}`}
            aria-labelledby="tm-pe-add-title"
          >
            <h2 id="tm-pe-add-title" className="tm-cc-card__title">
              {t('PermissionEditor.add.title')}
            </h2>
            <Select
              label={t('PermissionEditor.add.permission')}
              value={capability}
              disabled={!editable}
              onChange={(event) => setCapability(event.currentTarget.value as Capability | '')}
            >
              <option value="">{t('PermissionEditor.add.choose')}</option>
              {options.map((group) => (
                <optgroup
                  key={group.area}
                  label={t(`PermissionMatrix.area.${group.area}` as MessageKey)}
                >
                  {group.capabilities.map((cap) => (
                    <option key={cap} value={cap}>
                      {capabilityCellLabel(t, cap)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
            <div
              className="tm-pe__segmented"
              role="group"
              aria-label={t('PermissionEditor.add.effect')}
            >
              {(['allow', 'deny'] as const).map((choice) => (
                <Button
                  key={choice}
                  type="button"
                  tone="outline"
                  size="compact"
                  aria-pressed={effect === choice}
                  disabled={!editable}
                  onClick={() => setEffect(choice)}
                >
                  {t(`PermissionEditor.overrides.${choice}` as MessageKey)}
                </Button>
              ))}
            </div>
            <Field
              type="date"
              label={t('PermissionEditor.add.ends')}
              name="override-ends"
              value={ends}
              disabled={!editable}
              onChange={(event) => setEnds(event.currentTarget.value)}
            />
            <Field
              label={t('PermissionEditor.add.reason')}
              name="override-reason"
              value={rowReason}
              maxLength={500}
              disabled={!editable}
              onChange={(event) => setRowReason(event.currentTarget.value)}
            />
            <div className="tm-pe__actions">
              <Button
                type="button"
                tone="outline"
                disabled={!editable || capability === ''}
                onClick={add}
              >
                {t('PermissionEditor.add.button')}
              </Button>
            </div>
          </section>

          {withReason && editable ? (
            <Field
              label={t('PermissionEditor.reasonOptional')}
              name="overrides-reason"
              value={saveReason}
              maxLength={500}
              onChange={(event) => setSaveReason(event.currentTarget.value)}
            />
          ) : null}
          {saveError ? (
            <InlineAlert tone="danger" title={t('PermissionEditor.saveFailed')} live>
              {saveError instanceof ApiRequestError
                ? saveError.message
                : t('PermissionEditor.errorGeneric')}
            </InlineAlert>
          ) : null}
          <div className="tm-pe__actions">
            <Button
              type="button"
              tone="ink"
              disabled={!editable || !dirty}
              loading={saving}
              loadingLabel={t('PermissionEditor.saving')}
              onClick={() => void onSave(toInputs(draft), saveReason.trim())}
            >
              {t('PermissionEditor.overrides.save')}
            </Button>
            <Button
              type="button"
              tone="text"
              disabled={!dirty || saving}
              onClick={() => setDraft(overrides)}
            >
              {t('PermissionEditor.discard')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <LoadingRegion label={label}>
      <Skeleton height="var(--row)" />
      <Skeleton height="var(--row)" />
      <Skeleton height="var(--row)" />
    </LoadingRegion>
  );
}

// ── Organization side: /{orgSlug}/people/[membershipId]/permissions ─────────

export interface OrgMemberOverridesScreenProps {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly membershipId: string;
  readonly client?: ApiClient;
}

export function MemberOverridesScreen({
  organizationSlug,
  organizationName,
  membershipId,
  client,
}: OrgMemberOverridesScreenProps) {
  const t = useT();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState<string | null>(null);

  const profile = useQuery({
    queryKey: ['person-profile', organizationSlug, membershipId],
    queryFn: () => fetchPersonProfile(api, organizationSlug, membershipId),
  });
  const overrides = useQuery({
    queryKey: ['member-overrides', organizationSlug, membershipId],
    queryFn: () => readMemberOverrides(api, organizationSlug, membershipId),
  });
  const effective = useQuery({
    queryKey: ['member-effective', organizationSlug, membershipId, projectId],
    queryFn: () =>
      readEffectivePermissions(api, organizationSlug, membershipId, projectId ?? undefined),
  });
  const roles = useQuery({
    queryKey: ['roles-matrix', organizationSlug],
    queryFn: () => readRolesMatrix(api, organizationSlug),
    retry: false,
  });
  const save = useMutation({
    mutationFn: (list: readonly MemberOverrideInput[]) =>
      replaceMemberOverrides(api, organizationSlug, membershipId, list),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['member-overrides', organizationSlug, membershipId],
      });
      await queryClient.invalidateQueries({
        queryKey: ['member-effective', organizationSlug, membershipId],
      });
    },
  });

  const name = profile.data?.displayName ?? '';
  const role = overrides.data?.role ?? profile.data?.role ?? '';
  const customName = roles.data?.roles.find((entry) => entry.id === role && !entry.builtIn)?.name;
  const person: MemberPerson = {
    displayName: name,
    roleName: customName ?? role,
    custom: customName !== undefined,
    scope: role === 'owner' || role === 'org_admin' ? 'org' : 'projects',
    kind: 'internal',
    isOwner: role === 'owner',
  };
  const rows: readonly OverrideRow[] = overrides.data?.overrides ?? [];
  const error = overrides.error ?? effective.error ?? profile.error;

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="members"
      crumbs={[t('PermissionEditor.crumbPeople'), name, t('PermissionEditor.crumbPermissions')]}
      title={
        name
          ? fill(t('PermissionEditor.member.title'), { name })
          : t('PermissionEditor.member.titleLoading')
      }
      description={overrides.data ? memberSubtitle(t, person, rows) : undefined}
      actions={
        <>
          <Link
            className="tm-button tm-button--outline tm-button--default"
            href={`/${organizationSlug}/people/${membershipId}`}
          >
            {t('PermissionEditor.member.openProfile')}
          </Link>
          <Link
            className="tm-button tm-button--outline tm-button--default"
            href={`/${organizationSlug}/people`}
          >
            {t('PermissionEditor.member.changeRole')}
          </Link>
        </>
      }
    >
      {error ? (
        <InlineAlert tone="danger" title={t('PermissionEditor.loadFailed')} live>
          {error instanceof ApiRequestError ? error.message : t('PermissionEditor.errorGeneric')}
        </InlineAlert>
      ) : null}
      {!error && (overrides.isPending || effective.isPending) ? (
        <Loading label={t('PermissionEditor.loading')} />
      ) : null}
      {overrides.data && effective.data ? (
        <MemberOverridesBody
          person={person}
          overrides={rows}
          effective={effective.data}
          projectOptions={(profile.data?.projects ?? []).map((project) => ({
            id: project.projectId,
            name: project.name,
          }))}
          projectId={projectId}
          onSimulate={setProjectId}
          withReason={false}
          saving={save.isPending}
          saveError={save.error}
          onSave={(list) => save.mutateAsync(list).catch(() => undefined)}
        />
      ) : null}
    </ControlCenterShell>
  );
}

// ── Platform side: /platform/organizations/[organizationId]/members/[membershipId]/permissions ─

export function PlatformMemberOverridesScreen({
  organizationId,
  membershipId,
  client,
}: {
  organizationId: string;
  membershipId: string;
  client?: ApiClient;
}) {
  const t = useT();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState<string | null>(null);
  const key = ['platform-member-permissions', organizationId, membershipId, projectId] as const;
  const view = useQuery({
    queryKey: key,
    queryFn: () =>
      fetchPlatformMemberPermissions(api, organizationId, membershipId, projectId ?? undefined),
  });
  const save = useMutation({
    mutationFn: (input: { list: readonly MemberOverrideInput[]; reason: string }) =>
      replacePlatformMemberOverrides(
        api,
        organizationId,
        membershipId,
        input.list,
        input.reason || undefined,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['platform-member-permissions', organizationId, membershipId],
      });
    },
  });
  const data = view.data;
  const person: MemberPerson | null = data
    ? {
        displayName: data.displayName,
        roleName: data.roleName,
        custom: data.roleName !== data.role,
        scope: data.scope,
        kind: data.kind,
        isOwner: data.kind === 'internal' && data.role === 'owner',
      }
    : null;

  return (
    <PlatformGate
      api={api}
      section="organizations"
      crumbs={[
        t('PermissionEditor.crumbOrganizations'),
        data?.organizationName ?? '…',
        t('PermissionEditor.crumbMembers'),
        data?.displayName ?? '…',
        t('PermissionEditor.crumbPermissions'),
      ]}
      title={
        data
          ? fill(t('PermissionEditor.member.title'), { name: data.displayName })
          : t('PermissionEditor.member.titleLoading')
      }
      {...(data && person ? { description: memberSubtitle(t, person, data.overrides) } : {})}
      actions={() =>
        data ? (
          <>
            <Link
              className="tm-button tm-button--outline tm-button--default"
              href={`/platform/people/${data.userId}`}
            >
              {t('PermissionEditor.member.openProfile')}
            </Link>
            <Link
              className="tm-button tm-button--outline tm-button--default"
              href={`/platform/organizations/${organizationId}/members`}
            >
              {t('PermissionEditor.member.changeRole')}
            </Link>
          </>
        ) : null
      }
    >
      {(me) => {
        if (view.isPending)
          return <PlatformPageState state="loading" loadingLabel={t('PermissionEditor.loading')} />;
        if (view.isError) {
          const missing = missingPlatformPermission(view.error);
          if (missing !== null) {
            return <PlatformPageState state="forbidden" permission={missing} preset={me.preset} />;
          }
          return (
            <PlatformPageState
              state="error"
              error={view.error}
              onRetry={() => void view.refetch()}
            />
          );
        }
        if (!data || !person) return null;
        const canEdit = me.permissions.includes('platform.permissions.edit');
        return (
          <MemberOverridesBody
            person={person}
            readOnly={!canEdit || !data.editable}
            overrides={data.overrides}
            effective={data.effective}
            projectOptions={data.projects}
            projectId={projectId}
            onSimulate={setProjectId}
            withReason
            saving={save.isPending}
            saveError={save.error}
            onSave={(list, reason) => save.mutateAsync({ list, reason }).catch(() => undefined)}
          />
        );
      }}
    </PlatformGate>
  );
}
