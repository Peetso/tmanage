'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import type { StorageMoveView, StorageProvider } from '../../lib/api/storage-root';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useStorageCard } from '../../lib/use-storage-card';
import type { StorageConnection, StorageStopReason } from '../../lib/use-storage-card';
import { formatSize } from '../viewer/format-stage-helpers';
import { count, fill, planUsageText, providerCompany, providerName } from './plan-usage-format';
import type { PlanUsageText } from './plan-usage-format';
import { UsageMeter } from './UsageMeter';

export interface StorageCardProps {
  readonly organizationSlug: string;
  readonly client: ApiClient;
}

const LINK_OUTLINE = 'tm-button tm-button--outline tm-button--accessible';
const LINK_INK = 'tm-button tm-button--ink tm-button--accessible';

/**
 * 57-13c. **Where your files live** (Figma 668:36868), under "What you use": connect a Drive
 * first (S1), move the files TManage still holds (S2, confirmed in S3), follow the move (S4), the
 * result (S5), or one calm way forward when it stopped (S6). Connecting goes to the existing flow
 * on Integrations. Rendered only for `org.security.manage`; the server decides every request.
 */
export function StorageCard({ organizationSlug, client }: StorageCardProps) {
  const tr = planUsageText(useTOr());
  const locale = useActiveLocale();
  const { state, isStarting, startError, start } = useStorageCard(client, organizationSlug);
  const [confirming, setConfirming] = useState<StorageProvider | null>(null);
  const integrations = `/${organizationSlug}/automations/apps`;

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
          tr={tr}
          busy={isStarting}
          onMove={() => setConfirming(state.connection.provider)}
        />
      ) : null}

      {state.kind === 'done' ? <DoneBody job={state.job} locale={locale} tr={tr} /> : null}

      {startAlert}

      {confirming === null ? null : (
        <MoveDialog
          provider={confirming}
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

function ReadyBody({
  connection,
  tr,
  busy,
  onMove,
}: {
  connection: StorageConnection;
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
      <p className="tm-pu-files__text">{fill(tr('PlanUsage.filesMoveNote'), { provider })}</p>
      <div className="tm-pu-files__actions">
        <Button type="button" tone="ink" size="accessible" disabled={busy} onClick={onMove}>
          {fill(tr('PlanUsage.filesMove'), { provider })}
        </Button>
      </div>
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
  const size = formatSize(job.movedBytes);
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
  locale,
  tr,
}: {
  job: StorageMoveView;
  locale: string;
  tr: PlanUsageText;
}) {
  const provider = providerName(job.provider);
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
    lines.push(
      job.failed === 1
        ? tr('PlanUsage.filesDoneFailedOne')
        : fill(tr('PlanUsage.filesDoneFailed'), { count: count(job.failed, locale) }),
    );
  }
  return (
    <>
      <InlineAlert tone="success" live>
        {fill(tr('PlanUsage.filesDone'), { provider })}
      </InlineAlert>
      {lines.map((line, index) => (
        <p key={line} className={index === 0 ? 'tm-pu-files__where' : 'tm-pu-files__text'}>
          {line}
        </p>
      ))}
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
  tr,
  onCancel,
  onMove,
}: {
  provider: StorageProvider;
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
        {fill(tr('PlanUsage.filesConfirmTitle'), { provider: name })}
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
