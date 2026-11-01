'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Checkbox, InlineAlert, StatusDot, Switch } from '@tmanage/ui';
import { apiBaseUrl, browserApiClient } from '../../../lib/api/browser-client';
import {
  disablePlatformPerson,
  endPlatformPersonSession,
  fetchPlatformPersonAccess,
  fetchPlatformPersonSessions,
  personSignInTrailCsvUrl,
  resetPlatformPersonTwoStep,
  sendPlatformPersonPasswordReset,
  setPlatformPersonTwoStepRequired,
  signOutPlatformPersonEverywhere,
} from '../../../lib/api/platform-people';
import type { PlatformPersonSessionView } from '../../../lib/api/platform-people';
import { downloadTrailCsv } from '../../../lib/api/session-intel';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import {
  IntelDeviceCell,
  IntelLocationCell,
  IntelNetworkCell,
  SessionIntelDrawer,
} from '../../security/SessionIntelCards';
import { SignalPill } from '../../security/SignalPill';
import { useT } from '../../../lib/i18n/use-t';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import { ReasonDialog, platformErrorText } from '../shared/ReasonDialog';
import { relativeMoment } from '../team/PlatformTeamScreen';
import { dayAndTime, deviceOf, firstNameOf, fullDay, shortDay } from './people-format';
import { DisableDialog, PersonFrame } from './PersonFrame';
import type { PersonScreenContext } from './PersonFrame';
import { PeopleReasonDialog } from './PeopleReasonDialog';
import { accessReason } from './PersonProfileScreen';

type Pending =
  | { kind: 'end'; session: PlatformPersonSessionView }
  | { kind: 'sign-out' }
  | { kind: 'reset-password' }
  | { kind: 'reset-two-step' }
  | { kind: 'disable' }
  | null;

/** B3 · Security & sessions — `/platform/people/:userId/security` (435:15658, 435:16133, 435:15963). */
export function PersonSecurityScreen({ client, userId }: ScreenProps & { userId: string }) {
  const api = client ?? browserApiClient();
  return (
    <PersonFrame api={api} userId={userId} tab="security">
      {(context) => <SecurityBody {...context} />}
    </PersonFrame>
  );
}

