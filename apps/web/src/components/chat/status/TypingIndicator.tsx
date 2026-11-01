'use client';

import type { ReactElement } from 'react';
import { useParams } from 'next/navigation';
import { browserApiClient } from '../../../lib/api/browser-client';
import { useT } from '../../../lib/i18n/use-t';
import type { MessageKey } from '../../../lib/i18n/t';
import { useMembers } from '../../../lib/use-members';
import { useTyping } from '../../../lib/use-typing';
import './status.css';

/** Pure: the typing sentence — "Sara is typing…", "Sara and Omar…", "Sara and 2 others…". */
export function typingSentence(
  names: readonly string[],
  t: (key: MessageKey) => string,
): string | null {
  const [first, second] = names;
  if (first === undefined) return null;
  if (second === undefined) return t('ChatStatus.typingOne').replace('{name}', first);
  if (names.length === 2) {
    return t('ChatStatus.typingTwo').replace('{name}', first).replace('{other}', second);
  }
  return t('ChatStatus.typingMany')
    .replace('{name}', first)
    .replace('{n}', String(names.length - 1));
}

/**
 * The typing row under the transcript. Reads its own studio from the route, joins the shared
 * chat socket for `conversationId`, and names people from the member directory.
 */
export function TypingIndicator({
  conversationId,
}: {
  readonly conversationId: string;
}): ReactElement | null {
  const t = useT();
  const params = useParams<{ orgSlug?: string }>();
  const organizationSlug = typeof params?.orgSlug === 'string' ? params.orgSlug : '';
  const api = browserApiClient();
  const { typingUserIds } = useTyping(organizationSlug, conversationId, api);
  const { members } = useMembers(api, organizationSlug);
  const names = typingUserIds.map(
    (id) => members.find((member) => member.userId === id)?.displayName ?? t('ChatStatus.someone'),
  );
  const sentence = typingSentence(names, t);
  return (
    <div className="tm-typing" role="status" aria-live="polite">
      {sentence === null ? null : (
        <>
          <span className="tm-typing__dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="tm-typing__text">{sentence}</span>
        </>
      )}
    </div>
  );
}
