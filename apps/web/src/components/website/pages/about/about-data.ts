import type { MessageKey } from '../../../../lib/i18n/t';
import type { WebIconName } from '../../WebIcon';

/** Copy keys for /about (Figma WEB-16 About, node 308:41). Every string lives in the catalog. */

export const WHY_PARAGRAPHS: readonly MessageKey[] = ['AboutPage.whyPara1', 'AboutPage.whyPara2'];

export interface Principle {
  icon: WebIconName;
  titleKey: MessageKey;
}

/** The four principle cards, numbered 01–04 in the design. */
export const PRINCIPLES: readonly Principle[] = [
  { icon: 'pulse', titleKey: 'AboutPage.principleCalm' },
  { icon: 'help', titleKey: 'AboutPage.principleExplain' },
  { icon: 'shield', titleKey: 'AboutPage.principlePrivate' },
  { icon: 'portal', titleKey: 'AboutPage.principleClarity' },
];

/** "How we build": three ruled columns, each a small outline orb and one line. */
export const HOW_WE_BUILD: readonly { icon: WebIconName; titleKey: MessageKey }[] = [
  { icon: 'layers', titleKey: 'AboutPage.buildReleases' },
  { icon: 'doc', titleKey: 'AboutPage.buildBilingual' },
  { icon: 'person', titleKey: 'AboutPage.buildAccessibility' },
];

/**
 * Team grid placeholder: eight Avatar instances, as drawn, until real photos and consent exist.
 * No invented names — the avatars are decorative and the row is labelled "Team photos coming soon".
 */
export const TEAM_PLACEHOLDER_COUNT = 8;
export const TEAM_PLACEHOLDER_NAME = 'M S';
