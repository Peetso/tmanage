import { RecoveryScreen } from '../../components/screens/RecoveryScreen';

/**
 * **ID-05 Session and recovery** — the recovery half.
 *
 * This route renders the `request` state and only the `request` state, for every request.
 *
 * ## Why it no longer reads `?state=`
 *
 * It used to. `?state=` was validated against the four `RecoveryState` values and passed
 * straight to the screen, which meant `/recover?state=completed` told whoever typed it that
 * their access had been restored, that their other sessions had been signed out, and that the
 * event had been written to the audit log. The 2026-09-05 production review recorded that as
 * **D15 · P2 · Recovery success is controlled by a URL parameter**, and its acceptance
 * sentence is the rule this file now keeps: changing query parameters cannot fabricate
 * recovery, email-send, session-revocation, or audit outcomes.
 *
 * Nothing was bypassed by it — there is no recovery operation to bypass, which is the point. A
 * query string is not evidence that anything happened, and this route has no server operation
 * that could be evidence of anything. `04-SECURITY-PRIVACY` §8 makes the audit log an
 * append-only record with a named actor and result; a page that reports a row was written when
 * none was is a false statement about a security control, made to a person, by anyone who can
 * construct a URL.
 *
 * `RecoveryScreen` keeps all four states as a component API — `41` line 36 approves them for
 * ID-05 and the design stays reviewable — but this route deliberately passes no `state` prop,
 * so the component's own default applies. The `sent` and `completed` branches are for a caller
 * that has a real result to show. ID-002 will build the operation that produces one; until it
 * does, no caller in this application has one, and this route is not pretending otherwise.
 */
export default async function RecoverPage() {
  return <RecoveryScreen />;
}
