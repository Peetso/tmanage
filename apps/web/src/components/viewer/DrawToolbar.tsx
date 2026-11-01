'use client';

import { localeDirection } from '../../lib/i18n/direction';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useT } from '../../lib/i18n/use-t';
import { DRAW_COLOURS, DRAW_WIDTHS, type DrawTool } from '../../lib/review-anchors';
import type { DrawSettings } from './DrawLayer';
import { ViewerIcon, type ViewerIconName } from './viewer-icons';

export interface DrawToolbarProps {
  readonly settings: DrawSettings;
  readonly onSettings: (next: DrawSettings) => void;
  readonly canUndo: boolean;
  readonly onUndo: () => void;
  /** Enabled once there is at least one stroke: opens the new-comment composer. */
  readonly canFinish: boolean;
  readonly onDone: () => void;
  /** A short line when the drawing reached the most one comment can hold. */
  readonly limitReached?: boolean;
}

const TOOLS: readonly { readonly id: DrawTool; readonly icon: ViewerIconName }[] = [
  { id: 'pen', icon: 'pen' },
  { id: 'arrow', icon: 'arrowDraw' },
  { id: 'rect', icon: 'rect' },
];

/**
 * V-12 draw toolbar (`463:27445`): Pen · Arrow · Rectangle | seven colours | three widths |
 * Undo · Done, floating over the top of the stage. On a phone (V-12 phone `463:27493`) it becomes
 * two bottom pills — the colour row above, the tools (icons only), the current colour, Undo and a
 * round lime Done below — with "Draw with one finger · pinch with two to zoom" over the stage.
 * Laid out in the reading direction; the undo glyph mirrors in Arabic.
 */
export function DrawToolbar({
  settings,
  onSettings,
  canUndo,
  onUndo,
  canFinish,
  onDone,
  limitReached = false,
}: DrawToolbarProps) {
  const t = useT();
  // The stage under the bar is left-to-right; the bar itself follows the reading direction.
  const direction = localeDirection(useActiveLocale());
  const widthLabel: Record<number, string> = {
    4: t('Viewer.draw.width.thin'),
    6: t('Viewer.draw.width.medium'),
    9: t('Viewer.draw.width.thick'),
  };

  const colours = (
    <div
      className="tm-viewer-draw-bar__colours"
      role="radiogroup"
      aria-label={t('Viewer.draw.colour')}
    >
      {DRAW_COLOURS.map((colour) => {
        const on = settings.color === colour.hex;
        return (
          <button
            key={colour.id}
            type="button"
            role="radio"
            aria-checked={on}
            className="tm-viewer-draw-bar__swatch"
            aria-label={t(`Viewer.draw.colours.${colour.id}`)}
            title={t(`Viewer.draw.colours.${colour.id}`)}
            onClick={() => onSettings({ ...settings, color: colour.hex })}
          >
            <span style={{ background: colour.hex }} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="tm-viewer-draw-ui" dir={direction}>
      <p className="tm-viewer-draw-hint">{t('Viewer.draw.phoneHint')}</p>
      <div className="tm-viewer-draw-bar" role="toolbar" aria-label={t('Viewer.draw.toolbar')}>
        {colours}
        <div className="tm-viewer-draw-bar__main">
          <div className="tm-viewer-draw-bar__tools">
            {TOOLS.map((item) => {
              const on = settings.tool === item.id;
              const label = t(`Viewer.draw.${item.id}`);
              return (
                <button
                  key={item.id}
                  type="button"
                  className="tm-viewer-draw-bar__tool"
                  aria-pressed={on}
                  aria-label={label}
                  title={label}
                  onClick={() => onSettings({ ...settings, tool: item.id })}
                >
                  <ViewerIcon name={item.icon} />
                  <span className="tm-viewer-draw-bar__word" aria-hidden="true">
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
          <span className="tm-viewer-draw-bar__divider" aria-hidden="true" />
          <span
            className="tm-viewer-draw-bar__current"
            style={{ background: settings.color }}
            aria-hidden="true"
          />
          <span
            className="tm-viewer-draw-bar__divider tm-viewer-draw-bar__divider--second"
            aria-hidden="true"
          />
          <div
            className="tm-viewer-draw-bar__widths"
            role="radiogroup"
            aria-label={t('Viewer.draw.width')}
          >
            {DRAW_WIDTHS.map((width) => (
              <button
                key={width}
                type="button"
                role="radio"
                aria-checked={settings.width === width}
                className="tm-viewer-draw-bar__width"
                aria-label={widthLabel[width]}
                title={widthLabel[width]}
                onClick={() => onSettings({ ...settings, width })}
              >
                <span style={{ inlineSize: width, blockSize: width }} aria-hidden="true" />
              </button>
            ))}
          </div>
          <span
            className="tm-viewer-draw-bar__divider tm-viewer-draw-bar__divider--third"
            aria-hidden="true"
          />
          <button
            type="button"
            className="tm-viewer-draw-bar__undo"
            aria-label={t('Viewer.draw.undo')}
            title={t('Viewer.draw.undo')}
            disabled={!canUndo}
            onClick={onUndo}
          >
            <ViewerIcon name="undo" />
          </button>
          <button
            type="button"
            className="tm-viewer-draw-bar__done"
            aria-label={t('Viewer.draw.done')}
            disabled={!canFinish}
            onClick={onDone}
          >
            <ViewerIcon name="check" />
            <span className="tm-viewer-draw-bar__word" aria-hidden="true">
              {t('Viewer.draw.done')}
            </span>
          </button>
        </div>
      </div>
      {limitReached ? (
        <p className="tm-viewer-draw-limit" role="status">
          {t('Viewer.draw.limit')}
        </p>
      ) : null}
    </div>
  );
}
