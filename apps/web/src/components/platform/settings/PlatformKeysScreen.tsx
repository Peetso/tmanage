'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, StateCapsule, StatusDot } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import {
  PLATFORM_KEYS_QUERY_KEY,
  fetchPlatformKeys,
  rotatePlatformKey,
  rotationPercent,
} from '../../../lib/api/platform-keys';
import type {
  KeyPurpose,
  KeyPurposeView,
  KeyRotationView,
  PlatformKeysView,
} from '../../../lib/api/platform-keys';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useT } from '../../../lib/i18n/use-t';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { PlatformGate, isStepUpLapse } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import { PlatformDialog, PlatformDialogActions, platformErrorText } from '../shared/ReasonDialog';
import { PLATFORM_ME_QUERY_KEY, missingPlatformPermission } from '../shared/usePlatformPermissions';
import { SettingsSubNav, fill } from './settings-kit';

/**
 * 56-02 · Settings → Keys (`/platform/settings/keys`, frames 442:20173 EN / 442:20443 AR).
 * Status only: which keys are present, the active key per purpose, rotation progress and the
 * "Adding a key" steps. No key value is ever shown and there is no field to type one in — keys
 * live only in the server environment. Rotate queues the worker's re-encrypt job (super admin).
 */

/** English copy; Arabic arrives with the i18n fragment (`PlatformKeys.*`). */
export const KEYS_COPY = {
  title: 'Keys',
  description:
    'Status of the keys that protect stored secrets such as connected-app tokens and two-step seeds. Key values are never shown here and cannot be typed in — they live only in the server environment.',
  viewLog: 'View rotation log',
  loading: 'Loading keys',
  keyring: 'Keyring',
  allPresent: 'All keys present',
  noKeys: 'No keys set',
  fallbackOnly: 'Two-step keys only',
  keyringSub: '{purposes} purposes · {keys} keys loaded from the server',
  noKeysSub: 'Stored secrets cannot be saved until keys are added in the server environment',
  activeKey: 'Active key',
  activeKeySub: 'Used for every new encryption',
  lastRotation: 'Last rotation',
  never: 'Never',
  daysAgo: '{days} days ago · quarterly schedule',
  quarterly: 'Quarterly schedule',
  nextDue: 'Next rotation due',
  nextDueNone: 'After the first rotation',
  nextDueSub: 'Or at once if a key may have leaked',
  inProgress: 'Rotation in progress',
  running: 'Running',
  queued: 'Queued',
  progressLine: '{done} of {total} rows re-encrypted · {percent}%',
  startedLine: 'Started {when} · batches of 500 rows · resumes on its own after a restart',
  queuedLine: 'Queued {when} · batches of 500 rows · starts within a minute',
  removeOld: 'Remove {key} from the server only after rows on the old key reach 0.',
  noRotation: 'No rotation running',
  noRotationBody:
    'Every purpose is on its active key. After a new key is in place, rotate a purpose in the table below.',
  addingTitle: 'Adding a key — Peter only',
  addingLead: 'Keys are never typed into TManage. They live only in the server environment.',
  step1: 'On your computer, create a 32-byte key:',
  step2:
    'In Hostinger hPanel → Node.js app → Environment variables, add it to FIELD_CIPHER_KEYS as a new entry. Leave the old entry in place.',
  step3: 'Redeploy. The new key shows here as “present”.',
  step4: 'Press Rotate on the purpose and confirm with two-step.',
  step5: 'When rows on the old key reach 0, remove the old entry at the next deploy.',
  neverPaste:
    'Never paste a key into TManage, a chat or an e-mail. Keep the offline copy with you.',
  byPurpose: 'Keys by purpose',
  byPurposeSub: 'Rows on the old key must reach 0 before the old key is removed.',
  colPurpose: 'Purpose',
  colActiveKey: 'Active key',
  colKeysInRing: 'Keys in ring',
  colRowsOld: 'Rows on old key',
  colLastRotation: 'Last rotation',
  colAction: 'Action',
  rotatingNow: 'Rotating now · {percent}%',
  rotate: 'Rotate',
  rotating: 'Rotating…',
  hPanelOnly: 'In hPanel only',
  overlap: '24 h overlap',
  purpose_storage_token: 'Connected apps (Drive, OneDrive)',
  purpose_calendar_token: 'Calendars (Google, Outlook)',
  purpose_mfa: 'Two-step sign-in',
  purpose_webhook_secret: 'Webhook signing',
  purpose_scim_token: 'Directory sync (SCIM)',
  purpose_push_key: 'Push notifications',
  purpose_integration_token: 'Integrations',
  purpose_zatca_key: 'E-invoicing (ZATCA)',
  sessions: 'Sign-in sessions',
  footer:
    'Every rotation is recorded in Platform admin actions with your name, IP and device. Key values are never shown, logged or exported.',
  confirmTitle: 'Rotate {purpose}?',
  confirmBody:
    'Every stored secret for this purpose is re-encrypted onto key {key} in batches of 500. It runs in the background and resumes on its own after a restart.',
  confirm: 'Rotate',
  cancel: 'Cancel',
  working: 'Working…',
  arrow: '→',
} as const;

