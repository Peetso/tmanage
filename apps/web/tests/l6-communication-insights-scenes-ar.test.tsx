import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FeaturesCommunicationPage } from '../src/components/website/pages/features-communication/FeaturesCommunicationPage';
import { FeaturesInsightsPage } from '../src/components/website/pages/features-insights/FeaturesInsightsPage';
import { activeLocale } from '../src/lib/i18n/locale-store';

/**
 * Slice L6 (live check 014a9d51, REPORT line 27): in Arabic the Features · Insights and
 * Features · Chat & calendar mock-ups were all English. Every visible scene string is now a
 * catalog key, so an ar-EG render keeps only the proper names that stay Latin on purpose.
 */

const RLM = '‏';

/** Names, titles, channels and IDs that stay in Latin inside the Arabic mock-ups. */
const LATIN_ALLOWED = [
  'tmanage.app / northstar / chat / atlas-website-relaunch',
  'Homepage Concept v2.pdf',
  'Atlas Website Relaunch',
  'Northwind Brand Sprint',
  'Cedar Clinic Booking App',
  'Atlas Hospitality',
  'Northstar Studio',
  'Homepage Concept v2',
  'Concept v2',
  /# ?[a-z-]+/g,
  /@?(Maya|Lina|Omar|Salma|Youssef|Karim|Noor)( (Hassan|Samir|Adel|Riad|Kamal|Nabil|Fathy))?/g,
  'Atlas',
  'DEC-42',
  // Letter bounds, not \b: textContent runs a row's number into its kind ("3DEL"), and since
  // Arabic defaults to Latin digits (AR-DIGITS a7b6d3c0) \b sees no edge between 3 and D.
  /(?<![A-Za-z])(TSK|DEL|DEC|v2|v3|MB)(?![A-Za-z])/g,
];

/** This slice's scene bodies (not the shared ProductScenes), allowed Latin names removed. */
function sceneText(container: HTMLElement): string {
  let text = [
    ...container.querySelectorAll('.tm-web-fi-scene > .tm-web-scene__body, .tm-wc-scene__body'),
  ]
    .map((body) => {
      // Avatar initials (MH, LS…) are derived from the Latin names, not copy.
      const copy = body.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('.tm-avatar').forEach((avatar) => avatar.remove());
      return copy.textContent ?? '';
    })
    .join(' \n ');
  for (const allowed of LATIN_ALLOWED) {
    text = typeof allowed === 'string' ? text.split(allowed).join(' ') : text.replace(allowed, ' ');
  }
  return text;
}

afterEach(() => activeLocale.set('en-US'));

describe('L6 Features scenes in Arabic', () => {
  it('Insights: no English mock-up text in ar-EG', () => {
    activeLocale.set('ar-EG');
    const { container } = render(
      <div dir="rtl">
        <FeaturesInsightsPage />
      </div>,
    );
    const text = sceneText(container);
    expect(container.querySelectorAll('.tm-web-fi-scene').length).toBeGreaterThan(5);
    expect(text).toMatch(/[؀-ۿ]/);
    expect(text).not.toMatch(/FeaturesInsightsScenes\./);
    expect(text.match(/[A-Za-z]{2,}/g) ?? []).toEqual([]);
    expect(container.textContent).not.toContain('Where delivery is losing time');
    expect(container.textContent).toContain('أين يضيع وقت التسليم');
    // A line that opens with a Latin name starts with U+200F so it stays right-aligned.
    const pulseTitle = container.querySelector('.tm-web-fi-scene--pulse .tm-web-fi-card__title');
    expect(pulseTitle?.textContent?.startsWith(RLM)).toBe(true);
  });

  it('Chat & calendar: no English mock-up text in ar-EG', () => {
    activeLocale.set('ar-EG');
    const { container } = render(
      <div dir="rtl">
        <FeaturesCommunicationPage />
      </div>,
    );
    const text = sceneText(container);
    expect(container.querySelectorAll('.tm-wc-scene').length).toBeGreaterThan(4);
    expect(text).toMatch(/[؀-ۿ]/);
    expect(text).not.toMatch(/FeaturesCommunicationScenes\./);
    expect(text.match(/[A-Za-z]{2,}/g) ?? []).toEqual([]);
    expect(container.textContent).not.toContain('Turn into');
    expect(container.textContent).toContain('تحويل إلى');
  });

  it('English stays as designed', () => {
    const { container } = render(<FeaturesInsightsPage />);
    expect(container.textContent).toContain('Where delivery is losing time');
    expect(container.textContent).toContain('Exceptions, not averages');
  });
});
