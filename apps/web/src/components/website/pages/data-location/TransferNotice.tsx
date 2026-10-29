import { InlineAlert } from '@tmanage/ui';

/**
 * The cross-border transfer notice (54-17 §14.2): the design's Warning InlineAlert — mono warning
 * title beside the body, structural border. Shared by the public page and the organization card.
 */
export function TransferNotice({ title, body }: { title: string; body: string }) {
  return (
    <InlineAlert tone="warning" className="tm-dloc-transfer">
      <span className="tm-dloc-transfer__title">{title}</span>
      <span className="tm-dloc-transfer__body">{body}</span>
    </InlineAlert>
  );
}