export type KeysCopyName = keyof typeof KEYS_COPY;

function useCopy(): (
  name: KeysCopyName,
  values?: Readonly<Record<string, string | number>>,
) => string {
  const tOr = useTOr();
  return (name, values) => {
    const text = tOr(`PlatformKeys.${name}`, KEYS_COPY[name]);
    return values === undefined ? text : fill(text, values);
  };
}

type Row =
  | { readonly kind: 'purpose'; readonly view: KeyPurposeView }
  | { readonly kind: 'sessions'; readonly keysInRing: number; readonly overlap: boolean };

const GRID: CSSProperties = {
  display: 'grid',
  gap: 'var(--s4)',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
};
const SPLIT: CSSProperties = {
  display: 'grid',
  gap: 'var(--s4)',
  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
  alignItems: 'start',
};
const STEPS: CSSProperties = {
  display: 'grid',
  gap: 'var(--s3)',
  margin: 0,
  paddingInlineStart: 0,
};
const STEP: CSSProperties = { display: 'flex', gap: 'var(--s3)', alignItems: 'flex-start' };
const KEY_LINE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--s2)',
  alignItems: 'center',
};

/** A key id, isolated so it reads left-to-right inside Arabic text. */
function KeyId({ id }: { id: string | null }) {
  if (id === null) return <span>—</span>;
  return (
    <Badge mono>
      <bdi>{id}</bdi>
    </Badge>
  );
}

export function PlatformKeysScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const copy = useCopy();
  return (
    <PlatformGate
      api={api}
      section="settings"
      crumbs={[t('PlatformSettings.crumbSettings'), copy('title')]}
      title={copy('title')}
      description={copy('description')}
      actions={() => (
        <Link
          href="/platform/activity/platform"
          className="tm-button tm-button--outline tm-button--default"
        >
          {copy('viewLog')}
        </Link>
      )}
    >
      {(me) => <KeysBody api={api} me={me} />}
    </PlatformGate>
  );
}

