'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button, InfoButton, InlineAlert, Skeleton, StateCapsule } from '@tmanage/ui';
import type { TrackAccount, TrackDetail } from '../../../lib/api/platform-security';
import { useT } from '../../../lib/i18n/use-t';
import {
  NETWORK_LABEL,
  OUTCOME_CAPSULE,
  OUTCOME_LABEL,
  TIMELINE_PREVIEW,
  allowlistAction,
  countryName,
  doorReadings,
  groupTimeline,
  networkKind,
  networkNumber,
  parseUserAgent,
  reasonDetail,
  signalLabel,
  stepTitle,
} from './attack-tracker-model';
import type { ParsedAgent, TimelineGroup } from './attack-tracker-model';
import { SourceCapsules } from './SourcesCard';
import type { SourceAction } from './SourcesCard';
import type { TrackerFormat } from './tracker-format';
import { useAccountsPhrase } from './use-tracker-text';

export interface SourceDetailProps {
  readonly detail: TrackDetail | undefined;
  readonly status: 'pending' | 'error' | 'success';
  readonly onRetry: () => void;
  readonly format: TrackerFormat;
  readonly onAction: (action: SourceAction) => void;
  readonly onAccounts: (detail: TrackDetail) => void;
  readonly onSignOut: (account: TrackAccount, detail: TrackDetail) => void;
  /** The id the address heading carries, so a side sheet can name itself by it. */
  readonly headingId: string;
}

/**
 * One source: its address and severity, the facts, the signals, the timeline
 * newest first and the actions, which follow the source's state (Fable build rule 1).
 */
export function SourceDetail(props: SourceDetailProps) {
  const t = useT();
  if (props.status === 'pending' || props.detail === undefined) {
    if (props.status === 'error') {
      return (
        <InlineAlert tone="danger" title={t('AttackTracker.couldNotLoadPart')} live>
          <Button tone="outline" size="compact" onClick={props.onRetry}>
            {t('AttackTracker.tryAgain')}
          </Button>
        </InlineAlert>
      );
    }
    return (
      <div className="tm-at-facts" role="status" aria-label={t('AttackTracker.loadingSources')}>
        <Skeleton height="28px" width="60%" />
        <Skeleton height="24px" width="45%" />
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <Skeleton key={row} />
        ))}
      </div>
    );
  }
  return <DetailBody {...props} detail={props.detail} />;
}

