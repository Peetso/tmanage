import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  Button,
  Combobox,
  LiveAnnouncer,
  SkipLink,
  Toast,
  ToastRegion,
  UiLabelsProvider,
  type UiLabels,
} from '../src/components/index.js';

/**
 * TESTUX P0 3: the Arabic client portal read "Skip to main content" and "Working" because the
 * primitives fell back to English. Under a provider every primitive speaks the page's language.
 */
const ARABIC: UiLabels = {
  working: 'جارٍ العمل',
  skipToMain: 'انتقل إلى المحتوى الرئيسي',
  liveAnnouncements: 'إعلانات مباشرة',
  notifications: 'الإشعارات',
  dismissNotification: 'إغلاق الإشعار',
  noMatches: 'لا توجد نتائج',
};

function Everything() {
  return (
    <LiveAnnouncer>
      <SkipLink targetId="main" />
      <main id="main">
        <Button loading>حفظ</Button>
        <ToastRegion>
          <Toast onDismiss={() => undefined}>تم</Toast>
        </ToastRegion>
        <Combobox label="الشخص" options={[]} defaultOpen />
      </main>
    </LiveAnnouncer>
  );
}

describe('UiLabelsProvider', () => {
  it('names every primitive default in the provided language', async () => {
    render(
      <UiLabelsProvider labels={ARABIC}>
        <Everything />
      </UiLabelsProvider>,
    );

    expect(screen.getByRole('link', { name: ARABIC.skipToMain })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: ARABIC.notifications })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ARABIC.dismissNotification })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: ARABIC.liveAnnouncements })).toBeInTheDocument();
    expect(await screen.findByText(ARABIC.working)).toBeInTheDocument();
    expect(screen.getAllByText(ARABIC.noMatches).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/Skip to main|Working|Notifications|No matches/);
  });

  it('keeps English outside a provider, and a passed label still wins', () => {
    render(
      <UiLabelsProvider labels={ARABIC}>
        <SkipLink targetId="main">تخطَّ</SkipLink>
      </UiLabelsProvider>,
    );
    expect(screen.getByRole('link', { name: 'تخطَّ' })).toBeInTheDocument();

    render(<SkipLink targetId="main" />);
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument();
  });
});
