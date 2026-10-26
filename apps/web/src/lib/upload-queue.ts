import type { UploadDestination } from './api/uploads';

/**
 * The rows of the upload progress list (Figma 409:6602): one per file being sent, with how many
 * bytes have gone, and whether it is still going, stopped or done. Pure, so cancel and retry are
 * provable without a browser; `UploadProgress.tsx` drives it with `useReducer`.
 *
 * Every row carries an `attempt`. A retry starts a new attempt, and progress or an outcome from an
 * older attempt (a cancelled transfer still settling) is ignored, so a late event cannot flip a
 * fresh row to "stopped" or "done".
 */
export interface UploadRow {
  readonly id: string;
  readonly file: File;
  readonly destination: UploadDestination;
  readonly sent: number;
  readonly state: 'uploading' | 'failed' | 'done';
  /** Why it stopped, in words; `null` means the connection dropped (the design's Retry line). */
  readonly reason: string | null;
  readonly attempt: number;
  /** What the finished upload created (an attachment's id), so the list can show it once. */
  readonly resultId: string | null;
}

export type UploadAction =
  | {
      readonly type: 'start';
      readonly id: string;
      readonly file: File;
      readonly destination: UploadDestination;
    }
  | {
      readonly type: 'progress';
      readonly id: string;
      readonly attempt: number;
      readonly sent: number;
    }
  | {
      readonly type: 'failed';
      readonly id: string;
      readonly attempt: number;
      readonly reason: string | null;
    }
  | {
      readonly type: 'done';
      readonly id: string;
      readonly attempt: number;
      readonly resultId: string | null;
    }
  | { readonly type: 'retry'; readonly id: string }
  | { readonly type: 'remove'; readonly id: string }
  | { readonly type: 'clear-settled' };

export function uploadRowsReducer(
  rows: readonly UploadRow[],
  action: UploadAction,
): readonly UploadRow[] {
  switch (action.type) {
    case 'start':
      return [
        ...rows,
        {
          id: action.id,
          file: action.file,
          destination: action.destination,
          sent: 0,
          state: 'uploading',
          reason: null,
          attempt: 0,
          resultId: null,
        },
      ];
    case 'remove':
      return rows.filter((row) => row.id !== action.id);
    case 'clear-settled':
      return rows.filter((row) => row.state === 'uploading');
    case 'retry':
      return rows.map((row) =>
        row.id === action.id && row.state === 'failed'
          ? { ...row, state: 'uploading', sent: 0, reason: null, attempt: row.attempt + 1 }
          : row,
      );
    default:
      return rows.map((row) => {
        if (row.id !== action.id || row.attempt !== action.attempt || row.state !== 'uploading') {
          return row;
        }
        if (action.type === 'progress') return { ...row, sent: Math.max(row.sent, action.sent) };
        if (action.type === 'failed') return { ...row, state: 'failed', reason: action.reason };
        return { ...row, state: 'done', sent: row.file.size, resultId: action.resultId };
      });
  }
}

/** Whole percent sent, never above 100. */
export function uploadPercent(sent: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.floor((sent * 100) / total));
}

/**
 * `4.1 of 9.8 MB`: both figures in the total's unit, so the line reads as one measure.
 * Answers the numbers and the unit's key; the screen words the unit for the locale.
 */
export function sizePair(
  sent: number,
  total: number,
): { readonly sent: string; readonly total: string; readonly unit: 'B' | 'KB' | 'MB' } {
  if (total < 1024) return { sent: String(sent), total: String(total), unit: 'B' };
  const divisor = total < 1024 * 1024 ? 1024 : 1024 * 1024;
  const show = (bytes: number) => {
    const value = bytes / divisor;
    return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  };
  return { sent: show(sent), total: show(total), unit: divisor === 1024 ? 'KB' : 'MB' };
}
