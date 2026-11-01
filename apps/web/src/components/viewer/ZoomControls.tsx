'use client';

import { useT } from '../../lib/i18n/use-t';
import { MAX_ZOOM, MIN_ZOOM } from './viewer-geometry';
import { ViewerIcon } from './viewer-icons';

export interface ZoomControlsProps {
  readonly zoom: number;
  readonly fitted: boolean;
  /** `width` labels the fit button "Fit width" (PDF); `contain` labels it "Fit". */
  readonly fitMode: 'contain' | 'width';
  readonly onStep: (direction: 1 | -1) => void;
  readonly onFit: () => void;
}

/** V-01 `Zoom` pill: − 125 % + | Fit. */
export function ZoomControls({ zoom, fitted, fitMode, onStep, onFit }: ZoomControlsProps) {
  const t = useT();
  const percent = Math.round(zoom * 100);
  return (
    <div className="tm-viewer-pill tm-viewer-zoom" role="group" aria-label={t('Viewer.zoom.group')}>
      <button
        type="button"
        className="tm-viewer-pill__icon"
        onClick={() => onStep(-1)}
        disabled={zoom <= MIN_ZOOM + 0.001}
        aria-label={t('Viewer.zoom.out')}
      >
        <ViewerIcon name="minus" />
      </button>
      <output className="tm-viewer-zoom__value" dir="ltr" aria-live="polite">
        {percent} %
      </output>
      <button
        type="button"
        className="tm-viewer-pill__icon"
        onClick={() => onStep(1)}
        disabled={zoom >= MAX_ZOOM - 0.001}
        aria-label={t('Viewer.zoom.in')}
      >
        <ViewerIcon name="plus" />
      </button>
      <span className="tm-viewer-pill__rule" aria-hidden="true" />
      <button type="button" className="tm-viewer-pill__text" onClick={onFit} aria-pressed={fitted}>
        {fitMode === 'width' ? t('Viewer.zoom.fitWidth') : t('Viewer.zoom.fit')}
      </button>
    </div>
  );
}
