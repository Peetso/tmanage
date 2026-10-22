import { render } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { activeLocale } from '../src/lib/i18n/locale-store';
import {
  ApprovalScene,
  AuditLogScene,
  OFFBOARDING_STEPS,
  OffboardingScene,
  PublicationScene,
  offboardingProgress,
} from '../src/components/website/pages/security/SecurityScenes';
import {
  ClientBoundariesScene,
  CreativeReviewScene,
  PortfolioScene,
  RetainerPlanScene,
} from '../src/components/website/pages/solutions-agencies/scenes';
import {
  DecisionDetailScene,
  DecisionRegisterScene,
  EngagementStoryScene,
  SteeringHealthScene,
} from '../src/components/website/pages/solutions-consultancies/scenes';
import {
  IntakeFormScene,
  RequestInboxScene,
  StakeholderReviewScene,
  WorkloadScene,
} from '../src/components/website/pages/solutions-inhouse/scenes';

/**
 * Slice L7 (live check 014a9d51, report lines 120, 121, 131, 140, 160): the product scenes on
 * /solutions/agencies, /solutions/consultancies, /solutions/in-house and /security render in
 * Arabic under ar-EG, keeping only the Latin the design keeps (TManage, client and person names,
 * IDs, hashes, version tags, addresses); and the offboarding crumb and panel agree on the steps.
 */

const SCENES: readonly [string, ComponentType][] = [
  ['OffboardingScene', OffboardingScene],
  ['AuditLogScene', AuditLogScene],
  ['PublicationScene', PublicationScene],
  ['ApprovalScene', ApprovalScene],
  ['PortfolioScene', PortfolioScene],
  ['ClientBoundariesScene', ClientBoundariesScene],
  ['CreativeReviewScene', CreativeReviewScene],
  ['RetainerPlanScene', RetainerPlanScene],
  ['DecisionRegisterScene', DecisionRegisterScene],
  ['EngagementStoryScene', EngagementStoryScene],
  ['DecisionDetailScene', DecisionDetailScene],
  ['SteeringHealthScene', SteeringHealthScene],
  ['RequestInboxScene', RequestInboxScene],
  ['IntakeFormScene', IntakeFormScene],
  ['StakeholderReviewScene', StakeholderReviewScene],
  ['WorkloadScene', WorkloadScene],
];

/** Latin words the design keeps in Arabic: the product, organizations and people. */
const KEPT_LATIN = new Set([
  'TManage',
  'Northstar',
  'Studio',
  'Atlas',
  'Hospitality',
  'Meridian',
  'Group',
  'Harbour',
  'Northwind',
  'Karim',
  'Nabil',
  'Lina',
  'Samir',
  'Omar',
  'Adel',
  'Maya',
  'Hassan',
  'Youssef',
  'Kamal',
  'Salma',
  'Riad',
  'Dina',
  'Ashraf',
  'Noor',
  'Fathy',
  'CSV',
]);

/** The English words left in a rendered scene once addresses, IDs and hashes are removed. */
function englishWords(text: string): string[] {
  const stripped = text
    .replace(/[a-z]+\.tmanage\.com\S*/g, ' ')
    .replace(/#[a-z-]+/g, ' ')
    .replace(/\b[A-Z]+(?:-[A-Z0-9]+)+\b/g, ' ')
    .replace(/\b[0-9a-f]{4}[·-][0-9a-f]{4}\b/g, ' ');
  return (stripped.match(/[A-Za-z]{3,}/g) ?? []).filter((word) => !KEPT_LATIN.has(word));
}

/** Every text node, space-separated, so adjacent spans (initials, name) do not run together. */
function textOf(element: Element): string {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    parts.push(node.textContent ?? '');
  }
  return parts.join(' ');
}

afterEach(() => activeLocale.set('en-US'));

describe('L7 offboarding step count', () => {
  it('derives done, running and total from OFFBOARDING_STEPS', () => {
    expect(offboardingProgress()).toEqual({
      done: OFFBOARDING_STEPS.filter((step) => step.state === 'done').length,
      current: OFFBOARDING_STEPS.findIndex((step) => step.state === 'now') + 1,
      total: OFFBOARDING_STEPS.length,
    });
    expect(offboardingProgress()).toEqual({ done: 4, current: 5, total: 6 });
  });

  it('shows the same count in the crumb and the panel', () => {
    const { container } = render(<OffboardingScene />);
    const text = container.textContent ?? '';
    expect(text).toContain('Step 5 of 6');
    expect(text).toContain('4 of 6 steps done');
    expect(text).not.toContain('Step 3 of 3');
  });

  it('keeps the counts in Arabic', () => {
    activeLocale.set('ar-EG');
    const { container } = render(
      <div dir="rtl">
        <OffboardingScene />
      </div>,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('الخطوة 5 من 6');
    expect(text).toContain('اكتملت 4 من 6 خطوات');
  });
});

describe('L7 solutions and security scenes in Arabic', () => {
  it.each(SCENES)('%s renders no raw key in English', (_name, Scene) => {
    const { container } = render(<Scene />);
    expect(container.textContent ?? '').not.toMatch(/Scenes\.[A-Za-z0-9]+/);
  });

  it.each(SCENES)('%s has no English scene text under ar-EG', (_name, Scene) => {
    activeLocale.set('ar-EG');
    const { container } = render(
      <div dir="rtl">
        <Scene />
      </div>,
    );
    const text = textOf(container);
    expect(text).not.toMatch(/Scenes\.[A-Za-z0-9]+/);
    expect(text).toMatch(/[؀-ۿ]/);
    expect(englishWords(text)).toEqual([]);
  });
});
