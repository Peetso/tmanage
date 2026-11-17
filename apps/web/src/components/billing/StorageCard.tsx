'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import type {
  StorageMoveView,
  StorageOnTManageView,
  StorageProvider,
} from '../../lib/api/storage-root';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import type { PlanStorageView } from '../../lib/api/plan-usage';
import { useStorageCard } from '../../lib/use-storage-card';
import type { StorageConnection, StorageStopReason } from '../../lib/use-storage-card';
import { formatSize } from '../viewer/format-stage-helpers';
import { count, fill, planUsageText, providerCompany, providerName } from './plan-usage-format';
import type { PlanUsageText } from './plan-usage-format';
import { planStorageText } from './plan-storage-copy';
import { StorageAllowance } from './StorageAllowance';
import { UsageMeter } from './UsageMeter';

export interface StorageCardProps {
  readonly organizationSlug: string;
  readonly client: ApiClient;
  /** 57-13r. The temporary storage allowance from the plan-usage read; null while unknown. */
  readonly allowance: PlanStorageView | null;
}

const LINK_OUTLINE = 'tm-button tm-button--outline tm-button--accessible';
const LINK_INK = 'tm-button tm-button--ink tm-button--accessible';

/**
 * 57-13c. **Where your files live** (Figma 668:36868), under "What you use": connect a Drive
 * first (S1), move the files TManage still holds (S2, confirmed in S3), follow the move (S4), the
 * result (S5), or one calm way forward when it stopped (S6). Connecting goes to the existing flow
 * on Integrations. Rendered only for `org.security.manage`; the server decides every request.
 * Before a Drive is connected, the amount on TManage is shown against the temporary allowance
 * (57-13r) with a notice from 70 %; once a Drive is connected, uploads no longer wait on it.
 * After a finished move the Move button comes back while files are left to move (new uploads, or
 * files that failed: then it reads Try again).
 */
export function StorageCard({ organizationSlug, client, allowance }: StorageCardProps) {
  const tOr = useTOr();
  const tr = planUsageText(tOr);
  const ts = planStorageText(tOr);
  const locale = useActiveLocale();
  const { state, onTManage, isStarting, startError, start } = useStorageCard(
    client,
    organizationSlug,
  );
  const [confirming, setConfirming] = useState<StorageProvider | null>(null);
  const integrations = `/${organizationSlug}/automations/apps`;
  const movable = onTManage?.movable ?? 0;

  if (state.kind === 'loading') return null;

  const startAlert =
    startError === null ? null : (
      <InlineAlert tone="danger" live>
        {tr('PlanUsage.filesStartError')}
      </InlineAlert>
    );

  if (state.kind === 'moving' || state.kind === 'stopped') {
    const { job } = state;
    const provider = providerName(job.provider);
    return (
      <section className="tm-pu-card tm-pu-files" aria-labelledby="tm-pu-files-heading">
        <h2 id="tm-pu-files-heading" className="tm-pu-usage__title">
          {state.kind === 'moving'
            ? fill(tr('PlanUsage.filesMovingHeading'), { provider })
            : tr('PlanUsage.filesStoppedHeading')}
        </h2>
        {state.kind === 'moving' ? (
          <MovingBody job={job} locale={locale} tr={tr} />
        ) : (
          <StoppedBody
            job={job}
            reason={state.reason}
            locale={locale}
            tr={tr}
            reconnectHref={integrations}
            retrying={isStarting}
            onRetry={() => start(job.provider)}
          />
        )}
        {startAlert}
      </section>
    );
  }

  const doneTarget = state.kind === 'done' && movable > 0 ? state.connection : null;

  return (
    <section className="tm-pu-card tm-pu-files" aria-labelledby="tm-pu-files-heading">
      <h2 id="tm-pu-files-heading" className="tm-pu-usage__title">
        {tr('PlanUsage.filesHeading')}
      </h2>

      {state.kind === 'error' ? (
        <InlineAlert tone="danger">{tr('PlanUsage.filesLoadError')}</InlineAlert>
      ) : null}

      {state.kind === 'connect' ? (
        <>
          {allowance === null ? (
            <OnTManageAmount label={tr('PlanUsage.filesTemporary')} figures={onTManage} />
          ) : (
            <StorageAllowance storage={allowance} locale={locale} tr={ts} />
          )}
          <p className="tm-pu-files__text">{tr('PlanUsage.filesConnectNote')}</p>
          <div className="tm-pu-files__actions">
            <Link href={integrations} className={LINK_OUTLINE}>
              {tr('PlanUsage.filesConnectGoogle')}
            </Link>
            <Link href={integrations} className={LINK_OUTLINE}>
              {tr('PlanUsage.filesConnectOneDrive')}
            </Link>
          </div>
        </>
      ) : null}

      {state.kind === 'ready' ? (
        <ReadyBody
          connection={state.connection}
          figures={onTManage}
          tr={tr}
          busy={isStarting}
          onMove={() => setConfirming(state.connection.provider)}
        />
      ) : null}

      {state.kind === 'done' ? (
        <DoneBody
          job={state.job}
          figures={onTManage}
          locale={locale}
          tr={tr}
          busy={isStarting}
          onMove={doneTarget === null ? null : () => setConfirming(doneTarget.provider)}
        />
      ) : null}

      {startAlert}

      {confirming === null ? null : (
        <MoveDialog
          provider={confirming}
          files={movable}
          locale={locale}
          tr={tr}
          onCancel={() => setConfirming(null)}
          onMove={() => {
            setConfirming(null);
            start(confirming);
          }}
        />
      )}
    </section>
  );
}