function DetailBody({
  detail,
  format,
  onAction,
  onAccounts,
  onSignOut,
  headingId,
}: SourceDetailProps & { readonly detail: TrackDetail }) {
  const t = useT();
  const accountsPhrase = useAccountsPhrase('AttackTracker.accounts');
  const [all, setAll] = useState(false);
  const kind = networkKind(detail.network);
  const country = countryName(detail.network?.countryCode ?? null, format.locale);
  const asn = networkNumber(detail.network);
  const agents = uniqueAgents(detail.userAgents);
  const groups = groupTimeline(detail.timeline);
  const shown = all ? groups : groups.slice(0, TIMELINE_PREVIEW);
  const allow = allowlistAction(detail);
  const accountsById = new Map(detail.accounts.map((account) => [account.userId, account]));

  return (
    <>
      <div className="tm-at-facts">
        <h2 id={headingId} className="tm-at-detail__address">
          <bdi dir="ltr">{detail.ip}</bdi>
        </h2>
        <div className="tm-at-status">
          <SourceCapsules track={detail} />
          {detail.breached ? <span>{t('AttackTracker.gotInAfterFailing')}</span> : null}
        </div>
      </div>

      <dl className="tm-at-facts">
        <Fact label={t('AttackTracker.network')}>
          <span>
            {[country, detail.network?.owner].filter((part) => part).join(' · ') ||
              t('AttackTracker.none')}
          </span>
          {kind ? <StateCapsule state="neutral">{t(NETWORK_LABEL[kind])}</StateCapsule> : null}
        </Fact>
        {asn ? (
          <Fact label={t('AttackTracker.networkNumber')}>
            <span className="tm-at-mono">
              <bdi dir="ltr">{asn}</bdi>
            </span>
          </Fact>
        ) : null}
        <Fact label={t('AttackTracker.firstSeen')}>{format.dayTime(detail.firstSeen)}</Fact>
        <Fact label={t('AttackTracker.lastSeen')}>{format.dayTime(detail.lastSeen)}</Fact>
        <Fact label={t('AttackTracker.attempts')}>
          <span>
            {format.count(detail.attempts)} ·{' '}
            {t('AttackTracker.splitRefused').replace('{count}', format.count(detail.refused))} ·{' '}
            {t('AttackTracker.splitSlowed').replace('{count}', format.count(detail.throttled))}
            {detail.succeeded > 0 ? (
              <>
                {' · '}
                <span className="tm-at-split__got-in">
                  {t('AttackTracker.splitGotIn').replace('{count}', format.count(detail.succeeded))}
                </span>
              </>
            ) : null}
          </span>
        </Fact>
        <Fact label={t('AttackTracker.accountsTargeted')}>
          {detail.accountsTotal === 0 ? (
            t('AttackTracker.none')
          ) : (
            <button type="button" className="tm-at-link" onClick={() => onAccounts(detail)}>
              {accountsPhrase(detail.accountsTotal)}
            </button>
          )}
        </Fact>
        <Fact label={t('AttackTracker.browsers')} lines>
          {agents.length === 0
            ? t('AttackTracker.none')
            : agents.map((agent) => <span key={agentKey(agent)}>{agentText(agent, t)}</span>)}
        </Fact>
      </dl>

      <hr className="tm-at-rule" />
      <h3 className="tm-at-heading">
        {t('AttackTracker.signals')}
        <InfoButton title={t('AttackTracker.signals')} label={t('AttackTracker.aboutSignals')}>
          {t('AttackTracker.infoSignals')}
        </InfoButton>
      </h3>
      {detail.signals.length === 0 ? (
        <p className="tm-at-secondary">{t('AttackTracker.none')}</p>
      ) : (
        <ul className="tm-at-capsules" aria-label={t('AttackTracker.signals')}>
          {[...new Set(detail.signals.map(signalLabel))].map((key) => (
            <li key={key}>
              <StateCapsule state="neutral">{t(key)}</StateCapsule>
            </li>
          ))}
        </ul>
      )}

      <hr className="tm-at-rule" />
      <h3 className="tm-at-heading">
        {t('AttackTracker.timeline')}
        <InfoButton title={t('AttackTracker.timeline')} label={t('AttackTracker.aboutTimeline')}>
          {t('AttackTracker.infoTimeline')}
        </InfoButton>
        <span className="tm-at-heading__end tm-at-secondary">{t('AttackTracker.newestFirst')}</span>
      </h3>
      <ol className="tm-at-timeline">
        {shown.map((group) => (
          <TimelineRow
            key={group.key}
            group={group}
            detail={detail}
            accountsById={accountsById}
            format={format}
            onSignOut={onSignOut}
          />
        ))}
      </ol>
      {groups.length > TIMELINE_PREVIEW ? (
        <button type="button" className="tm-at-link" onClick={() => setAll((open) => !open)}>
          {all
            ? t('AttackTracker.fewerAttempts')
            : t('AttackTracker.allAttempts').replace('{count}', format.count(detail.attempts))}
        </button>
      ) : null}

      <hr className="tm-at-rule" />
      <div className="tm-at-actions">
        <div className="tm-at-actions__row">
          {detail.blocked ? (
            <Button tone="outline" onClick={() => onAction('unblock')}>
              {t('AttackTracker.unblock')}
            </Button>
          ) : (
            <Button tone="ink" onClick={() => onAction('block')}>
              {t('AttackTracker.blockSource')}
            </Button>
          )}
          <InfoButton title={t('AttackTracker.blockSource')} label={t('AttackTracker.aboutBlock')}>
            {t('AttackTracker.infoBlock')}
          </InfoButton>
        </div>
        <div className="tm-at-actions__row">
          <Button tone="outline" disabled={allow === 'on-list'} onClick={() => onAction('allow')}>
            {allow === 'on-list'
              ? t('AttackTracker.onAllowlist')
              : t('AttackTracker.addToAllowlist')}
          </Button>
          <Button
            tone="outline"
            onClick={() => onAction(detail.label === 'known_tester' ? 'unmark' : 'mark')}
          >
            {detail.label === 'known_tester'
              ? t('AttackTracker.removeTesterMark')
              : t('AttackTracker.markTester')}
          </Button>
        </div>
      </div>
    </>
  );
}

