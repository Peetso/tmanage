import { render } from '@testing-library/react';
import type { Decorator } from '@storybook/react-vite';
import { afterEach, describe, expect, it } from 'vitest';
import preview from '../.storybook/preview';
import {
  PHONE_VIEWPORT,
  SCREEN_VIEWPORTS,
  VR_VIEWPORT_DATASET_KEY,
  storyViewportSize,
} from '../.storybook/vr-viewport';

/**
 * T5 D9: a story's own viewport reaches the VR harness. The preview marks the document with the
 * size the story's `viewport` global names; `vr/stories.spec.ts` resizes the page to the mark.
 */
afterEach(() => {
  delete document.documentElement.dataset[VR_VIEWPORT_DATASET_KEY];
});

function decorate(globals: Record<string, unknown>): string | undefined {
  const decorators = (preview.decorators ?? []) as readonly Decorator[];
  const context = { globals, parameters: preview.parameters ?? {} } as Parameters<Decorator>[1];
  for (const decorator of decorators) {
    render(
      <>
        {decorator(
          () => (
            <p>Story</p>
          ),
          context,
        )}
      </>,
    );
  }
  return document.documentElement.dataset[VR_VIEWPORT_DATASET_KEY];
}

describe('VR story viewport (T5 D9)', () => {
  it('marks a Phone story with the design phone frame, 390 × 844', () => {
    expect(decorate({ viewport: { value: PHONE_VIEWPORT, isRotated: false } })).toBe('390x844');
  });

  it('clears the mark for a story with no viewport, so a size never carries over', () => {
    decorate({ viewport: { value: PHONE_VIEWPORT } });
    expect(decorate({})).toBeUndefined();
  });

  it('reads the Storybook forms: a bare name, a rotated frame, and nothing for unknown or %', () => {
    expect(storyViewportSize(PHONE_VIEWPORT, SCREEN_VIEWPORTS)).toEqual({
      width: 390,
      height: 844,
    });
    expect(storyViewportSize({ value: 'phone', isRotated: true }, SCREEN_VIEWPORTS)).toEqual({
      width: 844,
      height: 390,
    });
    expect(storyViewportSize({ value: 'toString' }, SCREEN_VIEWPORTS)).toBeUndefined();
    expect(
      storyViewportSize('full', { full: { styles: { width: '100%', height: '100%' } } }),
    ).toBeUndefined();
  });
});
