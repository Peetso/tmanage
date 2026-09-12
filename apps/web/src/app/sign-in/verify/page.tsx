import { MfaChallengeScreen } from '../../../components/screens/MfaChallengeScreen';

/**
 * **ID-02 MFA / passkey challenge.**
 *
 * This route renders the plain challenge, and only the plain challenge, for every request.
 *
 * ## Why it no longer reads `?state=`
 *
 * It used to. `params['state'] === 'rate-limited'` was passed straight to the screen's
 * `rateLimited` prop, so `/sign-in/verify?state=rate-limited` raised a danger alert reading
 * "Too many attempts" and ending "The attempt was recorded in the audit log." No request had
 * been made, nothing had been refused and no row had been written. `04-SECURITY-PRIVACY` §8
 * makes the audit log an append-only record with a named actor and a result; a page that
 * reports a row was appended when none was is a false statement about a security control, made
 * to a person, by anyone who can construct a URL. It is D15's defect — recorded against
 * `/recover` on 2026-09-05 and fixed there in `ddeb7d6` — on a second screen, and the rule from
 * its acceptance sentence is the one this file now keeps: changing query parameters cannot
 * fabricate an outcome.
 *
 * The alert also disabled both inputs and the Verify button, so the URL did not merely say an
 * attempt had been refused, it made the screen behave as though one had.
 *
 * ## Why the state stays, and why no denial is added beside it
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX.md` line 33 approves "rate limit" as an ID-02 state, so
 * `MfaChallengeScreen` keeps `rateLimited` as a component API and `screens.test.tsx` keeps
 * exercising it. Unlike ID-05's `sent` and `completed` — which `/recover` had to deny outright,
 * because ID-002 is unbuilt and no operation could ever have produced them — this claim is one
 * the application can substantiate. `POST /v1/auth/mfa` and `POST /v1/auth/recovery-code` answer
 * a flooded attempt with 429 `rate_limited`, and `AuthenticationService` writes the refusal to
 * the audit log before it throws. So the copy is true for a caller holding that 429, and adding
 * a "no attempt was refused" notice under it would be the same kind of unfounded sentence
 * pointing the other way.
 *
 * What is missing is the wiring: `MfaChallengeScreen` renders a 429 in its generic failure alert
 * rather than entering this state, and `SignInScreen` — the only caller that ever holds a real
 * challenge — passes no `rateLimited`. Connecting the two is a behaviour change that belongs
 * with the sign-in work, not with removing a false claim. Until it lands, nothing in this
 * application asks for the state, which is correct: nothing in this application has a refusal to
 * report.
 */
export default async function MfaPage() {
  return <MfaChallengeScreen />;
}
