'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, Switch } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import {
  attachFigmaLink,
  figmaProblem,
  inspectFigmaUrl,
  listFigmaLinks,
  type FigmaAttachTarget,
  type FigmaInspection,
  type FigmaLink,
  type FigmaLinkAudience,
  type FigmaProblem,
} from '../../lib/api/figma';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import './viewer-versions.css';
import './figma-stage.css';

/** The words for each Figma refusal: a title and a sentence. */
export const FIGMA_PROBLEM_KEYS: Record<
  FigmaProblem,
  { readonly title: MessageKey; readonly body: MessageKey }
> = {
  not_connected: {
    title: 'Figma.problem.not_connectedTitle',
    body: 'Figma.problem.not_connected',
  },
  no_access: { title: 'Figma.problem.no_accessTitle', body: 'Figma.problem.no_access' },
  rate_limited: { title: 'Figma.problem.rate_limitedTitle', body: 'Figma.problem.rate_limited' },
  unreachable: { title: 'Figma.problem.unreachableTitle', body: 'Figma.problem.unreachable' },
};

/** The frames ticked by default: the one the link points at, or the first ones up to the cap. */
export function defaultFrameChoice(inspection: FigmaInspection): ReadonlySet<string> {
  if (
    inspection.linkedNodeId &&
    inspection.frames.some((frame) => frame.nodeId === inspection.linkedNodeId)
  ) {
    return new Set([inspection.linkedNodeId]);
  }
  return new Set(inspection.frames.slice(0, inspection.maxFrames).map((frame) => frame.nodeId));
}

export interface FigmaLinksPanelProps {
  readonly organizationSlug: string;
  readonly projectId: string;
  readonly target: { readonly type: FigmaAttachTarget; readonly id: string } | null;
  /** Whether this person may attach (the screen's own upload permission). */
  readonly canAttach: boolean;
  readonly client?: ApiClient;
}

/**
 * V-53 entry point — the Figma links attached to a work item or deliverable version, each opening
 * the viewer (V-23), and "Attach Figma link" for people who may add files here.
 */
