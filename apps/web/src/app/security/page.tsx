import { TrustScreen } from '../../components/screens/TrustScreen';

/**
 * **Public security & trust page** (x158), module 1 — routed at `/security`.
 *
 * A public, unauthenticated route: no organization slug, no session. The screen fetches the
 * API's code-defined trust content and renders it. Kept as a thin route so a test mounts the
 * screen directly, as the other screens are.
 */
export default function SecurityPage() {
  return <TrustScreen />;
}
