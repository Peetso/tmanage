'use client';

import { useQuery } from '@tanstack/react-query';
import { StatusDot, Tooltip } from '@tmanage/ui';
import type { StatusTone } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { fetchPlatformCapacity } from '../../../lib/api/platform-capacity';
import type {
  CapacityGaugeColour,
  CapacityGaugeKey,
  CapacityGaugeView,
  CapacityView,
} from '../../../lib/api/platform-capacity';
import type { MessageKey } from '../../../lib/i18n/t';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useT } from '../../../lib/i18n/use-t';
import { useRelative } from '../organizations/org-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { formatBytes } from '../shared/platform-kit';

const MIB = 1024 * 1024;

interface GaugeCopy {
  readonly label: MessageKey;
  readonly hint: MessageKey;
  readonly advice: MessageKey;
}

const GAUGE_COPY: Readonly<Record<CapacityGaugeKey, GaugeCopy>> = {
  ram: {
    label: 'platformCapacity.ram',
    hint: 'platformCapacity.ramHint',
    advice: 'platformCapacity.ramAdvice',
  },
  loop_lag: {
    label: 'platformCapacity.loopLag',
    hint: 'platformCapacity.loopLagHint',
    advice: 'platformCapacity.loopLagAdvice',
  },
  sockets: {
    label: 'platformCapacity.sockets',
    hint: 'platformCapacity.socketsHint',
    advice: 'platformCapacity.socketsAdvice',
  },
  inodes: {
    label: 'platformCapacity.inodes',
    hint: 'platformCapacity.inodesHint',
    advice: 'platformCapacity.inodesAdvice',
  },
  disk: {
    label: 'platformCapacity.disk',
    hint: 'platformCapacity.diskHint',
    advice: 'platformCapacity.diskAdvice',
  },
  db_connections: {
    label: 'platformCapacity.dbConnections',
    hint: 'platformCapacity.dbConnectionsHint',
    advice: 'platformCapacity.dbConnectionsAdvice',
  },
};

const LEVEL: Readonly<Record<CapacityGaugeColour, { tone: StatusTone; word: MessageKey }>> = {
  green: { tone: 'success', word: 'platformCapacity.levelFine' },
  amber: { tone: 'warning', word: 'platformCapacity.levelWatch' },
  red: { tone: 'danger', word: 'platformCapacity.levelAct' },
};

/**
 * 56-32 — the "Server capacity" card on the platform overview: each shared-hosting limit in words,
 * its level (Fine / Watch / Act now, never colour alone) and one line of advice past Fine.
 */
export function PlatformCapacityCard({ api }: { api: ApiClient }) {
  const t = useT();
  const capacity = useQuery({
    queryKey: ['platform', 'health', 'capacity'],
    queryFn: () => fetchPlatformCapacity(api),
    retry: false,
  });
  return (
    <section className="tm-cc-card" aria-labelledby="tm-platform-capacity">
      <div className="tm-cc-card__head">
        <h2 id="tm-platform-capacity" className="tm-cc-card__title">
          {t('platformCapacity.title')}
        </h2>
        <Tooltip content={t('platformCapacity.help')}>
          <button
            type="button"
            className="tm-cc-row-button"
            aria-label={t('platformCapacity.helpLabel')}
          >
            ?
          </button>
        </Tooltip>
      </div>
      <p className="tm-cc-note">{t('platformCapacity.intro')}</p>
      {capacity.isPending ? (
        <PlatformPageState state="loading" loadingLabel={t('platformCapacity.loading')} />
      ) : null}
      {capacity.isError ? (
        <PlatformPageState
          state="error"
          error={capacity.error}
          title={t('platformCapacity.errorTitle')}
          onRetry={() => void capacity.refetch()}
        />
      ) : null}
      {capacity.isSuccess ? <CapacityBody data={capacity.data} /> : null}
    </section>
  );
}

function CapacityBody({ data }: { data: CapacityView }) {
  const t = useT();
  const relative = useRelative();
  const taken = [data.latest.sample?.takenAt, data.latest.nightly?.takenAt]
    .filter((iso): iso is string => iso !== undefined)
    .sort()
    .at(-1);
  if (data.gauges.length === 0 || taken === undefined) {
    return <p className="tm-cc-note">{t('platformCapacity.noReadings')}</p>;
  }
  return (
    <>
      <ul className="tm-cc-rows">
        {data.gauges.map((gauge) => (
          <GaugeRow key={gauge.key} gauge={gauge} />
        ))}
      </ul>
      {data.trigger.due ? (
        <p className="tm-cc-note">
          {t('platformCapacity.moveDue').replace('{days}', String(data.trigger.days))}
        </p>
      ) : null}
      {data.profile.source === 'planning' ? (
        <p className="tm-cc-note">{t('platformCapacity.planningLimits')}</p>
      ) : null}
      <p className="tm-cc-note">
        {t('platformCapacity.measuredAt').replace('{when}', relative(taken))}
      </p>
    </>
  );
}

function GaugeRow({ gauge }: { gauge: CapacityGaugeView }) {
  const t = useT();
  const fmt = useDisplayFormatters();
  const copy = GAUGE_COPY[gauge.key];
  const level = LEVEL[gauge.colour];
  const amount = (value: number): string => {
    if (gauge.key === 'ram' || gauge.key === 'disk') return formatBytes(value * MIB);
    if (gauge.key === 'loop_lag') return `${fmt.number(value)} ms`;
    return fmt.number(value);
  };
  const label = t(copy.label);
  const fill = Math.min(100, Math.max(0, gauge.percent));
  return (
    <li className="tm-cc-rows__grow">
      <div className="tm-cc-hero__actions">
        <Tooltip content={t(copy.hint)}>
          <span
            className="tm-cc-rows__title"
            // The hint lives in a tooltip, so a keyboard must be able to reach the label to read it.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
          >
            {label}
          </span>
        </Tooltip>
        <StatusDot tone={level.tone}>{t(level.word)}</StatusDot>
        <span>
          {t('platformCapacity.valueOf')
            .replace('{value}', amount(gauge.value))
            .replace('{ceiling}', amount(gauge.ceiling))}
          {' · '}
          {t('platformCapacity.percentUsed').replace('{percent}', fmt.number(gauge.percent))}
        </span>
      </div>
      <span
        className="tm-cc-bar"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fill}
        aria-label={label}
      >
        <span className="tm-cc-bar__fill" style={{ inlineSize: `${fill}%` }} />
      </span>
      {gauge.colour === 'green' ? null : <p className="tm-cc-note">{t(copy.advice)}</p>}
    </li>
  );
}