export function FigmaLinksPanel({
  organizationSlug,
  projectId,
  target,
  canAttach,
  client,
}: FigmaLinksPanelProps) {
  const t = useT();
  const api = client ?? browserApiClient();
  const id = useId();
  const [open, setOpen] = useState(false);
  const queryKey = [
    'figma-links',
    organizationSlug,
    projectId,
    target?.type ?? '',
    target?.id ?? '',
  ];
  const links = useQuery({
    queryKey,
    queryFn: () => listFigmaLinks(api, organizationSlug, projectId, target),
    retry: false,
  });
  const queryClient = useQueryClient();
  const items = links.data?.links ?? [];

  if (!canAttach && items.length === 0) return null;

  return (
    <section className="tm-figma-links" aria-labelledby={`${id}-title`}>
      <div className="tm-figma-links__head">
        <h2 id={`${id}-title`} className="tm-figma-links__title">
          {t('Figma.links.title')}
        </h2>
        {canAttach ? (
          <Button type="button" tone="outline" onClick={() => setOpen(true)}>
            {t('Figma.links.attach')}
          </Button>
        ) : null}
      </div>
      {links.isError ? (
        <InlineAlert tone="danger">{t('Figma.links.loadError')}</InlineAlert>
      ) : items.length === 0 ? (
        <p className="tm-figma-links__meta">{t('Figma.links.empty')}</p>
      ) : (
        <ul className="tm-figma-links__list">
          {items.map((item) => (
            <li key={item.id} className="tm-figma-links__item">
              <span>
                <span className="tm-figma-links__name" dir="auto">
                  {item.fileName ?? t('Figma.viewer.untitled')}
                </span>
                <br />
                <span className="tm-figma-links__meta">
                  {(item.frameCount === 1
                    ? t('Figma.links.framesOne')
                    : t('Figma.links.framesMany')
                  ).replace('{count}', String(item.frameCount))}
                  {' · '}
                  {item.audience === 'client_visible'
                    ? t('Viewer.audience.client')
                    : t('Viewer.audience.internal')}
                </span>
              </span>
              <Link
                className="tm-button tm-button--outline tm-button--default"
                href={`/${organizationSlug}/figma/${encodeURIComponent(item.id)}`}
              >
                {t('Figma.links.review')}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <AttachFigmaDialog
          api={api}
          organizationSlug={organizationSlug}
          projectId={projectId}
          target={target}
          onClose={() => setOpen(false)}
          onAttached={() => {
            setOpen(false);
            void queryClient.invalidateQueries({ queryKey });
          }}
        />
      ) : null}
    </section>
  );
}

export interface AttachFigmaDialogProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly projectId: string;
  readonly target: { readonly type: FigmaAttachTarget; readonly id: string } | null;
  readonly onClose: () => void;
  readonly onAttached: (link: FigmaLink) => void;
}

/**
 * **V-53 — Attach a Figma link.** Paste a Figma address, see the frames it holds (the one the link
 * points at is ticked), choose up to 20, choose who sees the snapshots, and attach. A person who has
 * not connected Figma is sent to Connected apps; a file their Figma account cannot open says so.
 */
export function AttachFigmaDialog({
  api,
  organizationSlug,
  projectId,
  target,
  onClose,
  onAttached,
}: AttachFigmaDialogProps) {
  const t = useT();
  const describeError = useDescribeApiError();
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState('');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [audience, setAudience] = useState<FigmaLinkAudience>('internal');

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('input')?.focus();
  }, []);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') closeRef.current();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const inspect = useMutation({
    mutationFn: (address: string) => inspectFigmaUrl(api, organizationSlug, projectId, address),
    onSuccess: (inspection) => setChosen(defaultFrameChoice(inspection)),
  });
  const attach = useMutation({
    mutationFn: () =>
      attachFigmaLink(api, organizationSlug, projectId, {
        url: url.trim(),
        nodeIds: [...chosen],
        audience,
        attachedTo: target,
      }),
    onSuccess: onAttached,
  });

  const inspection = inspect.data;
  const max = inspection?.maxFrames ?? 20;
  const failure = inspect.error ?? attach.error;
  const problem = figmaProblem(failure);

  return (
    <div className="tm-upload-version__scrim">
      <div
        ref={dialogRef}
        className="tm-upload-version"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
      >
        <div className="tm-upload-version__body">
          <h2 id={`${id}-title`} className="tm-upload-version__title">
            {t('Figma.attach.title')}
          </h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (url.trim() !== '') inspect.mutate(url.trim());
            }}
          >
            <Field
              label={t('Figma.attach.urlLabel')}
              hint={t('Figma.attach.urlHint')}
              value={url}
              dir="ltr"
              inputMode="url"
              autoComplete="off"
              onChange={(event) => {
                setUrl(event.target.value);
                inspect.reset();
                attach.reset();
              }}
            />
            <Button
              type="submit"
              tone="outline"
              disabled={url.trim() === ''}
              loading={inspect.isPending}
              loadingLabel={t('Figma.attach.finding')}
            >
              {t('Figma.attach.find')}
            </Button>
          </form>

          {failure ? (
            <InlineAlert
              tone={problem === 'not_connected' ? 'warning' : 'danger'}
              title={problem ? t(FIGMA_PROBLEM_KEYS[problem].title) : t('Figma.attach.error')}
              live
            >
              <p>{problem ? t(FIGMA_PROBLEM_KEYS[problem].body) : describeError(failure)}</p>
              {problem === 'not_connected' ? (
                <p>
                  <Link href={`/${organizationSlug}/settings/connected-apps`}>
                    {t('Figma.attach.connectLink')}
                  </Link>
                </p>
              ) : null}
            </InlineAlert>
          ) : null}

          {inspection ? (
            <>
              <p className="tm-viewer-rail__note" dir="auto">
                {t('Figma.attach.found')
                  .replace('{name}', inspection.fileName)
                  .replace('{count}', String(inspection.frames.length))}
              </p>
              {inspection.frames.length === 0 ? (
                <p className="tm-viewer-rail__note">{t('Figma.attach.noFrames')}</p>
              ) : (
                <fieldset className="tm-figma-attach__fieldset">
                  <legend className="tm-viewer-rail__note">
                    {t('Figma.attach.framesLegend')
                      .replace('{chosen}', String(chosen.size))
                      .replace('{max}', String(max))}
                  </legend>
                  <ul className="tm-figma-attach__frames">
                    {inspection.frames.map((frame) => {
                      const on = chosen.has(frame.nodeId);
                      return (
                        <li key={frame.nodeId} className="tm-figma-attach__frame">
                          <Checkbox
                            label={
                              <span dir="auto">
                                {frame.pageName ? `${frame.pageName} › ` : ''}
                                {frame.name}
                              </span>
                            }
                            checked={on}
                            disabled={!on && chosen.size >= max}
                            onChange={() =>
                              setChosen((current) => {
                                const next = new Set(current);
                                if (next.has(frame.nodeId)) next.delete(frame.nodeId);
                                else next.add(frame.nodeId);
                                return next;
                              })
                            }
                          />
                          <span className="tm-figma-attach__size" dir="ltr">
                            {frame.width}×{frame.height}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              )}
              <Switch
                label={t('Figma.attach.clientVisible')}
                hint={t('Figma.attach.clientVisibleHint')}
                checked={audience === 'client_visible'}
                onChange={(event) =>
                  setAudience(event.target.checked ? 'client_visible' : 'internal')
                }
              />
            </>
          ) : null}
        </div>
        <div className="tm-upload-version__actions">
          <Button type="button" tone="outline" size="accessible" onClick={onClose}>
            {t('Figma.attach.cancel')}
          </Button>
          <Button
            type="button"
            tone="ink"
            size="accessible"
            disabled={!inspection || chosen.size === 0}
            loading={attach.isPending}
            loadingLabel={t('Figma.attach.attaching')}
            onClick={() => attach.mutate()}
          >
            {t('Figma.attach.submit')}
          </Button>
        </div>
      </div>
    </div>
  );
}
