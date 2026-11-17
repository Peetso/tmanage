import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BETA_FEATURES,
  CURRENT_STEP,
  FEEDBACK_HREF,
  HomePage,
  nextPillarIndex,
  storyStepState,
} from '../src/components/website/pages/home/HomePage';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { translate, type MessageKey } from '../src/lib/i18n/t';
import { SIGN_UP_HREF } from '../src/lib/public-signup';

/**
 * WEB-01 Home / WEB-18 Home on mobile (round-2 Figma 308:26, 308:43). Layout and painting are
 * checked side by side against the Figma, not here; what jsdom can prove is the behaviour the
 * page owns: the pillar tabs, the work-story states, and that the product clones stay out of the
 * accessibility tree.
 */
describe('website home', () => {
  it('marks the steps before the current one done, the current one in progress, the rest next', () => {
    expect(storyStepState(CURRENT_STEP - 1)).toEqual({
      state: 'done',
      statusKey: 'HomePage.trackDone',
    });
    expect(storyStepState(CURRENT_STEP)).toEqual({
      state: 'current',
      statusKey: 'HomePage.trackInProgress',
    });
    expect(storyStepState(CURRENT_STEP + 1).state).toBe('future');
  });

  it('moves between pillar tabs with arrows that mirror in RTL and wrap at the ends', () => {
    expect(nextPillarIndex('ArrowRight', 0, 4, false)).toBe(1);
    expect(nextPillarIndex('ArrowRight', 0, 4, true)).toBe(3);
    expect(nextPillarIndex('ArrowLeft', 3, 4, true)).toBe(0);
    expect(nextPillarIndex('End', 0, 4, false)).toBe(3);
    expect(nextPillarIndex('Enter', 1, 4, false)).toBeNull();
  });

  it('shows one pillar panel at a time and switches on click', async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);

    await user.click(tabs[3]!);
    expect(tabs[3]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', tabs[3]!.id);
  });

  it('keeps the product clones inert and out of the accessibility tree', () => {
    const { container } = render(<HomePage />);
    const bodies = container.querySelectorAll('.tm-home-scene .tm-web-scene__body');
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).toHaveAttribute('aria-hidden', 'true');
      expect(body.hasAttribute('inert')).toBe(true);
    }
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});

/** The open beta (approved Figma 415:21855 desktop, 415:23448 phone, 418:9537 Arabic hero). */
describe('website home — open beta', () => {
  afterEach(() => activeLocale.set('en-US'));
  const L = (key: string) => translate('en-US', key as MessageKey);
  const ar = (key: string) => translate('ar-EG', key as MessageKey);

  it('leads with the beta: free for everyone, start free and see the product', () => {
    render(<HomePage />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(L('HomePage.betaHeroTitle'));
    // SIGNUP2: the wide and the phone capsule now say the same "Free during the beta".
    expect(screen.getAllByText(L('HomePage.betaCapsule')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: L('HomePage.startFree') })[0]).toHaveAttribute(
      'href',
      SIGN_UP_HREF,
    );
    expect(screen.getByRole('link', { name: L('HomePage.seeProduct') })).toHaveAttribute(
      'href',
      '/product',
    );
    expect(screen.getAllByText(L('HomePage.betaMicro')).length).toBeGreaterThan(0);
  });

  it('lists the six beta features, the free band and the feedback link', () => {
    render(<HomePage />);
    const section = within(screen.getByRole('region', { name: L('HomePage.betaIncludedTitle') }));
    expect(section.getAllByRole('listitem').length).toBeGreaterThanOrEqual(BETA_FEATURES.length);
    for (const feature of BETA_FEATURES) {
      expect(section.getByRole('heading', { name: L(feature.titleKey) })).toBeInTheDocument();
    }
    expect(section.getByText(L('HomePage.betaFreeTitle'))).toBeInTheDocument();
    expect(section.getByRole('link', { name: L('HomePage.sendFeedback') })).toHaveAttribute(
      'href',
      FEEDBACK_HREF,
    );
    expect(FEEDBACK_HREF).toBe('/contact');
  });

  it('ar-EG: the beta hero and features come from the Arabic catalog', () => {
    activeLocale.set('ar-EG');
    render(<HomePage />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      ar('HomePage.betaHeroTitle'),
    );
    for (const feature of BETA_FEATURES) {
      expect(screen.getByRole('heading', { name: ar(feature.titleKey) })).toBeInTheDocument();
    }
  });
});
