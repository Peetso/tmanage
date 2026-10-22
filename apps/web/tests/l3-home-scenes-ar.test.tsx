import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HomePage } from '../src/components/website/pages/home/HomePage';
import { DeliveryRiskScene, ObjectCardStack } from '../src/components/website/ProductScenes';
import { LogoStrip, TestimonialCard } from '../src/components/website/sections';
import { activeLocale } from '../src/lib/i18n/locale-store';

/**
 * Live-check L3: on `/` in Arabic the product mock-ups (My Day, the #atlas-relaunch thread, the
 * convert-to-work panel, the client portal, the decision register, the audit log and the shared
 * Delivery risk view) and the design-partner tiles used to stay English. Every scene word now
 * comes from the catalog; only brand names, the channel name and IDs stay Latin.
 */

/** Latin that is allowed to remain in an Arabic scene: brands, the channel, IDs, protocols. */
const ALLOWED_LATIN =
  /TManage|Northstar Studio|Northstar|Atlas Hospitality|Atlas|Meridian Group|#atlas-relaunch|#atlas|macOS|SSO|CSV|DEC-\d+|RUN-\d+|EV·\w+|TSK|DEL|[0-9a-f]{4}·[0-9a-f]{4}/g;

/** Any Latin word of three letters or more left after the allowed names are removed. */
function strayEnglish(text: string): string[] {
  return text.replace(ALLOWED_LATIN, ' ').match(/[A-Za-z]{3,}/g) ?? [];
}

const ARABIC = /[؀-ۿ]/;

/** Every text node on its own, so two adjacent avatar initials ("LS", "KN") do not merge. */
function textOf(root: Element | null): string {
  if (!root) return '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    parts.push(node.nodeValue ?? '');
  return parts.join(' ');
}

afterEach(() => activeLocale.set('en-US'));

describe('L3 home scenes in Arabic', () => {
  it('leaves no English in any home scene or the logo strip', () => {
    activeLocale.set('ar-EG');
    const { container } = render(
      <div dir="rtl">
        <HomePage />
      </div>,
    );

    const scenes = container.querySelectorAll('figure.tm-web-scene');
    expect(scenes.length).toBeGreaterThanOrEqual(7);
    for (const scene of scenes) {
      expect(strayEnglish(textOf(scene))).toEqual([]);
      const caption = scene.querySelector('figcaption');
      expect(caption?.textContent).toMatch(ARABIC);
    }

    const risk = container.querySelector('.tm-web-scene--risk figcaption');
    expect(risk?.textContent).toMatch(ARABIC);
    expect(risk?.textContent).not.toContain('Delivery risk');

    const logos = container.querySelector('.tm-web-logos');
    expect(logos?.textContent).not.toMatch(/Design partner|Agency|Design studio/);
  });

  it('localises the shared scene and placeholder defaults used on other pages', () => {
    activeLocale.set('ar-EG');
    const { container } = render(
      <div dir="rtl">
        <DeliveryRiskScene />
        <ObjectCardStack />
        <LogoStrip />
        <TestimonialCard quote="—" author="—" org="—" />
      </div>,
    );
    for (const figure of container.querySelectorAll('figure.tm-web-scene')) {
      expect(strayEnglish(textOf(figure))).toEqual([]);
      expect(figure.querySelector('figcaption')?.textContent).toMatch(ARABIC);
    }
    const strip = container.querySelector('.tm-web-logos__list');
    expect(strip?.textContent).toMatch(ARABIC);
    expect(strayEnglish(textOf(strip))).toEqual([]);
  });

  it('keeps the English defaults in English', () => {
    const { container } = render(<DeliveryRiskScene />);
    expect(container.querySelector('figcaption')?.textContent).toContain(
      'The Delivery risk saved view',
    );
    expect(container.textContent).toContain('Search work items');
  });
});
