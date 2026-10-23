import { fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FeaturesWorkPage } from '../src/components/website/pages/features-work/FeaturesWorkPage';
import { activeLocale } from '../src/lib/i18n/locale-store';

/**
 * Slice M3 (live check 9c6d816c, REPORT /features/work): the template cards on /features/work —
 * title, meta, length badge, the phase steps and the preview's caption — read Arabic on the
 * Arabic page, and the English page keeps the design copy.
 */

afterEach(() => activeLocale.set('en-US'));

function templatesBand(container: HTMLElement): HTMLElement {
  const band = container.querySelector<HTMLElement>('#templates');
  if (!band) throw new Error('templates band missing');
  return band;
}

/** Every Latin word in the band's cards, minus the button labels' absence check below. */
function latinWords(root: HTMLElement): string[] {
  const words: string[] = [];
  for (const card of root.querySelectorAll('.tm-fw-template')) {
    words.push(...((card.textContent ?? '').match(/[A-Za-z]{2,}/g) ?? []));
  }
  return words;
}

describe('M3 · Work templates in Arabic', () => {
  it('the template cards carry no English in ar-EG, closed and previewed', () => {
    activeLocale.set('ar-EG');
    const { container } = render(
      <div dir="rtl">
        <FeaturesWorkPage />
      </div>,
    );
    const band = templatesBand(container);
    expect(band.querySelectorAll('.tm-fw-template')).toHaveLength(3);
    expect(latinWords(band)).toEqual([]);
    expect(band.textContent).toContain('إعادة إطلاق موقع');
    expect(band.textContent).toContain('أسبوع 1–2');

    for (const card of band.querySelectorAll<HTMLElement>('.tm-fw-template')) {
      const [preview] = within(card).getAllByRole('button');
      fireEvent.click(preview!);
    }
    expect(latinWords(band)).toEqual([]);
    expect(band.textContent).toContain('تدقيق المحتوى والمخططات الهيكلية');
    const caption = band.querySelector('.tm-fw-scene > figcaption');
    expect(caption?.textContent).toMatch(/^قالب إعادة إطلاق موقع: /);
  });

  it('the English page keeps the design copy', () => {
    const { container } = render(<FeaturesWorkPage />);
    const band = templatesBand(container);
    expect(band.textContent).toContain('Website relaunch');
    expect(band.textContent).toContain('6 milestones · 38 work items · 2 client reviews');
    expect(band.textContent).toContain('Recurs monthly · request intake · Pulse update');
    expect(band.querySelector('.tm-fw-scene > figcaption')?.textContent).toBe(
      'Website relaunch template: Discovery and sitemap, WK 1–2; Homepage direction review, WK 3; Launch and handover, WK 8.',
    );
  });
});