function KeysBody({ api, me }: { api: ApiClient; me: PlatformMeView }) {
  const copy = useCopy();
  const [confirming, setConfirming] = useState<KeyPurposeView | null>(null);
  const keys = useQuery({
    queryKey: PLATFORM_KEYS_QUERY_KEY,
    queryFn: () => fetchPlatformKeys(api),
    // While a rotation runs the progress bar follows the worker's 500-row batches.
    refetchInterval: (query) => (query.state.data?.rotation ? 5_000 : false),
  });

  if (keys.isPending) {
    return (
      <>
        <SettingsSubNav active="keys" />
        <PlatformPageState state="loading" loadingLabel={copy('loading')} />
      </>
    );
  }
  if (keys.isError) {
    const missing = missingPlatformPermission(keys.error);
    return (
      <>
        <SettingsSubNav active="keys" />
        {missing !== null ? (
          <PlatformPageState state="forbidden" permission={missing} preset={me.preset} />
        ) : (
          <PlatformPageState state="error" error={keys.error} onRetry={() => void keys.refetch()} />
        )}
      </>
    );
  }

  const view = keys.data;
  return (
    <div className="tm-stack">
      <SettingsSubNav active="keys" />
      <StatusCards view={view} />
      <div style={SPLIT}>
        <RotationCard view={view} />
        <AddingKeyCard />
      </div>
      <PurposeTable
        view={view}
        canRotate={me.preset === 'super_admin'}
        onRotate={(purpose) => setConfirming(purpose)}
      />
      <p className="tm-cc-note">{copy('footer')}</p>
      {confirming !== null ? (
        <RotateDialog
          api={api}
          purpose={confirming}
          toKeyId={view.activeKeyId}
          onClose={() => setConfirming(null)}
        />
      ) : null}
    </div>
  );
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="tm-cc-card tm-stack tm-stack--tight">
      <p className="tm-cc-eyebrow">{label}</p>
      {children}
    </section>
  );
}

function StatusCards({ view }: { view: PlatformKeysView }) {
  const copy = useCopy();
  const fmt = useDisplayFormatters();
  const loaded = view.purposes.filter((purpose) => purpose.keysInRing > 0).length;
  const keyCount = view.keyIds.length;
  const days =
    view.lastRotationAt === null
      ? null
      : Math.max(
          0,
          Math.floor((Date.now() - new Date(view.lastRotationAt).getTime()) / 86_400_000),
        );
  const status = view.enabled ? (
    <StatusDot tone="success">{copy('allPresent')}</StatusDot>
  ) : view.mfaFallback ? (
    <StatusDot tone="warning">{copy('fallbackOnly')}</StatusDot>
  ) : (
    <StatusDot tone="danger">{copy('noKeys')}</StatusDot>
  );
  return (
    <div style={GRID}>
      <Metric label={copy('keyring')}>
        {status}
        <p className="tm-cc-cell-sub">
          {view.enabled
            ? copy('keyringSub', { purposes: fmt.number(loaded), keys: fmt.number(keyCount) })
            : copy('noKeysSub')}
        </p>
      </Metric>
      <Metric label={copy('activeKey')}>
        <div>
          <KeyId id={view.activeKeyId} />
        </div>
        <p className="tm-cc-cell-sub">{copy('activeKeySub')}</p>
      </Metric>
      <Metric label={copy('lastRotation')}>
        <p className="tm-cc-metric__value">
          {view.lastRotationAt === null ? copy('never') : fmt.day(view.lastRotationAt)}
        </p>
        <p className="tm-cc-cell-sub">
          {days === null ? copy('quarterly') : copy('daysAgo', { days: fmt.number(days) })}
        </p>
      </Metric>
      <Metric label={copy('nextDue')}>
        <p className="tm-cc-metric__value">
          {view.nextRotationDueAt === null ? copy('nextDueNone') : fmt.day(view.nextRotationDueAt)}
        </p>
        <p className="tm-cc-cell-sub">{copy('nextDueSub')}</p>
      </Metric>
    </div>
  );
}

function purposeName(copy: ReturnType<typeof useCopy>, purpose: string): string {
  const name = `purpose_${purpose}`;
  return name in KEYS_COPY ? copy(name as KeysCopyName) : purpose;
}

