'use client';

import Link from 'next/link';
import { useAiText } from './use-ai-text';
import './own-ai-pointer.css';

/**
 * AI-TWO-WAYS (plan 62 §Decision): wherever TManage AI cannot answer, the other direction stays in
 * sight — the member's own AI through MCP, which never depends on the test list, the owner's
 * switch or credits. Links to Settings › AI assistant (connect in three steps).
 */
export function OwnAiPointer({ organizationSlug }: { readonly organizationSlug: string }) {
  const { t } = useAiText();
  return (
    <p className="tm-own-ai-pointer">
      {t('AiSettings.own.pointer')}{' '}
      <Link href={`/${encodeURIComponent(organizationSlug)}/settings/ai-assistant`}>
        {t('AiSettings.own.pointerLink')}
      </Link>
    </p>
  );
}
