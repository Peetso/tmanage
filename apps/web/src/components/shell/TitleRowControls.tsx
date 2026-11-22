'use client';

import { Tooltip, MOTION_DELAY_TOOLTIP_MS } from '@tmanage/ui';
import { NavIcon } from '../icons/phone';
import { OPEN_COMMAND_PALETTE_EVENT } from '../screens/CommandPalette';
import { SupportLauncher } from '../support/SupportLauncher';
import { AiPanelLauncher } from '../ai-panel/AiPanelLauncher';
import { RunningTimerPill } from '../time/TimerControls';
import { useAutoTracker } from '../time/use-auto-tracker';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import { FeatureOn } from './FeatureOn';
import { NewMenu } from './NewMenu';
import './title-row.css';

/**
 * **The dashboard title row's controls** (Figma `Shell/Title row` 795:931, My Day v3.1 W0):
 * Search, Help ("?") and AI as 40 px icon buttons with their names in a tooltip, then the
 * running-timer capsule (only while a timer runs), then "+ New" as the one text button (C6).
 *
 * The automatic timer has no chip in this row: its switch is in My Day's Timer widget. Its
 * activity tracking still runs on this page, through the same tracker the header chip drives
 * everywhere else, so turning the chip into a widget switch never stops the time being counted.
 */
export function TitleRowControls({
  organizationSlug,
  live,
}: {
  readonly organizationSlug: string;
  /** False in a bare render without a query client: only Search is drawn. */
  readonly live: boolean;
}) {
  const t = useT();
  const search = t('MyDay.search');
  return (
    <>
      <Tooltip content={search} delayMs={MOTION_DELAY_TOOLTIP_MS} placement="bottom">
        <button
          type="button"
          className="tm-title-icon"
          aria-label={search}
          onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))}
        >
          <NavIcon name="search" size={20} />
        </button>
      </Tooltip>
      {live ? (
        <>
          <SupportLauncher organizationSlug={organizationSlug} variant="icon" />
          <AiPanelLauncher organizationSlug={organizationSlug} variant="icon" />
          <FeatureOn organizationSlug={organizationSlug} flag="time_tracking">
            <RunningTimerPill organizationSlug={organizationSlug} variant="capsule" />
            <AutoTrackerHost organizationSlug={organizationSlug} />
          </FeatureOn>
          <NewMenu organizationSlug={organizationSlug} variant="outline" />
        </>
      ) : null}
    </>
  );
}

/** Runs the automatic timer's activity tracker on this page; draws nothing. */
function AutoTrackerHost({ organizationSlug }: { readonly organizationSlug: string }) {
  useAutoTracker(browserApiClient(), organizationSlug);
  return null;
}
