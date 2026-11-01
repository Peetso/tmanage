'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { ReviewDoor } from '../../lib/api/review';

/**
 * R4 slice 8 — which door the viewer's parts talk through, and how they speak.
 *
 * The studio viewer (`door: 'studio'`) is the default, so every part works unchanged without a
 * provider. The portal viewer wraps the same parts with `door: 'portal'`: the review calls go to
 * the client's twins under `/portal`, the composer has no audience switch (a client's comment is
 * always seen by the team) and says who will read it, the @mention list is the team, and the rail
 * shows comments only.
 */
export interface ReviewDoorValue {
  readonly door: ReviewDoor;
  /** The delivery team's name, for "Everyone on the {team} team will see this." */
  readonly teamName: string | null;
}

const DEFAULT_DOOR: ReviewDoorValue = { door: 'studio', teamName: null };

const ReviewDoorContext = createContext<ReviewDoorValue>(DEFAULT_DOOR);

export function ReviewDoorProvider({
  value,
  children,
}: {
  readonly value: ReviewDoorValue;
  readonly children: ReactNode;
}) {
  return <ReviewDoorContext.Provider value={value}>{children}</ReviewDoorContext.Provider>;
}

export function useReviewDoor(): ReviewDoorValue {
  return useContext(ReviewDoorContext);
}
