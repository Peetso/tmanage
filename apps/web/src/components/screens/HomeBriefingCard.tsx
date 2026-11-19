'use client';

import { useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, StatusDot, VisuallyHidden } from '@tmanage/ui';
import type { StatusTone } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { getHomeBriefing, hasBriefing, homeBriefingQueryKey } from '../../lib/api/home-briefing';
import type {
  BriefingGroup,
  BriefingGroupKey,
  BriefingLine,
  HomeBriefing,
} from '../../lib/api/home-briefing';
import { getHomeWidgetPrefs, updateHomeWidgetPrefs } from '../../lib/api/home-widget-prefs';
import { useIsMobile } from '../../lib/hooks/useIsMobile';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useUndo } from '../../lib/undo/use-undo';
import {
  BRIEFING_COPY,
  briefingReason,
  briefingTitle,
  filledParts,
  fillHoles,
  groupKey,
} from './home-briefing-copy';
import type { BriefingCopyKey, FilledText } from './home-briefing-copy';
import '../../styles/screens/home-briefing.css';

/** The Home widget id of this card (hidden through the person's own widget prefs). */
export const BRIEFING_WIDGET_ID = 'businessBriefing';

const HIDE_UNDO_KEY = 'home-briefing:hide';

/** The dot before each group name: the same tone a signal of that kind carries elsewhere. */
const GROUP_TONE: Readonly<Record<BriefingGroupKey, StatusTone>> = {
  projects_at_risk: 'danger',
  money_to_collect: 'warning',
  money_to_invoice: 'neutral',
  people_overloaded: 'warning',
  waiting_on_clients: 'client',
  over_budget: 'danger',
  stale_work: 'neutral',
  unusual_expenses: 'warning',
};

export interface HomeBriefingCardProps {
  readonly organizationSlug: string;
  readonly client?: ApiClient | undefined;
  /** For stories and tests: "now", to say "today". */
  readonly now?: () => Date;
}

function useCopy() {
  const tOr = useTOr();
  return useMemo(() => {
    const text = (key: BriefingCopyKey) => tOr(key, BRIEFING_COPY[key]);
    return {
      text,
      fill: (key: BriefingCopyKey, values: Readonly<Record<string, string>>) =>
        fillHoles(text(key), values),
    };
  }, [tOr]);
}

/** Words with each value isolated, so a Latin name or an amount never reorders Arabic (fix 20). */
function Filled({ text }: { readonly text: FilledText }) {
  return (
    <>
      {filledParts(text).map((part, index) =>
        part.kind === 'value' ? <bdi key={index}>{part.value}</bdi> : part.value,
      )}
    </>
  );
}

/**
 * **Business briefing on Home (62-A1b, FIGMA-D group b).**
 *
 * The first block on Home for anyone who may see at least one group: what the last hourly check
 * found that this person can act on, grouped in a fixed order, three lines a group and "and N
 * more", each line opening its record. Built from rows on the server; no model. Absent when the
 * company's `business_briefing` flag is off, for clients and guests, for someone who leads
 * nothing, and when the person hid it (their own widget prefs; Undo in the toast, back from Home
 * settings). On the phone each group shows its header and first line and opens on tap (fix 12).
 */
