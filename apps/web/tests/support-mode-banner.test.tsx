import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  SupportModeBannerView,
  formatSupportClock,
  supportBannerState,
} from '../src/components/platform/support/SupportModeBanner';
import { translate, type MessageKey } from '../src/lib/i18n/t';

const en = (key: string) => translate('en-US', `SupportMode.${key}` as MessageKey);

function renderBanner(remainingSeconds: number) {
  const onExtend = vi.fn();
  const onExit = vi.fn();
  const view = render(
    <SupportModeBannerView
      organizationName="Northstar Studio"
      adminEmail="peter@tmanage.app"
      sessionId="0190a8c4-0000-7000-8000-000000000001"
      remainingSeconds={remainingSeconds}
      actionsCount={7}
      onExtend={onExtend}
      onExit={onExit}
    />,
  );
  const banner = view.container.querySelector('.tm-support-banner');
  return { banner, onExtend, onExit };
}

describe('Support mode banner (PA-05, A8)', () => {
  it('formats the countdown as h:mm:ss over an hour and mm:ss under it', () => {
    expect(formatSupportClock(7092)).toBe('1:58:12');
    expect(formatSupportClock(252)).toBe('04:12');
    expect(formatSupportClock(-5)).toBe('00:00');
  });

  it('is red while live, amber under five minutes, grey once ended', () => {
    expect(supportBannerState(301)).toBe('live');
    expect(supportBannerState(300)).toBe('live');
    expect(supportBannerState(299)).toBe('warning');
    expect(supportBannerState(0)).toBe('ended');
  });

  it('shows the countdown, the actions link and Exit while live', () => {
    const { banner, onExit } = renderBanner(7092);
    expect(banner?.getAttribute('data-state')).toBe('live');
    expect(screen.getByText(en('expiresIn').replace('{time}', '1:58:12'))).toBeTruthy();
    const link = screen.getByRole('link', { name: en('viewActions').replace('{count}', '7') });
    expect(link.getAttribute('href')).toBe(
      '/platform/activity?supportSessionId=0190a8c4-0000-7000-8000-000000000001',
    );
    expect(screen.queryByRole('button', { name: en('extend') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en('exit') }));
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('turns amber under five minutes and offers Extend 30 min', () => {
    const { banner, onExtend } = renderBanner(252);
    expect(banner?.getAttribute('data-state')).toBe('warning');
    expect(screen.getByText(en('endsIn').replace('{time}', '04:12'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en('extend') }));
    expect(onExtend).toHaveBeenCalledOnce();
  });

  it('turns grey when the time is up, with no Exit or Extend', () => {
    const { banner } = renderBanner(0);
    expect(banner?.getAttribute('data-state')).toBe('ended');
    expect(screen.getByText(en('badgeEnded'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: en('exit') })).toBeNull();
    expect(screen.queryByRole('button', { name: en('extend') })).toBeNull();
    expect(screen.getByRole('link', { name: en('openPlatform') }).getAttribute('href')).toBe(
      '/platform',
    );
  });
});
