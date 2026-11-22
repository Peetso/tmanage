'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { NavIcon } from '../icons/phone';
import type { ApiClient } from '../../lib/api/client';
import type { HomeWidgetId } from '../../lib/api/home-widget-prefs';
import { listWorkActivity } from '../../lib/api/work-activity';
import type { WorkItemAudience } from '../../lib/api/work-items';
import { PORTAL_PROJECT_PARAM } from '../shell/PortalProjectSwitcher';
import { fill } from '../../lib/privacy-presentation';
import { useT } from '../../lib/i18n/use-t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import type { MessageKey } from '../../lib/i18n/t';
import {
  ALWAYS_SHOWN,
  LAYOUT_GROUPS,
  moveWidget,
  movable,
  setHidden,
  RESET_LAYOUT,
} from './my-day-layout';
import type { LayoutGroup, MyDayLayout } from './my-day-layout';
import type { MyDayEntry } from './my-day-model';
import { clock, shortDate } from './my-day-format';

/**
 * A side sheet at the inline end of the page (Figma Edit widgets `825:614`, Task story
 * `824:15643`). Non-modal: the page stays readable beside it and is not dimmed. Focus moves into
 * the sheet when it opens; Escape and × close it and focus returns to the control that opened it.
 */
function SidePanel({
  title,
  onClose,
  children,
  headerExtra,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly headerExtra?: ReactNode;
}) {
  const t = useT();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    opener.current = document.activeElement;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);

  return (
    <div
      ref={panel}
      className="tm-myday-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <div className="tm-myday-panel__head">
        <h2 id={titleId} className="tm-myday-panel__title">
          {title}
        </h2>
        <span className="tm-myday-w__spacer" />
        {headerExtra}
        <button
          type="button"
          className="tm-myday-icon"
          aria-label={t('MyDay.close')}
          onClick={onClose}
        >
          <NavIcon name="close" size={20} />
        </button>
      </div>
      {children}
    </div>
  );
}

/* ── Edit widgets ───────────────────────────────────────────────────────────────────────── */

const GROUP_KEY: Readonly<Record<LayoutGroup, MessageKey>> = {
  top: 'MyDay.group.top',
  main: 'MyDay.group.main',
  side: 'MyDay.group.side',
  bottom: 'MyDay.group.bottom',
};

/**
 * **Edit widgets** (spec rule 10, Fable F6 and ruling (c)): the groups in page order, each widget
 * with a grip (drag), Move up / Move down (the non-drag way, WCAG 2.5.7) and a switch. Next shows
 * a lock named "Always shown"; Today, alone in its group, has no arrows. Every change saves at
 * once; Done closes, Reset puts the default back.
 */
