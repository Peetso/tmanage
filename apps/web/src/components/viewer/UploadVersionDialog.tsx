'use client';

import { useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { Button, Field, InlineAlert, Switch } from '@tmanage/ui';
import { addAttachmentVersion } from '../../lib/api/attachment-versions';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { FilePreviewManifest } from '../../lib/api/file-preview';
import type { ReviewThread } from '../../lib/api/review';
import {
  attachmentProblem,
  formatBytes,
  uploadProjectFile,
  UploadCancelledError,
  type UploadAttachmentOptions,
} from '../../lib/api/uploads';
import { useT } from '../../lib/i18n/use-t';
import { CarryForwardList } from './CarryForwardDialog';
import { ViewerIcon } from './viewer-icons';
import './viewer-versions.css';

export interface UploadVersionDialogProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly manifest: FilePreviewManifest;
  /** The open threads on the version on screen — what may travel to the new one. */
  readonly openThreads: readonly ReviewThread[];
  readonly onClose: () => void;
  /** The new version is recorded: open it. */
  readonly onUploaded: (fileAssetId: string, carriedThreads: number) => void;
  /** Injectable for tests (the part PUTs and the progress). */
  readonly uploadOptions?: UploadAttachmentOptions;
}

/**
 * R4 slice 11 — upload a new version from the viewer (Figma V-35 `466:30902`, phone `466:31075`).
 *
 * A dialog over the viewer: "homepage-concept.png · now v3", "Upload a new version", a dashed drop
 * zone (choose or drop a file; then its name, size, a lime progress bar and the v4 badge), "What
 * changed in v4?" with its hint, the switch "Carry the 3 open comments to v4" with the comments to
 * untick (V-32), the line "v4 becomes the current version when the upload finishes. v3 stays under
 * Versions." and Cancel / Upload v4. The file goes through the normal upload pipeline (verified and
 * scanned like any upload), then is recorded as the next version of this file.
 */
