'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  addMeetingGuest,
  createMeeting,
  getMeetingOverview,
  listAllProjects,
  removeMeetingGuest,
  updateMeeting,
  type CreateMeetingInput,
  type MeetingConference,
  type MeetingOverviewView,
} from '../../lib/api/meetings';
import { inviteMeetingAttendee, removeMeetingAttendee } from '../../lib/api/meeting-attendees';
import { getProjectDriveFiles, getStorageStatus } from '../../lib/api/google-drive';
import { getProjectOneDriveFiles } from '../../lib/api/onedrive';
import { fetchMyProfile } from '../../lib/api/member-profile';
import { useMembers } from '../../lib/use-members';
import { fillTemplate } from '../../lib/ai-approval-presentation';
import { useT } from '../../lib/i18n/use-t';
import { DriveProjectFilesDialog } from '../storage/DriveProjectFilesDialog';
import {
  MEETING_COLOURS,
  WEEKDAYS,
  buildRrule,
  occurrenceCount,
  parseRrule,
  presetOf,
  reminderMinutes,
  repeatPresets,
  splitReminder,
  type RepeatRule,
  type ReminderUnit,
} from './meeting-model';
import { calendarName, initialsOf } from './MeetingBits';
import { useCalendarAccounts } from './use-meetings-data';
import { readMeetingDefaults } from './meeting-defaults';
import './meetings.css';

export interface MeetingFormProps {
  organizationSlug: string;
  client: ApiClient;
  /** Absent = a new meeting; present = edit that meeting. */
  meetingId?: string;
  /** A new meeting's project, e.g. from `?project=`. */
  initialProjectId?: string;
}

interface GuestRow {
  readonly key: string;
  readonly kind: 'member' | 'guest' | 'client';
  readonly userId: string | null;
  readonly email: string | null;
  readonly name: string;
  readonly optional: boolean;
  /** The attendee/guest row id once saved; `null` for someone added in this form. */
  readonly savedId: string | null;
}

interface ReminderRow {
  readonly method: 'popup' | 'email';
  readonly amount: number;
  readonly unit: ReminderUnit;
}

interface PickedFile {
  readonly provider: 'google_drive' | 'onedrive';
  readonly fileId: string;
  readonly driveId: string | null;
  readonly title: string;
  readonly mimeType: string;
  readonly webUrl: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_REMINDERS = 5;

/** `2026-10-26` and `11:30` in the reader's zone, for the date and time inputs. */
function localParts(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function nextHalfHour(): Date {
  const d = new Date();
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}

/**
 * **Create / edit a meeting (approved Figma 417:9827 EN, 417:10292 AR, menus 419:23591).**
 *
 * Every option Google Calendar offers that TManage edits: title, date, start/end, all day, time
 * zone, repeat (presets or a custom rule), the video call (Google Meet / Microsoft Teams from the
 * organizer's own connected calendar), location, the description/agenda, Drive/OneDrive
 * attachments, the project, guests (members or any email, required/optional) and what guests can
 * do, reminders, busy/free, visibility and colour. "Save and send invitations" creates or patches
 * the meeting; the API then sends it to the organizer's calendar, which emails the guests.
 */
export function MeetingForm({
  organizationSlug,
  client: api,
  meetingId,
  initialProjectId,
}: MeetingFormProps) {
  const t = useT();
  const router = useRouter();
  const queries = useQueryClient();
  const editing = meetingId !== undefined;

  const existing = useQuery({
    queryKey: ['meeting-overview', organizationSlug, meetingId ?? ''],
    queryFn: () => getMeetingOverview(api, organizationSlug, meetingId ?? ''),
    enabled: editing,
    retry: false,
  });
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listAllProjects(api, organizationSlug),
  });
  const me = useQuery({
    queryKey: ['my-profile', organizationSlug],
    queryFn: () => fetchMyProfile(api, organizationSlug),
    staleTime: 300_000,
    retry: false,
  });
  const storage = useQuery({
    queryKey: ['storage-status', organizationSlug],
    queryFn: () => getStorageStatus(api, organizationSlug),
    staleTime: 60_000,
    retry: false,
  });
  const { accounts } = useCalendarAccounts(api, organizationSlug);
  const connected = accounts.filter((a) => a.status === 'connected');
  const primary = connected[0];

  const start = useMemo(() => nextHalfHour(), []);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(localParts(start.toISOString()).date);
  const [startTime, setStartTime] = useState(localParts(start.toISOString()).time);
  const [endTime, setEndTime] = useState(
    localParts(new Date(start.getTime() + 3_600_000).toISOString()).time,
  );
  const [timeZone, setTimeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  );
  const [allDay, setAllDay] = useState(false);
  const [repeat, setRepeat] = useState<RepeatRule | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [conference, setConference] = useState<MeetingConference>('none');
  const [location, setLocation] = useState('');
  const [agenda, setAgenda] = useState('');
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  const [guests, setGuests] = useState<readonly GuestRow[]>([]);
  const [removed, setRemoved] = useState<readonly GuestRow[]>([]);
  const [canModify, setCanModify] = useState(false);
  const [canInvite, setCanInvite] = useState(true);
  const [canSee, setCanSee] = useState(true);
  const [reminders, setReminders] = useState<readonly ReminderRow[]>(() => [
    { method: 'popup', ...splitReminder(readMeetingDefaults().reminderMinutes) },
  ]);
  const [showAs, setShowAs] = useState<'busy' | 'free'>('busy');
  const [visibility, setVisibility] = useState<'default' | 'public' | 'private'>('default');
  const [colorId, setColorId] = useState<string | null>(null);
  const [files, setFiles] = useState<readonly PickedFile[]>([]);
  const [picker, setPicker] = useState<'google_drive' | 'onedrive' | null>(null);
  const loaded = useRef(false);

