'use client';

import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, Select } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { describeApiErrorNow } from '../../lib/api/describe-error';
import {
  APP_VERSION,
  SUPPORT_CATEGORIES,
  SUPPORT_PRIORITIES,
  cleanFromPath,
  closeSupportThread,
  createSupportThread,
  fetchSupportThread,
  fetchSupportThreads,
  postSupportMessage,
  projectIdFromPath,
  supportThreadKey,
  supportThreadsKey,
} from '../../lib/api/support';
import type {
  SupportCategory,
  SupportPolicy,
  SupportPriority,
  SupportThread,
  SupportThreadDetail,
} from '../../lib/api/support';
import { ATTACHMENT_ACCEPT, attachmentProblem, uploadProjectFile } from '../../lib/api/uploads';
import { appDateLocale, appLocale } from '../../lib/i18n/app-locale';
import { localizedRouteTitle } from '../../lib/route-titles';
import {
  REQUEST_STATE_TONE,
  requestState,
  slaSummary,
  targetWording,
} from '../../lib/support-sla-text';
import type { RequestState } from '../../lib/support-sla-text';
import { AppShell } from '../shell/AppShell';
import { SupportBadge } from './SupportBadge';
import { isToday, planName, shortWhen, useSupportText } from './support-text';
import { SUPPORT_EMAIL } from '../../lib/public-contact';
import './support.css';

/**
 * Plan row 57-10 · **Get help** (`/{orgSlug}/help`, Figma 614:35008). A person opens a request to
 * the TManage team (topic, subject, priority, message, the page they came from), sees their own
 * requests with the response promise the API computes (business hours, Sun–Thu 09:00–18:00), and
 * opens one to read the team's replies and answer. The help menu's "Contact support" leads here
 * with `?from=<page>`; the reply e-mail links here with `?request=<id>`.
 */

const ID_PATTERN = /^[0-9a-f-]{36}$/iu;

export function GetHelpScreen({
  organizationSlug,
  organizationName,
  from,
  request,
  client,
}: {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly from?: string | undefined;
  readonly request?: string | undefined;
  readonly client?: ApiClient;
}) {
  const text = useSupportText();
  const { tOr } = text;
  const api = useMemo(() => client ?? browserApiClient(), [client]);
  const [selected, setSelected] = useState<string | null>(
    request && ID_PATTERN.test(request) ? request : null,
  );
  const contextPath = cleanFromPath(from, organizationSlug);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={tOr('GetHelp.eyebrow', 'Help')}
      title={tOr('GetHelp.title', 'Get help')}
      description={tOr(
        'GetHelp.description',
        'A person from the TManage team replies to every request.',
      )}
      actions={
        <a className="tm-button tm-button--outline tm-button--default" href="/help">
          {tOr('GetHelp.browseArticles', 'Browse help articles')}
        </a>
      }
    >
      <div className="tm-gethelp">
        <NewRequestCard
          api={api}
          organizationSlug={organizationSlug}
          contextPath={contextPath}
          onCreated={setSelected}
        />
        <section className="tm-gethelp-card" aria-labelledby="tm-gethelp-requests">
          {selected ? (
            <RequestThread
              api={api}
              organizationSlug={organizationSlug}
              id={selected}
              onBack={() => setSelected(null)}
            />
          ) : (
            <RequestList api={api} organizationSlug={organizationSlug} onOpen={setSelected} />
          )}
        </section>
      </div>
    </AppShell>
  );
}

