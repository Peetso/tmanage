'use client';

import Link from 'next/link';
import { useAiText } from '../ai-chat/use-ai-text';

export type AiAdminTab = 'settings' | 'usage' | 'memory';

/**
 * Control Center › AI: the in-page tabs Settings · Usage · Business Memory (Figma G11 771:45480,
 * G1 v2 786:48752). They are links between pages, so the current one carries
 * `aria-current="page"` rather than a tab role (no panel switches in place). Settings opens the
 * existing AI assistant settings until the TManage AI settings page has its API (62-17).
 */
export function AiAdminTabs({
  organizationSlug,
  current,
}: {
  readonly organizationSlug: string;
  readonly current: AiAdminTab;
}) {
  const { t } = useAiText();
  const base = `/${encodeURIComponent(organizationSlug)}`;
  const tabs: readonly { id: AiAdminTab; href: string; label: string }[] = [
    { id: 'settings', href: `${base}/settings/ai-assistant`, label: t('AiUsage.tab.settings') },
    { id: 'usage', href: `${base}/admin/ai/usage`, label: t('AiUsage.tab.usage') },
    { id: 'memory', href: `${base}/admin/ai/memory`, label: t('BusinessMemory.title') },
  ];
  return (
    <nav className="tm-aia-tabs" aria-label={t('AiUsage.tab.label')}>
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          className="tm-aia-tabs__item"
          {...(tab.id === current ? { 'aria-current': 'page' as const } : {})}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
