'use client';

import { PlatformAnnouncementBanner } from '../platform/announcements/PlatformAnnouncementBanner';
import { SupportModeBanner } from '../platform/support/SupportModeBanner';

/**
 * The platform's banners above every organization page (AppShell and the client portal): the
 * Support mode banner (PA-05) and the platform announcement (PA-10). They sit in the shell's column
 * flow, so the canvas below shrinks instead of sliding under them. Mount with a `QueryClient`.
 */
export function ShellBanners({
  organizationSlug,
  organizationName,
}: {
  organizationSlug: string;
  organizationName: string;
}) {
  return (
    <>
      <SupportModeBanner organizationSlug={organizationSlug} organizationName={organizationName} />
      <PlatformAnnouncementBanner />
    </>
  );
}
