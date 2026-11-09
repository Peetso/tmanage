'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { describeApiErrorNow } from '../../lib/api/describe-error';
import {
  APP_VERSION,
  closeSupportThread,
  createSupportThread,
  fetchSupportThread,
  fetchSupportThreads,
  postSupportMessage,
  projectIdFromPath,
  supportThreadKey,
  supportThreadsKey,
} from '../../lib/api/support';
import type { SupportStatus, SupportThread, SupportThreadDetail } from '../../lib/api/support';
import { ATTACHMENT_ACCEPT, attachmentProblem, uploadProjectFile } from '../../lib/api/uploads';
import { useHelpContextArticle } from '../help/HelpContextLink';
import { useTOr } from '../../lib/i18n/use-t-or';
import './support.css';

/**
 * Row 55-17 — the shell's help menu ("Help centre", "Contact support") and the support panel
 * (Figma R39 L2-55-17-support). The panel writes to the TManage team: subject, message, an
 * optional screenshot through the existing upload pipeline (on a project page, where the upload
 * has a home), and the context that is sent with it — workspace, page, app version — shown before
 * sending. Replies appear in the same panel; the API also sends the notification and e-mail.
 * The address `?support=<threadId>` (the e-mail's link) opens the panel on that conversation.
 */

type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'new' }
  | { readonly kind: 'thread'; readonly id: string };

const CAPSULE: Record<SupportStatus, CapsuleState> = {
  open: 'current',
  waiting: 'waiting',
  closed: 'done',
};

export function useSupportStatusText(): (status: SupportStatus) => string {
  const tOr = useTOr();
  return (status) =>
    status === 'open'
      ? tOr('Support.statusOpen', 'With the team')
      : status === 'waiting'
        ? tOr('Support.statusWaiting', 'Waiting for you')
        : tOr('Support.statusClosed', 'Closed');
}

function readPath(): string {
  return typeof window === 'undefined' ? '/' : window.location.pathname;
}

function errorText(error: unknown): string {
  return describeApiErrorNow(error);
}

export function SupportLauncher({
  organizationSlug,
  client,
  pathname,
}: {
  readonly organizationSlug: string;
  readonly client?: ApiClient;
  readonly pathname?: string;
}) {
  const tOr = useTOr();
  const api = useMemo(() => client ?? browserApiClient(), [client]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<View | null>(null);
  const menuId = useId();
  const screenGuide = useHelpContextArticle(pathname);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const id = new URLSearchParams(window.location.search).get('support');
    if (id && /^[0-9a-f-]{36}$/iu.test(id)) setPanel({ kind: 'thread', id });
  }, []);

  return (
    <div className="tm-support-launcher">
      <button
        type="button"
        className="tm-support-launcher__trigger"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuId}
        onClick={() => setMenuOpen((open) => !open)}
      >
        {tOr('Support.menuLabel', 'Help')}
      </button>
      {menuOpen ? (
        <ul id={menuId} role="menu" className="tm-support-menu">
          {/* FIX3 item 10: the guide for this screen (the old "?" beside the title) is the menu's
              first entry, so the header has one help button. */}
          {screenGuide ? (
            <li role="none">
              <a
                role="menuitem"
                className="tm-support-menu__item"
                href={screenGuide.href}
                target="_blank"
                rel="noopener noreferrer"
                data-help-slug={screenGuide.slug}
              >
                {tOr('Support.screenGuide', 'Guide for this screen')}
              </a>
            </li>
          ) : null}
          <li role="none">
            <a
              role="menuitem"
              className="tm-support-menu__item"
              href="/help"
              target="_blank"
              rel="noopener noreferrer"
            >
              {tOr('Support.helpCentre', 'Help centre')}
            </a>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="tm-support-menu__item tm-support-menu__item--accent"
              onClick={() => {
                setMenuOpen(false);
                setPanel({ kind: 'list' });
              }}
            >
              {tOr('Support.contact', 'Contact support')}
            </button>
          </li>
        </ul>
      ) : null}
      {panel ? (
        <SupportPanel
          api={api}
          organizationSlug={organizationSlug}
          pathname={pathname ?? readPath()}
          view={panel}
          onView={setPanel}
          onClose={() => setPanel(null)}
        />
      ) : null}
    </div>
  );
}

