'use client';

import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, LoadingRegion, Skeleton, StatusDot } from '@tmanage/ui';
import { ControlCenterShell, ccKey } from '../admin/ControlCenterShell';
import { PrivacyDialog, PrivacyPoints } from '../privacy/PrivacyDialog';
import { PrivacyStepUpDialog, isStepUpRefusal, usePrivacyStepUp } from '../privacy/PrivacyStepUp';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  cancelCompanyDeletion,
  privacyExportDownloadUrl,
  readPrivacyOverview,
  requestCompanyDeletion,
  requestPrivacyExport,
} from '../../lib/api/privacy';
import type {
  PrivacyDeletionView,
  PrivacyExportView,
  PrivacyMemberOptionView,
  PrivacyOverviewView,
} from '../../lib/api/privacy';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import {
  confirmsName,
  fill,
  firstNameOf,
  initialsOf,
  isSameDay,
  privacyClock,
  privacyDay,
  privacySize,
  progressShare,
} from '../../lib/privacy-presentation';
import '../privacy/privacy.css';

export interface PrivacyScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Injected in tests. Defaults to the real API origin. */
  baseUrl?: string;
  /** Injected in tests. */
  now?: () => Date;
}

type DialogState =
  | { readonly kind: 'export-company' }
  | { readonly kind: 'export-member'; readonly membershipId?: string }
  | { readonly kind: 'delete-company' }
  | { readonly kind: 'cancel-deletion' }
  | null;

type Tr = (key: string, english: string) => string;

/** The refusal a dialog shows when its write did not go through. */
function writeErrorText(tr: Tr, error: unknown): string {
  if (isStepUpRefusal(error)) {
    return tr('PrivacyStepUp.needed', 'Confirm it’s you to go on.');
  }
  if (error instanceof ApiRequestError) {
    const reason = error.details[0]?.message;
    if (error.status === 409 && reason === 'preparing') {
      return tr('PrivacyScreen.errorPreparing', 'An export is already being prepared.');
    }
    if (error.status === 409 && reason === 'scheduled') {
      return tr('PrivacyScreen.errorScheduled', 'A deletion is already scheduled.');
    }
    if (error.status === 400) {
      return tr('PrivacyScreen.errorName', 'Type the company name exactly as it is shown.');
    }
    if (error.status === 403) {
      return tr('PrivacyScreen.ownerOnly', 'Only company owners can use this page.');
    }
  }
  return tr('PrivacyScreen.errorGeneric', 'That did not go through. Try again.');
}

/**
 * **Privacy** — Control › Trust › Privacy (Figma F5, 390:24482 / 391:5561).
 *
 * Two columns: the company export and the company deletion on the left, one member's personal data
 * on the right. Every write answers with the whole page's state, so a dialog closes onto what the
 * API now holds. The archive is a plain download link to the API; no bytes pass through the app.
 * Only an owner may use the page — the API refuses anyone else, and the page says so in words.
 */
