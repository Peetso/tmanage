'use client';

import { useId, useState } from 'react';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import {
  revokeAgentKey,
  revokeAiEmployeeConnector,
  rotateAgentKey,
  type AiEmployeeConnectionView,
  type AiEmployeeView,
  type CreatedAgentKeyView,
} from '../../lib/api/ai-employees';
import type { ApiClient } from '../../lib/api/client';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useTOr } from '../../lib/i18n/use-t-or';
import { fill } from '../people/ChangeRoleDialog';
import { LockIcon } from '../work/work-icons';
import { AiDialogFrame, AiDialogHead, ConfirmDialog } from './AiDialog';
import { CopyField } from './AiField';
import { ConnectPanel, type ConnectChoice } from './ConnectPanel';
import { SparkIcon } from './ai-icons';
import { useAiConnections, useAiRefresh } from './use-ai-employees';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "4 minutes ago", "2 hours ago", "in 58 days": the nearest whole unit, in the active locale. */
function useDistance(now: number): (iso: string, future?: boolean) => string {
  const fmt = useDisplayFormatters();
  return (iso, future = false) => {
    const gap = Math.abs(Date.parse(iso) - now);
    const sign = future ? 1 : -1;
    if (gap < HOUR) return fmt.relative(sign * Math.max(1, Math.round(gap / MINUTE)), 'minute');
    if (gap < DAY) return fmt.relative(sign * Math.round(gap / HOUR), 'hour');
    return fmt.relative(sign * Math.round(gap / DAY), 'day');
  };
}

export type ConnectionDialog =
  | { readonly kind: 'revoke'; readonly connectionId: string }
  | { readonly kind: 'rotated'; readonly key: CreatedAgentKeyView }
  | { readonly kind: 'add' };

/**
 * S6b Connections (Figma `956:1350`): "2 of 3 connections", Add connection, and the table
 * (connection, added by, last used, expires, Rotate for a key, Revoke). S6d asks before a revoke,
 * S6f shows a rotated key once, S6g is the none-yet state with Connect.
 */