function Fact({
  label,
  lines = false,
  children,
}: {
  readonly label: string;
  readonly lines?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="tm-at-fact">
      <dt>{label}</dt>
      <dd {...(lines ? { className: 'tm-at-fact__lines' } : {})}>{children}</dd>
    </div>
  );
}

function TimelineRow({
  group,
  detail,
  accountsById,
  format,
  onSignOut,
}: {
  readonly group: TimelineGroup;
  readonly detail: TrackDetail;
  readonly accountsById: ReadonlyMap<string, TrackAccount>;
  readonly format: TrackerFormat;
  readonly onSignOut: (account: TrackAccount, detail: TrackDetail) => void;
}) {
  const t = useT();
  const accountsPhrase = useAccountsPhrase('AttackTracker.accounts');
  const { step } = group;
  const account = step.userId === null ? undefined : accountsById.get(step.userId);
  const lines = stepLines(group, account, format, t, accountsPhrase, detail);
  const canSignOut =
    step.outcome === 'succeeded' && account !== undefined && detail.canSignOutAccounts;
  return (
    <li className="tm-at-step">
      <span className="tm-at-step__time tm-at-mono">{format.time(step.at)}</span>
      <div className="tm-at-step__body">
        <p className="tm-at-step__title">
          {t(stepTitle(step))}
          {group.times > 1 ? ` ×${format.count(group.times)}` : ''}
        </p>
        {lines ? <p className="tm-at-secondary">{lines}</p> : null}
      </div>
      <StateCapsule state={OUTCOME_CAPSULE[step.outcome]}>
        {t(OUTCOME_LABEL[step.outcome])}
      </StateCapsule>
      {canSignOut ? (
        <span className="tm-at-step__action">
          <Button tone="outline" size="compact" onClick={() => onSignOut(account, detail)}>
            {t('AttackTracker.signOutEverywhere')}
          </Button>
        </span>
      ) : null}
    </li>
  );
}

/** The step's second line: who and with what on a success, why on a refusal. */
function stepLines(
  group: TimelineGroup,
  account: TrackAccount | undefined,
  format: TrackerFormat,
  t: ReturnType<typeof useT>,
  accountsPhrase: (count: number) => string,
  detail: TrackDetail,
): string | null {
  const { step } = group;
  if (step.kind === 'signal') return null;
  if (step.action === 'network_guard' || step.kind === 'guard') {
    const country = countryName(detail.network?.countryCode ?? null, format.locale) ?? '';
    const readings = doorReadings(step.layers).map((reading) =>
      t(reading.key).replace('{country}', country),
    );
    return readings.length > 0 ? readings.join(' · ') : null;
  }
  const parts: string[] = [];
  if (step.outcome === 'succeeded') {
    if (account) {
      parts.push(account.displayName);
      const org = account.organizations[0]?.name;
      if (org) parts.push(org);
    }
    const agent = parseUserAgent(step.userAgent);
    if (agent) parts.push(agentText(agent, t));
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  if (group.userIds.length > 1) parts.push(accountsPhrase(group.userIds.length));
  const reason = reasonDetail(step);
  if (reason) parts.push(t(reason));
  return parts.length > 0 ? parts.join(' · ') : null;
}

function uniqueAgents(userAgents: readonly string[]): readonly ParsedAgent[] {
  const out = new Map<string, ParsedAgent>();
  for (const raw of userAgents) {
    const agent = parseUserAgent(raw);
    if (agent) out.set(agentKey(agent), agent);
  }
  return [...out.values()];
}

function agentKey(agent: ParsedAgent): string {
  return agent.kind === 'script' ? `s:${agent.name}` : `b:${agent.browser}:${agent.system ?? ''}`;
}

function agentText(agent: ParsedAgent, t: ReturnType<typeof useT>): string {
  if (agent.kind === 'script') return t('AttackTracker.scriptAgent').replace('{name}', agent.name);
  if (agent.system === null) return agent.browser;
  return t('AttackTracker.browserOn')
    .replace('{browser}', agent.browser)
    .replace('{system}', agent.system);
}
