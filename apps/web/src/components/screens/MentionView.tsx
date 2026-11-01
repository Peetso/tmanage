import Link from 'next/link';
import type { MentionSummary } from '../../lib/api/my-mentions';
import { appLocale } from '../../lib/i18n/app-locale';

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
    <li className="tm-chat-mention">
      <div className="tm-chat-mention__head">
        <Link href={href}>#{mention.conversationName.replace(/^#/u, '')}</Link>
        <time dateTime={mention.createdAt} className="tm-chat-mono">
          {formatStamp(mention.createdAt)}
        </time>
      </div>
      <p className="tm-chat-mention__body">{mention.body}</p>
    </li>
  );
}

function formatStamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(appLocale(), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(parsed);
}
