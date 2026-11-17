'use client';

import { useId } from 'react';
import Link from '../../WebLink';
import { WebSection } from '../../sections';
import {
  COMPARE_LINKS_COPY,
  compareLinks,
  type CompareLinkTopic,
} from '../../../../content/alternatives/compare-links';
import { languageOf } from '../../../../lib/i18n/route-locale';
import { useActiveLocale } from '../../../../lib/i18n/use-active-locale';
import '../compare/compare.css';

/**
 * SEOG (B19) — the "Compare TManage" links above a feature or solution page's call to action, in
 * the compare pages' own link style. The compare and alternative pages exist in English and
 * Arabic only, so a reader in another language sees no links rather than English ones.
 */
export function CompareLinks({ topic }: { topic: CompareLinkTopic }) {
  const id = useId();
  const language = languageOf(useActiveLocale());
  if (language !== 'en' && language !== 'ar') return null;
  const links = compareLinks(topic, language);
  return (
    <WebSection spacing="compact">
      <p
        className="tm-web-compare-all tm-web-compare-all--index"
        role="group"
        aria-labelledby={id}
        data-testid="compare-links"
      >
        <span id={id}>{COMPARE_LINKS_COPY[language].label}:</span>{' '}
        {links.map((link, index) => (
          <span key={link.href}>
            {index === 0 ? null : <span aria-hidden="true"> · </span>}
            <Link href={link.href}>{link.label}</Link>
          </span>
        ))}
      </p>
    </WebSection>
  );
}
