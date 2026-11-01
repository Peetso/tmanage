'use client';

import type { ReactNode } from 'react';
import { useT } from '../../lib/i18n/use-t';
import type { ViewerTool } from './ViewerCanvas';
import { useReviewDoor } from './review-door';
import { ViewerIcon, type ViewerIconName } from './viewer-icons';

export interface ViewerToolsProps {
  readonly tool: ViewerTool;
  readonly onTool: (tool: ViewerTool) => void;
  /** Pin, Box and Draw need comment rights; Select is always there. */
  readonly canComment: boolean;
}

/**
 * V-01 `Tools` pill: Select · Pin · Box · Draw. The active tool is an ink capsule with its word;
 * the others are icon buttons named for a screen reader.
 */
export function ViewerTools({ tool, onTool, canComment }: ViewerToolsProps) {
  const t = useT();
  // The client's viewer calls the pin "Comment" (V-40).
  const { door } = useReviewDoor();
  const tools: readonly { id: ViewerTool; icon: ViewerIconName; label: string }[] = [
    { id: 'select', icon: 'cursor', label: t('Viewer.tool.select') },
    ...(canComment
      ? ([
          {
            id: 'pin',
            icon: 'pin',
            label: door === 'portal' ? t('Viewer.portal.toolComment') : t('Viewer.tool.pin'),
          },
          { id: 'box', icon: 'box', label: t('Viewer.tool.box') },
          { id: 'draw', icon: 'pen', label: t('Viewer.tool.draw') },
        ] as const)
      : []),
  ];
  return (
    <div
      className="tm-viewer-pill tm-viewer-tools"
      role="toolbar"
      aria-label={t('Viewer.tool.group')}
    >
      {tools.map((item) => {
        const on = item.id === tool;
        return (
          <button
            key={item.id}
            type="button"
            className="tm-viewer-tools__tool"
            aria-pressed={on}
            aria-label={on ? undefined : item.label}
            title={item.label}
            onClick={() => onTool(item.id)}
          >
            <ViewerIcon name={item.icon} />
            {on ? <span>{item.label}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export interface ViewerShellProps {
  /** Above the stage: tools, the thread counter, zoom. */
  readonly toolbar: ReactNode;
  /** A line above the canvas (virus check, blocked, staff preview). */
  readonly notice?: ReactNode;
  readonly stage: ReactNode;
  /** Under the stage: the PDF page strip. */
  readonly strip?: ReactNode;
  readonly rail: ReactNode;
  /** The short line under the stage: file id, version, size, type. */
  readonly footnote?: ReactNode;
}

/**
 * V-01 / V-02 body: the canvas column (toolbar, stage, page strip) and the 380 px right rail.
 * In Arabic the columns swap by themselves (grid in the document direction); the stage inside
 * stays left-to-right. Below 900 px the rail becomes the bottom sheet under the stage.
 */
export function ViewerShell({ toolbar, notice, stage, strip, rail, footnote }: ViewerShellProps) {
  return (
    <div className="tm-viewer">
      <div className="tm-viewer__canvas">
        <div className="tm-viewer__toolbar">{toolbar}</div>
        {notice}
        {stage}
        {footnote ? <p className="tm-viewer__footnote">{footnote}</p> : null}
        {strip}
      </div>
      {rail}
    </div>
  );
}
