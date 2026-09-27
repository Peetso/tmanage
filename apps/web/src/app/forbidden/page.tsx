import type { Metadata } from 'next';
import { ForbiddenState, StateScreen } from '../../components/state/StateScreens';

/**
 * The 403 view.
 *
 * There is no `forbidden()` convention in this App Router version the way `notFound()` exists,
 * so the forbidden state gets an explicit route a caller can send an unauthorised person to
 * (`redirect('/forbidden')`) or link from a client boundary. It composes the same shared
 * `ForbiddenState` inside the same page frame as the other platform states.
 */
export const metadata: Metadata = {
  title: 'Access denied',
};

export default function ForbiddenPage() {
  return (
    <StateScreen>
      <ForbiddenState />
    </StateScreen>
  );
}