export function EditWidgetsPanel({
  layout,
  names,
  onChange,
  onClose,
  failed,
}: {
  readonly layout: MyDayLayout;
  readonly names: Readonly<Record<HomeWidgetId, string>>;
  readonly onChange: (layout: MyDayLayout) => void;
  readonly onClose: () => void;
  readonly failed: boolean;
}) {
  const t = useT();
  const [dragging, setDragging] = useState<HomeWidgetId | null>(null);

  const dropOn = (group: LayoutGroup, target: HomeWidgetId) => (event: DragEvent) => {
    event.preventDefault();
    if (dragging === null || dragging === target) return;
    const list = layout.groups[group];
    const from = list.indexOf(dragging);
    const to = list.indexOf(target);
    if (from < 0 || to < 0) return;
    let next = layout;
    const step = to > from ? 1 : -1;
    for (let index = from; index !== to; index += step) next = moveWidget(next, dragging, step);
    onChange(next);
    setDragging(null);
  };

  return (
    <SidePanel title={t('MyDay.editWidgets')} onClose={onClose}>
      <div className="tm-myday-edit">
        {LAYOUT_GROUPS.map((group) => {
          const list = layout.groups[group];
          const arrows = movable(group);
          return (
            <section key={group} className="tm-myday-edit__group" aria-label={t(GROUP_KEY[group])}>
              <h3 className="tm-myday-edit__group-title">{t(GROUP_KEY[group])}</h3>
              <ul className="tm-myday-edit__list">
                {list.map((id, index) => {
                  const name = names[id];
                  const locked = ALWAYS_SHOWN.has(id);
                  return (
                    <li
                      key={id}
                      className="tm-myday-edit__row"
                      draggable={arrows}
                      data-dragging={dragging === id || undefined}
                      onDragStart={() => setDragging(id)}
                      onDragEnd={() => setDragging(null)}
                      onDragOver={(event) => {
                        if (arrows && dragging !== null && list.includes(dragging)) {
                          event.preventDefault();
                        }
                      }}
                      onDrop={dropOn(group, id)}
                    >
                      {arrows ? (
                        <NavIcon name="grip" size={16} className="tm-myday-edit__grip" />
                      ) : (
                        <span className="tm-myday-edit__grip" />
                      )}
                      <span className="tm-myday-edit__name" id={`tm-myday-edit-${id}`}>
                        {name}
                      </span>
                      {arrows ? (
                        <>
                          <button
                            type="button"
                            className="tm-myday-icon"
                            aria-label={fill(t('MyDay.moveUp'), { name })}
                            disabled={index === 0}
                            onClick={() => onChange(moveWidget(layout, id, -1))}
                          >
                            <NavIcon name="arrowUp" size={16} />
                          </button>
                          <button
                            type="button"
                            className="tm-myday-icon"
                            aria-label={fill(t('MyDay.moveDown'), { name })}
                            disabled={index === list.length - 1}
                            onClick={() => onChange(moveWidget(layout, id, 1))}
                          >
                            <NavIcon name="arrowDown" size={16} />
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="tm-myday-icon tm-myday-icon--blank" />
                          <span className="tm-myday-icon tm-myday-icon--blank" />
                        </>
                      )}
                      {locked ? (
                        <span
                          className="tm-myday-edit__lock"
                          role="img"
                          aria-label={t('MyDay.alwaysShown')}
                        >
                          <NavIcon name="lock" size={16} />
                        </span>
                      ) : (
                        <input
                          type="checkbox"
                          role="switch"
                          className="tm-switch"
                          aria-label={fill(t('MyDay.showWidget'), { name })}
                          checked={!layout.hidden.has(id)}
                          onChange={(event) =>
                            onChange(setHidden(layout, id, !event.target.checked))
                          }
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {failed ? (
          <div className="tm-myday-w__line" role="alert">
            {t('MyDay.saveFailed')}
          </div>
        ) : null}
        <div className="tm-myday-edit__foot">
          <button
            type="button"
            className="tm-button tm-button--outline tm-button--accessible"
            onClick={onClose}
          >
            {t('MyDay.done')}
          </button>
          <button type="button" className="tm-myday-link" onClick={() => onChange(RESET_LAYOUT)}>
            {t('MyDay.reset')}
          </button>
        </div>
      </div>
    </SidePanel>
  );
}

/* ── Task story (the context lens) ──────────────────────────────────────────────────────── */

const AUDIENCE_KEY: Readonly<Record<WorkItemAudience, MessageKey>> = {
  internal: 'MyDay.audience.internal',
  client_visible: 'MyDay.audience.clientVisible',
  client_action_required: 'MyDay.audience.clientAction',
};

/**
 * **Task story** — the context lens of the old frame `351:1972`, rebuilt as Figma `824:15643`:
 * the project, the task, its due date, the latest three updates and who can see it, with
 * "Open task" and "View as client". Every line is the API's: the activity feed is the item's own
 * read, and "who can see this" is the item's audience.
 */
export function TaskStoryPanel({
  api,
  slug,
  entry,
  projectName,
  onClose,
}: {
  readonly api: ApiClient;
  readonly slug: string;
  readonly entry: MyDayEntry;
  readonly projectName: string;
  readonly onClose: () => void;
}) {
  const t = useT();
  const locale = useActiveLocale();
  const item = entry.workItem;
  const href = `/${slug}/work/${encodeURIComponent(item.id)}`;
  const activity = useQuery({
    queryKey: ['work-activity', slug, item.id],
    queryFn: () => listWorkActivity(api, slug, item.id),
    retry: false,
  });
  const latest = (activity.data ?? []).slice(0, 3);
  return (
    <SidePanel
      title={t('MyDay.taskStory')}
      onClose={onClose}
      headerExtra={
        <Link href={href} className="tm-myday-icon" aria-label={t('MyDay.openTask')}>
          <NavIcon name="arrow" size={20} />
        </Link>
      }
    >
      <div className="tm-myday-story">
        <p className="tm-myday-story__project">{projectName}</p>
        <p className="tm-myday-story__title">{item.title}</p>
        {item.dueAt ? (
          <p className="tm-myday-row__meta">
            {fill(t('MyDay.dueOn'), { day: shortDate(locale, item.dueAt, false) })}
          </p>
        ) : null}
        <hr className="tm-myday-story__rule" />
        <h3 className="tm-myday-story__heading">{t('MyDay.latest')}</h3>
        {activity.isPending ? null : latest.length === 0 ? (
          <div className="tm-myday-w__line">{t('MyDay.noActivity')}</div>
        ) : (
          <ol className="tm-myday-story__feed">
            {latest.map((event) => (
              <li key={event.id}>
                <span className="tm-myday-row__meta">{clock(event.occurredAt)}</span>
                <span className="tm-myday-story__event">{event.summary}</span>
              </li>
            ))}
          </ol>
        )}
        <hr className="tm-myday-story__rule" />
        <h3 className="tm-myday-story__heading">{t('MyDay.whoCanSee')}</h3>
        <div className="tm-myday-w__line">{t(AUDIENCE_KEY[item.audience])}</div>
        <div className="tm-myday-story__actions">
          <Link href={href} className="tm-button tm-button--outline tm-button--accessible">
            {t('MyDay.openTask')}
          </Link>
          {item.audience !== 'internal' ? (
            <Link
              href={`/${slug}/portal?${PORTAL_PROJECT_PARAM}=${encodeURIComponent(item.projectId)}`}
              className="tm-myday-link"
            >
              {t('MyDay.viewAsClient')}
            </Link>
          ) : null}
        </div>
      </div>
    </SidePanel>
  );
}
