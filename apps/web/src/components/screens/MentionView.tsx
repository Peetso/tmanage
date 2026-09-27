import Link from 'next/link';
import type { MentionSummary } from '../../lib/api/my-mentions';

export interface MentionViewProps {
  organizationSlug: string;
  mention: MentionSummary;
}

/**
 * **One mention row** — the presentational half paired with {@link MyMentionsScreen}.
 *
 * It draws a single mention: the channel it was said in, when, and the body, with a jump into the
 * channel at that message. It owns no data fetching and no state; the screen supplies a
 * {@link MentionSummary} the API has already scoped to the caller's own conversations, so this
 * component never has to decide what the caller may see — it only renders it.
 */
export function MentionView({ organizationSlug, mention }: MentionViewProps) {
  const href = `/${organizationSlug}/chat/${mention.conversationId}#message-${mention.messageId}`;

  return (
    <li className="tm-stack">
      <Link href={href} className="tm-table__title">
        {mention.conversationName}
      </Link>
      <p className="tm-text-muted">{mention.body}</p>
      <time dateTime={mention.createdAt} className="tm-eyebrow">
        {new Date(mention.createdAt).toLocaleString()}
      </time>
    </li>
  );
}
