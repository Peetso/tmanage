import Link from 'next/link';
import { MOBILE_PRIMARY_NAVIGATION } from './navigation';

export interface MobilePrimaryNavProps {
  /**
   * The organization the person is working in, as it appears in a URL. Supplies the prefix
   * every destination's `href` suffix lives under, exactly as the orbital rail does in
   * `AppShell` — the dock is the same navigation at phone width, not a second one with its
   * own routes.
   */
  organizationSlug: string;
  /** The id of the destination that is current, e.g. `work`. */
  activeNavigationId?: string;
}

/**
 * Module 23's five-item primary bottom navigation.
 *
 * It mirrors the rail's rules so the two read as one navigation at two widths:
 *
 * 1. **Every destination is a real `<a>`.** The item is drawn as an orb, but the orb is the
 *    appearance and the link is the element — middle-click, open-in-new-tab and a screen
 *    reader all get a destination, which a `<button>` with an onClick would deny them.
 * 2. **`aria-current="page"`** marks the active destination in a word, not only in colour —
 *    the token export's third law, the same one the rail follows.
 *
 * It is rendered unconditionally by `AppShell`; `globals.css` shows it only below ~768px and
 * hides the orbital rail at that same breakpoint, so the two never appear together. Its
 * accessible name differs from the rail's ("Primary") because both landmarks are present in
 * the document at once and a screen reader announces each by name.
 */
export function MobilePrimaryNav({ organizationSlug, activeNavigationId }: MobilePrimaryNavProps) {
  return (
    <nav className="tm-mobile-nav" aria-label="Primary mobile">
      <ul className="tm-mobile-nav__list">
        {MOBILE_PRIMARY_NAVIGATION.map((item) => {
          const current = item.id === activeNavigationId;
          return (
            <li key={item.id}>
              <Link
                href={`/${organizationSlug}${item.href}`}
                className="tm-mobile-nav__item"
                {...(current ? { 'aria-current': 'page' as const } : {})}
              >
                <span className="tm-mobile-nav__orb" aria-hidden="true">
                  {item.glyph}
                </span>
                <span className="tm-mobile-nav__label">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
