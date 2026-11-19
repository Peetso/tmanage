import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GrowthFigures } from '../src/components/platform/activity/GrowthFigures';
import type { GrowthFigures as Figures } from '../src/lib/api/platform-growth';

/**
 * T5 D1: the Growth tile meters drew empty. The bar and its fill are spans, and an inline fill
 * ignores its `inline-size`; the shared `.tm-cc-bar` is also the 12 px admin bar, not the 4 px
 * tile meter (fix 34). The two screen sheets are applied to the rendered tiles so the cascade,
 * not the source text, is what the assertions read.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const sheet = (name: string): string =>
  readFileSync(join(HERE, '../src/styles/screens', name), 'utf8');

const FIGURES: Figures = {
  weeklyActiveCompanies: { weekStart: '2026-11-16', active: 142, companies: 384 },
  firstProjectFinished: { within30d: 0.31, within60d: 0.44 },
  timeToFirstOutcomeP50Hours: null,
  ai: {
    month: '2026-11-01',
    tasksRun: null,
    tasksCompleted: null,
    creditsUsed: null,
    creditsCap: 1,
  },
  costPerActiveCompany: { available: false, reason: 'not_set' },
  margin: { available: false, reason: 'beta_free' },
};

afterEach(() => {
  document.head.innerHTML = '';
});

describe('T5 D1 Growth tile meters', () => {
  it('draw a 4 px block bar whose fill is a block, so its width shows', () => {
    const style = document.createElement('style');
    style.textContent = `${sheet('admin.css')}\n${sheet('r44-security-growth.css')}`;
    document.head.append(style);
    render(<GrowthFigures figures={FIGURES} now={new Date('2026-11-19T10:00:00Z')} />);

    const meters = screen.getAllByRole('meter');
    expect(meters).toHaveLength(3);
    for (const meter of meters) {
      const bar = getComputedStyle(meter);
      expect(bar.display).toBe('block');
      expect(bar.getPropertyValue('block-size')).toBe('4px');
      const fill = meter.firstElementChild as HTMLElement;
      expect(getComputedStyle(fill).display).toBe('block');
      expect(fill.style.inlineSize).toBe(`${meter.getAttribute('aria-valuenow') ?? ''}%`);
    }
  });
});
