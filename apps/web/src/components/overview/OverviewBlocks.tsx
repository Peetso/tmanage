'use client';

import type { ReactNode } from 'react';
import { Button, LoadingRegion, Skeleton } from '@tmanage/ui';
import type { OverviewModel } from './overview-model';
import { useOverviewCopy } from './use-overview-copy';
import { useOverviewFormat } from './use-overview-format';
import { DeliveryBlock } from './DeliveryBlock';
import { ApprovalsBlock } from './ApprovalsBlock';
import { RisksBlock } from './RisksBlock';
import { FilesBlock } from './FilesBlock';
import { TimeBlock } from './TimeBlock';
import { MoneyBlock } from './MoneyBlock';
import '../../styles/screens/overview.css';

export type OverviewBlocksProps =
  | {
      readonly state: 'ready';
      readonly model: OverviewModel;
      readonly now: Date;
      readonly deliveryEmpty: 'work' | 'projects';
    }
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly onRetry: () => void };

/**
 * ONEPAGE — the six blocks in the frames' two rows: delivery, approvals, risks; then files, time,
 * money (Figma "Overview blocks" 739:40526). A row holds only the blocks that are present and
 * shares its width between them, so an absent block leaves no gap (frame 739:41403); a row with no
 * block is not drawn. One column on a phone, in the same order.
 *
 * Loading draws a skeleton per card. The page is one read, so a failed read shows one card with
 * "Could not load this. Try again." and the header and tabs stay (review FIGMA-C fix 7).
 */
export function OverviewBlocks(props: OverviewBlocksProps) {
  const copy = useOverviewCopy();
  if (props.state === 'loading') {
    return (
      <LoadingRegion label={copy.text('Overview.loading')} className="tm-ov-blocks">
        {[0, 1].map((row) => (
          <div key={row} className="tm-ov-blocks__row">
            {[0, 1, 2].map((card) => (
              <div key={card} className="tm-ov-card tm-ov-card--skeleton">
                <Skeleton height="27px" width="45%" />
                <Skeleton height="50px" />
                <Skeleton height="40px" />
              </div>
            ))}
          </div>
        ))}
      </LoadingRegion>
    );
  }
  if (props.state === 'error') {
    return (
      <div className="tm-ov-blocks">
        <div className="tm-ov-card tm-ov-card--error" role="alert">
          <p className="tm-ov-card__empty">{copy.text('Overview.loadFailed')}</p>
          <Button tone="ink" size="accessible" onClick={props.onRetry}>
            {copy.text('Overview.tryAgain')}
          </Button>
        </div>
      </div>
    );
  }
  return <ReadyBlocks model={props.model} now={props.now} deliveryEmpty={props.deliveryEmpty} />;
}

function ReadyBlocks({
  model,
  now,
  deliveryEmpty,
}: {
  model: OverviewModel;
  now: Date;
  deliveryEmpty: 'work' | 'projects';
}) {
  const format = useOverviewFormat(now);
  const top: ReactNode[] = [];
  const bottom: ReactNode[] = [];
  if (model.delivery) {
    top.push(
      <DeliveryBlock key="delivery" model={model.delivery} format={format} empty={deliveryEmpty} />,
    );
  }
  if (model.approvals) {
    top.push(<ApprovalsBlock key="approvals" model={model.approvals} format={format} />);
  }
  if (model.risks) top.push(<RisksBlock key="risks" model={model.risks} format={format} />);
  if (model.files) bottom.push(<FilesBlock key="files" model={model.files} format={format} />);
  if (model.time) bottom.push(<TimeBlock key="time" model={model.time} format={format} />);
  if (model.money) bottom.push(<MoneyBlock key="money" model={model.money} format={format} />);

  return (
    <div className="tm-ov-blocks">
      {top.length > 0 ? <div className="tm-ov-blocks__row">{top}</div> : null}
      {bottom.length > 0 ? <div className="tm-ov-blocks__row">{bottom}</div> : null}
    </div>
  );
}
