import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { channelLabel } from '../src/lib/text/channel-label';

/**
 * FIX2 item 14: in Arabic the app drew "# atlas-website-relaunch" as "atlas-website- #" over
 * "relaunch", and the composer hint as "…atlas-website-relaunch#". The label is now one isolated
 * run (FSI … PDI), so `#` and the name keep their own order inside right-to-left text.
 */
describe('channelLabel', () => {
  it('isolates "#name" as one bidi run', () => {
    expect(channelLabel('atlas-website-relaunch')).toBe('\u2068#atlas-website-relaunch\u2069');
  });

  it('keeps an Arabic channel name whole and isolated', () => {
    const label = channelLabel('إطلاق-الموقع');
    expect(label.startsWith('\u2068#')).toBe(true);
    expect(label.endsWith('\u2069')).toBe(true);
    expect(label).toContain('إطلاق-الموقع');
  });

  it('survives interpolation into Arabic running text and attributes', () => {
    const { container } = render(
      <div dir="rtl">
        <input placeholder={`اكتب رسالة في ${channelLabel('atlas-website-relaunch')}`} />
      </div>,
    );
    const placeholder = container.querySelector('input')?.getAttribute('placeholder') ?? '';
    // The isolate opens right before "#", so the "#" can no longer drift to the end of the line.
    expect(placeholder).toMatch(/في \u2068#atlas-website-relaunch\u2069$/u);
  });
});