/** How much is still on TManage, as an amount (once a Drive is connected, or before usage loads). */
function OnTManageAmount({
  label,
  figures,
}: {
  label: string;
  figures: StorageOnTManageView | null;
}) {
  if (figures === null) return null;
  return (
    <div className="tm-pu-meter">
      <div className="tm-pu-meter__row">
        <span className="tm-pu-meter__label">{label}</span>
        <span className="tm-pu-meter__value">{formatSize(figures.bytes)}</span>
      </div>
    </div>
  );
}

function ReadyBody({
  connection,
  figures,
  tr,
  busy,
  onMove,
}: {
  connection: StorageConnection;
  figures: StorageOnTManageView | null;
  tr: PlanUsageText;
  busy: boolean;
  onMove: () => void;
}) {
  const provider = providerName(connection.provider);
  return (
    <>
      <p className="tm-pu-files__where">
        {connection.account === null
          ? fill(tr('PlanUsage.filesLiveIn'), { provider })
          : fill(tr('PlanUsage.filesLiveInAccount'), { provider, account: connection.account })}
      </p>
      <OnTManageAmount label={tr('PlanUsage.filesStillTemporary')} figures={figures} />
      {figures !== null && figures.movable > 0 ? (
        <>
          <p className="tm-pu-files__text">{fill(tr('PlanUsage.filesMoveNote'), { provider })}</p>
          <div className="tm-pu-files__actions">
            <Button type="button" tone="ink" size="accessible" disabled={busy} onClick={onMove}>
              {fill(tr('PlanUsage.filesMove'), { provider })}
            </Button>
          </div>
        </>
      ) : null}
    </>
  );
}

function MovingBody({
  job,
  locale,
  tr,
}: {
  job: StorageMoveView;
  locale: string;
  tr: PlanUsageText;
}) {
  const moved = fill(tr('PlanUsage.filesMovedOf'), {
    moved: count(job.moved, locale),
    total: count(job.total, locale),
  });
  const size = fill(tr('PlanUsage.valueOf'), {
    used: formatSize(job.movedBytes),
    limit: formatSize(job.totalBytes),
  });
  return (
    <>
      <div aria-live="polite">
        <UsageMeter
          id="files-moving"
          label={moved}
          meter={{ used: job.moved, limit: job.total, level: 'normal' }}
          value={size}
          valueText={`${moved}, ${size}`}
        />
      </div>
      <p className="tm-pu-files__text">{tr('PlanUsage.filesLeaveNote')}</p>
    </>
  );
}