export function SupportPanel({
  api,
  organizationSlug,
  pathname,
  view,
  onView,
  onClose,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly pathname: string;
  readonly view: View;
  readonly onView: (view: View) => void;
  readonly onClose: () => void;
}) {
  const tOr = useTOr();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="tm-support-scrim">
      <div
        ref={ref}
        className="tm-support-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="tm-support-panel__head">
          <h2 id={titleId} className="tm-support-panel__title">
            {tOr('Support.title', 'Contact support')}
          </h2>
          <Button type="button" tone="text" onClick={onClose}>
            {tOr('Support.closePanel', 'Close')}
          </Button>
        </div>
        {view.kind === 'new' ? (
          <NewThreadForm
            api={api}
            organizationSlug={organizationSlug}
            pathname={pathname}
            onCancel={() => onView({ kind: 'list' })}
            onCreated={(id) => onView({ kind: 'thread', id })}
          />
        ) : view.kind === 'thread' ? (
          <ThreadView
            api={api}
            organizationSlug={organizationSlug}
            id={view.id}
            onBack={() => onView({ kind: 'list' })}
          />
        ) : (
          <ThreadList
            api={api}
            organizationSlug={organizationSlug}
            onNew={() => onView({ kind: 'new' })}
            onOpen={(id) => onView({ kind: 'thread', id })}
          />
        )}
      </div>
    </div>
  );
}