export function HomeBriefingCard({
  organizationSlug,
  client,
  now = () => new Date(),
}: HomeBriefingCardProps) {
  const api = client ?? browserApiClient();
  const copy = useCopy();
  const format = useDisplayFormatters();
  const phone = useIsMobile();
  const queries = useQueryClient();
  const undo = useUndo();
  const titleId = useId();

  const briefing = useQuery({
    queryKey: homeBriefingQueryKey(organizationSlug),
    queryFn: () => getHomeBriefing(api, organizationSlug),
  });
  const prefs = useQuery({
    queryKey: ['home-widget-prefs', organizationSlug],
    queryFn: () => getHomeWidgetPrefs(api, organizationSlug),
  });

  // Nothing until the first answer: most people have no briefing, so a skeleton would flash a
  // card they never get (FIGMA-D fix 17's skeleton is read as the refetch, which keeps the lines).
  if (briefing.isPending) return null;
  if (briefing.isSuccess && !hasBriefing(briefing.data)) return null;
  if (prefs.data?.hidden.includes(BRIEFING_WIDGET_ID)) return null;
  if (undo.isPending(HIDE_UNDO_KEY)) return null;

  const hide = (): void => {
    const current = prefs.data ?? { order: [], hidden: [] };
    undo.schedule({
      key: HIDE_UNDO_KEY,
      message: copy.text('HomeBriefing.hidden'),
      commit: () =>
        updateHomeWidgetPrefs(api, organizationSlug, {
          order: current.order,
          hidden: [...current.hidden.filter((id) => id !== BRIEFING_WIDGET_ID), BRIEFING_WIDGET_ID],
        }),
      onCommitted: () =>
        void queries.invalidateQueries({ queryKey: ['home-widget-prefs', organizationSlug] }),
    });
  };

  const head = (data: HomeBriefing | null) => (
    <header className="tm-brief__head">
      <div className="tm-brief__heading">
        <h2 id={titleId} className="tm-brief__title">
          {copy.text('HomeBriefing.title')}
        </h2>
        {data?.asOf ? <p className="tm-brief__asof">{asOfLine(data.asOf)}</p> : null}
      </div>
      <Button type="button" tone="text" size="accessible" onClick={hide}>
        {copy.text('HomeBriefing.hide')}
      </Button>
    </header>
  );

  function asOfLine(iso: string): string {
    const time = format.time(iso);
    const today = format.day(iso) === format.day(now().toISOString());
    return copy.fill(today ? 'HomeBriefing.asOfToday' : 'HomeBriefing.asOf', {
      time: today ? time : format.dateTime(iso),
    });
  }

  if (briefing.isError) {
    return (
      <section className="tm-brief" aria-labelledby={titleId}>
        {head(null)}
        <div className="tm-brief__failed" role="alert">
          <p>{copy.text('HomeBriefing.loadFailed')}</p>
          <Button type="button" tone="outline" onClick={() => void briefing.refetch()}>
            {copy.text('HomeBriefing.tryAgain')}
          </Button>
        </div>
      </section>
    );
  }

  const data = briefing.data;
  if (!hasBriefing(data)) return null;

  return (
    <section className="tm-brief" aria-labelledby={titleId}>
      {head(data)}
      {data.groups.length === 0 ? (
        <div className="tm-brief__empty">
          <h3 className="tm-brief__empty-title">
            <StatusDot tone="success">{copy.text('HomeBriefing.emptyTitle')}</StatusDot>
          </h3>
          <p className="tm-brief__empty-body">
            {data.asOf
              ? copy.fill('HomeBriefing.emptyBody', { time: format.time(data.asOf) })
              : copy.text('HomeBriefing.emptyNotYet')}
          </p>
        </div>
      ) : (
        <>
          <p className="tm-brief__lead">
            {copy.text(
              data.audience === 'company' ? 'HomeBriefing.leadCompany' : 'HomeBriefing.leadTeam',
            )}
          </p>
          <div className="tm-brief__groups">
            {data.groups.map((group) => (
              <BriefingGroupBlock
                key={group.group}
                group={group}
                organizationSlug={organizationSlug}
                collapsible={phone}
                copy={copy}
                count={(value) => format.number(value)}
                reasonOf={(line) =>
                  briefingReason(line, {
                    text: copy.text,
                    number: (value) => format.number(value),
                    money: (minor, currency) => format.money(minor, currency),
                  })
                }
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

interface GroupBlockProps {
  readonly group: BriefingGroup;
  readonly organizationSlug: string;
  readonly collapsible: boolean;
  readonly copy: ReturnType<typeof useCopy>;
  readonly reasonOf: (line: BriefingLine) => FilledText;
  /** A count in the reader's digits. */
  readonly count: (value: number) => string;
}

function BriefingGroupBlock({
  group,
  organizationSlug,
  collapsible,
  copy,
  reasonOf,
  count,
}: GroupBlockProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const name = copy.text(groupKey(group.group));
  const href = (path: string) => `/${encodeURIComponent(organizationSlug)}${path}`;
  const expanded = !collapsible || open;
  const lines = expanded ? group.lines : group.lines.slice(0, 1);

  const label = (
    <>
      <StatusDot tone={GROUP_TONE[group.group]}>
        <span className="tm-brief-group__name">{name}</span>
      </StatusDot>
      <Badge tone={group.group === 'waiting_on_clients' ? 'client' : 'neutral'}>
        <span aria-hidden="true">{count(group.count)}</span>
        <VisuallyHidden>
          {copy.fill('HomeBriefing.countLabel', { count: count(group.count), group: name })}
        </VisuallyHidden>
      </Badge>
    </>
  );

  return (
    <section className="tm-brief-group" data-group={group.group}>
      <h3 className="tm-brief-group__head">
        {collapsible ? (
          <button
            type="button"
            className="tm-brief-group__toggle"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen(!open)}
          >
            {label}
          </button>
        ) : (
          <span className="tm-brief-group__label">{label}</span>
        )}
      </h3>
      <div id={listId}>
        <ul className="tm-brief-group__lines">
          {lines.map((line) => (
            <li key={line.signalId}>
              <Link className="tm-brief-line" href={href(line.path)}>
                <span className="tm-brief-line__title">
                  <bdi>{briefingTitle(line, copy.text)}</bdi>
                  {line.context ? (
                    <>
                      {' · '}
                      <bdi>{line.context}</bdi>
                    </>
                  ) : null}
                </span>
                <span className="tm-brief-line__reason">
                  <Filled text={reasonOf(line)} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {expanded && group.more > 0 ? (
          <Link className="tm-brief-group__more" href={href(group.path)}>
            <Filled
              text={{
                template: copy.text('HomeBriefing.more'),
                values: { count: count(group.more) },
              }}
            />
          </Link>
        ) : null}
      </div>
    </section>
  );
}
