'use client';

import type { ComponentProps, ReactElement } from 'react';
import { Tooltip } from '@tmanage/ui';

/** How long the pointer rests on a control before its hover help shows (Peter: "for a moment"). */
export const HELP_TIP_DELAY_MS = 600;

export interface HelpTipProps {
  /** One plain-language sentence: what this is and what it does. Already translated. */
  readonly tip: string;
  /** A full-width trigger (a rail row): the wrapper keeps the row's width. */
  readonly block?: boolean;
  /** `'end'`: beside the trigger (navigation rails and menus); above it otherwise. */
  readonly placement?: 'top' | 'end';
  /** The trigger: focusable, with its own accessible name (the tip describes, never names). */
  readonly children: ReactElement;
}

/**
 * FIX2 item 5 — hover help. The app's one tooltip for icon buttons, chips, status badges,
 * technical labels and navigation items: the shared `@tmanage/ui` Tooltip (role="tooltip", the
 * trigger's aria-describedby points at it, Escape dismisses, keyboard focus shows it at once) with
 * a ~600 ms hover delay, so new users get a short guide without bubbles flashing as the pointer
 * passes.
 */
export function HelpTip({ tip, block = false, placement = 'top', children }: HelpTipProps) {
  return (
    <Tooltip
      content={tip}
      delayMs={HELP_TIP_DELAY_MS}
      placement={placement}
      {...(block ? { className: 'tm-tooltip--block' } : {})}
    >
      {children as ComponentProps<typeof Tooltip>['children']}
    </Tooltip>
  );
}