export function PrivacyScreen({
  organizationSlug,
  organizationName,
  client,
  baseUrl,
  now = () => new Date(),
}: PrivacyScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const tr = useTOr();
  const locale = useActiveLocale();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['privacy-overview', organizationSlug], [organizationSlug]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const close = useCallback(() => setDialog(null), []);

  const overview = useQuery({
    queryKey,
    queryFn: () => readPrivacyOverview(api, organizationSlug),
    retry: false,
    // While an archive is being built, look again now and then so the bar moves on its own.
    refetchInterval: (query) => {
      const data = query.state.data;
      const preparing =
        data?.companyExports.some((row) => row.state === 'preparing') ||
        data?.memberExports.some((row) => row.state === 'preparing');
      return preparing ? 15_000 : false;
    },
  });

  const settle = (data: PrivacyOverviewView) => {
    queryClient.setQueryData(queryKey, data);
    setDialog(null);
  };

  // The export and deletion requests need fresh proof (F28): a step-up refusal opens "Confirm it's
  // you" and the same request runs again with the token it returns.
  const stepUp = usePrivacyStepUp();
  const exportCompany = useMutation({
    mutationFn: () =>
      requestPrivacyExport(api, organizationSlug, { kind: 'company' }, stepUp.token()),
    onSuccess: settle,
    onError: (error) =>
      stepUp.ask(error, () => {
        exportCompany.mutate();
      }),
  });
  const exportMember = useMutation({
    mutationFn: (membershipId: string) =>
      requestPrivacyExport(api, organizationSlug, { kind: 'member', membershipId }, stepUp.token()),
    onSuccess: settle,
    onError: (error, membershipId) =>
      stepUp.ask(error, () => {
        exportMember.mutate(membershipId);
      }),
  });
  const deleteCompany = useMutation({
    mutationFn: (confirmName: string) =>
      requestCompanyDeletion(api, organizationSlug, confirmName, stepUp.token()),
    onSuccess: settle,
    onError: (error, confirmName) =>
      stepUp.ask(error, () => {
        deleteCompany.mutate(confirmName);
      }),
  });
  const cancelDeletion = useMutation({
    mutationFn: () => cancelCompanyDeletion(api, organizationSlug),
    onSuccess: settle,
  });

  const origin = baseUrl ?? apiBaseUrl();
  const downloadHref = (row: PrivacyExportView) =>
    privacyExportDownloadUrl(origin, organizationSlug, row.id);

  const data = overview.data;
  const name = data?.organizationName ?? organizationName;
  const refused = overview.error instanceof ApiRequestError && overview.error.status === 403;

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="privacy"
      crumbs={[t(ccKey('ControlCenter.privacy'))]}
      title={tr('PrivacyScreen.title', 'Privacy')}
      description={tr(
        'PrivacyScreen.description',
        "Get a copy of your company's data, or ask for it to be deleted.",
      )}
      client={api}
    >
      {overview.isPending ? (
        <LoadingRegion label={tr('PrivacyScreen.loading', 'Loading privacy settings')}>
          <div className="prv-layout">
            <div className="prv-column">
              <Skeleton height="320px" />
              <Skeleton height="180px" />
            </div>
            <div className="prv-side">
              <Skeleton height="420px" />
            </div>
          </div>
        </LoadingRegion>
      ) : refused ? (
        <InlineAlert tone="neutral">
          {tr('PrivacyScreen.ownerOnly', 'Only company owners can use this page.')}
        </InlineAlert>
      ) : !data ? (
        <InlineAlert tone="danger">
          {tr('PrivacyScreen.loadError', 'Privacy settings could not be loaded. Try again.')}
        </InlineAlert>
      ) : (
        <div className="prv-layout">
          <div className="prv-column">
            <CompanyExportCard
              data={data}
              name={name}
              tr={tr}
              locale={locale}
              now={now()}
              downloadHref={downloadHref}
              onRequest={() => setDialog({ kind: 'export-company' })}
            />
            <DeleteCompanyCard
              data={data}
              name={name}
              tr={tr}
              locale={locale}
              now={now()}
              downloadHref={downloadHref}
              onDelete={() => setDialog({ kind: 'delete-company' })}
              onCancel={() => setDialog({ kind: 'cancel-deletion' })}
              onExport={() => setDialog({ kind: 'export-company' })}
            />
          </div>
          <div className="prv-side">
            <MemberExportCard
              data={data}
              tr={tr}
              locale={locale}
              downloadHref={downloadHref}
              onExport={(membershipId) =>
                setDialog(
                  membershipId === undefined
                    ? { kind: 'export-member' }
                    : { kind: 'export-member', membershipId },
                )
              }
            />
          </div>
        </div>
      )}

      {data && dialog?.kind === 'export-company' ? (
        <ExportCompanyDialog
          name={name}
          linkDays={data.linkDays}
          tr={tr}
          pending={exportCompany.isPending}
          error={exportCompany.error}
          onClose={close}
          onConfirm={() => exportCompany.mutate()}
        />
      ) : null}
      {data && dialog?.kind === 'export-member' ? (
        <ExportMemberDialog
          members={data.members}
          initial={dialog.membershipId}
          linkDays={data.linkDays}
          tr={tr}
          pending={exportMember.isPending}
          error={exportMember.error}
          onClose={close}
          onConfirm={(membershipId) => exportMember.mutate(membershipId)}
        />
      ) : null}
      {data && dialog?.kind === 'delete-company' ? (
        <DeleteCompanyDialog
          name={name}
          memberCount={data.memberCount}
          graceDays={data.gracePeriodDays}
          deleteOn={privacyDay(
            new Date(now().getTime() + data.gracePeriodDays * 86_400_000).toISOString(),
            locale,
          )}
          tr={tr}
          pending={deleteCompany.isPending}
          error={deleteCompany.error}
          onClose={close}
          onConfirm={(typed) => deleteCompany.mutate(typed)}
        />
      ) : null}
      {data && dialog?.kind === 'cancel-deletion' ? (
        <CancelDeletionDialog
          name={name}
          tr={tr}
          pending={cancelDeletion.isPending}
          error={cancelDeletion.error}
          onClose={close}
          onConfirm={() => cancelDeletion.mutate()}
        />
      ) : null}
      {stepUp.open ? (
        <PrivacyStepUpDialog
          api={api}
          tr={tr}
          onConfirmed={stepUp.confirmed}
          onClose={stepUp.cancel}
        />
      ) : null}
    </ControlCenterShell>
  );
}