function NewRequestCard({
  api,
  organizationSlug,
  contextPath,
  onCreated,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly contextPath: string | null;
  readonly onCreated: (id: string) => void;
}) {
  const text = useSupportText();
  const { tOr } = text;
  const queryClient = useQueryClient();
  const messageId = useId();
  const [category, setCategory] = useState<SupportCategory>('question');
  const [priority, setPriority] = useState<SupportPriority>('normal');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [attachPage, setAttachPage] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const pageTitle = contextPath
    ? (localizedRouteTitle(contextPath, appLocale()) ?? contextPath)
    : null;

  const send = useMutation({
    mutationFn: () =>
      createSupportThread(api, organizationSlug, {
        category,
        priority,
        subject: subject.trim(),
        message: message.trim(),
        contextPath: attachPage ? contextPath : null,
        appVersion: APP_VERSION,
        attachmentFileId: null,
      }),
    onSuccess: (detail: SupportThreadDetail) => {
      setSubject('');
      setMessage('');
      void queryClient.invalidateQueries({ queryKey: supportThreadsKey(organizationSlug) });
      onCreated(detail.thread.id);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (subject.trim() === '' || message.trim() === '') {
      setProblem(tOr('GetHelp.required', 'Write a subject and tell us what is happening.'));
      return;
    }
    setProblem(null);
    send.mutate();
  };

  return (
    <section className="tm-gethelp-card" aria-labelledby="tm-gethelp-new">
      <h2 id="tm-gethelp-new" className="tm-gethelp-card__title">
        {tOr('GetHelp.newRequest', 'New request')}
      </h2>
      <form className="tm-support-stack" onSubmit={submit} noValidate>
        <Select
          label={tOr('GetHelp.topic', 'Topic')}
          value={category}
          onChange={(event) => setCategory(event.target.value as SupportCategory)}
        >
          {SUPPORT_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {text.category(value)}
            </option>
          ))}
        </Select>
        <Field
          label={tOr('Support.subject', 'Subject')}
          placeholder={tOr('Support.subjectPlaceholder', 'What do you need help with?')}
          value={subject}
          maxLength={160}
          onChange={(event) => setSubject(event.target.value)}
        />
        <div className="tm-support-textarea">
          <label htmlFor={messageId}>{tOr('GetHelp.whatsHappening', 'What’s happening?')}</label>
          <textarea
            id={messageId}
            rows={5}
            maxLength={5000}
            value={message}
            placeholder={tOr(
              'Support.messagePlaceholder',
              'Tell us what happened and what you expected to happen.',
            )}
            onChange={(event) => setMessage(event.target.value)}
          />
        </div>
        <Select
          label={tOr('GetHelp.priority', 'How urgent is it?')}
          value={priority}
          onChange={(event) => setPriority(event.target.value as SupportPriority)}
        >
          {SUPPORT_PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {text.priority(value)}
            </option>
          ))}
        </Select>
        {pageTitle ? (
          <Checkbox
            label={text.fill(tOr('GetHelp.attachPage', 'Attach the page I was on: {page}'), {
              page: pageTitle,
            })}
            checked={attachPage}
            onChange={(event) => setAttachPage(event.target.checked)}
          />
        ) : null}
        <p className="tm-support-muted">
          {tOr(
            'GetHelp.noPasswords',
            'Please don’t send passwords. You can add screenshots after you send.',
          )}
        </p>
        {problem ? <InlineAlert tone="danger">{problem}</InlineAlert> : null}
        {send.isError ? (
          <InlineAlert tone="danger">{describeApiErrorNow(send.error)}</InlineAlert>
        ) : null}
        <Button type="submit" tone="ink" className="tm-gethelp-send" disabled={send.isPending}>
          {send.isPending
            ? tOr('Support.sending', 'Sending…')
            : tOr('GetHelp.send', 'Send request')}
        </Button>
      </form>
    </section>
  );
}

function useMemberStateText(): (state: RequestState) => string {
  const { tOr } = useSupportText();
  return (state) =>
    ({
      resolved: tOr('GetHelp.stateResolved', 'Resolved'),
      withCustomer: tOr('Support.statusWaiting', 'Waiting for you'),
      late: tOr('GetHelp.stateAwaiting', 'Waiting for our reply'),
      awaitingReply: tOr('GetHelp.stateAwaiting', 'Waiting for our reply'),
      newReply: tOr('GetHelp.stateAwaiting', 'Waiting for our reply'),
      answered: tOr('GetHelp.stateAnswered', 'Answered'),
    })[state];
}

/** The response line under the badge: when we reply by, how late, or how fast we answered. */
function SlaLine({ thread }: { readonly thread: SupportThread }) {
  const text = useSupportText();
  const { tOr } = text;
  const summary = slaSummary(thread);
  if (summary.kind === 'due') {
    const when = isToday(summary.dueAt)
      ? text.fill(tOr('GetHelp.todayAt', '{time} today'), { time: shortWhen(summary.dueAt, true) })
      : shortWhen(summary.dueAt, true);
    return (
      <span className="tm-sla-line tm-sla-line--due">
        {text.fill(tOr('GetHelp.replyBy', 'Reply by {when} · {left} left'), {
          when,
          left: text.duration(summary.minutes),
        })}
      </span>
    );
  }
  if (summary.kind === 'late') {
    return (
      <span className="tm-sla-line tm-sla-line--late">
        {text.fill(tOr('GetHelp.lateBy', 'Our reply is {late} late. We are on it.'), {
          late: text.duration(summary.minutes),
        })}
      </span>
    );
  }
  if (summary.kind === 'answered') {
    return (
      <span className="tm-sla-line tm-sla-line--answered">
        {text.fill(tOr('GetHelp.answeredIn', 'Answered in {time}'), {
          time: text.duration(summary.minutes),
        })}
      </span>
    );
  }
  return null;
}