function ThreadList({
  api,
  organizationSlug,
  onNew,
  onOpen,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly onNew: () => void;
  readonly onOpen: (id: string) => void;
}) {
  const tOr = useTOr();
  const statusText = useSupportStatusText();
  const list = useQuery({
    queryKey: supportThreadsKey(organizationSlug),
    queryFn: () => fetchSupportThreads(api, organizationSlug),
  });
  return (
    <div className="tm-support-stack">
      <p className="tm-support-muted">
        {tOr(
          'Support.intro',
          'Write to the TManage team. We usually answer within one working day.',
        )}
      </p>
      <div>
        <Button type="button" tone="ink" onClick={onNew}>
          {tOr('Support.newConversation', 'New conversation')}
        </Button>
      </div>
      {list.isPending ? (
        <p className="tm-support-muted">{tOr('Support.loading', 'Loading your conversations')}</p>
      ) : list.isError ? (
        <InlineAlert tone="danger">{errorText(list.error)}</InlineAlert>
      ) : list.data.length === 0 ? (
        <p className="tm-support-muted">
          {tOr('Support.empty', 'You have not written to support yet.')}
        </p>
      ) : (
        <ul
          className="tm-support-threads"
          aria-label={tOr('Support.listLabel', 'Your conversations')}
        >
          {list.data.map((thread: SupportThread) => (
            <li key={thread.id}>
              <button
                type="button"
                className="tm-support-thread-row"
                onClick={() => onOpen(thread.id)}
              >
                <span className="tm-support-thread-row__text">
                  <span className="tm-support-thread-row__subject">{thread.subject}</span>
                  {!thread.mine && thread.startedByName ? (
                    <span className="tm-support-muted">{thread.startedByName}</span>
                  ) : null}
                </span>
                <StateCapsule state={CAPSULE[thread.status]}>
                  {statusText(thread.status)}
                </StateCapsule>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function NewThreadForm({
  api,
  organizationSlug,
  pathname,
  onCancel,
  onCreated,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly pathname: string;
  readonly onCancel: () => void;
  readonly onCreated: (id: string) => void;
}) {
  const tOr = useTOr();
  const queryClient = useQueryClient();
  const messageId = useId();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const projectId = projectIdFromPath(pathname);

  const send = useMutation({
    mutationFn: async () => {
      const attachmentFileId =
        file && projectId
          ? await uploadProjectFile(api, organizationSlug, { projectId, file })
          : null;
      return createSupportThread(api, organizationSlug, {
        subject: subject.trim(),
        message: message.trim(),
        contextPath: pathname,
        appVersion: APP_VERSION,
        attachmentFileId,
      });
    },
    onSuccess: (detail: SupportThreadDetail) => {
      void queryClient.invalidateQueries({ queryKey: supportThreadsKey(organizationSlug) });
      onCreated(detail.thread.id);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (subject.trim() === '' || message.trim() === '') {
      setProblem(tOr('Support.required', 'Write a subject and a message.'));
      return;
    }
    setProblem(null);
    send.mutate();
  };

  return (
    <form className="tm-support-stack" onSubmit={submit} noValidate>
      <Field
        label={tOr('Support.subject', 'Subject')}
        hint={tOr('Support.subjectHint', 'A short line, up to 160 characters.')}
        placeholder={tOr('Support.subjectPlaceholder', 'What do you need help with?')}
        value={subject}
        maxLength={160}
        onChange={(event) => setSubject(event.target.value)}
      />
      <div className="tm-support-textarea">
        <label htmlFor={messageId}>{tOr('Support.message', 'Message')}</label>
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
      <section
        className="tm-support-context"
        aria-label={tOr('Support.contextTitle', 'Sent with your message')}
      >
        <p className="tm-support-context__title">
          {tOr('Support.contextTitle', 'Sent with your message')}
        </p>
        <dl>
          <div>
            <dt>{tOr('Support.contextWorkspace', 'Workspace')}</dt>
            <dd>{organizationSlug}</dd>
          </div>
          <div>
            <dt>{tOr('Support.contextPage', 'Page')}</dt>
            <dd>{pathname}</dd>
          </div>
          <div>
            <dt>{tOr('Support.contextVersion', 'App version')}</dt>
            <dd>{APP_VERSION}</dd>
          </div>
        </dl>
        <p className="tm-support-muted">
          {tOr(
            'Support.contextNote',
            'This helps the team see where you are. Nothing else is shared.',
          )}
        </p>
      </section>
      {problem ? <InlineAlert tone="danger">{problem}</InlineAlert> : null}
      {send.isError ? <InlineAlert tone="danger">{errorText(send.error)}</InlineAlert> : null}
      <div className="tm-support-actions">
        <Button type="button" tone="text" onClick={onCancel}>
          {tOr('Support.cancel', 'Cancel')}
        </Button>
        <Button type="submit" tone="ink" disabled={send.isPending}>
          {send.isPending
            ? tOr('Support.sending', 'Sending…')
            : tOr('Support.send', 'Send to support')}
        </Button>
      </div>
    </form>
  );
}

function ThreadView({
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
  const tOr = useTOr();
  const statusText = useSupportStatusText();
  const queryClient = useQueryClient();
  const replyId = useId();
  const [reply, setReply] = useState('');
  const detail = useQuery({
    queryKey: supportThreadKey(organizationSlug, id),
    queryFn: () => fetchSupportThread(api, organizationSlug, id),
    refetchInterval: 60_000,
  });
  const refresh = (data: SupportThreadDetail) => {
    queryClient.setQueryData(supportThreadKey(organizationSlug, id), data);
    void queryClient.invalidateQueries({ queryKey: supportThreadsKey(organizationSlug) });
  };
  const send = useMutation({
    mutationFn: () => postSupportMessage(api, organizationSlug, id, reply.trim()),
    onSuccess: (data) => {
      setReply('');
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
          {tOr('Support.back', 'All conversations')}
        </Button>
      </div>
      {detail.isPending ? (
        <p className="tm-support-muted">
          {tOr('Support.loadingThread', 'Loading the conversation')}
        </p>
      ) : detail.isError ? (
        <InlineAlert tone="danger">{errorText(detail.error)}</InlineAlert>
      ) : (
        <>
          <div className="tm-support-thread-head">
            <h3 className="tm-support-thread-head__subject">{detail.data.thread.subject}</h3>
            <StateCapsule state={CAPSULE[detail.data.thread.status]}>
              {statusText(detail.data.thread.status)}
            </StateCapsule>
          </div>
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
                    {new Date(message.createdAt).toLocaleString()}
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
              {send.isError ? (
                <InlineAlert tone="danger">{errorText(send.error)}</InlineAlert>
              ) : null}
              <div className="tm-support-actions">
                {detail.data.thread.status !== 'closed' ? (
                  <Button
                    type="button"
                    tone="text"
                    onClick={() => close.mutate()}
                    disabled={close.isPending}
                  >
                    {tOr('Support.closeConversation', 'Close conversation')}
                  </Button>
                ) : null}
                <Button type="submit" tone="ink" disabled={send.isPending || reply.trim() === ''}>
                  {tOr('Support.sendReply', 'Send reply')}
                </Button>
              </div>
            </form>
          ) : null}
          <p className="tm-support-muted">
            {tOr(
              'Support.mailNotice',
              'You also get replies by e-mail from tm-support@peetrix.com.',
            )}
          </p>
        </>
      )}
    </div>
  );
}
