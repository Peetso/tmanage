/**
 * The authentication boundary — the one place a change of principal becomes a lifecycle event.
 *
 * ## Why this exists (review finding D01, 2026-09-05)
 *
 * Signing out used to invalidate the `['sessions']` query family and navigate. The root
 * `QueryClient` survives a client-side navigation, and every other cached query —
 * organizations, work, portal — is keyed by organization slug, never by the signed-in person.
 * On a shared browser the next person to sign in could therefore be shown the previous
 * person's cached rows: fresh for up to `staleTime`, stale during the refetch. That is a
 * browser-side isolation failure even though the API refused nothing it should have refused.
 *
 * The fix is not "invalidate more keys". A change of principal is a boundary the whole client
 * has to observe: cancel what is in flight, drop what is cached, forget the CSRF token held
 * in memory, and tell the other tabs. Screens announce the event here; the things that must
 * react subscribe here. No screen knows what the consequences are, so no screen can forget
 * one.
 *
 * ## The events
 *
 * - `signed-in`: a person authenticated in this tab. Announced **before** navigation so the
 *   caches are empty by the time the next screen mounts.
 * - `signed-out`: this tab ended the session deliberately.
 * - `session-ended`: the API refused the session and the refresh could not recover it. The
 *   app has to treat it exactly like a sign-out, plus send the person to sign in.
 *
 * Each arrives with an `origin`: `local` when this tab announced it, `remote` when another tab
 * did. A remote `signed-in` matters as much as a local one — the cookie jar is shared, so
 * this tab's next request already runs as the new person, and its cache must not be the old
 * person's.
 *
 * ## Cross-tab delivery
 *
 * `BroadcastChannel`, same-origin by construction, so nothing here leaves the site. The
 * message carries the event name and nothing else: no ids, no tokens, no slugs. A tab that
 * receives one clears its own state and reads the truth back from the API through the
 * ordinary authorized paths. The channel is optional so that the class is testable in jsdom,
 * which has no `BroadcastChannel`, and harmless during server rendering, where there is no
 * window.
 */

export type AuthEvent = 'signed-in' | 'signed-out' | 'session-ended';
export type AuthEventOrigin = 'local' | 'remote';

export interface AuthNotice {
  readonly event: AuthEvent;
  readonly origin: AuthEventOrigin;
}

export type AuthListener = (notice: AuthNotice) => void;

/** The subset of `BroadcastChannel` this module uses, so a test can hand in a fake. */
export interface AuthChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

const EVENTS: ReadonlySet<string> = new Set<AuthEvent>([
  'signed-in',
  'signed-out',
  'session-ended',
]);

function isAuthEvent(value: unknown): value is AuthEvent {
  return typeof value === 'string' && EVENTS.has(value);
}

export class AuthBoundary {
  private readonly listeners = new Set<AuthListener>();
  private readonly channel: AuthChannel | undefined;

  constructor(channel?: AuthChannel) {
    this.channel = channel;
    channel?.addEventListener('message', (message) => {
      // Anything on the channel is data from another tab of this origin. Only the three
      // known words are acted on; everything else is ignored rather than interpreted.
      const data = message.data;
      const event =
        typeof data === 'object' && data !== null && 'event' in data
          ? (data as { event: unknown }).event
          : undefined;
      if (isAuthEvent(event)) this.deliver({ event, origin: 'remote' });
    });
  }

  /** Register for every notice. Returns the unsubscribe, for `useEffect`'s cleanup. */
  subscribe(listener: AuthListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Announce a local event.
   *
   * Local listeners run synchronously, so a caller that announces and then navigates can rely
   * on the caches being empty before the navigation starts. The other tabs hear it after.
   */
  announce(event: AuthEvent): void {
    this.deliver({ event, origin: 'local' });
    try {
      this.channel?.postMessage({ event });
    } catch {
      // A closed channel is not a reason to fail a sign-out.
    }
  }

  private deliver(notice: AuthNotice): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(notice);
      } catch (error) {
        // One listener's failure must not stop the next from clearing its state. The error
        // is surfaced, not swallowed: `console.error` is what the error reporter reads here.
        console.error('[auth-boundary] listener failed', error);
      }
    }
  }
}

const CHANNEL_NAME = 'tmanage-auth';

function browserChannel(): AuthChannel | undefined {
  if (typeof globalThis.BroadcastChannel === 'undefined') return undefined;
  try {
    return new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return undefined;
  }
}

/**
 * The application's boundary. Module-level for the same reason `browserApiClient()` is: the
 * screens, the API client and the providers must all reach the same instance. Tests construct
 * their own with their own channel.
 */
export const authBoundary = new AuthBoundary(browserChannel());
