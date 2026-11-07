import type { Metadata } from 'next';
import { NotFoundState, StateScreen } from '../components/state/StateScreens';

/**
 * The 404 route.
 *
 * Next renders this for an unmatched path and for any `notFound()` call. It is a server
 * component that composes the shared, client `NotFoundState` inside the shared page frame, so
 * the not-found page carries the same skip link, `<main>` and copy as every other platform
 * state rather than the framework default.
 */
export const metadata: Metadata = {
  title: 'Page not found',
};

export default function NotFound() {
  return (
    <StateScreen label="Not found" labelKey="StateScreens.eyebrowNotFound">
      <NotFoundState />
    </StateScreen>
  );
}