  // A video call defaults to the organizer's connected calendar, as the design's default.
  useEffect(() => {
    if (editing || conference !== 'none' || !primary) return;
    const preferred = readMeetingDefaults().conference;
    const usable = (value: MeetingConference) =>
      connected.some((a) => (a.provider === 'microsoft' ? 'teams' : 'google_meet') === value);
    if (preferred === 'none') return;
    if (preferred && usable(preferred)) setConference(preferred);
    else setConference(primary.provider === 'microsoft' ? 'teams' : 'google_meet');
    // Only once the accounts answer; a person's later choice is never overridden.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary?.provider]);

  // Edit: fill the form from the meeting page's read, once.
  useEffect(() => {
    const o = existing.data;
    if (!o || loaded.current) return;
    loaded.current = true;
    applyOverview(o);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing.data]);

  function applyOverview(o: MeetingOverviewView) {
    const startParts = localParts(o.meeting.startsAt);
    setTitle(o.meeting.title);
    setDate(startParts.date);
    setStartTime(startParts.time);
    if (o.meeting.endsAt) setEndTime(localParts(o.meeting.endsAt).time);
    if (o.timeZone) setTimeZone(o.timeZone);
    setAllDay(o.allDay);
    setRepeat(parseRrule(o.rrule));
    setConference(
      o.conference === 'google_meet' || o.conference === 'teams' ? o.conference : 'none',
    );
    setLocation(o.location ?? '');
    setAgenda(o.meeting.agendaNote ?? '');
    setProjectId(o.meeting.projectId);
    setCanModify(o.guestsCanModify);
    setCanInvite(o.guestsCanInviteOthers);
    setCanSee(o.guestsCanSeeOthers);
    setShowAs(o.showAs === 'free' ? 'free' : 'busy');
    setVisibility(
      o.visibility === 'public' || o.visibility === 'private' ? o.visibility : 'default',
    );
    setColorId(o.colorId);
    setReminders(
      (o.reminders ?? []).map((r) => ({ method: r.method, ...splitReminder(r.minutes) })),
    );
    setGuests(
      o.people
        .filter((p) => !p.organizer)
        .map((p) => ({
          key: `${p.kind}:${p.id}`,
          kind: p.kind,
          userId: p.userId,
          email: p.email,
          name: p.displayName ?? p.email ?? '',
          optional: p.optional,
          savedId: p.id,
        })),
    );
  }

  const startDate = new Date(`${date}T${startTime || '00:00'}`);
  const presets = repeatPresets(startDate);
  const preset = presetOf(repeat, startDate);

  const save = useMutation({
    mutationFn: async () => {
      const startsAt = allDay
        ? new Date(`${date}T00:00`).toISOString()
        : new Date(`${date}T${startTime}`).toISOString();
      const endsAt = allDay
        ? new Date(new Date(`${date}T00:00`).getTime() + 86_400_000).toISOString()
        : new Date(`${date}T${endTime}`).toISOString();
      const options = {
        allDay,
        timeZone,
        location: location.trim() === '' ? null : location.trim(),
        rrule: repeat ? buildRrule(repeat) : null,
        visibility,
        showAs,
        colorId,
        conference,
        reminders: reminders.map((r) => ({
          method: r.method,
          minutes: reminderMinutes(r.amount, r.unit),
        })),
        guestsCanModify: canModify,
        guestsCanInviteOthers: canInvite,
        guestsCanSeeOthers: canSee,
      };
      if (!editing) {
        const input: CreateMeetingInput = {
          projectId,
          title: title.trim(),
          startsAt,
          endsAt,
          ...(agenda.trim() === '' ? {} : { agendaNote: agenda }),
          ...options,
          attendees: guests
            .filter((g) => g.kind === 'member' && g.userId)
            .map((g) => ({ userId: g.userId ?? '', optional: g.optional })),
          guests: guests
            .filter((g) => g.kind === 'guest' && g.email)
            .map((g) => ({ email: g.email ?? '', optional: g.optional })),
          ...(files.length > 0 ? { attachments: files } : {}),
        };
        return createMeeting(api, organizationSlug, input);
      }
      const id = meetingId ?? '';
      // People first, so the patch's calendar push carries the final guest list.
      for (const row of removed) {
        if (!row.savedId) continue;
        if (row.kind === 'guest') await removeMeetingGuest(api, organizationSlug, id, row.savedId);
        else await removeMeetingAttendee(api, organizationSlug, id, row.savedId);
      }
      for (const row of guests.filter((g) => g.savedId === null)) {
        if (row.kind === 'guest' && row.email) {
          await addMeetingGuest(api, organizationSlug, id, {
            email: row.email,
            optional: row.optional,
          });
        } else if (row.userId) {
          await inviteMeetingAttendee(api, organizationSlug, id, { userId: row.userId });
        }
      }
      return updateMeeting(api, organizationSlug, id, {
        title: title.trim(),
        startsAt,
        endsAt,
        agendaNote: agenda.trim() === '' ? null : agenda,
        ...options,
      });
    },
    onSuccess: (meeting) => {
      void queries.invalidateQueries({ queryKey: ['meetings', organizationSlug] });
      void queries.invalidateQueries({ queryKey: ['meeting-overview', organizationSlug] });
      router.push(
        `/${organizationSlug}/calendar/meetings/${encodeURIComponent(meeting.id)}?saved=1`,
      );
    },
  });

  const canSave =
    title.trim() !== '' &&
    projectId !== '' &&
    date !== '' &&
    (allDay || (startTime !== '' && endTime !== '' && endTime > startTime));

  const [tried, setTried] = useState(false);
  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (canSave && !save.isPending) save.mutate();
  }

  function addGuest(row: GuestRow) {
    setGuests((current) =>
      current.some((g) => g.key === row.key || (row.email && g.email === row.email))
        ? current
        : [...current, row],
    );
  }

  function removeGuest(row: GuestRow) {
    setGuests((current) => current.filter((g) => g.key !== row.key));
    if (row.savedId) setRemoved((current) => [...current, row]);
  }

  if (editing && existing.isPending) {
    return (
      <LoadingRegion label={t('MeetingForm.loading')}>
        <Skeleton height="var(--row)" />
      </LoadingRegion>
    );
  }
  if (editing && existing.isError) {
    return (
      <InlineAlert tone="danger" title={t('MeetingForm.notFound')} live>
        <Link href={`/${organizationSlug}/calendar`}>{t('MeetingForm.backToMeetings')}</Link>
      </InlineAlert>
    );
  }

  const canAttach =
    !editing &&
    projectId !== '' &&
    storage.data?.googleDrive !== undefined &&
    (storage.data.storageMode === 'google_drive' || storage.data.storageMode === 'onedrive');
  const summary = repeat ? repeatSummary(t, repeat, startDate) : null;

  return (
    <form
      id="tm-mtg-form"
      className="tm-mtg tm-mtg-form"
      onSubmit={submit}
      aria-label={editing ? t('MeetingForm.editTitle') : t('MeetingForm.newTitle')}
    >
      <p className="tm-mtg-banner" data-tone="lime">
        <span className="tm-mtg-dot" data-status="connected" aria-hidden="true" />
        {primary
          ? fillTemplate(t('MeetingForm.invitesFrom'), {
              calendar: calendarName(primary.provider),
              email: primary.accountEmail ?? '',
            })
          : t('MeetingForm.invitesTManageOnly')}
        {!primary ? (
          <>
            {' '}
            <Link href={`/${organizationSlug}/settings/calendar-connections`}>
              {t('MeetingForm.connectCalendar')}
            </Link>
          </>
        ) : null}
      </p>

      {tried && !canSave ? (
        <InlineAlert tone="danger" title={t('MeetingForm.incomplete')} live>
          {t('MeetingForm.incompleteBody')}
        </InlineAlert>
      ) : null}
      {save.isPending ? (
        <p className="tm-visually-hidden" role="status">
          {t('MeetingForm.saving')}
        </p>
      ) : null}
      {save.isError ? (
        <InlineAlert tone="danger" title={t('MeetingForm.saveError')} live>
          {save.error instanceof ApiRequestError ? save.error.message : t('MeetingsHub.noAnswer')}
        </InlineAlert>
      ) : null}

      <div className="tm-mtg-form__cols">
        <div className="tm-mtg-form__main">
          <section className="tm-mtg-card" aria-labelledby="tm-mf-when">
            <h2 id="tm-mf-when" className="tm-mtg-card__title">
              {t('MeetingForm.when')}
            </h2>
            <Field label={t('MeetingForm.titleLabel')}>
              {(id) => (
                <input
                  id={id}
                  className="tm-mtg-input"
                  value={title}
                  maxLength={300}
                  required
                  onChange={(event) => setTitle(event.target.value)}
                />
              )}
            </Field>
            <div className="tm-mtg-form__row4">
              <Field label={t('MeetingForm.date')}>
                {(id) => (
                  <input
                    id={id}
                    type="date"
                    className="tm-mtg-input"
                    value={date}
                    required
                    onChange={(event) => setDate(event.target.value)}
                  />
                )}
              </Field>
              <Field label={t('MeetingForm.starts')}>
                {(id) => (
                  <input
                    id={id}
                    type="time"
                    className="tm-mtg-input"
                    value={startTime}
                    disabled={allDay}
                    onChange={(event) => setStartTime(event.target.value)}
                  />
                )}
              </Field>
              <Field label={t('MeetingForm.ends')}>
                {(id) => (
                  <input
                    id={id}
                    type="time"
                    className="tm-mtg-input"
                    value={endTime}
                    disabled={allDay}
                    onChange={(event) => setEndTime(event.target.value)}
                  />
                )}
              </Field>
              <Field label={t('MeetingForm.timeZone')}>
                {(id) => (
                  <select
                    id={id}
                    className="tm-mtg-input"
                    value={timeZone}
                    onChange={(event) => setTimeZone(event.target.value)}
                  >
                    {zoneOptions(timeZone).map((zone) => (
                      <option key={zone} value={zone}>
                        {zoneLabel(zone, startDate)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            <label className="tm-mtg-check">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(event) => setAllDay(event.target.checked)}
              />
              {t('MeetingForm.allDay')}
            </label>
            <div className="tm-mtg-field">
              <span className="tm-mtg-label" id="tm-mf-repeat">
                {t('MeetingForm.repeat')}
              </span>
              <div
                className="tm-mtg-seg tm-mtg-seg--wide"
                role="group"
                aria-labelledby="tm-mf-repeat"
              >
                <button
                  type="button"
                  aria-pressed={preset === 'none'}
                  onClick={() => setRepeat(null)}
                >
                  {t('MeetingForm.repeatNone')}
                </button>
                {(['daily', 'weekly', 'monthly', 'yearly'] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={preset === key}
                    onClick={() => setRepeat(presets[key])}
                  >
                    {t(REPEAT_KEYS[key])}
                  </button>
                ))}
                <button
                  type="button"
                  aria-pressed={preset === 'custom' || preset === 'weekdays'}
                  onClick={() => setCustomOpen(true)}
                >
                  {t('MeetingForm.repeatCustom')}
                </button>
              </div>
              {summary ? <p className="tm-mtg-hint">{summary}</p> : null}
            </div>
          </section>

          <section className="tm-mtg-card" aria-labelledby="tm-mf-video">
            <h2 id="tm-mf-video" className="tm-mtg-card__title">
              {t('MeetingForm.videoCall')}
            </h2>
            <div className="tm-mtg-radios" role="radiogroup" aria-labelledby="tm-mf-video">
              {accounts.map((account) => {
                const value: MeetingConference =
                  account.provider === 'microsoft' ? 'teams' : 'google_meet';
                const usable = account.status === 'connected';
                return (
                  // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the option's name is in its <strong>, one level deeper than the rule looks
                  <label
                    key={value}
                    className="tm-mtg-radio"
                    data-checked={conference === value || undefined}
                  >
                    <input
                      type="radio"
                      name="tm-mf-conference"
                      checked={conference === value}
                      disabled={!usable}
                      onChange={() => setConference(value)}
                    />
                    <span>
                      <strong>{value === 'teams' ? 'Microsoft Teams' : 'Google Meet'}</strong>
                      <small>
                        {usable
                          ? t(value === 'teams' ? 'MeetingForm.teamsHint' : 'MeetingForm.meetHint')
                          : fillTemplate(t('MeetingForm.connectFirst'), {
                              calendar: calendarName(account.provider),
                            })}
                      </small>
                    </span>
                  </label>
                );
              })}
              {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- the option's name is in its <strong>, one level deeper than the rule looks */}
              <label className="tm-mtg-radio" data-checked={conference === 'none' || undefined}>
                <input
                  type="radio"
                  name="tm-mf-conference"
                  checked={conference === 'none'}
                  onChange={() => setConference('none')}
                />
                <span>
                  <strong>{t('MeetingsHub.noVideo')}</strong>
                  <small>{t('MeetingForm.noVideoHint')}</small>
                </span>
              </label>
            </div>
            <Field label={t('MeetingForm.location')}>
              {(id) => (
                <input
                  id={id}
                  className="tm-mtg-input"
                  value={location}
                  maxLength={512}
                  onChange={(event) => setLocation(event.target.value)}
                />
              )}
            </Field>
          </section>

          <section className="tm-mtg-card" aria-labelledby="tm-mf-agenda">
            <h2 id="tm-mf-agenda" className="tm-mtg-card__title">
              {t('MeetingForm.agenda')}
            </h2>
            <textarea
              aria-labelledby="tm-mf-agenda"
              className="tm-mtg-input tm-mtg-textarea"
              value={agenda}
              maxLength={8000}
              rows={6}
              onChange={(event) => setAgenda(event.target.value)}
            />
          </section>

          <section className="tm-mtg-card" aria-labelledby="tm-mf-files">
            <h2 id="tm-mf-files" className="tm-mtg-card__title">
              {t('MeetingForm.attachments')}
            </h2>
            {[
              ...(existing.data?.attachments ?? []).map((a) => ({
                key: a.id,
                title: a.title,
                provider: a.provider,
                removable: false,
              })),
              ...files.map((f) => ({
                key: f.fileId,
                title: f.title,
                provider: f.provider,
                removable: true,
              })),
            ].map((file) => (
              <div key={file.key} className="tm-mtg-file">
                <span className="tm-mtg-file__icon" aria-hidden="true" />
                <span>
                  <strong>{file.title}</strong>
                  <small>{file.provider === 'onedrive' ? 'OneDrive' : 'Google Drive'}</small>
                </span>
                {file.removable ? (
                  <button
                    type="button"
                    className="tm-mtg-x"
                    aria-label={fillTemplate(t('MeetingForm.removeNamed'), { name: file.title })}
                    onClick={() =>
                      setFiles((current) => current.filter((f) => f.fileId !== file.key))
                    }
                  >
                    ×
                  </button>
                ) : null}
              </div>
            ))}
            {canAttach ? (
              <div className="tm-mtg-form__buttons">
                {storage.data?.storageMode === 'google_drive' ? (
                  <button
                    type="button"
                    className="tm-mtg-btn tm-mtg-btn--outline"
                    onClick={() => setPicker('google_drive')}
                  >
                    {t('MeetingForm.addFromDrive')}
                  </button>
                ) : null}
                {storage.data?.storageMode === 'onedrive' ? (
                  <button
                    type="button"
                    className="tm-mtg-btn tm-mtg-btn--outline"
                    onClick={() => setPicker('onedrive')}
                  >
                    {t('MeetingForm.addFromOneDrive')}
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="tm-mtg-hint">
                {editing ? t('MeetingForm.attachOnCreate') : t('MeetingForm.attachNeedsStorage')}
              </p>
            )}
          </section>

          <section className="tm-mtg-card" aria-labelledby="tm-mf-project">
            <h2 id="tm-mf-project" className="tm-mtg-card__title">
              {t('MeetingForm.projectHeading')}
            </h2>
            <Field label={t('MeetingForm.project')}>
              {(id) => (
                <select
                  id={id}
                  className="tm-mtg-input"
                  value={projectId}
                  required
                  disabled={editing}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  <option value="">{t('MeetingForm.chooseProject')}</option>
                  {(projects.data ?? []).map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </section>
        </div>

        <div className="tm-mtg-form__side">
          <GuestsCard
            api={api}
            organizationSlug={organizationSlug}
            organizer={{ name: me.data?.displayName ?? '', email: me.data?.email ?? '' }}
            guests={guests}
            onAdd={addGuest}
            onRemove={removeGuest}
            onOptional={(key, optional) =>
              setGuests((current) => current.map((g) => (g.key === key ? { ...g, optional } : g)))
            }
            canModify={canModify}
            canInvite={canInvite}
            canSee={canSee}
            setCanModify={setCanModify}
            setCanInvite={setCanInvite}
            setCanSee={setCanSee}
          />

          <section className="tm-mtg-card" aria-labelledby="tm-mf-reminders">
            <h2 id="tm-mf-reminders" className="tm-mtg-card__title">
              {t('MeetingForm.reminders')}
            </h2>
            {reminders.map((reminder, index) => (
              <div key={index} className="tm-mtg-reminder">
                <select
                  className="tm-mtg-input tm-mtg-input--sm"
                  aria-label={t('MeetingForm.reminderMethod')}
                  value={reminder.method}
                  onChange={(event) =>
                    setReminders((current) =>
                      current.map((r, i) =>
                        i === index ? { ...r, method: event.target.value as 'popup' | 'email' } : r,
                      ),
                    )
                  }
                >
                  <option value="popup">{t('MeetingForm.notification')}</option>
                  <option value="email">{t('MeetingForm.email')}</option>
                </select>
                <input
                  type="number"
                  min={0}
                  className="tm-mtg-input tm-mtg-input--sm tm-mtg-input--num"
                  aria-label={t('MeetingForm.reminderAmount')}
                  value={reminder.amount}
                  onChange={(event) =>
                    setReminders((current) =>
                      current.map((r, i) =>
                        i === index ? { ...r, amount: Number(event.target.value) || 0 } : r,
                      ),
                    )
                  }
                />
                <select
                  className="tm-mtg-input tm-mtg-input--sm"
                  aria-label={t('MeetingForm.reminderUnit')}
                  value={reminder.unit}
                  onChange={(event) =>
                    setReminders((current) =>
                      current.map((r, i) =>
                        i === index ? { ...r, unit: event.target.value as ReminderUnit } : r,
                      ),
                    )
                  }
                >
                  {(['minutes', 'hours', 'days', 'weeks'] as const).map((unit) => (
                    <option key={unit} value={unit}>
                      {t(UNIT_KEYS[unit])}
                    </option>
                  ))}
                </select>
                <span className="tm-mtg-quiet">{t('MeetingForm.before')}</span>
                <button
                  type="button"
                  className="tm-mtg-x"
                  aria-label={t('MeetingForm.removeReminder')}
                  onClick={() => setReminders((current) => current.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </div>
            ))}
            {reminders.length < MAX_REMINDERS ? (
              <button
                type="button"
                className="tm-mtg-textlink"
                onClick={() =>
                  setReminders((current) => [
                    ...current,
                    { method: 'popup', amount: 30, unit: 'minutes' },
                  ])
                }
              >
                + {t('MeetingForm.addReminder')}
              </button>
            ) : (
              <p className="tm-mtg-hint">{t('MeetingForm.maxReminders')}</p>
            )}
          </section>

          <section className="tm-mtg-card" aria-labelledby="tm-mf-details">
            <h2 id="tm-mf-details" className="tm-mtg-card__title">
              {t('MeetingForm.details')}
            </h2>
            <Segment
              label={t('MeetingForm.showMeAs')}
              value={showAs}
              options={[
                ['busy', t('MeetingForm.busy')],
                ['free', t('MeetingForm.free')],
              ]}
              onChange={setShowAs}
            />
            <Segment
              label={t('MeetingForm.visibility')}
              value={visibility}
              options={[
                ['default', t('MeetingForm.visDefault')],
                ['public', t('MeetingForm.visPublic')],
                ['private', t('MeetingForm.visPrivate')],
              ]}
              onChange={setVisibility}
            />
            <div className="tm-mtg-field">
              <span className="tm-mtg-label" id="tm-mf-colour">
                {t('MeetingForm.colour')}
              </span>
              <div className="tm-mtg-swatches" role="radiogroup" aria-labelledby="tm-mf-colour">
                {MEETING_COLOURS.map((colour) => (
                  <button
                    key={colour.id}
                    type="button"
                    role="radio"
                    aria-checked={colorId === colour.id}
                    aria-label={fillTemplate(t('MeetingForm.colourNamed'), { n: colour.id })}
                    className="tm-mtg-swatch"
                    style={{ backgroundColor: colour.hex }}
                    onClick={() => setColorId(colorId === colour.id ? null : colour.id)}
                  />
                ))}
              </div>
              <p className="tm-mtg-hint">{t('MeetingForm.colourOutlook')}</p>
            </div>
            <div className="tm-mtg-field">
              <span className="tm-mtg-label">{t('MeetingForm.calendar')}</span>
              <p className="tm-mtg-input tm-mtg-input--static">
                {primary
                  ? `${calendarName(primary.provider)} · ${primary.accountEmail ?? ''}`
                  : t('MeetingForm.tmanageOnly')}
              </p>
            </div>
          </section>
        </div>
      </div>

      {customOpen ? (
        <CustomRepeat
          start={startDate}
          initial={repeat ?? presets.weekly}
          onCancel={() => setCustomOpen(false)}
          onDone={(rule) => {
            setRepeat(rule);
            setCustomOpen(false);
          }}
        />
      ) : null}

      {picker ? (
        <AttachDialog
          api={api}
          organizationSlug={organizationSlug}
          projectId={projectId}
          provider={picker}
          onClose={() => setPicker(null)}
          onPick={(picked) =>
            setFiles((current) => [
              ...current,
              ...picked.filter((p) => !current.some((c) => c.fileId === p.fileId)),
            ])
          }
        />
      ) : null}
    </form>
  );
}

const REPEAT_KEYS = {
  daily: 'MeetingForm.repeatDaily',
  weekly: 'MeetingForm.repeatWeekly',
  monthly: 'MeetingForm.repeatMonthly',
  yearly: 'MeetingForm.repeatYearly',
} as const;

const UNIT_KEYS = {
  minutes: 'MeetingForm.unitMinutes',
  hours: 'MeetingForm.unitHours',
  days: 'MeetingForm.unitDays',
  weeks: 'MeetingForm.unitWeeks',
} as const;

const WEEKDAY_KEYS = {
  MO: 'MeetingForm.dayMo',
  TU: 'MeetingForm.dayTu',
  WE: 'MeetingForm.dayWe',
  TH: 'MeetingForm.dayTh',
  FR: 'MeetingForm.dayFr',
  SA: 'MeetingForm.daySa',
  SU: 'MeetingForm.daySu',
} as const;

type Translate = ReturnType<typeof useT>;

/** "Every Monday until 21 Dec 2026 · 9 meetings". */
export function repeatSummary(t: Translate, rule: RepeatRule, start: Date): string {
  const unitKey = {
    DAILY: 'MeetingForm.everyDay',
    WEEKLY: 'MeetingForm.everyWeekOn',
    MONTHLY: 'MeetingForm.everyMonth',
    YEARLY: 'MeetingForm.everyYear',
  } as const;
  const days = rule.byDay
    .map((d) => d.replace(/^-?\d+/, ''))
    .map((d) => (d in WEEKDAY_KEYS ? t(WEEKDAY_KEYS[d as keyof typeof WEEKDAY_KEYS]) : d))
    .join(', ');
  const parts = [fillTemplate(t(unitKey[rule.freq]), { days, n: String(rule.interval) })];
  if (rule.until) {
    parts[0] += ` ${fillTemplate(t('MeetingForm.until'), {
      date: new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(new Date(`${rule.until}T12:00`)),
    })}`;
  }
  const count = occurrenceCount(rule, start);
  if (count !== null)
    parts.push(fillTemplate(t('MeetingForm.meetingsCount'), { n: String(count) }));
  return parts.join(' · ');
}

function zoneOptions(current: string): readonly string[] {
  const base = [
    'Africa/Cairo',
    'Asia/Dubai',
    'Asia/Riyadh',
    'Europe/London',
    'Europe/Berlin',
    'America/New_York',
    'America/Los_Angeles',
    'UTC',
  ];
  return base.includes(current) ? base : [current, ...base];
}

/** "(GMT+3) Cairo". */
function zoneLabel(zone: string, at: Date): string {
  let offset = '';
  try {
    offset =
      new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'shortOffset' })
        .formatToParts(at)
        .find((part) => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    offset = '';
  }
  const city = zone.split('/').pop()?.replace(/_/g, ' ') ?? zone;
  return offset ? `(${offset}) ${city}` : city;
}

function Field({ label, children }: { label: string; children: (id: string) => ReactElement }) {
  const id = useId();
  return (
    <div className="tm-mtg-field">
      <label className="tm-mtg-label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
    </div>
  );
}

function Segment<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: readonly (readonly [V, string])[];
  onChange: (value: V) => void;
}) {
  const id = useId();
  return (
    <div className="tm-mtg-field">
      <span className="tm-mtg-label" id={id}>
        {label}
      </span>
      <div className="tm-mtg-seg" role="group" aria-labelledby={id}>
        {options.map(([option, text]) => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            onClick={() => onChange(option)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Guests (417:9827 right column + "Add guests" menu 419:23591). */
function GuestsCard({
  api,
  organizationSlug,
  organizer,
  guests,
  onAdd,
  onRemove,
  onOptional,
  canModify,
  canInvite,
  canSee,
  setCanModify,
  setCanInvite,
  setCanSee,
}: {
  api: ApiClient;
  organizationSlug: string;
  organizer: { name: string; email: string };
  guests: readonly GuestRow[];
  onAdd: (row: GuestRow) => void;
  onRemove: (row: GuestRow) => void;
  onOptional: (key: string, optional: boolean) => void;
  canModify: boolean;
  canInvite: boolean;
  canSee: boolean;
  setCanModify: (value: boolean) => void;
  setCanInvite: (value: boolean) => void;
  setCanSee: (value: boolean) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const directory = useMembers(api, organizationSlug, query);
  const needle = query.trim().toLowerCase();
  const matches =
    needle === ''
      ? []
      : directory.members
          .filter((m) => m.displayName.toLowerCase().includes(needle))
          .filter((m) => !guests.some((g) => g.userId === m.userId))
          .slice(0, 6);
  const typedEmail = EMAIL.test(query.trim()) ? query.trim().toLowerCase() : null;
  const listId = useId();
  return (
    <section className="tm-mtg-card" aria-labelledby="tm-mf-guests">
      <div className="tm-mtg-card__head">
        <h2 id="tm-mf-guests" className="tm-mtg-card__title">
          {t('MeetingForm.guests')}
        </h2>
        <span className="tm-mtg-quiet">
          {fillTemplate(t('MeetingForm.invitedCount'), { n: String(guests.length + 1) })}
        </span>
      </div>
      <div className="tm-mtg-guestsearch">
        <label className="tm-mtg-search tm-mtg-search--block">
          <span className="tm-mtg-search__icon" aria-hidden="true" />
          <span className="tm-visually-hidden">{t('MeetingForm.addGuestsLabel')}</span>
          <input
            type="search"
            value={query}
            placeholder={t('MeetingForm.addGuestsPlaceholder')}
            aria-controls={listId}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && typedEmail) {
                event.preventDefault();
                onAdd({
                  key: `guest:${typedEmail}`,
                  kind: 'guest',
                  userId: null,
                  email: typedEmail,
                  name: typedEmail,
                  optional: false,
                  savedId: null,
                });
                setQuery('');
              }
            }}
          />
        </label>
        {needle !== '' ? (
          <div className="tm-mtg-menu" id={listId}>
            {matches.length > 0 ? (
              <p className="tm-mtg-mono tm-mtg-menu__group">{t('MeetingForm.peopleInTeam')}</p>
            ) : null}
            {matches.map((member) => (
              <button
                key={member.userId}
                type="button"
                className="tm-mtg-menu__item"
                onClick={() => {
                  onAdd({
                    key: `member:${member.userId}`,
                    kind: 'member',
                    userId: member.userId,
                    email: null,
                    name: member.displayName,
                    optional: false,
                    savedId: null,
                  });
                  setQuery('');
                }}
              >
                <span className="tm-mtg-avatar" aria-hidden="true">
                  {initialsOf(member.displayName)}
                </span>
                <span>{member.displayName}</span>
              </button>
            ))}
            {typedEmail ? (
              <button
                type="button"
                className="tm-mtg-menu__item"
                onClick={() => {
                  onAdd({
                    key: `guest:${typedEmail}`,
                    kind: 'guest',
                    userId: null,
                    email: typedEmail,
                    name: typedEmail,
                    optional: false,
                    savedId: null,
                  });
                  setQuery('');
                }}
              >
                <span className="tm-mtg-avatar" data-kind="guest" aria-hidden="true">
                  {initialsOf(null, typedEmail)}
                </span>
                <span>{fillTemplate(t('MeetingForm.inviteEmail'), { email: typedEmail })}</span>
              </button>
            ) : (
              <p className="tm-mtg-hint tm-mtg-menu__hint">{t('MeetingForm.typeEmailHint')}</p>
            )}
          </div>
        ) : null}
      </div>
      <ul className="tm-mtg-guests">
        <li className="tm-mtg-guest">
          <span className="tm-mtg-avatar" aria-hidden="true">
            {initialsOf(organizer.name)}
          </span>
          <span className="tm-mtg-guest__who">
            <strong>{organizer.name}</strong>
            <small>{organizer.email}</small>
          </span>
          <span className="tm-mtg-tag tm-mtg-mono">{t('MeetingForm.organizer')}</span>
        </li>
        {guests.map((guest) => (
          <li key={guest.key} className="tm-mtg-guest">
            <span className="tm-mtg-avatar" data-kind={guest.kind} aria-hidden="true">
              {initialsOf(guest.kind === 'guest' ? null : guest.name, guest.email)}
            </span>
            <span className="tm-mtg-guest__who">
              <strong>{guest.name}</strong>
              {guest.kind === 'guest' ? <small>{t('MeetingForm.outsideGuest')}</small> : null}
            </span>
            <div
              className="tm-mtg-seg tm-mtg-seg--sm"
              role="group"
              aria-label={fillTemplate(t('MeetingForm.attendanceFor'), { name: guest.name })}
            >
              <button
                type="button"
                aria-pressed={!guest.optional}
                disabled={guest.savedId !== null}
                onClick={() => onOptional(guest.key, false)}
              >
                {t('MeetingForm.required')}
              </button>
              <button
                type="button"
                aria-pressed={guest.optional}
                disabled={guest.savedId !== null}
                onClick={() => onOptional(guest.key, true)}
              >
                {t('MeetingForm.optional')}
              </button>
            </div>
            <button
              type="button"
              className="tm-mtg-x"
              aria-label={fillTemplate(t('MeetingForm.removeNamed'), { name: guest.name })}
              onClick={() => onRemove(guest)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <fieldset className="tm-mtg-fieldset">
        <legend className="tm-mtg-label">{t('MeetingForm.guestsCan')}</legend>
        <label className="tm-mtg-check">
          <input
            type="checkbox"
            checked={canModify}
            onChange={(event) => setCanModify(event.target.checked)}
          />
          {t('MeetingForm.canModify')}
        </label>
        <label className="tm-mtg-check">
          <input
            type="checkbox"
            checked={canInvite}
            onChange={(event) => setCanInvite(event.target.checked)}
          />
          {t('MeetingForm.canInvite')}
        </label>
        <label className="tm-mtg-check">
          <input
            type="checkbox"
            checked={canSee}
            onChange={(event) => setCanSee(event.target.checked)}
          />
          {t('MeetingForm.canSee')}
        </label>
      </fieldset>
    </section>
  );
}

/** Custom repeat (419:23591): every N day/week/month/year, on which days, and when it ends. */
function CustomRepeat({
  start,
  initial,
  onCancel,
  onDone,
}: {
  start: Date;
  initial: RepeatRule;
  onCancel: () => void;
  onDone: (rule: RepeatRule) => void;
}) {
  const t = useT();
  const titleId = useId();
  const [rule, setRule] = useState<RepeatRule>(initial);
  const ends: 'never' | 'on' | 'after' = rule.until ? 'on' : rule.count ? 'after' : 'never';
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open && typeof node.showModal === 'function') node.showModal();
  }, []);
  const freqUnit = {
    DAILY: 'MeetingForm.unitDay',
    WEEKLY: 'MeetingForm.unitWeek',
    MONTHLY: 'MeetingForm.unitMonth',
    YEARLY: 'MeetingForm.unitYear',
  } as const;
  return (
    <dialog
      ref={dialog}
      className="tm-mtg-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId} className="tm-mtg-card__title tm-mtg-dialog__title">
        {t('MeetingForm.customRepeat')}
      </h2>
      <div className="tm-mtg-dialog__row">
        <span>{t('MeetingForm.repeatEvery')}</span>
        <input
          type="number"
          min={1}
          className="tm-mtg-input tm-mtg-input--sm tm-mtg-input--num"
          aria-label={t('MeetingForm.repeatEvery')}
          value={rule.interval}
          onChange={(event) =>
            setRule({ ...rule, interval: Math.max(1, Number(event.target.value) || 1) })
          }
        />
        <select
          className="tm-mtg-input tm-mtg-input--sm"
          aria-label={t('MeetingForm.repeatUnit')}
          value={rule.freq}
          onChange={(event) =>
            setRule({ ...rule, freq: event.target.value as RepeatRule['freq'], byDay: [] })
          }
        >
          {(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const).map((freq) => (
            <option key={freq} value={freq}>
              {t(freqUnit[freq])}
            </option>
          ))}
        </select>
      </div>
      {rule.freq === 'WEEKLY' ? (
        <div className="tm-mtg-field">
          <span className="tm-mtg-label">{t('MeetingForm.on')}</span>
          <div className="tm-mtg-days">
            {WEEKDAYS.map((day) => (
              <button
                key={day}
                type="button"
                aria-pressed={rule.byDay.includes(day)}
                aria-label={t(WEEKDAY_KEYS[day])}
                onClick={() =>
                  setRule({
                    ...rule,
                    byDay: rule.byDay.includes(day)
                      ? rule.byDay.filter((d) => d !== day)
                      : WEEKDAYS.filter((d) => d === day || rule.byDay.includes(d)),
                  })
                }
              >
                {t(WEEKDAY_KEYS[day]).slice(0, 1)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <fieldset className="tm-mtg-fieldset">
        <legend className="tm-mtg-label">{t('MeetingForm.ends')}</legend>
        <label className="tm-mtg-check">
          <input
            type="radio"
            name="tm-mf-ends"
            checked={ends === 'never'}
            onChange={() => setRule({ ...rule, until: null, count: null })}
          />
          {t('MeetingForm.never')}
        </label>
        <label className="tm-mtg-check">
          <input
            type="radio"
            name="tm-mf-ends"
            checked={ends === 'on'}
            onChange={() =>
              setRule({
                ...rule,
                count: null,
                until: new Date(start.getTime() + 56 * 86_400_000).toISOString().slice(0, 10),
              })
            }
          />
          {t('MeetingForm.onDate')}
          <input
            type="date"
            className="tm-mtg-input tm-mtg-input--sm"
            aria-label={t('MeetingForm.endDate')}
            value={rule.until ?? ''}
            disabled={ends !== 'on'}
            onChange={(event) =>
              setRule({ ...rule, until: event.target.value || null, count: null })
            }
          />
        </label>
        <label className="tm-mtg-check">
          <input
            type="radio"
            name="tm-mf-ends"
            checked={ends === 'after'}
            onChange={() => setRule({ ...rule, until: null, count: 9 })}
          />
          {t('MeetingForm.after')}
          <input
            type="number"
            min={1}
            className="tm-mtg-input tm-mtg-input--sm tm-mtg-input--num"
            aria-label={t('MeetingForm.occurrences')}
            value={rule.count ?? ''}
            disabled={ends !== 'after'}
            onChange={(event) =>
              setRule({ ...rule, until: null, count: Math.max(1, Number(event.target.value) || 1) })
            }
          />
          {t('MeetingForm.meetingsWord')}
        </label>
      </fieldset>
      <p className="tm-mtg-hint">{repeatSummary(t, rule, start)}</p>
      <div className="tm-mtg-dialog__actions">
        <button type="button" className="tm-mtg-btn tm-mtg-btn--outline" onClick={onCancel}>
          {t('MeetingForm.cancel')}
        </button>
        <button
          type="button"
          className="tm-mtg-btn tm-mtg-btn--ink"
          onClick={() =>
            onDone(
              rule.freq === 'WEEKLY' && rule.byDay.length === 0
                ? { ...rule, byDay: repeatPresets(start).weekly.byDay }
                : rule,
            )
          }
        >
          {t('MeetingForm.done')}
        </button>
      </div>
    </dialog>
  );
}

/** "Add from Google Drive / OneDrive": the project's own folders (NV10), never the whole drive. */
function AttachDialog({
  api,
  organizationSlug,
  projectId,
  provider,
  onClose,
  onPick,
}: {
  api: ApiClient;
  organizationSlug: string;
  projectId: string;
  provider: 'google_drive' | 'onedrive';
  onClose: () => void;
  onPick: (files: readonly PickedFile[]) => void;
}) {
  const t = useT();
  const seen = useRef(new Map<string, { mimeType: string; driveId: string | null }>());
  const loadPage = async (input: { readonly folderId?: string; readonly pageToken?: string }) => {
    if (provider === 'google_drive') {
      const page = await getProjectDriveFiles(api, organizationSlug, projectId, input);
      for (const file of page.files) {
        seen.current.set(file.id, { mimeType: file.mimeType, driveId: null });
      }
      return page;
    }
    const page = await getProjectOneDriveFiles(api, organizationSlug, projectId, input);
    for (const file of page.files) {
      seen.current.set(file.id, { mimeType: file.mimeType, driveId: page.driveId });
    }
    return {
      folderId: page.folderId,
      files: page.files,
      folders: page.folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        kind: folder.kind === 'work_item' ? ('work_item' as const) : ('project' as const),
      })),
      nextPageToken: page.nextPageToken,
    };
  };
  return (
    <DriveProjectFilesDialog
      organizationSlug={organizationSlug}
      client={api}
      projectId={projectId}
      provider={provider}
      loadPage={loadPage}
      lede={t('MeetingForm.attachLede')}
      onClose={onClose}
      onPick={(items) =>
        onPick(
          items.map((item) => {
            const meta = seen.current.get(item.id);
            return {
              provider,
              fileId: item.id,
              driveId: meta?.driveId ?? null,
              title: item.name,
              mimeType: meta?.mimeType ?? 'application/octet-stream',
              webUrl:
                provider === 'google_drive'
                  ? `https://drive.google.com/file/d/${encodeURIComponent(item.id)}/view`
                  : `https://onedrive.live.com/?id=${encodeURIComponent(item.id)}`,
            };
          }),
        )
      }
    />
  );
}
