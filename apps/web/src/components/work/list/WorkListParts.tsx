'use client';

import type { StageGroup, StageSetView } from '../../../lib/api/work-stages';
import type { WorkItemSummary } from '../../../lib/api/work-items';
import { appDateLocale } from '../../../lib/i18n/app-locale';
import { dayOf, parseDay, useA6T } from '../DueDatePicker';
import { initialsOf } from '../OwnerPickerDialog';
import { BUILT_IN_NAME_KEY, groupOfState } from '../stages/stage-model';
import { StageCapsule } from '../stages/WorkStageControl';
import { ageOf } from './work-list-model';

/** Faces before "+N" on a row or a card (Figma `WV2-01`: "SA YT MR +1"). */
const FACES = 3;

/**
 * Figma `Avatar/24` in a row: up to three initials, then "+N". The names are read once by a
 * screen reader (the faces are decorative), and the tooltip carries them for a pointer.
 */
export function Faces({
  ids,
  nameOf,
  emptyLabel,
}: {
  readonly ids: readonly string[];
  readonly nameOf: (userId: string) => string;
  /** Read for an empty cell ("No supervisor"); the cell shows a dash. */
  readonly emptyLabel?: string;
}) {
  if (ids.length === 0) {
    return (
      <span className="tm-wl-faces" data-empty="true">
        <span aria-hidden="true">—</span>
        {emptyLabel ? <span className="tm-visually-hidden">{emptyLabel}</span> : null}
      </span>
    );
  }
  const names = ids.map(nameOf);
  return (
    <span className="tm-wl-faces" title={names.join(', ')}>
      <span className="tm-wl-faces__stack" aria-hidden="true">
        {ids.slice(0, FACES).map((id, index) => (
          <span key={id} className="tm-wl-face">
            {initialsOf(names[index] ?? '')}
          </span>
        ))}
      </span>
      {ids.length > FACES ? (
        // U+200E keeps "+1" reading left to right inside Arabic text (Fable must-fix 6).
        <span className="tm-wl-faces__more" aria-hidden="true">{`‎+${ids.length - FACES}`}</span>
      ) : null}
      <span className="tm-visually-hidden">{names.join(', ')}</span>
    </span>
  );
}

/** The client cell: the purple dot and the company, or "Internal" (Figma `WV2-01`). */
export function ClientName({
  item,
  nameOf,
}: {
  readonly item: WorkItemSummary;
  readonly nameOf: (clientOrganizationId: string) => string | undefined;
}) {
  const t = useA6T();
  if (item.audience === 'internal') {
    return (
      <span className="tm-wl-client" data-internal="true">
        {t('WorkPage.audienceInternal')}
      </span>
    );
  }
  const names = (item.clientOrganizationIds ?? [])
    .map(nameOf)
    .filter((name): name is string => name !== undefined);
  // A client-facing work whose companies this reader cannot name (no project client yet, or no
  // right to list them) says who it is for in the audience's own words.
  const label =
    names.length === 0
      ? t(
          item.audience === 'client_action_required'
            ? 'WorkPage.audienceAction'
            : 'WorkPage.audienceFollow',
        )
      : names.length === 1
        ? names[0]
        : `${names[0]} ‎+${names.length - 1}`;
  return (
    <span
      className="tm-wl-client"
      title={item.audience === 'client_action_required' ? t('WorkPage.audienceAction') : undefined}
    >
      <span className="tm-wl-client__dot" aria-hidden="true" />
      <bdi>{label}</bdi>
    </span>
  );
}

/**
 * A work's stage as a capsule: its set's stage (name and colour), the state's own word on the
 * built-in stages, and "Blocked" / "Archived" in place of a stage, as on the work page.
 */
export function WorkStageCapsule({
  item,
  sets,
}: {
  readonly item: WorkItemSummary;
  readonly sets: readonly StageSetView[];
}) {
  const t = useA6T();
  if (item.state === 'blocked' || item.state === 'archived') {
    return (
      <span className="tm-wl-stage" data-state={item.state}>
        <StageCapsule
          stage={{ colorKey: item.state === 'blocked' ? 'red' : null, group: 'not_started' }}
          name={t(
            item.state === 'blocked'
              ? 'WorkListScreen.stateBlocked'
              : 'WorkListScreen.stateArchived',
          )}
        />
      </span>
    );
  }
  const stage = item.stageId
    ? sets.flatMap((set) => set.stages).find((candidate) => candidate.id === item.stageId)
    : undefined;
  const group: StageGroup = stage?.group ?? groupOfState(item.state) ?? 'not_started';
  const name =
    item.stageName ?? stage?.name ?? t(BUILT_IN_NAME_KEY[item.state] ?? 'WorkStages.stage');
  return (
    <span className="tm-wl-stage">
      <StageCapsule stage={{ colorKey: stage?.colorKey ?? null, group }} name={name} />
    </span>
  );
}

/** "Tue 1 Dec" / "الثلاثاء 1 ديسمبر": the due day with its weekday, in the reader's language. */
export function formatDueDay(value: string | null, locale: string): string {
  const day = dayOf(value);
  const parsed = parseDay(day);
  if (parsed === null) return '';
  const arabic = locale.toLowerCase().startsWith('ar');
  const parts = new Intl.DateTimeFormat(appDateLocale(locale), {
    weekday: arabic ? 'long' : 'short',
    day: 'numeric',
    month: arabic ? 'long' : 'short',
    timeZone: 'UTC',
  }).formatToParts(parsed);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return [part('weekday'), part('day'), part('month')].filter(Boolean).join(' ');
}

/** "2h ago", "Yesterday", "3 days ago", "1 week ago" — when the work last changed. */
export function formatAge(updatedAt: string, now: Date, locale: string): string {
  const age = ageOf(updatedAt, now);
  if (age === null) return '';
  const tag = appDateLocale(locale, 'en');
  const short = age.unit === 'minute' || age.unit === 'hour';
  const text = new Intl.RelativeTimeFormat(tag, {
    // "yesterday" for one day; numbers for everything else ("1 week ago", not "last week").
    numeric: age.unit === 'day' ? 'auto' : 'always',
    style: short ? 'narrow' : 'long',
  }).format(-age.value, age.unit);
  return text.charAt(0).toLocaleUpperCase(tag) + text.slice(1);
}