function PolicyBox({ policy }: { readonly policy: SupportPolicy }) {
  const text = useSupportText();
  const { tOr } = text;
  const zone = policy.timezone.split('/').pop()?.replace(/_/gu, ' ') ?? policy.timezone;
  return (
    <div className="tm-gethelp-policy">
      <span className="tm-gethelp-policy__plan">
        {text.fill(tOr('GetHelp.planName', '{plan} plan'), { plan: planName(policy.plan) })}
      </span>
      <span>
        {targetWording(policy.firstResponseMinutes).kind === 'sameDay'
          ? tOr('GetHelp.promiseSameDay', 'We reply the same business day.')
          : text.fill(tOr('GetHelp.promiseWithin', 'We reply within {target}.'), {
              target: text.target(policy.firstResponseMinutes),
            })}{' '}
        {text.fill(tOr('GetHelp.clock', 'The clock runs Sun–Thu, 9:00–18:00 {zone} time.'), {
          zone,
        })}
      </span>
    </div>
  );
}

function RequestList({
  api,
  organizationSlug,
  onOpen,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly onOpen: (id: string) => void;
}) {
  const text = useSupportText();
  const { tOr } = text;
  const stateText = useMemberStateText();
  const list = useQuery({
    queryKey: supportThreadsKey(organizationSlug),
    queryFn: () => fetchSupportThreads(api, organizationSlug),
    refetchInterval: 60_000,
  });
  return (
    <div className="tm-support-stack">
      <h2 id="tm-gethelp-requests" className="tm-gethelp-card__title">
        {tOr('GetHelp.yourRequests', 'Your requests')}
      </h2>
      {list.isPending ? (
        <p className="tm-support-muted">{tOr('GetHelp.loading', 'Loading your requests')}</p>
      ) : list.isError ? (
        <InlineAlert tone="danger">{describeApiErrorNow(list.error)}</InlineAlert>
      ) : (
        <>
          <PolicyBox policy={list.data.policy} />
          {list.data.threads.length === 0 ? (
            <p className="tm-support-muted">
              {tOr(
                'GetHelp.empty',
                'No requests yet. When you write to us, you can follow the answer here.',
              )}
            </p>
          ) : (
            <ul
              className="tm-gethelp-requests"
              aria-label={tOr('GetHelp.yourRequests', 'Your requests')}
            >
              {list.data.threads.map((thread) => {
                const state = requestState(thread);
                return (
                  <li key={thread.id}>
                    <button
                      type="button"
                      className="tm-gethelp-request"
                      onClick={() => onOpen(thread.id)}
                    >
                      <span className="tm-gethelp-request__text">
                        <span className="tm-gethelp-request__subject">{thread.subject}</span>
                        <span className="tm-support-muted">
                          {text.fill(
                            isToday(thread.createdAt)
                              ? tOr('GetHelp.openedToday', 'Opened today at {when}')
                              : tOr('GetHelp.opened', 'Opened {when}'),
                            { when: shortWhen(thread.createdAt, false) },
                          )}
                          {` · ${text.category(thread.category)}`}
                          {!thread.mine && thread.startedByName ? ` · ${thread.startedByName}` : ''}
                        </span>
                      </span>
                      <span className="tm-gethelp-request__state">
                        <SupportBadge tone={REQUEST_STATE_TONE[state]}>
                          {stateText(state)}
                        </SupportBadge>
                        {thread.status === 'closed' ? null : <SlaLine thread={thread} />}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function RequestThread({
  api,
  organizationSlug,
  id,
  onBack,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly id: string;
  readonly onBack: () => void;
}) {
  const text = useSupportText();
  const { tOr } = text;
  const stateText = useMemberStateText();
  const queryClient = useQueryClient();
  const replyId = useId();
  const [reply, setReply] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: supportThreadKey(organizationSlug, id),
    queryFn: () => fetchSupportThread(api, organizationSlug, id),
    refetchInterval: 60_000,
  });
  const projectId = projectIdFromPath(detail.data?.thread.contextPath ?? '');
  const refresh = (data: SupportThreadDetail) => {
    queryClient.setQueryData(supportThreadKey(organizationSlug, id), data);
    void queryClient.invalidateQueries({ queryKey: supportThreadsKey(organizationSlug) });
  };
  const send = useMutation({
    mutationFn: async () => {
      const attachmentFileId =
        file && projectId
          ? await uploadProjectFile(api, organizationSlug, { projectId, file })
          : null;
      return postSupportMessage(api, organizationSlug, id, reply.trim(), attachmentFileId);
    },
    onSuccess: (data) => {
      setReply('');
      setFile(null);
      refresh(data);
    },
  });
  const close = useMutation({
    mutationFn: () => closeSupportThread(api, organizationSlug, id),
    onSuccess: refresh,
  });

  return (
    <div className="tm-support-stack">
      <div>
        <Button type="button" tone="text" onClick={onBack}>
          {tOr('GetHelp.back', 'All requests')}
        </Button>
      </div>
      {detail.isPending ? (
        <p className="tm-support-muted">
          {tOr('Support.loadingThread', 'Loading the conversation')}
        </p>
      ) : detail.isError ? (
        <InlineAlert tone="danger">{describeApiErrorNow(detail.error)}</InlineAlert>
      ) : (
        <>
          <div className="tm-support-thread-head">
            <h2 id="tm-gethelp-requests" className="tm-support-thread-head__subject">
              {detail.data.thread.subject}
            </h2>
            <span className="tm-gethelp-request__state">
              <SupportBadge tone={REQUEST_STATE_TONE[requestState(detail.data.thread)]}>
                {stateText(requestState(detail.data.thread))}
              </SupportBadge>
              {detail.data.thread.status === 'closed' ? null : (
                <SlaLine thread={detail.data.thread} />
              )}
            </span>
          </div>
          <p className="tm-support-muted">
            {`${text.category(detail.data.thread.category)} · ${text.priority(detail.data.thread.priority)}`}
          </p>
          <ol className="tm-support-messages">
            {detail.data.messages.map((message) => (
              <li
                key={message.id}
                className={`tm-support-message tm-support-message--${message.authorKind}`}
              >
                <p className="tm-support-message__meta">
                  <strong>
                    {message.authorKind === 'platform'
                      ? tOr('Support.teamName', 'TManage support')
                      : message.mine
                        ? tOr('Support.you', 'You')
                        : (message.authorName ?? '')}
                  </strong>{' '}
                  <time dateTime={message.createdAt}>
                    {new Date(message.createdAt).toLocaleString(
                      appDateLocale(appLocale(), appLocale()),
                    )}
                  </time>
                </p>
                <p className="tm-support-message__body">{message.body}</p>
                {message.attachmentName ? (
                  <p className="tm-support-muted">{message.attachmentName}</p>
                ) : null}
              </li>
            ))}
          </ol>
          {detail.data.thread.mine ? (
            <form
              noValidate
              className="tm-support-stack"
              onSubmit={(event) => {
                event.preventDefault();
                if (reply.trim() !== '') send.mutate();
              }}
            >
              <div className="tm-support-textarea">
                <label htmlFor={replyId}>{tOr('Support.replyLabel', 'Your reply')}</label>
                <textarea
                  id={replyId}
                  rows={3}
                  maxLength={5000}
                  value={reply}
                  placeholder={tOr('Support.replyPlaceholder', 'Write a reply')}
                  onChange={(event) => setReply(event.target.value)}
                />
              </div>
              {projectId ? (
                <div className="tm-support-attach">
                  <label className="tm-support-attach__label">
                    {tOr('Support.attach', 'Attach a screenshot')}
                    <input
                      type="file"
                      accept={ATTACHMENT_ACCEPT}
                      onChange={(event) => {
                        const picked = event.target.files?.[0] ?? null;
                        const issue = picked ? attachmentProblem(picked) : null;
                        setProblem(issue);
                        setFile(issue ? null : picked);
                      }}
                    />
                  </label>
                  <span className="tm-support-muted">
                    {file
                      ? file.name
                      : tOr('Support.attachHint', 'Optional · PNG or JPG, saved in this project')}
                  </span>
                </div>
              ) : null}
              {problem ? <InlineAlert tone="danger">{problem}</InlineAlert> : null}
              {send.isError ? (
                <InlineAlert tone="danger">{describeApiErrorNow(send.error)}</InlineAlert>
              ) : null}
              <div className="tm-support-actions">
                {detail.data.thread.status !== 'closed' ? (
                  <Button
                    type="button"
                    tone="text"
                    onClick={() => close.mutate()}
                    disabled={close.isPending}
                  >
                    {tOr('GetHelp.markResolved', 'Mark as resolved')}
                  </Button>
                ) : null}
                <Button type="submit" tone="ink" disabled={send.isPending || reply.trim() === ''}>
                  {tOr('Support.sendReply', 'Send reply')}
                </Button>
              </div>
            </form>
          ) : null}
          <p className="tm-support-muted">
            {tOr('Support.mailNotice', `You also get replies by e-mail from ${SUPPORT_EMAIL}.`)}
          </p>
        </>
      )}
    </div>
  );
}
