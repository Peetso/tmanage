import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MeetingIcsButton } from '../src/components/MeetingIcsButton';
import { expectNoAxeViolations } from './axe';

/** CAL — ICS export (x128). The download control: it renders, links to the ICS endpoint, axe-clean. */
describe('MeetingIcsButton', () => {
  it('renders a download link to the meeting ICS endpoint and is axe-clean', async () => {
    const { container } = render(
      <MeetingIcsButton
        organizationSlug="northstar"
        meetingId="meeting-1"
        baseUrl="https://api.example.test"
      />,
    );

    const link = screen.getByRole('link', { name: /export to calendar/i });
    expect(link.getAttribute('href')).toBe(
      'https://api.example.test/v1/organizations/northstar/meetings/meeting-1/ics',
    );
    expect(link.getAttribute('download')).toBe('meeting-meeting-1.ics');

    await expectNoAxeViolations(container);
  });
});
