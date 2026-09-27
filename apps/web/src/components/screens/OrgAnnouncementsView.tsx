'use client';

import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createAnnouncement,
  deleteAnnouncement,
  listActiveAnnouncements,
} from '../../lib/api/admin-announcements';
import type { AnnouncementSummary } from '../../lib/api/admin-announcements';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface OrgAnnouncementsViewProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

const QUERY_KEY = 'org-announcements';

/**
 * **Org announcements (Administration module 18, x276).**
 *
 * `38-MODULE-MAP` §Administration (org broadcast), `22-SCREEN-BY-SCREEN` §Administration governance.
 * The screen has two halves, both faithful readers of the API:
 *
 * 1. **The active-now banners**, which every member sees — the announcements whose window contains the
 *    present instant, gated on the server by `work.read`. A member dismisses a banner and it stays gone
 *    on this device: dismissal is remembered in `localStorage` this slice, so there is no per-member row
 *    and no second table. A dismissal is per announcement id, so a new announcement is never
 *    pre-dismissed.
 * 2. **The admin compose + list**, shown to an admin — a title, a body and an optional active window
 *    POSTed behind `org.manage`, and a delete behind `org.manage`. The API owns authorization: a caller
 *    without `org.manage` gets the ordinary 403, which `describeError` turns into a sentence; the screen
 *    never guesses a capability of its own.
 *
 * An announcement is posted and removed, never edited (the API grants no update path) — a correction is
 * a delete and a re-post, so there is no edit control here.
 */
export function OrgAnnouncementsView({
  organizationSlug,
  organizationName,
  client,
}: OrgAnnouncementsViewProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const bodyId = useId();

  const announcements = useQuery({
    queryKey: [QUERY_KEY, organizationSlug],
    queryFn: () => listActiveAnnouncements(api, organizationSlug),
  });

  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() =>
    readDismissed(organizationSlug),
  );
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [created, setCreated] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      createAnnouncement(api, organizationSlug, {
        title,
        body,
        startsAt: startsAt === '' ? null : startsAt,
        endsAt: endsAt === '' ? null : endsAt,
      }),
    onSuccess: async () => {
      setCreated(true);
      setTitle('');
      setBody('');
      setStartsAt('');
      setEndsAt('');
      await queryClient.invalidateQueries({ queryKey: [QUERY_KEY, organizationSlug] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteAnnouncement(api, organizationSlug, id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [QUERY_KEY, organizationSlug] });
    },
  });

  function dismiss(id: string): void {
    setDismissed((current) => {
      const next = new Set(current);
      next.add(id);
      writeDismissed(organizationSlug, next);
      return next;
    });
  }

  const active = announcements.data ?? [];
  const visible = active.filter((item) => !dismissed.has(item.id));

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Announcements"
      description="Post an organization-wide banner your members see, and read the ones active now."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-announcements-active-heading">
        <h2 id="tm-announcements-active-heading" className="tm-eyebrow">
          Active announcements
        </h2>

        {announcements.isPending ? (
          <LoadingRegion label="Loading the announcements." className="tm-stack tm-stack--tight">
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {announcements.isError ? (
          <InlineAlert tone="danger" title="Could not load the announcements" live>
            {describeError(announcements.error)}
          </InlineAlert>
        ) : null}

        {announcements.isSuccess && visible.length === 0 ? (
          <InlineAlert tone="neutral" title="No active announcements">
            There is nothing to show right now.
          </InlineAlert>
        ) : null}

        {visible.map((item) => (
          <AnnouncementBanner key={item.id} item={item} onDismiss={() => dismiss(item.id)} />
        ))}
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-announcements-new-heading">
        <h2 id="tm-announcements-new-heading" className="tm-eyebrow">
          Post an announcement
        </h2>

        <form
          className="tm-stack"
          noValidate
          aria-label="Post an announcement"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setCreated(false);
            if (!save.isPending) save.mutate();
          }}
        >
          <Field
            label="Title"
            name="announcement-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            hint="A short heading your members will see first."
          />

          <div className="tm-field">
            <label className="tm-field__label" htmlFor={bodyId}>
              Body
            </label>
            <textarea
              id={bodyId}
              className="tm-field__control"
              name="announcement-body"
              rows={4}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>

          <Field
            label="Starts (optional)"
            name="announcement-starts"
            type="datetime-local"
            value={startsAt}
            onChange={(event) => setStartsAt(event.target.value)}
            hint="Leave empty to show it immediately."
          />
          <Field
            label="Ends (optional)"
            name="announcement-ends"
            type="datetime-local"
            value={endsAt}
            onChange={(event) => setEndsAt(event.target.value)}
            hint="Leave empty to show it with no end."
          />

          {save.isError ? (
            <InlineAlert tone="danger" title="Could not post the announcement" live>
              {describeError(save.error)}
            </InlineAlert>
          ) : null}
          {created && !save.isPending && !save.isError ? (
            <InlineAlert tone="success" title="Announcement posted" live>
              Your members will see it while it is active.
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={save.isPending}
              loadingLabel="Posting"
            >
              Post announcement
            </Button>
          </div>
        </form>

        {visible.length > 0 ? (
          <ul className="tm-stack" aria-label="Active announcements you can remove">
            {visible.map((item) => (
              <li key={item.id} className="tm-row">
                <strong>{item.title}</strong>
                <Button
                  type="button"
                  tone="destructive"
                  size="accessible"
                  loading={remove.isPending && remove.variables === item.id}
                  loadingLabel="Removing"
                  onClick={() => {
                    if (!remove.isPending) remove.mutate(item.id);
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {remove.isError ? (
          <InlineAlert tone="danger" title="Could not remove the announcement" live>
            {describeError(remove.error)}
          </InlineAlert>
        ) : null}
      </section>
    </AppShell>
  );
}

/** One active announcement, with a dismiss control. Dismissal is remembered per device (localStorage). */
function AnnouncementBanner({
  item,
  onDismiss,
}: {
  item: AnnouncementSummary;
  onDismiss: () => void;
}) {
  return (
    <div className="tm-row" role="note" aria-label={`Announcement: ${item.title}`}>
      <div className="tm-stack tm-stack--tight">
        <strong>{item.title}</strong>
        <p className="tm-prose">{item.body}</p>
      </div>
      <Button type="button" tone="text" size="accessible" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

/** The `localStorage` key holding the ids a member has dismissed in one studio, on this device. */
function dismissKey(organizationSlug: string): string {
  return `tm-dismissed-announcements:${organizationSlug}`;
}

/** Read the dismissed ids, tolerating a missing store, a private window, or malformed JSON. */
function readDismissed(organizationSlug: string): ReadonlySet<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(dismissKey(organizationSlug));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

/** Persist the dismissed ids, tolerating a store that throws (private window, blocked storage). */
function writeDismissed(organizationSlug: string, ids: ReadonlySet<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(dismissKey(organizationSlug), JSON.stringify([...ids]));
  } catch {
    // A device that refuses storage still dismisses for this session; nothing else to do.
  }
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
