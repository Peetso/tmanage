'use client';

import type { FilesModel } from './overview-model';
import { useOverviewCopy } from './use-overview-copy';
import type { OverviewFormat } from './use-overview-format';
import {
  OverviewCard,
  OverviewEmpty,
  OverviewIconOrb,
  OverviewRow,
  OverviewRows,
} from './OverviewCard';

/** ONEPAGE Latest files (Figma 739:40704): the newest files, each opening in the viewer. */
export function FilesBlock({
  model,
  format,
}: {
  readonly model: FilesModel;
  readonly format: OverviewFormat;
}) {
  const copy = useOverviewCopy();
  return (
    <OverviewCard
      block="files"
      title={copy.text('Overview.files')}
      link={{ href: model.link.href, label: copy.link(model.link.kind) }}
    >
      {model.items.length === 0 ? (
        <OverviewEmpty>{copy.text('Overview.filesEmpty')}</OverviewEmpty>
      ) : (
        <OverviewRows>
          {model.items.map((file) => (
            <OverviewRow
              key={file.id}
              title={file.name}
              href={file.href}
              meta={[file.context, format.age(file.updatedAt)].filter(Boolean).join(' · ')}
              leading={<OverviewIconOrb icon="file" />}
            />
          ))}
        </OverviewRows>
      )}
    </OverviewCard>
  );
}
