import { RecoveryScreen, type RecoveryState } from '../../components/screens/RecoveryScreen';

const STATES: readonly RecoveryState[] = ['request', 'sent', 'expired', 'completed'];

/**
 * **ID-05 Session and recovery** — the recovery half, in its four states.
 *
 * The state comes from `?state=`, validated against the list above. An unrecognised value
 * falls back to `request` rather than throwing: a stale or mistyped link should land a person
 * on the screen that lets them start again, not on an error page.
 */
export default async function RecoverPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requested = params['state'];
  const state = STATES.find((candidate) => candidate === requested) ?? 'request';
  return <RecoveryScreen state={state} />;
}
