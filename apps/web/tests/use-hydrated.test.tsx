import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useHydrated } from '../src/lib/use-hydrated';

function Probe() {
  return <output>{useHydrated() ? 'hydrated' : 'cold'}</output>;
}

describe('useHydrated', () => {
  // Server snapshot false (so a gated fieldset ships disabled and hydration matches); client
  // snapshot true (so the gate opens once React is live).
  it('reads cold on the server snapshot and hydrated on the client snapshot', () => {
    expect(renderToString(<Probe />)).toContain('cold');
    expect(render(<Probe />).container.textContent).toBe('hydrated');
  });
});
