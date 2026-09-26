'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { getHomePins } from '../../lib/api/home';
import type { HomePinTargetKind } from '../../lib/api/home';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface HomePinnedSectionProps {
  organizationSlug: string;
  client?: ApiClient | undefined;
}

/**
 * **HOME-05 follow-up (x144)** — the Pinned section on the My Day screen, additive and disjoint from
 * the x143 hero and the older Saved (`saved_context`) section it sits beside.
 *
 * A faithful reader of the API's membership-scoped pins: it reads `GET .../home/pins` (behind
 * `work.read`, taking no membership id — the pins are the acting member's own) and lists each pin
 * newest first. A pin is a *reference* — its kind and id — not a copy of the target, so each row
 * shows the target's kind; a work pin links to the item, the read fan-out that resolves a live title
 * being the deferred follow-up. The section is its own landmark (`aria-labelledby`) with a labelled
 * list, so it is axe-clean the way the sibling sections are.
 */
export function HomePinnedSection({ organizationSlug, client }: HomePinnedSectionProps) {
  const api = client ?? browserApiClient();

  const pins = useQuery({
    queryKey: ['home', 'pins', organizationSlug],
    queryFn: () => getHomePins(api, organizationSlug),
  });

  const items = pins.data?.pins ?? [];

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-my-day-pinned">
      <h2 id="tm-my-day-pinned" className="tm-eyebrow">
        Pinned
      </h2>

      {pins.isError ? (
        <InlineAlert tone="danger" title="Could not load your pinned items" live>
          {describePinsError(pins.error)}
        </InlineAlert>
      ) : null}

      {pins.isPending ? (
        <LoadingRegion label="Loading your pinned items.">
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!pins.isPending && !pins.isError && items.length === 0 ? (
        <InlineAlert tone="neutral" title="Nothing pinned yet">
          Work, projects and documents you pin are kept here, newest first, so you can return to
          them from any screen.
        </InlineAlert>
      ) : null}

      {items.length > 0 ? (
        <ul className="tm-list" aria-label="Pinned to your Home">
          {items.map((item) => (
            <li key={item.id}>
              {item.targetKind === 'work' ? (
                <Link href={`/${organizationSlug}/work/${item.targetId}`}>
                  {pinTypeLabel(item.targetKind)}
                </Link>
              ) : item.targetKind === 'project' ? (
                <Link href={`/${organizationSlug}/projects/${item.targetId}`}>
                  {pinTypeLabel(item.targetKind)}
                </Link>
              ) : (
                <span>{pinTypeLabel(item.targetKind)}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** The word each pinned reference shows. The live title/preview is the deferred read fan-out. */
function pinTypeLabel(targetKind: HomePinTargetKind): string {
  switch (targetKind) {
    case 'work':
      return 'Pinned work item';
    case 'project':
      return 'Pinned project';
    case 'document':
      return 'Pinned document';
  }
}

function describePinsError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The network dropped before your pinned items loaded.';
  return 'Something went wrong loading your pinned items.';
}
