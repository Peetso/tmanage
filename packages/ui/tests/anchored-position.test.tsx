import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, Tooltip, computeAnchoredPosition } from '../src/components/index.js';

const VIEWPORT = { width: 1000, height: 800 };
const BUBBLE = { width: 200, height: 40 };

describe('computeAnchoredPosition — flip, shift and arrow', () => {
  it('sits on the preferred side, centred on the anchor, arrow at the anchor centre', () => {
    const p = computeAnchoredPosition({
      anchor: { top: 400, left: 400, width: 100, height: 30 },
      floating: BUBBLE,
      viewport: VIEWPORT,
      placements: ['top', 'bottom'],
      offset: 8,
    });
    expect(p.side).toBe('top');
    expect(p.y).toBe(400 - 8 - 40);
    expect(p.x).toBe(350);
    expect(p.arrow).toBe(100);
    expect(p.fits).toBe(true);
  });

  it('flips to the other side when the preferred one has no room', () => {
    const p = computeAnchoredPosition({
      anchor: { top: 10, left: 400, width: 100, height: 30 },
      floating: BUBBLE,
      viewport: VIEWPORT,
      placements: ['top', 'bottom'],
      offset: 8,
    });
    expect(p.side).toBe('bottom');
    expect(p.y).toBe(10 + 30 + 8);
  });

  it('shifts along the anchor to stay inside the viewport, arrow still on the anchor', () => {
    const p = computeAnchoredPosition({
      anchor: { top: 400, left: 960, width: 30, height: 30 },
      floating: BUBBLE,
      viewport: VIEWPORT,
      placements: ['top'],
      padding: 8,
    });
    expect(p.x).toBe(1000 - 200 - 8);
    expect(p.x + BUBBLE.width).toBeLessThanOrEqual(VIEWPORT.width);
    expect(p.x + p.arrow).toBeCloseTo(975, 0);
  });

  it('mirrors start/end in RTL', () => {
    const base = {
      anchor: { top: 400, left: 400, width: 100, height: 30 },
      floating: BUBBLE,
      viewport: VIEWPORT,
      placements: ['end'] as const,
      offset: 8,
    };
    const ltr = computeAnchoredPosition({ ...base, dir: 'ltr' });
    const rtl = computeAnchoredPosition({ ...base, dir: 'rtl' });
    expect(ltr.physicalSide).toBe('right');
    expect(ltr.x).toBe(508);
    expect(rtl.physicalSide).toBe('left');
    expect(rtl.x).toBe(400 - 8 - 200);
  });

  it('when no side has room, takes the roomiest and stays on screen', () => {
    const p = computeAnchoredPosition({
      anchor: { top: 0, left: 0, width: 1000, height: 780 },
      floating: BUBBLE,
      viewport: VIEWPORT,
      placements: ['bottom', 'top'],
    });
    expect(p.fits).toBe(false);
    expect(p.y).toBeGreaterThanOrEqual(8);
    expect(p.y + BUBBLE.height).toBeLessThanOrEqual(VIEWPORT.height - 8);
  });
});

function rect(top: number, left: number, width: number, height: number): DOMRect {
  return {
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('Tooltip — anchored bubble', () => {
  afterEach(() => vi.restoreAllMocks());

  it('flips below the trigger at the top edge of the viewport and draws an arrow', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('tm-tooltip__bubble')) return rect(0, 0, 160, 32);
      if (this.classList.contains('tm-tooltip')) return rect(4, 300, 80, 32);
      return rect(0, 0, 0, 0);
    });
    render(
      <Tooltip content="Publishes to the client portal.">
        <Button tone="outline">Publish</Button>
      </Tooltip>,
    );
    await userEvent.tab();
    const bubble = screen.getByRole('tooltip');
    expect(bubble).toHaveAttribute('data-open');
    expect(bubble).toHaveAttribute('data-side', 'bottom');
    expect(bubble.style.position).toBe('fixed');
    expect(bubble.style.top).toBe(`${4 + 32 + 8}px`);
    expect(bubble.querySelector('.tm-tooltip__arrow')).not.toBeNull();
    // The arrow is decoration: the description is still just the sentence.
    expect(screen.getByRole('button', { name: 'Publish' })).toHaveAccessibleDescription(
      'Publishes to the client portal.',
    );
  });

  it('beside the trigger, mirrors to the left in RTL', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('tm-tooltip__bubble')) return rect(0, 0, 160, 32);
      if (this.classList.contains('tm-tooltip')) return rect(300, 600, 80, 32);
      return rect(0, 0, 0, 0);
    });
    render(
      <div dir="rtl">
        <Tooltip content="المشاريع" placement="end">
          <Button tone="outline">مشاريع</Button>
        </Tooltip>
      </div>,
    );
    await userEvent.tab();
    const bubble = screen.getByRole('tooltip');
    expect(bubble).toHaveAttribute('data-side', 'left');
    expect(bubble.style.left).toBe(`${600 - 8 - 160}px`);
  });

  it('still dismisses on Escape once anchored', async () => {
    render(
      <Tooltip content="Publishes to the client portal.">
        <Button tone="outline">Publish</Button>
      </Tooltip>,
    );
    await userEvent.tab();
    expect(screen.getByRole('tooltip')).toHaveAttribute('data-open');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('tooltip')).not.toHaveAttribute('data-open');
  });
});
