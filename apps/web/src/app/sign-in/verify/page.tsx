import { MfaChallengeScreen } from '../../../components/screens/MfaChallengeScreen';

/**
 * **ID-02 MFA / passkey challenge.**
 *
 * `?state=rate-limited` renders the rate-limited variant. A query parameter rather than a
 * separate route because it is one screen in two states, and `22-SCREEN-BY-SCREEN` §1 lists
 * "rate limited" among the states a screen must have rather than among the screens.
 */
export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return <MfaChallengeScreen rateLimited={params['state'] === 'rate-limited'} />;
}
