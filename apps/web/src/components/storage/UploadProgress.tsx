'use client';

import { useCallback, useReducer, useRef } from 'react';
import { useA6T } from '../work/DueDatePicker';
import {
  UploadCancelledError,
  type UploadAttachmentOptions,
  type UploadDestination,
} from '../../lib/api/uploads';
import { sizePair, uploadPercent, uploadRowsReducer, type UploadRow } from '../../lib/upload-queue';
import './upload-progress.css';

/**
 * Upload progress (Figma 409:6602): a row per file being sent — name, a percentage bar, "4.1 of
 * 9.8 MB · 42 %", Cancel — with "To Google Drive" / "To OneDrive" when the company keeps files
 * there (409:6668), "Upload stopped at 64 %" with Retry and Remove (409:6729), and "Uploaded ·
 * 1.2 MB · just now" once done (409:6794). Arabic mirrors it (409:6853): the bar fills from the
 * right.
 */

/** One upload attempt: sends `file`, reporting bytes and stopping on `signal`. */
export type UploadRun = (
  file: File,
  deps: Required<Pick<UploadAttachmentOptions, 'onProgress' | 'signal'>>,
) => Promise<string | null>;

function newRowId(): string {
  return `up-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * The rows and their controls. `describeFailure` words a failure; `null` means the connection
 * dropped, which the row says as "Upload stopped at N %. Check your connection…".
 */
export function useUploadQueue(describeFailure: (error: unknown) => string | null) {
  const [rows, dispatch] = useReducer(uploadRowsReducer, [] as readonly UploadRow[]);
  const runs = useRef(new Map<string, { run: UploadRun; controller: AbortController }>());
  const describeRef = useRef(describeFailure);
  describeRef.current = describeFailure;

  const launch = useCallback(
    async (id: string, file: File, attempt: number, run: UploadRun): Promise<boolean> => {
      const controller = new AbortController();
      runs.current.set(id, { run, controller });
      try {
        const resultId = await run(file, {
          signal: controller.signal,
          onProgress: (sent) => dispatch({ type: 'progress', id, attempt, sent }),
        });
        dispatch({ type: 'done', id, attempt, resultId });
        return true;
      } catch (error) {
        if (!(error instanceof UploadCancelledError) && !controller.signal.aborted) {
          dispatch({ type: 'failed', id, attempt, reason: describeRef.current(error) });
        }
        return false;
      }
    },
    [],
  );

  /** Start sending `file`; resolves `true` once it is uploaded and attached. */
  const start = useCallback(
    (file: File, destination: UploadDestination, run: UploadRun): Promise<boolean> => {
      const id = newRowId();
      dispatch({ type: 'start', id, file, destination });
      return launch(id, file, 0, run);
    },
    [launch],
  );

  const cancel = useCallback((id: string) => {
    runs.current.get(id)?.controller.abort();
    runs.current.delete(id);
    dispatch({ type: 'remove', id });
  }, []);

  const retry = useCallback(
    (row: UploadRow) => {
      const entry = runs.current.get(row.id);
      if (!entry || row.state !== 'failed') return;
      dispatch({ type: 'retry', id: row.id });
      void launch(row.id, row.file, row.attempt + 1, entry.run);
    },
    [launch],
  );

  const remove = useCallback((id: string) => {
    runs.current.delete(id);
    dispatch({ type: 'remove', id });
  }, []);

  const clearSettled = useCallback(() => dispatch({ type: 'clear-settled' }), []);

  return { rows, start, cancel, retry, remove, clearSettled };
}

function fileKind(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0
    ? 'FILE'
    : name
        .slice(dot + 1)
        .toUpperCase()
        .slice(0, 5);
}

const UPLOADING_KEY: Readonly<Record<UploadDestination, string>> = {
  tmanage: 'UploadProgress.uploading',
  google_drive: 'UploadProgress.uploadingDrive',
  onedrive: 'UploadProgress.uploadingOneDrive',
};

function CheckGlyph() {
  return (
    <svg className="tm-upload__check" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 8.5l3.2 3L13 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface UploadProgressItemProps {
  readonly row: UploadRow;
  readonly onCancel: (id: string) => void;
  readonly onRetry: (row: UploadRow) => void;
  readonly onRemove: (row: UploadRow) => void;
  /** Whether a finished row offers Remove (its attachment can be detached here). */
  readonly removableWhenDone?: boolean;
}

/** One file's row, as an `<li>` for the attachments list it sits in. */
export function UploadProgressItem({
  row,
  onCancel,
  onRetry,
  onRemove,
  removableWhenDone = false,
}: UploadProgressItemProps) {
  const ta = useA6T();
  const total = row.file.size;
  const percent = uploadPercent(row.sent, total);
  const sizes = sizePair(row.sent, total);
  const unit = ta(`UploadProgress.unit${sizes.unit}`);
  const done = sizePair(total, total);

  const meta =
    row.state === 'uploading'
      ? ta(UPLOADING_KEY[row.destination], {
          sent: sizes.sent,
          total: sizes.total,
          unit,
          pct: percent,
        })
      : row.state === 'failed'
        ? (row.reason ?? ta('UploadProgress.stopped', { pct: percent }))
        : ta('UploadProgress.done', { size: `${done.total} ${unit}` });

  return (
    <li className="tm-upload" data-state={row.state}>
      <span className="tm-upload__kind">{fileKind(row.file.name)}</span>
      <span className="tm-upload__info">
        <span className="tm-upload__title">
          <span className="tm-upload__name">{row.file.name}</span>
          {row.state === 'uploading' && row.destination !== 'tmanage' ? (
            <span className="tm-upload__dest">
              {ta(
                row.destination === 'google_drive'
                  ? 'UploadProgress.toDrive'
                  : 'UploadProgress.toOneDrive',
              )}
            </span>
          ) : null}
        </span>
        {row.state === 'done' ? null : (
          <span
            className="tm-upload__bar"
            role="progressbar"
            aria-label={ta('UploadProgress.progressLabel', { name: row.file.name })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span className="tm-upload__fill" style={{ inlineSize: `${percent}%` }} />
          </span>
        )}
        <span className="tm-upload__meta" role={row.state === 'failed' ? 'alert' : undefined}>
          {row.state === 'done' ? <CheckGlyph /> : null}
          <span>{meta}</span>
        </span>
      </span>
      <span className="tm-upload__actions">
        {row.state === 'uploading' ? (
          <button type="button" className="tm-upload__text" onClick={() => onCancel(row.id)}>
            {ta('UploadProgress.cancel')}
          </button>
        ) : null}
        {row.state === 'failed' ? (
          <button type="button" className="tm-upload__outline" onClick={() => onRetry(row)}>
            {ta('UploadProgress.retry')}
          </button>
        ) : null}
        {row.state === 'failed' || (row.state === 'done' && removableWhenDone) ? (
          <button type="button" className="tm-upload__text" onClick={() => onRemove(row)}>
            {ta('UploadProgress.remove')}
          </button>
        ) : null}
      </span>
    </li>
  );
}
