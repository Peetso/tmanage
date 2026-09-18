import { waitFor } from '@testing-library/react';
import { expect } from 'vitest';

/**
 * The shared half of the hydration-gate tests (x38, then x39).
 *
 * A screen whose controlled inputs are in the server-rendered HTML can be typed into before
 * React hydrates: the DOM holds the characters, no listener exists, state stays at its initial
 * value, and hydration then re-applies that value and wipes what was typed. The fix is one
 * `<fieldset disabled={<the screen's own query>.isPending}>` around the controls, because a
 * server render always has `isPending === true` and it can only turn false on the client.
 *
 * These two helpers are what every such test needs and nothing more: a response the test holds
 * back so the screen can be observed mid-flight, and the assertion that the gate is shut while
 * the query is pending and open once it answers. They are deliberately not a render helper —
 * each screen's props and fixtures stay in its own file.
 */

/**
 * A query answer the test decides when to give.
 *
 * `after(make)` is the promise a fake `fetch` returns; `answer()` releases it. Without this a
 * pending query in jsdom resolves on the next microtask, which is too fast to assert against.
 */
export function heldAnswer(): {
  readonly answer: () => void;
  readonly after: <T>(make: () => T) => Promise<T>;
} {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { answer: () => release(), after: (make) => held.then(make) };
}

/**
 * Every control is refused while the query is pending, and every one of them is usable once it
 * has answered.
 *
 * `toBeDisabled` and `toBeEnabled` walk up to an ancestor disabled `fieldset`, which is what
 * makes this an assertion about the gate rather than about each control's own attributes.
 */
export async function expectInertUntilAnswered(
  controls: readonly HTMLElement[],
  answer: () => void,
): Promise<void> {
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) expect(control).toBeDisabled();

  answer();

  await waitFor(() => {
    for (const control of controls) expect(control).toBeEnabled();
  });
}
