'use client';

import { StateCapsule } from '@tmanage/ui';
import type { ApprovalsModel } from './overview-model';
import { useOverviewCopy } from './use-overview-copy';
import type { OverviewFormat } from './use-overview-format';
import {
  OverviewCard,
  OverviewEmpty,
  OverviewIconOrb,
  OverviewRow,
  OverviewRows,
  isolatedParts,
} from './OverviewCard';

/**
 * ONEPAGE Approvals waiting (Figma 739:40583): the oldest deliverables waiting, each saying on whom
 * it waits: the client (violet Client capsule) or the team (Waiting capsule), and for how long.
 */
export function ApprovalsBlock({
  model,
  format,
}: {
  readonly model: ApprovalsModel;
  readonly format: OverviewFormat;
}) {
  const copy = useOverviewCopy();
  return (
    <OverviewCard
      block="approvals"
      title={copy.text('Overview.approvals')}
      link={{ href: model.link.href, label: copy.link(model.link.kind) }}
    >
      {model.items.length === 0 ? (
        <OverviewEmpty>{copy.text('Overview.approvalsEmpty')}</OverviewEmpty>
      ) : (
        <OverviewRows>
          {model.items.map((item) => (
            <OverviewRow
              key={item.id}
              title={item.title}
              href={item.href}
              meta={isolatedParts([item.context, format.age(item.since)])}
              leading={<OverviewIconOrb icon="badgeCheck" />}
              end={
                item.waitingOn === 'client' ? (
                  <StateCapsule state="client">{copy.text('Overview.withClient')}</StateCapsule>
                ) : (
                  <StateCapsule state="waiting">{copy.text('Overview.withTeam')}</StateCapsule>
                )
              }
            />
          ))}
        </OverviewRows>
      )}
    </OverviewCard>
  );
}
