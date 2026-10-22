import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ClientPortalPage } from '../src/components/website/pages/client-portal/ClientPortalPage';
import { FeaturesCommunicationPage } from '../src/components/website/pages/features-communication/FeaturesCommunicationPage';
import { FeaturesInsightsPage } from '../src/components/website/pages/features-insights/FeaturesInsightsPage';

/**
 * **Website round 2 · WEB-04, WEB-06, WEB-07 (2026-10-22).** The three pages follow their Figma
 * frames: on-page anchors land on a real section, the chat hero sits on the ink panel, and the
 * portal's "thirty seconds" cards are the numbered steps 1–3 with no internal-only links.
 */

function anchorTargetsExist(container: HTMLElement, nav: HTMLElement) {
  const hrefs = within(nav)
    .getAllByRole('link')
    .map((link) => link.getAttribute('href') ?? '');
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) {
    expect(href.startsWith('#')).toBe(true);
    expect(container.querySelector(href), href).not.toBeNull();
  }
}

describe('website round-2 pages', () => {
  it('Insights: every hero pill lands on a section of the page', () => {
    const { container } = render(<FeaturesInsightsPage />);
    anchorTargetsExist(container, screen.getByRole('navigation'));
  });

  it('Chat & calendar: every anchor lands on a section and the hero visual is the ink panel', () => {
    const { container } = render(<FeaturesCommunicationPage />);
    anchorTargetsExist(container, screen.getByRole('navigation'));
    expect(container.querySelector('.tm-wc-hero__visual.tm-web-visual--ink')).not.toBeNull();
    expect(container.querySelector('.tm-wc-quiet.tm-web-section--sunken li')).not.toBeNull();
  });

  it('Client portal: thirty-seconds cards are steps 1, 2, 3 and the free block links to pricing', () => {
    const { container } = render(<ClientPortalPage />);
    const steps = [...container.querySelectorAll('.tm-cp-three .tm-cp-step')].map(
      (step) => step.textContent,
    );
    expect(steps).toEqual(['1', '2', '3']);
    const free = container.querySelector('.tm-cp-free');
    expect(free?.querySelector('a[href="/pricing"]')).not.toBeNull();
  });
});
