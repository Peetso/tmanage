/**
 * `PlatformAdminScreens.tsx` was split by area (PA-02): this module re-exports the screens and
 * the shared `me` query key so existing imports keep working until each area slice replaces
 * its screen.
 */
export { PLATFORM_ME_KEY } from './shared/platform-kit';
export { PlatformOverviewScreen } from './PlatformOverviewScreen';
export { PlatformCompaniesScreen, PlatformCompanyScreen } from './PlatformCompaniesScreens';
export { PlatformAuditScreen } from './PlatformAuditScreen';