function RotationCard({ view }: { view: PlatformKeysView }) {
  const copy = useCopy();
  const fmt = useDisplayFormatters();
  const rotation: KeyRotationView | null = view.rotation;
  if (rotation === null) {
    return (
      <section className="tm-cc-card tm-stack">
        <h2 className="tm-cc-card__title">{copy('noRotation')}</h2>
        <p className="tm-cc-cell-sub">{copy('noRotationBody')}</p>
      </section>
    );
  }
  const percent = rotationPercent(rotation);
  const running = rotation.status === 'running';
  const when = rotation.startedAt ?? rotation.createdAt;
  return (
    <section className="tm-cc-card tm-stack">
      <div className="tm-cc-card__head">
        <h2 className="tm-cc-card__title">{copy('inProgress')}</h2>
        <StateCapsule state={running ? 'current' : 'waiting'}>
          {running ? copy('running') : copy('queued')}
        </StateCapsule>
      </div>
      <p style={KEY_LINE}>
        <span>{purposeName(copy, rotation.purpose)} ·</span>
        {rotation.fromKeyId !== null ? (
          <>
            <KeyId id={rotation.fromKeyId} />
            <span aria-hidden="true">{copy('arrow')}</span>
          </>
        ) : null}
        <KeyId id={rotation.toKeyId} />
      </p>
      <span
        className="tm-cc-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={copy('inProgress')}
      >
        <span className="tm-cc-bar__fill" style={{ inlineSize: `${percent}%` }} />
      </span>
      <p>
        {copy('progressLine', {
          done: fmt.number(rotation.rowsProcessed),
          total: fmt.number(rotation.rowsTotal),
          percent: fmt.number(percent),
        })}
      </p>
      <p className="tm-cc-cell-sub">
        {copy(running ? 'startedLine' : 'queuedLine', {
          when: when === null ? '—' : fmt.dateTime(when),
        })}
      </p>
      {rotation.fromKeyId !== null ? (
        <InlineAlert tone="neutral">
          {copy('removeOld', { key: `⁨${rotation.fromKeyId}⁩` })}
        </InlineAlert>
      ) : null}
    </section>
  );
}