// ── Cards ────────────────────────────────────────────────────────────────────────────────────────

function CompanyExportCard({
  data,
  name,
  tr,
  locale,
  now,
  downloadHref,
  onRequest,
}: {
  data: PrivacyOverviewView;
  name: string;
  tr: Tr;
  locale: string;
  now: Date;
  downloadHref: (row: PrivacyExportView) => string;
  onRequest: () => void;
}) {
  const [current, ...rest] = data.companyExports;
  const live = current && (current.state === 'preparing' || current.state === 'ready');
  const earlier = live ? rest : data.companyExports;
  const preparing = current?.state === 'preparing';

  return (
    <section className="prv-card" aria-labelledby="prv-company-export">
      <div className="prv-card__head">
        <h2 id="prv-company-export" className="prv-card__title">
          {tr('PrivacyScreen.companyExportTitle', 'Company data export')}
        </h2>
        <p className="prv-card__body">
          {fill(
            tr(
              'PrivacyScreen.companyExportBody',
              'One file with everything in {org}: projects, tasks, chat, docs, files and members. Only owners can ask for it.',
            ),
            { org: name },
          )}
        </p>
      </div>

      {current && current.state === 'preparing' ? (
        <div className="prv-panel" role="status">
          <StatusDot tone="warning" className="prv-panel__state">
            {tr('PrivacyScreen.preparingTitle', 'Preparing your export')}
          </StatusDot>
          <p className="prv-panel__body">
            {fill(
              isSameDay(current.requestedAt, now)
                ? tr(
                    'PrivacyScreen.preparingBodyToday',
                    'Started today at {time} by {name}. This can take a few hours. We will email you when it is ready.',
                  )
                : tr(
                    'PrivacyScreen.preparingBodyDay',
                    'Started on {date} at {time} by {name}. This can take a few hours. We will email you when it is ready.',
                  ),
              {
                time: privacyClock(current.requestedAt),
                date: privacyDay(current.requestedAt, locale),
                name: current.requestedBy.displayName,
              },
            )}
          </p>
          <ProgressBar percent={current.progressPercent} />
          <p className="prv-panel__meta">
            {fill(tr('PrivacyScreen.progress', 'About {percent}% done'), {
              percent: Math.round(current.progressPercent),
            })}
          </p>
        </div>
      ) : null}

      {current && current.state === 'ready' ? (
        <div className="prv-panel">
          <StatusDot tone="success" className="prv-panel__state">
            {tr('PrivacyScreen.readyTitle', 'Ready to download')}
          </StatusDot>
          <p className="prv-panel__body">
            {fill(
              current.completedAt !== null && isSameDay(current.completedAt, now)
                ? tr(
                    'PrivacyScreen.readyBodyToday',
                    '{size} · made today at {time}. The download link works until {until}.',
                  )
                : tr(
                    'PrivacyScreen.readyBodyDay',
                    '{size} · made on {date}. The download link works until {until}.',
                  ),
              {
                size: privacySize(current.sizeBytes),
                time: privacyClock(current.completedAt ?? current.requestedAt),
                date: privacyDay(current.completedAt ?? current.requestedAt, locale),
                until: privacyDay(current.expiresAt ?? current.requestedAt, locale),
              },
            )}
          </p>
          <div className="prv-actions">
            <a className="tm-button tm-button--ink tm-button--default" href={downloadHref(current)}>
              {tr('PrivacyScreen.download', 'Download')}
            </a>
            <Button tone="outline" onClick={onRequest}>
              {tr('PrivacyScreen.requestNew', 'Request a new export')}
            </Button>
          </div>
        </div>
      ) : null}

      {current && current.state === 'failed' ? (
        <div className="prv-panel" role="status">
          <StatusDot tone="danger" className="prv-panel__state">
            {tr('PrivacyScreen.failedTitle', 'The export did not finish')}
          </StatusDot>
          <p className="prv-panel__body">
            {tr('PrivacyScreen.failedBody', 'Nothing was made. Ask for a new export to try again.')}
          </p>
        </div>
      ) : null}

      {current?.state === 'ready' ? null : (
        <div className="prv-actions">
          <Button tone="ink" disabled={preparing} onClick={onRequest}>
            {tr('PrivacyScreen.requestExport', 'Request export')}
          </Button>
        </div>
      )}

      {earlier.length > 0 ? (
        <div className="prv-earlier">
          <p className="prv-caption">
            {fill(tr('PrivacyScreen.earlier', 'Earlier exports · links work for {days} days'), {
              days: data.linkDays,
            })}
          </p>
          <ul className="prv-earlier__list">
            {earlier.map((row) => (
              <li key={row.id} className="prv-earlier__row">
                <span>
                  {privacyDay(row.requestedAt, locale)} · {row.requestedBy.displayName}
                </span>
                {row.state === 'ready' ? (
                  <a className="prv-link" href={downloadHref(row)}>
                    {tr('PrivacyScreen.download', 'Download')}
                  </a>
                ) : (
                  <Badge>
                    {row.state === 'failed'
                      ? tr('PrivacyScreen.badgeFailed', 'Did not finish')
                      : tr('PrivacyScreen.badgeExpired', 'Expired')}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div
      className="prv-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
    >
      <span className="prv-progress__fill" style={{ inlineSize: `${progressShare(percent)}%` }} />
    </div>
  );
}

function daysLeftText(tr: Tr, days: number): string {
  if (days <= 1) return tr('PrivacyScreen.daysLeftOne', '1 day left');
  return fill(tr('PrivacyScreen.daysLeft', '{days} days left'), { days });
}

function requestedLine(tr: Tr, deletion: PrivacyDeletionView, locale: string, now: Date): string {
  const values = {
    name: deletion.requestedBy.displayName,
    date: privacyDay(deletion.requestedAt, locale),
    left: daysLeftText(tr, deletion.daysLeft),
  };
  return fill(
    isSameDay(deletion.requestedAt, now)
      ? tr('PrivacyScreen.requestedToday', 'Requested today by {name} · {left}')
      : tr('PrivacyScreen.requestedDay', 'Requested on {date} by {name} · {left}'),
    values,
  );
}

function DeleteCompanyCard({
  data,
  name,
  tr,
  locale,
  now,
  downloadHref,
  onDelete,
  onCancel,
  onExport,
}: {
  data: PrivacyOverviewView;
  name: string;
  tr: Tr;
  locale: string;
  now: Date;
  downloadHref: (row: PrivacyExportView) => string;
  onDelete: () => void;
  onCancel: () => void;
  onExport: () => void;
}) {
  const deletion = data.deletion;
  const ready = data.companyExports.find((row) => row.state === 'ready');
  return (
    <section className="prv-card" aria-labelledby="prv-delete-company">
      <div className="prv-card__head">
        <h2 id="prv-delete-company" className="prv-card__title">
          {tr('PrivacyScreen.deleteTitle', 'Delete the company')}
        </h2>
        {deletion ? null : (
          <p className="prv-card__body">
            {fill(
              tr(
                'PrivacyScreen.deleteBody',
                'Deletes {org} and everything in it for all {count} members. You get {days} days to change your mind before anything is removed.',
              ),
              { org: name, count: data.memberCount, days: data.gracePeriodDays },
            )}
          </p>
        )}
      </div>
      {deletion ? (
        <>
          <InlineAlert tone="danger">
            {fill(
              tr(
                'PrivacyScreen.deletionScheduled',
                '{org} will be deleted on {date}. Until then everyone can keep working. You can cancel any time before that date.',
              ),
              { org: name, date: privacyDay(deletion.scheduledFor, locale) },
            )}
          </InlineAlert>
          <p className="prv-card__meta">{requestedLine(tr, deletion, locale, now)}</p>
          <div className="prv-actions">
            <Button tone="outline" onClick={onCancel}>
              {tr('PrivacyScreen.cancelDeletion', 'Cancel deletion')}
            </Button>
            {ready ? (
              <a
                className="tm-button tm-button--text tm-button--default"
                href={downloadHref(ready)}
              >
                {tr('PrivacyScreen.downloadCopyFirst', 'Download a copy first')}
              </a>
            ) : (
              <Button tone="text" onClick={onExport}>
                {tr('PrivacyScreen.downloadCopyFirst', 'Download a copy first')}
              </Button>
            )}
          </div>
        </>
      ) : (
        <div className="prv-actions">
          <Button tone="destructive" onClick={onDelete}>
            {tr('PrivacyScreen.requestDeletion', 'Request deletion')}
          </Button>
        </div>
      )}
    </section>
  );
}

function memberStatus(
  tr: Tr,
  row: PrivacyExportView,
  locale: string,
): { tone: 'success' | 'warning' | 'neutral' | 'danger'; text: string } {
  if (row.state === 'ready') {
    return {
      tone: 'success',
      text: fill(tr('PrivacyScreen.memberReady', 'Ready to download · until {date}'), {
        date: privacyDay(row.expiresAt ?? row.requestedAt, locale),
      }),
    };
  }
  if (row.state === 'preparing') {
    return { tone: 'warning', text: tr('PrivacyScreen.memberPreparing', 'Preparing') };
  }
  if (row.state === 'failed') {
    return { tone: 'danger', text: tr('PrivacyScreen.memberFailed', 'Did not finish') };
  }
  return {
    tone: 'neutral',
    text: fill(tr('PrivacyScreen.memberExpired', 'Expired on {date}'), {
      date: privacyDay(row.expiresAt ?? row.requestedAt, locale),
    }),
  };
}

function MemberExportCard({
  data,
  tr,
  locale,
  downloadHref,
  onExport,
}: {
  data: PrivacyOverviewView;
  tr: Tr;
  locale: string;
  downloadHref: (row: PrivacyExportView) => string;
  onExport: (membershipId?: string) => void;
}) {
  const membershipOf = (userId: string | undefined) =>
    data.members.find((member) => member.userId === userId)?.membershipId;
  return (
    <section className="prv-card" aria-labelledby="prv-member-export">
      <div className="prv-card__head">
        <h2 id="prv-member-export" className="prv-card__title">
          {tr('PrivacyScreen.memberTitle', 'Personal data for one member')}
        </h2>
        <p className="prv-card__body">
          {tr(
            'PrivacyScreen.memberBody',
            'A copy of what TManage keeps about one person: profile, messages they wrote, files they added and sign-in history. The file comes to you, not to them.',
          )}
        </p>
      </div>
      {data.memberExports.length > 0 ? (
        <ul className="prv-members">
          {data.memberExports.map((row) => {
            const person = row.subject?.displayName ?? '';
            const status = memberStatus(tr, row, locale);
            const again = membershipOf(row.subject?.userId);
            return (
              <li key={row.id} className="prv-members__row">
                <span className="prv-avatar" aria-hidden="true">
                  {initialsOf(person)}
                </span>
                <span className="prv-members__text">
                  <span className="prv-members__name">{person}</span>
                  <StatusDot tone={status.tone}>{status.text}</StatusDot>
                </span>
                {row.state === 'ready' ? (
                  <a className="prv-link" href={downloadHref(row)}>
                    {tr('PrivacyScreen.download', 'Download')}{' '}
                    <span className="tm-visually-hidden">{person}</span>
                  </a>
                ) : (row.state === 'expired' || row.state === 'failed') && again ? (
                  <button type="button" className="prv-link" onClick={() => onExport(again)}>
                    {tr('PrivacyScreen.askAgain', 'Ask again')}{' '}
                    <span className="tm-visually-hidden">{person}</span>
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="prv-actions">
        <Button tone="outline" onClick={() => onExport()}>
          {tr('PrivacyScreen.exportMember', "Export a member's data")}
        </Button>
      </div>
    </section>
  );
}

// ── Dialogs ──────────────────────────────────────────────────────────────────────────────────────

interface WriteDialogProps {
  tr: Tr;
  pending: boolean;
  error: unknown;
  onClose: () => void;
}

function ExportCompanyDialog({
  name,
  linkDays,
  tr,
  pending,
  error,
  onClose,
  onConfirm,
}: WriteDialogProps & { name: string; linkDays: number; onConfirm: () => void }) {
  return (
    <PrivacyDialog
      title={tr('PrivacyScreen.exportDialogTitle', 'Export all company data?')}
      lede={fill(
        tr('PrivacyScreen.exportDialogLede', 'We will make one file with everything in {org}.'),
        { org: name },
      )}
      onClose={onClose}
      actions={
        <>
          <Button tone="outline" onClick={onClose}>
            {tr('PrivacyScreen.cancel', 'Cancel')}
          </Button>
          <Button
            tone="ink"
            loading={pending}
            loadingLabel={tr('PrivacyScreen.starting', 'Starting the export')}
            onClick={onConfirm}
          >
            {tr('PrivacyScreen.startExport', 'Start export')}
          </Button>
        </>
      }
    >
      <PrivacyPoints
        label={tr('PrivacyScreen.whatToKnow', 'What to know')}
        points={[
          {
            tone: 'neutral',
            text: tr(
              'PrivacyScreen.exportPointIncludes',
              'Includes projects, tasks, chat, docs, files, members and the audit log.',
            ),
          },
          {
            tone: 'neutral',
            text: tr(
              'PrivacyScreen.exportPointHours',
              'It can take a few hours. We will email you when it is done.',
            ),
          },
          {
            tone: 'neutral',
            text: fill(
              tr(
                'PrivacyScreen.exportPointLink',
                'The download link works for {days} days, then it expires and you can ask again.',
              ),
              { days: linkDays },
            ),
          },
          {
            tone: 'warning',
            text: tr(
              'PrivacyScreen.exportPointPrivate',
              'The file holds private information about your team and clients. Keep it somewhere safe.',
            ),
          },
          {
            tone: 'neutral',
            text: tr(
              'PrivacyScreen.exportPointOwners',
              'Other owners can see that you asked for it.',
            ),
          },
        ]}
      />
      {error ? <InlineAlert tone="danger">{writeErrorText(tr, error)}</InlineAlert> : null}
    </PrivacyDialog>
  );
}

function memberLabel(member: PrivacyMemberOptionView): string {
  return member.jobTitle ? `${member.displayName} · ${member.jobTitle}` : member.displayName;
}

function ExportMemberDialog({
  members,
  initial,
  linkDays,
  tr,
  pending,
  error,
  onClose,
  onConfirm,
}: WriteDialogProps & {
  members: readonly PrivacyMemberOptionView[];
  initial: string | undefined;
  linkDays: number;
  onConfirm: (membershipId: string) => void;
}) {
  const [choice, setChoice] = useState<string>(initial ?? members[0]?.membershipId ?? '');
  const chosen = members.find((member) => member.membershipId === choice);
  const first = chosen ? firstNameOf(chosen.displayName) : '';
  return (
    <PrivacyDialog
      title={tr('PrivacyScreen.memberDialogTitle', "Export a member's data")}
      lede={tr(
        'PrivacyScreen.memberDialogLede',
        'Choose the person. You get one file with the personal data TManage keeps about them.',
      )}
      onClose={onClose}
      actions={
        <>
          <Button tone="outline" onClick={onClose}>
            {tr('PrivacyScreen.cancel', 'Cancel')}
          </Button>
          <Button
            tone="ink"
            disabled={!chosen}
            loading={pending}
            loadingLabel={tr('PrivacyScreen.starting', 'Starting the export')}
            onClick={() => (chosen ? onConfirm(chosen.membershipId) : undefined)}
          >
            {tr('PrivacyScreen.startExport', 'Start export')}
          </Button>
        </>
      }
    >
      <label className="prv-field">
        <span className="prv-field__label">{tr('PrivacyScreen.memberField', 'Member')}</span>
        <select
          className="prv-field__control"
          value={choice}
          onChange={(event) => setChoice(event.currentTarget.value)}
        >
          {members.map((member) => (
            <option key={member.membershipId} value={member.membershipId}>
              {memberLabel(member)}
            </option>
          ))}
        </select>
      </label>
      <PrivacyPoints
        points={[
          {
            tone: 'neutral',
            text: tr(
              'PrivacyScreen.memberPointCovers',
              'Covers their profile, messages they wrote, files they added and sign-in history.',
            ),
          },
          {
            tone: 'neutral',
            text: fill(
              tr(
                'PrivacyScreen.memberPointToYou',
                'The file comes to you, not to {first}. Send it to them yourself if they asked.',
              ),
              { first },
            ),
          },
          {
            tone: 'neutral',
            text: fill(
              tr('PrivacyScreen.memberPointLink', 'The download link works for {days} days.'),
              { days: linkDays },
            ),
          },
        ]}
      />
      {error ? <InlineAlert tone="danger">{writeErrorText(tr, error)}</InlineAlert> : null}
    </PrivacyDialog>
  );
}

function DeleteCompanyDialog({
  name,
  memberCount,
  graceDays,
  deleteOn,
  tr,
  pending,
  error,
  onClose,
  onConfirm,
}: WriteDialogProps & {
  name: string;
  memberCount: number;
  graceDays: number;
  deleteOn: string;
  onConfirm: (typed: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const matches = confirmsName(typed, name);
  return (
    <PrivacyDialog
      title={fill(tr('PrivacyScreen.deleteDialogTitle', 'Delete {org}?'), { org: name })}
      lede={tr(
        'PrivacyScreen.deleteDialogLede',
        'Please read this first. Deleting the company affects everyone.',
      )}
      onClose={onClose}
      actions={
        <>
          <Button tone="outline" onClick={onClose}>
            {tr('PrivacyScreen.keepCompany', 'Keep the company')}
          </Button>
          <Button
            tone="destructive"
            disabled={!matches}
            loading={pending}
            loadingLabel={tr('PrivacyScreen.requesting', 'Requesting deletion')}
            onClick={() => (matches ? onConfirm(typed) : undefined)}
          >
            {tr('PrivacyScreen.requestDeletion', 'Request deletion')}
          </Button>
        </>
      }
    >
      <PrivacyPoints
        points={[
          {
            tone: 'danger',
            text: fill(
              tr(
                'PrivacyScreen.deletePointAll',
                'All projects, tasks, chat, docs and files are deleted for all {count} members.',
              ),
              { count: memberCount },
            ),
          },
          {
            tone: 'danger',
            text: tr(
              'PrivacyScreen.deletePointPortals',
              'Client portals stop working and clients lose access.',
            ),
          },
          {
            tone: 'danger',
            text: tr(
              'PrivacyScreen.deletePointBilling',
              'Billing stops. You are not charged after the deletion date.',
            ),
          },
          {
            tone: 'danger',
            text: fill(
              tr(
                'PrivacyScreen.deletePointGrace',
                'You have {days} days to cancel. After {date} it cannot be undone.',
              ),
              { days: graceDays, date: deleteOn },
            ),
          },
        ]}
      />
      <InlineAlert tone="neutral">
        {tr(
          'PrivacyScreen.deleteCopyFirst',
          'Want a copy? Download a full company export before you go on.',
        )}
      </InlineAlert>
      <label className="prv-field">
        <span className="prv-field__label">
          {fill(tr('PrivacyScreen.typeToConfirm', 'Type {org} to confirm'), { org: name })}
        </span>
        <input
          className="prv-field__control"
          value={typed}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setTyped(event.currentTarget.value)}
        />
      </label>
      {error ? <InlineAlert tone="danger">{writeErrorText(tr, error)}</InlineAlert> : null}
    </PrivacyDialog>
  );
}

function CancelDeletionDialog({
  name,
  tr,
  pending,
  error,
  onClose,
  onConfirm,
}: WriteDialogProps & { name: string; onConfirm: () => void }) {
  return (
    <PrivacyDialog
      title={tr('PrivacyScreen.cancelDialogTitle', 'Cancel the deletion?')}
      lede={fill(
        tr(
          'PrivacyScreen.cancelDialogLede',
          '{org} stays as it is. Nothing is deleted and everyone keeps working.',
        ),
        { org: name },
      )}
      onClose={onClose}
      actions={
        <>
          <Button tone="outline" onClick={onClose}>
            {tr('PrivacyScreen.notNow', 'Not now')}
          </Button>
          <Button
            tone="ink"
            loading={pending}
            loadingLabel={tr('PrivacyScreen.cancelling', 'Cancelling the deletion')}
            onClick={onConfirm}
          >
            {tr('PrivacyScreen.cancelDeletion', 'Cancel deletion')}
          </Button>
        </>
      }
    >
      <PrivacyPoints
        points={[
          {
            tone: 'neutral',
            text: tr(
              'PrivacyScreen.cancelPointOwners',
              'Other owners get a message that the deletion was cancelled.',
            ),
          },
        ]}
      />
      {error ? <InlineAlert tone="danger">{writeErrorText(tr, error)}</InlineAlert> : null}
    </PrivacyDialog>
  );
}