function DoneBody({
  job,
  figures,
  locale,
  tr,
  busy,
  onMove,
}: {
  job: StorageMoveView;
  figures: StorageOnTManageView | null;
  locale: string;
  tr: PlanUsageText;
  busy: boolean;
  /** Opens the confirm for a new move; null when nothing is left to move or nowhere to move it. */
  onMove: (() => void) | null;
}) {
  const provider = providerName(job.provider);
  const retry = onMove !== null && job.failed > 0;
  const lines: string[] = [
    job.moved === 1
      ? tr('PlanUsage.filesDoneMovedOne')
      : fill(tr('PlanUsage.filesDoneMoved'), { count: count(job.moved, locale) }),
  ];
  if (job.skipped > 0) {
    lines.push(
      job.skipped === 1
        ? fill(tr('PlanUsage.filesDoneSkippedOne'), { provider })
        : fill(tr('PlanUsage.filesDoneSkipped'), { count: count(job.skipped, locale), provider }),
    );
  }
  if (job.failed > 0) {
    const [one, many] = retry
      ? (['PlanUsage.filesDoneFailedRetryOne', 'PlanUsage.filesDoneFailedRetry'] as const)
      : (['PlanUsage.filesDoneFailedOne', 'PlanUsage.filesDoneFailed'] as const);
    lines.push(job.failed === 1 ? tr(one) : fill(tr(many), { count: count(job.failed, locale) }));
  } else if (onMove !== null) {
    lines.push(fill(tr('PlanUsage.filesMoveNote'), { provider }));
  }
  return (
    <>
      <InlineAlert tone="success" live>
        {fill(tr('PlanUsage.filesDone'), { provider })}
      </InlineAlert>
      <OnTManageAmount label={tr('PlanUsage.filesTemporary')} figures={figures} />
      {lines.map((line, index) => (
        <p key={line} className={index === 0 ? 'tm-pu-files__where' : 'tm-pu-files__text'}>
          {line}
        </p>
      ))}
      {onMove === null ? null : (
        <div className="tm-pu-files__actions">
          <Button type="button" tone="ink" size="accessible" disabled={busy} onClick={onMove}>
            {retry ? tr('PlanUsage.filesTryAgain') : fill(tr('PlanUsage.filesMove'), { provider })}
          </Button>
        </div>
      )}
    </>
  );
}

function StoppedBody({
  job,
  reason,
  locale,
  tr,
  reconnectHref,
  retrying,
  onRetry,
}: {
  job: StorageMoveView;
  reason: StorageStopReason;
  locale: string;
  tr: PlanUsageText;
  reconnectHref: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  const provider = providerName(job.provider);
  const notice =
    reason === 'not_connected'
      ? fill(tr('PlanUsage.filesStoppedNotConnected'), { provider })
      : reason === 'connection_changed'
        ? fill(tr('PlanUsage.filesStoppedChanged'), { company: providerCompany(job.provider) })
        : fill(tr('PlanUsage.filesStoppedUnavailable'), { provider });
  return (
    <>
      <p className="tm-pu-files__text">
        {fill(tr('PlanUsage.filesStoppedSoFar'), {
          moved: count(job.moved, locale),
          total: count(job.total, locale),
        })}
      </p>
      <InlineAlert tone="warning" live>
        {notice}
      </InlineAlert>
      <div className="tm-pu-files__actions">
        {reason === 'provider_unavailable' ? (
          <Button
            type="button"
            tone="outline"
            size="accessible"
            disabled={retrying}
            onClick={onRetry}
          >
            {tr('PlanUsage.filesTryAgain')}
          </Button>
        ) : (
          <Link href={reconnectHref} className={LINK_INK}>
            {reason === 'not_connected'
              ? fill(tr('PlanUsage.filesReconnectProvider'), { provider })
              : tr('PlanUsage.filesReconnect')}
          </Link>
        )}
      </div>
    </>
  );
}

/**
 * S3. A native modal dialog: the browser keeps focus inside it and makes the page behind inert;
 * Escape cancels, and focus returns to the button that opened it.
 */
function MoveDialog({
  provider,
  files,
  locale,
  tr,
  onCancel,
  onMove,
}: {
  provider: StorageProvider;
  files: number;
  locale: string;
  tr: PlanUsageText;
  onCancel: () => void;
  onMove: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    if (node && !node.open && typeof node.showModal === 'function') node.showModal();
    return () => previous?.focus?.();
  }, []);
  const name = providerName(provider);
  return (
    <dialog
      ref={dialog}
      className="tm-pu-dialog tm-pu-files-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId} className="tm-pu-dialog__title">
        {files === 1
          ? fill(tr('PlanUsage.filesConfirmTitleOne'), { provider: name })
          : fill(tr('PlanUsage.filesConfirmTitle'), {
              provider: name,
              count: count(files, locale),
            })}
      </h2>
      <p className="tm-pu-files__text">
        {fill(tr('PlanUsage.filesConfirmWhat'), { provider: name })}
      </p>
      <p className="tm-pu-files__text">{tr('PlanUsage.filesConfirmOpen')}</p>
      <p className="tm-pu-files__text">{tr('PlanUsage.filesConfirmLeave')}</p>
      <div className="tm-pu-dialog__actions">
        <Button type="button" tone="outline" size="accessible" onClick={onCancel}>
          {tr('PlanUsage.cancel')}
        </Button>
        <Button type="button" tone="ink" size="accessible" onClick={onMove}>
          {tr('PlanUsage.filesConfirmMove')}
        </Button>
      </div>
    </dialog>
  );
}
