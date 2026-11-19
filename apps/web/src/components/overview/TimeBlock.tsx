'use client';

import type { TimeModel } from './overview-model';
import { useOverviewCopy } from './use-overview-copy';
import type { OverviewFormat } from './use-overview-format';
import {
  OverviewCard,
  OverviewEmpty,
  OverviewFigures,
  OverviewRow,
  OverviewRows,
  type OverviewFigure,
} from './OverviewCard';

/**
 * ONEPAGE Time (Figma 739:40769): hours logged and billable, and "not invoiced yet" only for a
 * viewer with finance access (review fix 1). A figure the summary did not carry is not drawn. On
 * the client page each project with time follows as one line, most hours first (D7).
 */
export function TimeBlock({
  model,
  format,
}: {
  readonly model: TimeModel;
  readonly format: OverviewFormat;
}) {
  const copy = useOverviewCopy();
  const hours = (minutes: number) => copy.fill('Overview.hours', { hours: format.hours(minutes) });
  const figures: OverviewFigure[] = [];
  if (model.loggedMinutes !== undefined) {
    figures.push({ label: copy.text('Overview.logged'), value: hours(model.loggedMinutes) });
  }
  if (model.billableMinutes !== undefined) {
    figures.push({ label: copy.text('Overview.billable'), value: hours(model.billableMinutes) });
  }
  if (model.unbilledMinutes !== undefined) {
    figures.push({ label: copy.text('Overview.notInvoiced'), value: hours(model.unbilledMinutes) });
  }
  const nothing =
    (model.loggedMinutes ?? 0) + (model.billableMinutes ?? 0) + (model.unbilledMinutes ?? 0) === 0;
  return (
    <OverviewCard
      block="time"
      title={copy.text('Overview.time')}
      link={{ href: model.link.href, label: copy.link(model.link.kind) }}
    >
      {nothing ? (
        <OverviewEmpty>{copy.text('Overview.timeEmpty')}</OverviewEmpty>
      ) : (
        <>
          <OverviewFigures figures={figures} />
          {model.projects && model.projects.length > 0 ? (
            <OverviewRows>
              {model.projects.map((project) => (
                <OverviewRow
                  key={project.id}
                  title={project.name}
                  href={project.href}
                  end={<bdi>{hours(project.loggedMinutes)}</bdi>}
                />
              ))}
            </OverviewRows>
          ) : null}
        </>
      )}
    </OverviewCard>
  );
}
