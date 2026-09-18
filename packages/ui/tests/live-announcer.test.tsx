import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Announce, LiveAnnouncer } from '../src/components/index.js';

/**
 * The contract `LiveAnnouncer` exists for (WCAG 2.2 **4.1.3**): the live region is committed
 * **empty** and every sentence arrives as a later *mutation* of it — the shape assistive
 * technology actually announces — at the requested politeness, in exactly one slot, and the
 * same sentence twice still mutates the DOM rather than being swallowed as identical text.
 */
function slots(container: HTMLElement, politeness: 'polite' | 'assertive'): string[] {
  return [...container.querySelectorAll(`[aria-live="${politeness}"]`)].map(
    (node) => node.textContent ?? '',
  );
}

describe('LiveAnnouncer', () => {
  it('commits the region empty and delivers the sentence as a later mutation, once', () => {
    const { container, rerender } = render(<LiveAnnouncer>{null}</LiveAnnouncer>);

    // The region exists before any text does — that is the whole point of the provider.
    expect(slots(container, 'polite')).toEqual(['', '']);

    rerender(
      <LiveAnnouncer>
        <Announce message="Twelve more loaded, forty-eight in total." />
      </LiveAnnouncer>,
    );

    expect(slots(container, 'polite').filter(Boolean)).toEqual([
      'Twelve more loaded, forty-eight in total.',
    ]);
  });

  it('routes an assertive message to the assertive region and leaves the polite one empty', () => {
    const { container } = render(
      <LiveAnnouncer>
        <Announce message="The channel disconnected." politeness="assertive" />
      </LiveAnnouncer>,
    );

    expect(slots(container, 'assertive').filter(Boolean)).toEqual(['The channel disconnected.']);
    expect(slots(container, 'polite')).toEqual(['', '']);
  });

  it('re-announces identical text by alternating slots, without leaving a duplicate behind', () => {
    const { container, rerender } = render(
      <LiveAnnouncer>
        <Announce key="first" message="Loading more." />
      </LiveAnnouncer>,
    );
    const first = slots(container, 'polite');

    // A second press of "Load more": same sentence, new announcer instance.
    rerender(
      <LiveAnnouncer>
        <Announce key="second" message="Loading more." />
      </LiveAnnouncer>,
    );
    const second = slots(container, 'polite');

    expect(second).not.toEqual(first); // the DOM mutated, so it is announced again
    expect(second.filter(Boolean)).toEqual(['Loading more.']); // and only in one slot
  });
});
