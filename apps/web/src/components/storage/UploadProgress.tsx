'use client';

import { useCallback, useReducer, useRef } from 'react';
import { useA6T } from '../work/DueDatePicker';
import { UploadCancelledError, type UploadAttachmentOptions } from '../../lib/api/uploads';
import { sizePair, uploadPercent, uploadRowsReducer, type UploadRow } from '../../lib/upload-queue';
import './upload-progress.css';

/**
 * Upload progress (Figma 409:6602): a row per file being sent — name, a percentage bar, "4.1 of
 * 9.8 MB · 42 %", Cancel, "Upload stopped at 64 %" with Retry and Remove (409:6729), and "Uploaded ·
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
 * dropped, which the row says as "Upload stopped at N %. Check your connection…". A failure it
 * answers as `{ blocked }` (QA-FIX S5/M8: refused by type, name, size, the safety check or the
 * virus scan) ends the row `blocked`, with its reason and no Retry.
 */
export function useUploadQueue(
  describeFailure: (error: unknown, file: File) => string | null | { readonly blocked: string },
) {
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
          const described = describeRef.current(error, file);
          if (described !== null && typeof described === 'object') {
            dispatch({ type: 'blocked', id, attempt, reason: described.blocked });
          } else {
            dispatch({ type: 'failed', id, attempt, reason: described });
          }
        }
        return false;
      }
    },
    [],
  );

  /** Start sending `file`; resolves `true` once it is uploaded and attached. */
  const start = useCallback(
    (file: File, run: UploadRun): Promise<boolean> => {
      const id = newRowId();
      dispatch({ type: 'start', id, file });
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

  /** QA-FIX M8: a file refused before it was sent still gets its row, with the reason. */
  const refuse = useCallback((file: File, reason: string) => {
    dispatch({ type: 'refused', id: newRowId(), file, reason });
  }, []);

  return { rows, start, cancel, retry, remove, clearSettled, refuse };
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

/** The percentage bar of one file being sent (also under a chat message's attachment). */
export function UploadBar({ name, percent }: { readonly name: string; readonly percent: number }) {
  const ta = useA6T();
  return (
    <span
      className="tm-upload__bar"
      role="progressbar"
      aria-label={ta('UploadProgress.progressLabel', { name })}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span className="tm-upload__fill" style={{ inlineSize: `${percent}%` }} />
    </span>
  );
}

/** "Uploading · 4.1 of 9.8 MB · 42 %" with its bar, for a file whose send is in flight. */
export function UploadMeter({
  name,
  sent,
  total,
}: {
  readonly name: string;
  readonly sent: number;
  readonly total: number;
}) {
  const ta = useA6T();
  const percent = uploadPercent(sent, total);
  const sizes = sizePair(sent, total);
  return (
    <>
      <UploadBar name={name} percent={percent} />
      <span className="tm-upload__meta">
        <span>
          {ta('UploadProgress.uploading', {
            sent: sizes.sent,
            total: sizes.total,
            unit: ta(`UploadProgress.unit${sizes.unit}`),
            pct: percent,
          })}
        </span>
      </span>
    </>
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

  // QA-FIX M8: every byte is sent but the file is not usable yet — the safety check and the virus
  // scan run now (a few seconds), and the row says so instead of looking stuck at 100 %.
  const checking = row.state === 'uploading' && total > 0 && row.sent >= total;
  const meta =
    row.state === 'uploading'
      ? checking
        ? ta('UploadProgress.checking')
        : ta('UploadProgress.uploading', {
            sent: sizes.sent,
            total: sizes.total,
            unit,
            pct: percent,
          })
      : row.state === 'failed'
        ? (row.reason ?? ta('UploadProgress.stopped', { pct: percent }))
        : row.state === 'blocked'
          ? (row.reason ?? '')
          : ta('UploadProgress.done', { size: `${done.total} ${unit}` });

  return (
    <li className="tm-upload" data-state={row.state}>
      <span className="tm-upload__kind">{fileKind(row.file.name)}</span>
      <span className="tm-upload__info">
        <span className="tm-upload__title">
          <span className="tm-upload__name">{row.file.name}</span>
        </span>
        {row.state === 'done' || row.state === 'blocked' ? null : (
          <UploadBar name={row.file.name} percent={percent} />
        )}
        <span
          className="tm-upload__meta"
          role={row.state === 'failed' || row.state === 'blocked' ? 'alert' : undefined}
        >
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
        {row.state === 'failed' ||
        row.state === 'blocked' ||
        (row.state === 'done' && removableWhenDone) ? (
          <button type="button" className="tm-upload__text" onClick={() => onRemove(row)}>
            {ta('UploadProgress.remove')}
          </button>
        ) : null}
      </span>
    </li>
  );
}
