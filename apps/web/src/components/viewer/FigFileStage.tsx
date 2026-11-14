'use client';

import { useId } from 'react';
import { Button } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import type { PreviewFig } from '../../lib/api/file-preview';
import { useT } from '../../lib/i18n/use-t';
import { FigmaLinksPanel, PortalFigmaLinks } from './FigmaLinks';
import './figma-stage.css';

/**
 * Peter, 2026-11-10 (FIGMA item 10) — a `.fig` file in the viewer.
 *
 * It shows what the file itself holds, and says so: the small picture Figma saved inside it, and
 * the list of its pages and frames. Frames are not drawn from the file (that needs Figma's own
 * renderer, and a half-drawn frame would mislead a client). For every frame sharp, the team pastes
 * the file's Figma link here ("Show it from Figma"); the client then sees that link's viewer,
 * with nothing to connect.
 */

export interface FigFileStageProps {
  readonly organizationSlug: string;
  readonly fileAssetId: string;
  readonly projectId: string;
  readonly fileName: string;
  /** The saved picture's URL, or `null` when the file holds none. */
  readonly picture: string | null;
  readonly fig: PreviewFig | null;
  readonly door: 'studio' | 'portal';
  /** Whether this person may pair a Figma link with the file. */
  readonly canAttach: boolean;
  readonly client?: ApiClient;
  readonly onDownload?: (() => void) | null | undefined;
}

export function FigFileStage({
  organizationSlug,
  fileAssetId,
  projectId,
  fileName,
  picture,
  fig,
  door,
  canAttach,
  client,
  onDownload,
}: FigFileStageProps) {
  const t = useT();
  const id = useId();
  const target = { type: 'file_asset' as const, id: fileAssetId };
  const portal = door === 'portal';
  return (
    <div className="tm-fig-file" dir="auto">
      <figure className="tm-fig-file__picture">
        {picture ? (
          <img
            src={picture}
            alt={t('Figma.file.pictureAlt').replace('{name}', fileName)}
            className="tm-fig-file__img"
          />
        ) : (
          <p className="tm-viewer-rail__note">{t('Figma.file.noPicture')}</p>
        )}
        {picture ? (
          <figcaption className="tm-fig-file__chip">{t('Figma.file.pictureChip')}</figcaption>
        ) : null}
      </figure>

      <p className="tm-fig-file__note">
        {portal ? t('Figma.file.clientNote') : t('Figma.file.teamNote')}
      </p>

      {portal ? (
        <PortalFigmaLinks
          organizationSlug={organizationSlug}
          attachedTo={{ projectId, ...target }}
          {...(client ? { client } : {})}
        />
      ) : (
        <FigmaLinksPanel
          organizationSlug={organizationSlug}
          projectId={projectId}
          target={target}
          canAttach={canAttach}
          {...(client ? { client } : {})}
        />
      )}

      <section className="tm-fig-file__pages" aria-labelledby={`${id}-pages`}>
        <h2 id={`${id}-pages`} className="tm-figma-links__title">
          {t('Figma.file.pagesTitle')}
        </h2>
        {fig ? (
          <>
            <ul className="tm-fig-file__page-list">
              {fig.pages.map((page, index) => (
                <li key={`${index}-${page.name}`} className="tm-fig-file__page">
                  <span className="tm-fig-file__page-name" dir="auto">
                    {t('Figma.file.pageLine')
                      .replace('{name}', page.name)
                      .replace('{count}', String(page.frameCount))}
                  </span>
                  {page.frames.length > 0 ? (
                    <ul className="tm-fig-file__frames">
                      {page.frames.map((frame, at) => (
                        <li key={`${at}-${frame.name}`} className="tm-fig-file__frame">
                          <span dir="auto">
                            {frame.section ? `${frame.section} › ` : ''}
                            {frame.name}
                          </span>
                          <span className="tm-figma-attach__size" dir="ltr">
                            {frame.width}×{frame.height}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
            {fig.truncated ? (
              <p className="tm-viewer-rail__note">{t('Figma.file.truncated')}</p>
            ) : null}
          </>
        ) : (
          <p className="tm-viewer-rail__note">{t('Figma.file.outlineFailed')}</p>
        )}
      </section>

      {onDownload ? (
        <Button type="button" tone="outline" onClick={onDownload}>
          {t('Figma.file.download')}
        </Button>
      ) : null}
    </div>
  );
}