export function AiProfileConnections({
  api,
  organizationSlug,
  ai,
  dialog,
  onDialog,
  now = Date.now(),
  addressOverride,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly ai: AiEmployeeView;
  readonly dialog: ConnectionDialog | null;
  readonly onDialog: (dialog: ConnectionDialog | null) => void;
  /** Stories: a fixed clock, so "4 minutes ago" does not drift. */
  readonly now?: number;
  readonly addressOverride?: string;
}) {
  const tOr = useTOr();
  const fmt = useDisplayFormatters();
  const distance = useDistance(now);
  const refresh = useAiRefresh(organizationSlug);
  const list = useAiConnections(api, organizationSlug, ai.id);
  const [rotateFailed, setRotateFailed] = useState<string | null>(null);
  const name = ai.displayName;
  const editable = list.data?.canCreate ?? ai.canEdit;

  const rotate = async (connection: AiEmployeeConnectionView) => {
    setRotateFailed(null);
    try {
      const key = await rotateAgentKey(api, organizationSlug, ai.id, connection.id, {
        name: connection.name,
        lifetimeDays: 90,
      });
      refresh();
      onDialog({ kind: 'rotated', key });
    } catch {
      setRotateFailed(connection.id);
    }
  };

  const revoking =
    dialog?.kind === 'revoke'
      ? list.data?.connections.find((connection) => connection.id === dialog.connectionId)
      : undefined;

  let body;
  if (list.isPending) {
    body = (
      <LoadingRegion label={tOr('AiWizard.loading', 'Loading…')}>
        <Skeleton height="var(--app-row)" />
        <Skeleton height="var(--app-row)" />
      </LoadingRegion>
    );
  } else if (list.isError) {
    body = (
      <InlineAlert tone="danger">
        {tOr('AiProfile.connectionsFailed', 'Connections could not be loaded. Reload the page.')}
      </InlineAlert>
    );
  } else if (list.data.connections.length === 0) {
    body = (
      <section className="tm-aie-panel tm-aie-none" aria-labelledby="tm-aie-none">
        <span className="tm-aie-none__icon" aria-hidden="true">
          <SparkIcon />
        </span>
        <h2 id="tm-aie-none" className="tm-aie-panel__title">
          {fill(tOr('AiProfile.noneTitle', '{name} isn’t connected yet'), { name })}
        </h2>
        <p className="tm-aie-quiet">
          {fill(
            tOr(
              'AiProfile.noneBody',
              'Connect {name}’s agent with Claude or an agent key. Until then, no work can be given to {name}.',
            ),
            { name },
          )}
        </p>
        {editable ? (
          <Button type="button" tone="lime" size="large" onClick={() => onDialog({ kind: 'add' })}>
            {tOr('AiProfile.connect', 'Connect')}
          </Button>
        ) : null}
      </section>
    );
  } else {
    const data = list.data;
    body = (
      <>
        <div className="tm-aie-conn-head">
          <p className="tm-aie-quiet">
            {fill(tOr('AiProfile.connectionCount', '{live} of {limit} connections'), {
              live: fmt.number(data.live),
              limit: fmt.number(data.limit),
            })}
          </p>
          {data.canCreate && data.live < data.limit ? (
            <Button
              type="button"
              tone="outline"
              size="header"
              onClick={() => onDialog({ kind: 'add' })}
            >
              {tOr('AiProfile.addConnection', 'Add connection')}
            </Button>
          ) : null}
        </div>
        <div className="tm-aie-table-frame">
          <table
            className="tm-aie-conn"
            aria-label={fill(tOr('AiProfile.connectionsOf', 'Connections of {name}'), { name })}
          >
            <thead>
              <tr>
                <th scope="col">{tOr('AiProfile.colConnection', 'Connection')}</th>
                <th scope="col">{tOr('AiProfile.colAddedBy', 'Added by')}</th>
                <th scope="col">{tOr('AiProfile.colLastUsed', 'Last used')}</th>
                <th scope="col">{tOr('AiProfile.colExpires', 'Expires')}</th>
                <th scope="col">
                  <span className="tm-visually-hidden">
                    {tOr('AiProfile.colActions', 'Actions')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.connections.map((connection) => (
                <tr key={connection.id} data-live={connection.live || undefined}>
                  <th scope="row">
                    <span className="tm-aie-conn__name">
                      <span className="tm-aie-conn__icon" aria-hidden="true">
                        {connection.kind === 'key' ? <LockIcon /> : <SparkIcon />}
                      </span>
                      <span>
                        <span className="tm-aie-conn__title">{connection.name}</span>
                        <span
                          className="tm-aie-conn__sub"
                          dir={connection.kind === 'key' ? 'ltr' : undefined}
                        >
                          {connection.kind === 'key'
                            ? `${connection.tokenPrefix ?? ''}…`
                            : fill(tOr('AiProfile.worksAs', 'Works as {name}'), { name })}
                        </span>
                      </span>
                    </span>
                  </th>
                  <td>{connection.addedBy.displayName ?? '—'}</td>
                  <td>
                    {connection.lastUsedAt === null
                      ? tOr('AiProfile.never', 'Never')
                      : distance(connection.lastUsedAt)}
                  </td>
                  <td>
                    {connection.expiresAt === null ? '—' : distance(connection.expiresAt, true)}
                  </td>
                  <td>
                    {editable ? (
                      <span className="tm-aie-conn__actions">
                        {connection.kind === 'key' ? (
                          <Button
                            type="button"
                            tone="text"
                            size="header"
                            aria-label={fill(tOr('AiProfile.rotateNamed', 'Rotate {connection}'), {
                              connection: connection.name,
                            })}
                            onClick={() => void rotate(connection)}
                          >
                            {tOr('AiProfile.rotate', 'Rotate')}
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          tone="text"
                          size="header"
                          aria-label={fill(tOr('AiProfile.revokeNamed', 'Revoke {connection}'), {
                            connection: connection.name,
                          })}
                          onClick={() => onDialog({ kind: 'revoke', connectionId: connection.id })}
                        >
                          {tOr('AiProfile.revoke', 'Revoke')}
                        </Button>
                      </span>
                    ) : null}
                    {rotateFailed === connection.id ? (
                      <span className="tm-team-dialog__problem" role="alert">
                        {tOr('AiEmployees.writeFailed', 'That did not work. Try again.')}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  return (
    <div className="tm-aie-connections">
      {body}
      {dialog?.kind === 'revoke' && revoking ? (
        <ConfirmDialog
          title={fill(tOr('AiProfile.revokeTitle', 'Revoke {connection}?'), {
            connection: revoking.name,
          })}
          lines={[
            fill(
              tOr(
                'AiProfile.revokeBody',
                '{name}’s agent stops working through it at once. This cannot be undone; you can add a new connection later.',
              ),
              { name },
            ),
          ]}
          confirmLabel={tOr('AiProfile.revoke', 'Revoke')}
          onConfirm={async () => {
            if (revoking.kind === 'key')
              await revokeAgentKey(api, organizationSlug, ai.id, revoking.id);
            else await revokeAiEmployeeConnector(api, organizationSlug, ai.id, revoking.id);
            refresh();
            onDialog(null);
          }}
          onClose={() => onDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'rotated' ? (
        <RotatedKeyDialog name={name} createdKey={dialog.key} onClose={() => onDialog(null)} />
      ) : null}
      {dialog?.kind === 'add' ? (
        <AddConnectionDialog
          api={api}
          organizationSlug={organizationSlug}
          ai={ai}
          onClose={() => {
            refresh();
            onDialog(null);
          }}
          {...(addressOverride === undefined ? {} : { addressOverride })}
        />
      ) : null}
    </div>
  );
}

/** S6f: the rotated key, shown once. */
function RotatedKeyDialog({
  name,
  createdKey,
  onClose,
}: {
  readonly name: string;
  readonly createdKey: CreatedAgentKeyView;
  readonly onClose: () => void;
}) {
  const tOr = useTOr();
  const fmt = useDisplayFormatters();
  const titleId = useId();
  const days =
    createdKey.expiresAt === null
      ? null
      : Math.round((Date.parse(createdKey.expiresAt) - Date.parse(createdKey.createdAt)) / DAY);
  return (
    <AiDialogFrame labelledBy={titleId} onClose={onClose}>
      <div className="tm-team-dialog__form">
        <AiDialogHead
          id={titleId}
          title={fill(tOr('AiProfile.rotatedTitle', 'New key for {name}'), { name })}
          onClose={onClose}
        />
        <InlineAlert tone="warning">
          {tOr('AiConnect.copyNow', 'Copy this key now. You won’t see it again.')}
        </InlineAlert>
        <CopyField label={tOr('AiProfile.newKey', 'New agent key')} value={createdKey.token} />
        <p className="tm-aie-quiet">
          {days === null
            ? tOr('AiProfile.rotatedOldKey', 'The old key keeps working for 24 hours, then stops.')
            : fill(
                tOr(
                  'AiProfile.rotatedBody',
                  'The old key keeps working for 24 hours, then stops. The new key expires in {days} days.',
                ),
                { days: fmt.number(days) },
              )}
        </p>
        <div className="tm-team-dialog__actions">
          <Button type="button" tone="lime" size="large" data-autofocus onClick={onClose}>
            {tOr('AiProfile.done', 'Done')}
          </Button>
        </div>
      </div>
    </AiDialogFrame>
  );
}

/** Add connection (S6g Connect, S6b Add connection): the wizard's Connect step in a dialog. */
function AddConnectionDialog({
  api,
  organizationSlug,
  ai,
  onClose,
  addressOverride,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly ai: AiEmployeeView;
  readonly onClose: () => void;
  readonly addressOverride?: string;
}) {
  const tOr = useTOr();
  const titleId = useId();
  const [choice, setChoice] = useState<ConnectChoice>('claude');
  const [createdKey, setCreatedKey] = useState<CreatedAgentKeyView | null>(null);
  return (
    <AiDialogFrame labelledBy={titleId} onClose={onClose} wide>
      <div className="tm-team-dialog__form">
        <AiDialogHead
          id={titleId}
          title={fill(tOr('AiProfile.addTitle', 'Connect {name}'), { name: ai.displayName })}
          onClose={onClose}
        />
        <ConnectPanel
          api={api}
          organizationSlug={organizationSlug}
          ai={ai}
          choice={choice}
          onChoice={setChoice}
          createdKey={createdKey}
          onKeyCreated={setCreatedKey}
          {...(addressOverride === undefined ? {} : { addressOverride })}
        />
        <div className="tm-team-dialog__actions">
          <Button type="button" tone="lime" size="large" onClick={onClose}>
            {tOr('AiProfile.done', 'Done')}
          </Button>
        </div>
      </div>
    </AiDialogFrame>
  );
}
