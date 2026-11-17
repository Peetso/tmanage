import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { describeApiError } from '../src/lib/api/describe-error';
import { ApiRequestError } from '../src/lib/api/errors';
import { isServicePaused } from '../src/lib/api/service-paused';
import { ServicePausedNotice } from '../src/components/screens/ServicePausedNotice';

/** ADMINSVC2 — a service the platform switched off reads as paused, never as an error. */

const switchedOff = new ApiRequestError(
  409,
  'conflict',
  'This service is turned off for TManage right now',
  'c',
  [{ field: 'integration', message: 'switched_off' }],
);
const notSetUp = new ApiRequestError(409, 'conflict', 'Google Drive is not set up', 'c', [
  { field: 'storage', message: 'not_configured' },
]);

describe('service paused', () => {
  it('tells "switched off" apart from "not set up yet"', () => {
    expect(isServicePaused(switchedOff)).toBe(true);
    expect(isServicePaused(notSetUp)).toBe(false);
    expect(describeApiError(switchedOff, (_key, english) => english)).toMatch(/Nothing is lost/u);
  });

  it('renders the calm notice', () => {
    render(<ServicePausedNotice />);
    expect(screen.getByText('Paused by TManage')).toBeTruthy();
    expect(screen.getByText(/your connection is kept/u)).toBeTruthy();
  });
});
