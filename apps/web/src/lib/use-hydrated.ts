import { useSyncExternalStore } from 'react';

/**
 * Whether React has hydrated this tree on the client yet.
 *
 * Some screens carry a form whose controls are controlled inputs but have no query to gate on —
 * the sign-in fields, the onboarding pickers. On a cold page those controls exist in the
 * server-rendered HTML before React is live: a person can type into them, the DOM holds the
 * characters, no listener runs, state stays at its initial value, and hydration then re-applies
 * that value and wipes what was typed. The screens that *do* have a query gate their fieldset on
 * `<query>.isPending`, which is `true` in the server render for the same reason this hook is
 * `false` there. This is that same signal without a request behind it.
 *
 * `useSyncExternalStore` is the one hook that reads a different value on the server than on the
 * client without a re-render that flickers: the server snapshot is `false`, so the fieldset ships
 * disabled and the hydration markup matches; the client snapshot is `true`, so the first render
 * after hydration enables it. The store never changes, so `subscribe` returns a no-op and nothing
 * ever notifies it — the value only ever transitions once, from server to client, and React does
 * that transition itself. A `useEffect`/`useState` variant would render `false`, commit, then
 * flip to `true` in a second pass, which is the flicker this avoids.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
}

/** The value never changes on a mounted client, so there is nothing to subscribe to. */
const subscribe = (): (() => void) => () => {};
const getClientSnapshot = (): boolean => true;
const getServerSnapshot = (): boolean => false;
