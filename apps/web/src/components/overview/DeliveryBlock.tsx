'use client';

import { StateCapsule } from '@tmanage/ui';
import type { DeliveryModel, DeliveryRow, OverviewBand } from './overview-model';
import { useOverviewCopy, type OverviewCopy } from './use-overview-copy';
import type { OverviewFormat } from './use-overview-format';
import {
  OverviewCard,
  OverviewEmpty,
  OverviewFigures,
  OverviewIconOrb,
  OverviewRow,
  OverviewRows,
} from './OverviewCard';

export interface DeliveryBlockProps {
  readonly model: DeliveryModel;
  readonly format: OverviewFormat;
  /** The empty line: "No work in this yet." on a project, "No projects shared yet." on a client. */
  readonly empty: 'work' | 'projects';
}

/**
 * ONEPAGE Delivery (Figma 739:40527 / client 740:*): open, late and done, then the next milestone
 * (project) or the client's projects at risk first (client), each with its health capsule.
 */
export function DeliveryBlock({ model, format, empty }: DeliveryBlockProps) {
  const copy = useOverviewCopy();
  const nothing = model.open + model.late + model.done === 0 && model.rows.length === 0;
  return (
    <OverviewCard
      block="delivery"
      title={copy.text('Overview.delivery')}
      link={{ href: model.link.href, label: copy.link(model.link.kind) }}
    >
      {nothing ? (
        <OverviewEmpty>
          {copy.text(empty === 'work' ? 'Overview.deliveryEmpty' : 'Overview.noProjects')}
        </OverviewEmpty>
      ) : (
        <>
          <OverviewFigures
            figures={[
              { label: copy.text('Overview.open'), value: format.count(model.open) },
              {
                label: copy.text('Overview.late'),
                value: format.count(model.late),
                ...(model.late > 0 ? { tone: 'danger' as const } : {}),
              },
              { label: copy.text('Overview.done'), value: format.count(model.done) },
            ]}
          />
          {model.complete ? null : (
            <p className="tm-ov-card__note">{copy.text('Overview.figuresPartial')}</p>
          )}
          {model.rows.length > 0 ? (
            <OverviewRows>
              {model.rows.map((row) => (
                <DeliveryRowItem key={row.id} row={row} copy={copy} format={format} />
              ))}
            </OverviewRows>
          ) : null}
        </>
      )}
    </OverviewCard>
  );
}

function DeliveryRowItem({
  row,
  copy,
  format,
}: {
  row: DeliveryRow;
  copy: OverviewCopy;
  format: OverviewFormat;
}) {
  const end = row.band ? <BandCapsule band={row.band} copy={copy} /> : undefined;
  if (row.kind === 'nextMilestone') {
    return (
      <OverviewRow
        title={row.title}
        href={row.href}
        meta={
          row.dueOn === null
            ? copy.text('Overview.nextMilestoneUndated')
            : copy.isolated('Overview.nextMilestoneDue', { date: format.day(row.dueOn) })
        }
        leading={<OverviewIconOrb icon="calendar" />}
        end={end}
      />
    );
  }
  return (
    <OverviewRow
      title={row.name}
      href={row.href}
      leading={<OverviewIconOrb icon="folderKanban" />}
      end={end}
    />
  );
}

/**
 * A health band as a capsule: red is Blocked "Behind", amber Waiting "At risk", green Current
 * "On track". `neutral` (no signals at all) draws nothing rather than a false green.
 */
export function BandCapsule({ band, copy }: { band: OverviewBand; copy: OverviewCopy }) {
  if (band === 'red') {
    return <StateCapsule state="blocked">{copy.text('Overview.bandBehind')}</StateCapsule>;
  }
  if (band === 'amber') {
    return <StateCapsule state="waiting">{copy.text('Overview.bandAtRisk')}</StateCapsule>;
  }
  if (band === 'green') {
    return <StateCapsule state="current">{copy.text('Overview.bandOnTrack')}</StateCapsule>;
  }
  return null;
}
