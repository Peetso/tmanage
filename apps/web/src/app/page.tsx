import { MarketingHomeScreen } from '../components/screens/MarketingHomeScreen';

/**
 * The root — the public marketing home (module 1, x156).
 *
 * `/` no longer redirects to sign-in: it is now the public & trust site's landing page, the first
 * page an unauthenticated visitor sees (audit rank #1, Public site Missing). The page is a thin
 * route wrapper; `MarketingHomeScreen` (a client component) does the reading and rendering so a
 * test can mount it. Sign-in is one click away in the hero and the header, so no one is stranded.
 */
export default function RootPage() {
  return <MarketingHomeScreen />;
}