export function UploadVersionDialog({
  api,
  organizationSlug,
  manifest,
  openThreads,
  onClose,
  onUploaded,
  uploadOptions,
}: UploadVersionDialogProps) {
  const t = useT();
  const describeError = useDescribeApiError();
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [carry, setCarry] = useState(true);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(openThreads.map((thread) => thread.id)),
  );
  const [sent, setSent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const versions = manifest.versions.versions;
  const newest = versions.reduce((max, version) => Math.max(max, version.versionNo), 1);
  const here = versions.find((version) => version.fileAssetId === manifest.file.id);
  const nowNo = here?.versionNo ?? newest;
  const nextNo = newest + 1;
  const short = (no: number) => t('Viewer.version.short').replace('{no}', String(no));
  const uploading = sent !== null;
  const carriedCount = carry ? chosen.size : 0;

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('button, input')?.focus();
    return () => abortRef.current?.abort();
  }, []);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      abortRef.current?.abort();
      closeRef.current();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function close() {
    abortRef.current?.abort();
    onClose();
  }

  function pick(next: File | undefined) {
    if (!next) return;
    const why = attachmentProblem(next);
    setProblem(why ? t('ViewerUpload.badFile') : null);
    setFile(why ? null : next);
    setError(null);
  }

  async function submit() {
    if (!file || uploading) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setSent(0);
    try {
      const fileAssetId = await uploadProjectFile(
        api,
        organizationSlug,
        { projectId: manifest.file.projectId, file },
        { ...uploadOptions, signal: controller.signal, onProgress: (bytes) => setSent(bytes) },
      );
      const trimmed = note.trim();
      const added = await addAttachmentVersion(api, organizationSlug, manifest.file.id, {
        fileAssetId,
        note: trimmed === '' ? null : trimmed,
        carryForward: carry && chosen.size > 0 ? 'open' : 'none',
        ...(carry && chosen.size > 0 && chosen.size < openThreads.length
          ? { carryThreadIds: [...chosen] }
          : {}),
      });
      onUploaded(fileAssetId, added.carriedThreads);
    } catch (caught) {
      setSent(null);
      if (caught instanceof UploadCancelledError) return;
      setError(describeError(caught));
    }
  }

  const percent =
    file && sent !== null && file.size > 0
      ? Math.min(100, Math.round((sent / file.size) * 100))
      : 0;

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
          <p className="tm-upload-version__eyebrow">
            {t('ViewerUpload.eyebrow')
              .replace('{name}', manifest.file.name)
              .replace('{no}', short(nowNo))}
          </p>
          <h2 id={`${id}-title`} className="tm-upload-version__title">
            {t('ViewerUpload.title')}
          </h2>

          <div
            className="tm-upload-version__drop"
            data-has-file={file ? 'true' : undefined}
            onDragOver={(event: DragEvent) => event.preventDefault()}
            onDrop={(event: DragEvent) => {
              event.preventDefault();
              if (!uploading) pick(event.dataTransfer.files[0]);
            }}
          >
            {file ? (
              <div className="tm-upload-version__file">
                <ViewerIcon name="download" className="tm-upload-version__file-icon" />
                <span className="tm-upload-version__file-text">
                  <span className="tm-upload-version__file-name" dir="auto">
                    {file.name}
                  </span>
                  <span className="tm-upload-version__file-meta">
                    {uploading
                      ? t('ViewerUpload.progress')
                          .replace('{size}', formatBytes(file.size))
                          .replace('{percent}', String(percent))
                      : formatBytes(file.size)}
                  </span>
                </span>
                <span className="tm-upload-version__badge">{short(nextNo)}</span>
                {uploading ? (
                  <span
                    className="tm-upload-version__bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    aria-label={t('ViewerUpload.progressLabel')}
                  >
                    <span style={{ inlineSize: `${percent}%` }} />
                  </span>
                ) : null}
              </div>
            ) : (
              <p className="tm-upload-version__drop-text">{t('ViewerUpload.drop')}</p>
            )}
            {uploading ? null : (
              <Button
                type="button"
                tone="outline"
                onClick={() => inputRef.current?.click()}
                className="tm-upload-version__choose"
              >
                {t(file ? 'ViewerUpload.chooseAnother' : 'ViewerUpload.choose')}
              </Button>
            )}
            <input
              ref={inputRef}
              type="file"
              hidden
              data-testid="upload-version-input"
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                pick(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </div>
          {problem ? <InlineAlert tone="danger">{problem}</InlineAlert> : null}

          <Field
            label={t('ViewerUpload.noteLabel').replace('{no}', short(nextNo))}
            hint={t('ViewerUpload.noteHint')}
            value={note}
            maxLength={2000}
            dir="auto"
            disabled={uploading}
            onChange={(event) => setNote(event.target.value)}
          />

          {openThreads.length > 0 ? (
            <>
              <Switch
                label={t('ViewerUpload.carry')
                  .replace('{count}', String(openThreads.length))
                  .replace('{no}', short(nextNo))}
                checked={carry}
                disabled={uploading}
                onChange={(event) => setCarry(event.target.checked)}
              />
              {carry ? (
                <CarryForwardList
                  threads={openThreads}
                  chosen={chosen}
                  fromNo={nowNo}
                  toNo={nextNo}
                  onToggle={(threadId) =>
                    setChosen((current) => {
                      const next = new Set(current);
                      if (next.has(threadId)) next.delete(threadId);
                      else next.add(threadId);
                      return next;
                    })
                  }
                />
              ) : null}
            </>
          ) : null}

          <p className="tm-viewer-rail__note">
            {t('ViewerUpload.footnote')
              .replace('{next}', short(nextNo))
              .replace('{now}', short(newest))}
          </p>
          {error ? (
            <InlineAlert tone="danger" title={t('ViewerUpload.error')} live>
              {error}
            </InlineAlert>
          ) : null}
        </div>
        <div className="tm-upload-version__actions">
          <Button type="button" tone="outline" size="accessible" onClick={close}>
            {t('ViewerUpload.cancel')}
          </Button>
          <Button
            type="button"
            tone="ink"
            size="accessible"
            disabled={!file}
            loading={uploading}
            loadingLabel={t('ViewerUpload.uploading')}
            onClick={() => void submit()}
          >
            {uploading
              ? t('ViewerUpload.uploading')
              : carriedCount > 0
                ? t('ViewerUpload.submitCarry')
                    .replace('{no}', short(nextNo))
                    .replace('{count}', String(carriedCount))
                : t('ViewerUpload.submit').replace('{no}', short(nextNo))}
          </Button>
        </div>
      </div>
    </div>
  );
}
