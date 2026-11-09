'use client';

import type { Editor } from '@tiptap/core';
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react';

import '../doc-share-dialog.css';
import {
  attachmentProblem,
  formatBytes,
  UploadCancelledError,
  UploadFailedError,
} from '../../../lib/api/uploads';
import { useTOr } from '../../../lib/i18n/use-t-or';

/** An uploaded file as the editor references it: its id and its same-site content address. */
export interface UploadedDocFile {
  readonly id: string;
  readonly src: string;
}

interface EditorDialogProps {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/** The editor's small modal (the share dialog's look): Esc and the scrim close it. */
export function EditorDialog({ title, onClose, children }: EditorDialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('input, button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="tm-docshare">
      <div className="tm-docshare__scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={panel}
        className="tm-docshare__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId} className="tm-docshare__title">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

/** FIX4 item 1: say what actually went wrong, not "did not upload" for every failure. */
function uploadProblem(error: unknown, name: string, tOr: ReturnType<typeof useTOr>): string {
  if (error instanceof UploadFailedError) {
    const english: Record<UploadFailedError['reason'], string> = {
      busy: 'TManage was busy and “{name}” did not upload. Try again in a moment.',
      rejected: '“{name}” did not pass the safety check, so it cannot be added.',
      still_checking:
        '“{name}” uploaded and is still being checked for safety. Try again in a minute.',
      refused: '“{name}” could not be uploaded. Try again.',
    };
    return tOr(`DocEditor.upload.${error.reason}`, english[error.reason]).replace('{name}', name);
  }
  return tOr('DocEditor.uploadFailed', 'The file did not upload. Try again.');
}

export interface InsertImageDialogProps {
  readonly editor: Editor;
  readonly mode: 'image' | 'file';
  /** FIX4 item 1: `signal` aborts the upload (and any wait for it) when the dialog closes. */
  readonly onUploadFile: (file: File, signal?: AbortSignal) => Promise<UploadedDocFile>;
  readonly onClose: () => void;
}

/**
 * Insert an image or a file (Figma 486:28834): drop or choose a file, it goes through the project
 * upload, then an image lands as `img[src][data-file-id]` and anything else as a file card — a link
 * to the file with its name and size.
 */
export function InsertImageDialog({ editor, mode, onUploadFile, onClose }: InsertImageDialogProps) {
  const tOr = useTOr();
  const picker = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  // FIX4 item 1: closing the dialog stops the upload and its background polling.
  const uploading = useRef<AbortController | null>(null);
  useEffect(() => () => uploading.current?.abort(), []);

  async function take(file: File | undefined) {
    if (!file || busy) return;
    const refused = attachmentProblem(file);
    if (refused) {
      setProblem(refused);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const controller = new AbortController();
      uploading.current = controller;
      const uploaded = await onUploadFile(file, controller.signal);
      if (controller.signal.aborted) return;
      const chain = editor.chain().focus();
      if (file.type.startsWith('image/') && mode === 'image') {
        chain.insertContent({
          type: 'image',
          attrs: { src: uploaded.src, alt: file.name, fileId: uploaded.id },
        });
      } else {
        chain.insertContent({
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: file.name,
              marks: [{ type: 'link', attrs: { href: uploaded.src } }],
            },
            { type: 'text', text: ` · ${formatBytes(file.size)}` },
          ],
        });
      }
      chain.run();
      onClose();
    } catch (error) {
      if (error instanceof UploadCancelledError || uploading.current?.signal.aborted) return;
      setProblem(uploadProblem(error, file.name, tOr));
      setBusy(false);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setOver(false);
    void take(event.dataTransfer.files[0]);
  }

  return (
    <EditorDialog
      title={
        mode === 'image'
          ? tOr('DocEditor.insertImage', 'Insert an image')
          : tOr('DocEditor.insertFile', 'Attach a file')
      }
      onClose={onClose}
    >
      <div
        className="tm-doced__drop"
        data-over={over ? 'true' : 'false'}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <p>
          {busy
            ? tOr('DocEditor.uploading', 'Uploading…')
            : tOr('DocEditor.dropHere', 'Drop a file here, or choose one.')}
        </p>
        <input
          ref={picker}
          type="file"
          className="tm-visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          accept={mode === 'image' ? 'image/*' : undefined}
          onChange={(event) => void take(event.target.files?.[0])}
        />
        <button
          type="button"
          className="tm-docshare__btn"
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          {tOr('DocEditor.chooseFile', 'Choose file')}
        </button>
      </div>
      {problem ? (
        <p className="tm-doced__problem" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="tm-docshare__actions">
        <button type="button" className="tm-docshare__btn" onClick={onClose}>
          {tOr('DocEditor.cancel', 'Cancel')}
        </button>
      </div>
    </EditorDialog>
  );
}