function SecurityBody({ api, me, person, refresh }: PersonScreenContext) {
  const t = useT();
  const locale = useActiveLocale();
  const [pending, setPending] = useState<Pending>(null);
  const [signOutToo, setSignOutToo] = useState(false);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [csvFailed, setCsvFailed] = useState(false);
  const trailCsvUrl = personSignInTrailCsvUrl(apiBaseUrl(), person.id);
  const printHref = `/platform/people/${encodeURIComponent(person.id)}/sign-in-trail`;
  const downloadTrail = async () =>
    setCsvFailed(!(await downloadTrailCsv(trailCsvUrl, `sign-in-trail-${person.id}.csv`)));
  const canSecure = me.permissions.includes('platform.people.security');
  const first = firstNameOf(person.displayName);
  const sessions = useQuery({
    queryKey: ['platform', 'people', 'sessions', person.id],
    queryFn: () => fetchPlatformPersonSessions(api, person.id),
  });
  const access = useQuery({
    queryKey: ['platform', 'people', 'access', person.id],
    queryFn: () => fetchPlatformPersonAccess(api, person.id, { outcome: 'failed' }),
  });
  const require = useMutation({
    mutationFn: (required: boolean) => setPlatformPersonTwoStepRequired(api, person.id, required),
    onSuccess: () => refresh(),
  });
  const reloadAll = async () => {
    await Promise.all([refresh(), sessions.refetch(), access.refetch()]);
  };
  const failed = (access.data?.events ?? []).filter((event) => event.outcome !== 'succeeded');
  const facts = person.facts;

  return (
    <div className="tm-cc-split">
      <div className="tm-cc-column">
        <section className="tm-stack tm-stack--tight" aria-labelledby="pa06-sessions-title">
          <div className="tm-cc-card__head">
            <div>
              <h3 id="pa06-sessions-title" className="tm-cc-card__title">
                {t('PlatformPeople.sessions')}
              </h3>
              {sessions.data ? (
                <p className="tm-cc-note">
                  {sessions.data.live} {t('PlatformPeople.liveWord')} ·{' '}
                  {sessions.data.endedRecently} {t('PlatformPeople.endedRecently')}
                </p>
              ) : null}
            </div>
            {canSecure ? (
              <Button type="button" tone="outline" onClick={() => setPending({ kind: 'sign-out' })}>
                {t('PlatformPeople.signOutEverywhere')}
              </Button>
            ) : null}
          </div>
          {sessions.isPending ? (
            <PlatformPageState state="loading" loadingLabel={t('PlatformPeople.loadingSessions')} />
          ) : sessions.isError ? (
            <PlatformPageState
              state="error"
              error={sessions.error}
              onRetry={() => void sessions.refetch()}
            />
          ) : sessions.data.sessions.length === 0 ? (
            <section className="tm-cc-card tm-stack" aria-live="polite">
              <p className="tm-cc-eyebrow">{t('PlatformPeople.noSessionsEyebrow')}</p>
              <h4 className="tm-cc-card__title">
                {`${first} ${t('PlatformPeople.noSessionsTitle')}`}
              </h4>
              <p className="tm-cc-note">{t('PlatformPeople.noSessionsBody')}</p>
            </section>
          ) : (
            <PlatformTable<PlatformPersonSessionView>
              label={t('PlatformPeople.sessions')}
              rows={sessions.data.sessions}
              rowKey={(session) => session.id}
              isMuted={(session) => session.state !== 'live'}
              columns={[
                {
                  id: 'device',
                  header: t('PlatformPeople.colDevice'),
                  cell: (session) => (
                    <button
                      type="button"
                      className="tm-intel-open"
                      onClick={() => setOpenSessionId(session.id)}
                    >
                      <IntelDeviceCell
                        intel={session.intel}
                        fallback={deviceOf(session.userAgent)}
                      />
                    </button>
                  ),
                },
                {
                  id: 'location',
                  header: t('SessionIntel.colLocation'),
                  cell: (session) => (
                    <IntelLocationCell
                      intel={session.intel}
                      ip={session.ipLast ?? session.ipFirst ?? null}
                    />
                  ),
                },
                {
                  id: 'signal',
                  header: t('SessionIntel.colSignal'),
                  cell: (session) => <SignalPill automation={session.intel?.automation} />,
                },
                {
                  id: 'created',
                  header: t('PlatformPeople.colCreated'),
                  cell: (session) => shortDay(session.createdAt, locale),
                },
                {
                  id: 'lastActive',
                  header: t('PlatformPeople.colLastActive'),
                  cell: (session) => relativeMoment(session.lastActiveAt, locale),
                },
                {
                  id: 'state',
                  header: t('PlatformPeople.colState'),
                  cell: (session) => <SessionState session={session} />,
                },
                {
                  id: 'end',
                  header: <span className="tm-visually-hidden">{t('PlatformPeople.end')}</span>,
                  cell: (session) =>
                    canSecure && session.state === 'live' ? (
                      <Button
                        type="button"
                        tone="text"
                        size="compact"
                        onClick={() => setPending({ kind: 'end', session })}
                      >
                        {t('PlatformPeople.end')}
                      </Button>
                    ) : null,
                },
              ]}
            />
          )}
        </section>

        <section className="tm-stack tm-stack--tight" aria-labelledby="pa06-failed-title">
          <div className="tm-cc-card__head">
            <div>
              <h3 id="pa06-failed-title" className="tm-cc-card__title">
                {t('PlatformPeople.failedSignIns')}
              </h3>
              <p className="tm-cc-note">{t('SessionIntel.trailNote')}</p>
            </div>
            {canSecure ? (
              <div className="tm-intel-drawer__actions">
                <Button type="button" tone="outline" onClick={() => void downloadTrail()}>
                  {t('SessionIntel.downloadCsv')}
                </Button>
                <a
                  className="tm-button tm-button--outline"
                  href={printHref}
                  target="_blank"
                  rel="noopener"
                >
                  {t('SessionIntel.saveAsPdf')}
                </a>
              </div>
            ) : null}
          </div>
          {csvFailed ? (
            <InlineAlert tone="danger" live>
              {t('SessionIntel.csvFailed')}
            </InlineAlert>
          ) : null}
          {access.isPending ? (
            <PlatformPageState state="loading" loadingLabel={t('PlatformPeople.loadingAccess')} />
          ) : access.isError ? (
            <PlatformPageState
              state="error"
              error={access.error}
              onRetry={() => void access.refetch()}
            />
          ) : failed.length === 0 ? (
            <p className="tm-cc-card tm-cc-note">{t('PlatformPeople.noFailedSignIns')}</p>
          ) : (
            <PlatformTable
              label={t('PlatformPeople.failedSignIns')}
              rows={failed}
              rowKey={(event) => event.id}
              columns={[
                {
                  id: 'time',
                  header: t('PlatformPeople.colTime'),
                  cell: (event) => dayAndTime(event.occurredAt, locale),
                },
                {
                  id: 'reason',
                  header: t('PlatformPeople.colReason'),
                  cell: (event) => accessReason(t, event.reason),
                },
                {
                  id: 'device',
                  header: t('PlatformPeople.colDevice'),
                  cell: (event) => (
                    <IntelDeviceCell intel={event.intel} fallback={deviceOf(event.userAgent)} />
                  ),
                },
                {
                  id: 'location',
                  header: t('SessionIntel.colLocation'),
                  cell: (event) => <IntelLocationCell intel={event.intel} ip={event.ip} />,
                },
                {
                  id: 'network',
                  header: t('SessionIntel.colNetwork'),
                  cell: (event) => <IntelNetworkCell intel={event.intel} />,
                },
                {
                  id: 'signal',
                  header: t('SessionIntel.colSignal'),
                  cell: (event) => (
                    <SignalPill automation={event.intel?.automation} withScore withReasons />
                  ),
                },
              ]}
            />
          )}
        </section>
      </div>

      <div className="tm-cc-column">
        <section className="tm-cc-card tm-stack" aria-labelledby="pa06-twostep-title">
          <h3 id="pa06-twostep-title" className="tm-cc-card__title">
            {t('PlatformPeople.twoStepTitle')}
          </h3>
          {person.mfaEnabled ? (
            <>
              <StatusDot tone="success">
                {`${t('PlatformPeople.on')} · ${t('PlatformPeople.authenticatorApp')}`}
              </StatusDot>
              <p className="tm-cc-note">
                {`${facts.recoveryCodesLeft} ${t('PlatformPeople.recoveryLeft')} · ${t('PlatformPeople.setUp')} ${fullDay(facts.twoStepSetUpAt, locale)}`}
              </p>
            </>
          ) : (
            <>
              <StatusDot tone="neutral">{t('PlatformPeople.notSetUp')}</StatusDot>
              <InlineAlert tone="neutral">{t('PlatformPeople.notSetUpHint')}</InlineAlert>
            </>
          )}
          <Switch
            label={t('PlatformPeople.requireNextSignIn')}
            checked={person.twoStepRequired}
            disabled={!canSecure || require.isPending}
            onChange={(event) => require.mutate(event.target.checked)}
          />
          {require.isError ? (
            <InlineAlert tone="danger" live>
              {platformErrorText(require.error, t)}
            </InlineAlert>
          ) : null}
          {canSecure ? (
            <div>
              <Button
                type="button"
                tone="destructive"
                disabled={!person.mfaEnabled}
                onClick={() => {
                  setSignOutToo(false);
                  setPending({ kind: 'reset-two-step' });
                }}
              >
                {t('PlatformPeople.resetTwoStep')}
              </Button>
            </div>
          ) : null}
        </section>

        <section className="tm-cc-card tm-stack" aria-labelledby="pa06-password-title">
          <h3 id="pa06-password-title" className="tm-cc-card__title">
            {t('PlatformPeople.passwordTitle')}
          </h3>
          <p className="tm-cc-note">
            {facts.passwordSetAt
              ? `${t('PlatformPeople.lastChanged')} ${fullDay(facts.passwordSetAt, locale)}. `
              : ''}
            {t('PlatformPeople.passwordBody')}
          </p>
          {canSecure ? (
            <div>
              <Button
                type="button"
                tone="outline"
                onClick={() => setPending({ kind: 'reset-password' })}
              >
                {t('PlatformPeople.sendReset')}
              </Button>
            </div>
          ) : null}
        </section>

        <section className="tm-cc-card tm-stack" aria-labelledby="pa06-everywhere-title">
          <h3 id="pa06-everywhere-title" className="tm-cc-card__title">
            {t('PlatformPeople.signOutEverywhere')}
          </h3>
          <p className="tm-cc-note">{t('PlatformPeople.signOutBody')}</p>
          {canSecure ? (
            <div>
              <Button type="button" tone="outline" onClick={() => setPending({ kind: 'sign-out' })}>
                {t('PlatformPeople.signOutEverywhere')}
              </Button>
            </div>
          ) : null}
        </section>

        {person.status === 'active' && canSecure ? (
          <section
            className="tm-cc-card tm-cc-card--attention tm-stack"
            aria-labelledby="pa06-disable-title"
          >
            <h3 id="pa06-disable-title" className="tm-cc-card__title">
              {t('PlatformPeople.disableAccount')}
            </h3>
            <p className="tm-cc-note">{t('PlatformPeople.disableCardBody')}</p>
            <div>
              <Button
                type="button"
                tone="destructive"
                onClick={() => setPending({ kind: 'disable' })}
              >
                {t('PlatformPeople.disableAccount')}
              </Button>
            </div>
          </section>
        ) : null}
      </div>

      {(sessions.data?.sessions ?? [])
        .filter((session) => session.id === openSessionId)
        .map((session) => (
          <SessionIntelDrawer
            key={session.id}
            title={`${t('SessionIntel.sessionWord')} · ${person.displayName}`}
            subtitle={`${deviceOf(session.userAgent)} · ${t('SessionIntel.started')} ${dayAndTime(session.createdAt, locale)}`}
            intel={
              session.intel ?? {
                ipFirst: session.ipFirst,
                ipLast: session.ipLast,
                location: null,
                network: null,
                device: { browser: null, os: null, deviceType: 'unknown', raw: session.userAgent },
                automation: null,
              }
            }
            rawUserAgent={session.userAgent}
            csvUrl={trailCsvUrl}
            csvFileName={`sign-in-trail-${person.id}.csv`}
            printHref={printHref}
            onClose={() => setOpenSessionId(null)}
          />
        ))}
      {pending?.kind === 'end' ? (
        <ReasonDialog
          title={`${t('PlatformPeople.endTitle')} ${deviceOf(pending.session.userAgent)}?`}
          body={`${first} ${t('PlatformPeople.endBody')}`}
          reasonRequired
          destructive
          confirmLabel={t('PlatformPeople.endSession')}
          onConfirm={async (reason) => {
            await endPlatformPersonSession(api, person.id, pending.session.id, reason ?? '');
            await reloadAll();
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
      {pending?.kind === 'sign-out' ? (
        <ReasonDialog
          title={`${t('PlatformPeople.signOutTitle')} ${person.displayName}?`}
          body={t('PlatformPeople.signOutBody')}
          reasonRequired
          destructive
          confirmLabel={t('PlatformPeople.signOutEverywhere')}
          onConfirm={async (reason) => {
            await signOutPlatformPersonEverywhere(api, person.id, reason ?? '');
            await reloadAll();
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
      {pending?.kind === 'reset-password' ? (
        <ReasonDialog
          title={`${t('PlatformPeople.resetTitle')} ${person.displayName}?`}
          body={t('PlatformPeople.resetBody')}
          reasonRequired
          confirmLabel={t('PlatformPeople.sendReset')}
          onConfirm={async (reason) => {
            await sendPlatformPersonPasswordReset(api, person.id, reason ?? '');
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
      {pending?.kind === 'reset-two-step' ? (
        <PeopleReasonDialog
          eyebrow={t('PlatformPeople.destructiveEyebrow')}
          title={`${t('PlatformPeople.resetTwoStepTitle')} ${person.displayName}${t('PlatformPeople.resetTwoStepTitleEnd')}`}
          body={
            <p className="tm-cc-note">
              {`${t('PlatformPeople.resetTwoStepBody1')} ${facts.recoveryCodesLeft} ${t('PlatformPeople.resetTwoStepBody2')}`}
            </p>
          }
          extra={
            <Checkbox
              label={t('PlatformPeople.alsoSignOut')}
              checked={signOutToo}
              onChange={(event) => setSignOutToo(event.target.checked)}
            />
          }
          destructive
          confirmLabel={t('PlatformPeople.resetTwoStep')}
          note={t('PlatformPeople.reasonNote')}
          onConfirm={async (reason) => {
            await resetPlatformPersonTwoStep(api, person.id, { reason, signOut: signOutToo });
            await reloadAll();
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
      {pending?.kind === 'disable' ? (
        <DisableDialog
          person={person}
          first={first}
          onConfirm={async (reason) => {
            await disablePlatformPerson(api, person.id, reason);
            await reloadAll();
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}

function SessionState({ session }: { session: PlatformPersonSessionView }) {
  const t = useT();
  if (session.state !== 'live') {
    return <StatusDot tone="neutral">{t('PlatformPeople.stateEnded')}</StatusDot>;
  }
  const idle = Date.now() - new Date(session.lastActiveAt).getTime();
  if (idle < 15 * 60_000)
    return <StatusDot tone="live">{t('PlatformPeople.stateActiveNow')}</StatusDot>;
  if (idle < 7 * 86_400_000)
    return <StatusDot tone="success">{t('PlatformPeople.stateThisWeek')}</StatusDot>;
  return <StatusDot tone="neutral">{t('PlatformPeople.stateIdle')}</StatusDot>;
}
