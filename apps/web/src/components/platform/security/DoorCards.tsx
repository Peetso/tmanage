'use client';

import { Button, InfoButton, InlineAlert, Skeleton, Switch } from '@tmanage/ui';
import type { AllowlistEntry, NetworkAccessView } from '../../../lib/api/platform-security';
import { useT } from '../../../lib/i18n/use-t';
import { DOOR_LISTS, dayGap, lastListRefresh } from './attack-tracker-model';
import { allowlistValue } from './TrackerDialogs';
import { TrackerIcon } from './tracker-icons';
import type { TrackerFormat } from './tracker-format';

interface DoorCardProps {
  readonly door: NetworkAccessView | undefined;
  readonly status: 'pending' | 'error' | 'success';
  readonly onRetry: () => void;
  readonly format: TrackerFormat;
}

function DoorLoading() {
  return (
    <div className="tm-at-facts" aria-hidden="true">
      <Skeleton />
      <Skeleton />
    </div>
  );
}

function DoorError({ onRetry }: { readonly onRetry: () => void }) {
  const t = useT();
  return (
    <InlineAlert tone="danger" title={t('AttackTracker.couldNotLoadPart')} live>
      <Button tone="outline" size="compact" onClick={onRetry}>
        {t('AttackTracker.tryAgain')}
      </Button>
    </InlineAlert>
  );
}

/**
 * The Allowlist card: addresses and networks that always pass the sign-in door,
 * each with its note, the day it was added and a remove button.
 */
export function AllowlistCard({
  door,
  status,
  onRetry,
  format,
  onAdd,
  onRemove,
}: DoorCardProps & {
  readonly onAdd: () => void;
  readonly onRemove: (entry: AllowlistEntry) => void;
}) {
  const t = useT();
  return (
    <section className="tm-at-card" aria-labelledby="tm-at-allowlist-title">
      <div className="tm-at-card__head">
        <h2 id="tm-at-allowlist-title" className="tm-at-card__title tm-at-title">
          {t('AttackTracker.allowlist')}
          <InfoButton
            title={t('AttackTracker.allowlist')}
            label={t('AttackTracker.aboutAllowlist')}
          >
            {t('AttackTracker.infoAllowlist')}
          </InfoButton>
        </h2>
        <Button tone="outline" size="compact" onClick={onAdd} disabled={status !== 'success'}>
          {t('AttackTracker.add')}
        </Button>
      </div>
      {status === 'pending' ? <DoorLoading /> : null}
      {status === 'error' ? <DoorError onRetry={onRetry} /> : null}
      {status === 'success' && door ? (
        door.entries.length === 0 ? (
          <p className="tm-at-secondary">{t('AttackTracker.allowlistEmpty')}</p>
        ) : (
          <ul className="tm-at-list">
            {door.entries.map((entry) => {
              const value = allowlistValue(entry);
              return (
                <li key={entry.id}>
                  <span className="tm-at-mono">
                    <bdi dir="ltr">{value}</bdi>
                  </span>
                  <span>{entry.note ? <bdi>{entry.note}</bdi> : null}</span>
                  <span className="tm-at-list__date">{format.day(entry.createdAt)}</span>
                  <button
                    type="button"
                    className="tm-at-icon-button tm-at-icon-button--small"
                    aria-label={t('AttackTracker.removeEntry').replace('{value}', value)}
                    onClick={() => onRemove(entry)}
                  >
                    <TrackerIcon name="trash" />
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </section>
  );
}

/**
 * The Sign-in door card: the policy switch, the four free block lists with their
 * sizes and the last refresh. Turning the door on applies at once; turning it off asks first.
 */
export function SignInDoorCard({
  door,
  status,
  onRetry,
  format,
  now,
  busy,
  onTurnOn,
  onTurnOff,
}: DoorCardProps & {
  readonly now: Date;
  readonly busy: boolean;
  readonly onTurnOn: () => void;
  readonly onTurnOff: () => void;
}) {
  const t = useT();
  const refreshed = door ? lastListRefresh(door.lists) : null;
  return (
    <section className="tm-at-card" aria-labelledby="tm-at-door-title">
      <h2 id="tm-at-door-title" className="tm-at-card__title tm-at-title">
        {t('AttackTracker.signInDoor')}
        <InfoButton title={t('AttackTracker.signInDoor')} label={t('AttackTracker.aboutDoor')}>
          {t('AttackTracker.infoDoor')}
        </InfoButton>
      </h2>
      {status === 'pending' ? <DoorLoading /> : null}
      {status === 'error' ? <DoorError onRetry={onRetry} /> : null}
      {status === 'success' && door ? (
        <>
          <Switch
            className="tm-at-door__switch"
            label={t('AttackTracker.policyLabel')}
            checked={door.policy === 'refuse'}
            disabled={busy}
            onChange={(event) => (event.target.checked ? onTurnOn() : onTurnOff())}
          />
          <hr className="tm-at-rule" />
          <ul className="tm-at-door__lists">
            <li>
              <span>{t('AttackTracker.blockLists')}</span>
              <span>{t('AttackTracker.ranges')}</span>
            </li>
            {DOOR_LISTS.map((list) => {
              const state = door.lists.find((item) => item.key === list.key);
              return (
                <li key={list.key}>
                  <span>{t(list.label)}</span>
                  <span className="tm-at-door__count">
                    {state === undefined || state.status === 'off'
                      ? t('AttackTracker.listOff')
                      : state.status === 'failed'
                        ? t('AttackTracker.listFailed')
                        : format.count(state.rangeCount)}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="tm-at-secondary">
            {refreshed === null
              ? t('AttackTracker.neverRefreshed')
              : dayGap(refreshed, now) <= 0
                ? t('AttackTracker.lastRefreshToday').replace('{time}', format.time(refreshed))
                : t('AttackTracker.lastRefreshOn').replace('{when}', format.dayTime(refreshed))}
          </p>
        </>
      ) : null}
    </section>
  );
}
