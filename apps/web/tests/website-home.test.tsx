import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_STEP,
  HomePage,
  nextPillarIndex,
  storyStepState,
} from '../src/components/website/pages/home/HomePage';

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