function AddingKeyCard() {
  const copy = useCopy();
  const steps: readonly ReactNode[] = [
    <>
      {copy('step1')}{' '}
      <Badge mono>
        <bdi>openssl rand -base64 32</bdi>
      </Badge>
    </>,
    copy('step2'),
    copy('step3'),
    copy('step4'),
    copy('step5'),
  ];
  return (
    <section className="tm-cc-card tm-stack">
      <h2 className="tm-cc-card__title">{copy('addingTitle')}</h2>
      <p className="tm-cc-card__lead">{copy('addingLead')}</p>
      <ol style={STEPS}>
        {steps.map((step, index) => (
          <li key={index} style={STEP}>
            <Badge>{index + 1}</Badge>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <InlineAlert tone="warning">{copy('neverPaste')}</InlineAlert>
    </section>
  );
}

function PurposeTable({
  view,
  canRotate,
  onRotate,
}: {
  view: PlatformKeysView;
  canRotate: boolean;
  onRotate: (purpose: KeyPurposeView) => void;
}) {
  const copy = useCopy();
  const fmt = useDisplayFormatters();
  const rows: Row[] = [
    ...view.purposes.map((purpose): Row => ({ kind: 'purpose', view: purpose })),
    { kind: 'sessions', keysInRing: view.sessions.keysInRing, overlap: view.sessions.overlap },
  ];
  return (
    <section className="tm-stack tm-stack--tight">
      <h2 className="tm-cc-card__title">{copy('byPurpose')}</h2>
      <p className="tm-cc-cell-sub">{copy('byPurposeSub')}</p>
      <PlatformTable<Row>
        label={copy('byPurpose')}
        rows={rows}
        rowKey={(row) => (row.kind === 'sessions' ? 'sessions' : row.view.purpose)}
        columns={[
          {
            id: 'purpose',
            header: copy('colPurpose'),
            cell: (row) =>
              row.kind === 'sessions' ? copy('sessions') : purposeName(copy, row.view.purpose),
          },
          {
            id: 'active',
            header: copy('colActiveKey'),
            cell: (row) => (row.kind === 'sessions' ? '—' : <KeyId id={row.view.activeKeyId} />),
          },
          {
            id: 'ring',
            header: copy('colKeysInRing'),
            kind: 'mono',
            cell: (row) =>
              fmt.number(row.kind === 'sessions' ? row.keysInRing : row.view.keysInRing),
          },
          {
            id: 'old',
            header: copy('colRowsOld'),
            kind: 'mono',
            cell: (row) =>
              row.kind === 'sessions' || row.view.rowsOnOldKey === null
                ? '—'
                : fmt.number(row.view.rowsOnOldKey),
          },
          {
            id: 'last',
            header: copy('colLastRotation'),
            cell: (row) => <LastRotation row={row} />,
          },
          {
            id: 'action',
            header: copy('colAction'),
            cell: (row) => {
              if (row.kind === 'sessions') {
                return (
                  <Button type="button" tone="outline" size="compact" disabled>
                    {copy('hPanelOnly')}
                  </Button>
                );
              }
              if (!row.view.rotatable) return null;
              if (row.view.rotation !== null) {
                return (
                  <Button type="button" tone="outline" size="compact" disabled>
                    {copy('rotating')}
                  </Button>
                );
              }
              return (
                <Button
                  type="button"
                  tone="outline"
                  size="compact"
                  disabled={!canRotate || row.view.keysInRing < 2}
                  onClick={() => onRotate(row.view)}
                >
                  {copy('rotate')}
                </Button>
              );
            },
          },
        ]}
      />
    </section>
  );
}

function LastRotation({ row }: { row: Row }) {
  const copy = useCopy();
  const fmt = useDisplayFormatters();
  if (row.kind === 'sessions') {
    return <span className="tm-cc-cell-sub">{row.overlap ? copy('overlap') : '—'}</span>;
  }
  const rotation = row.view.rotation;
  if (rotation !== null) {
    return (
      <span className="tm-cc-cell-sub">
        {copy('rotatingNow', { percent: fmt.number(rotationPercent(rotation)) })}
      </span>
    );
  }
  return (
    <span className="tm-cc-cell-sub">
      {row.view.lastRotationAt === null ? '—' : fmt.day(row.view.lastRotationAt)}
    </span>
  );
}

function RotateDialog({
  api,
  purpose,
  toKeyId,
  onClose,
}: {
  api: ApiClient;
  purpose: KeyPurposeView;
  toKeyId: string | null;
  onClose: () => void;
}) {
  const copy = useCopy();
  const t = useT();
  const queryClient = useQueryClient();
  const rotate = useMutation({
    mutationFn: (key: KeyPurpose) => rotatePlatformKey(api, key),
    onSuccess: (view) => {
      queryClient.setQueryData(PLATFORM_KEYS_QUERY_KEY, view);
      onClose();
    },
    onError: (error) => {
      if (isStepUpLapse(error))
        void queryClient.invalidateQueries({ queryKey: PLATFORM_ME_QUERY_KEY });
    },
  });
  const name = purposeName(copy, purpose.purpose);
  return (
    <PlatformDialog title={copy('confirmTitle', { purpose: name })} onClose={onClose}>
      <p>{copy('confirmBody', { key: `⁨${toKeyId ?? '—'}⁩` })}</p>
      {rotate.isError ? (
        <InlineAlert tone="danger" live>
          {platformErrorText(rotate.error, t)}
        </InlineAlert>
      ) : null}
      <PlatformDialogActions>
        <Button type="button" tone="outline" onClick={onClose}>
          {copy('cancel')}
        </Button>
        <Button
          type="button"
          tone="ink"
          loading={rotate.isPending}
          loadingLabel={copy('working')}
          onClick={() => rotate.mutate(purpose.purpose)}
        >
          {copy('confirm')}
        </Button>
      </PlatformDialogActions>
    </PlatformDialog>
  );
}
