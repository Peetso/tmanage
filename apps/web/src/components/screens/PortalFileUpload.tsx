'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DragEvent, ReactNode, RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  MAX_ATTACHMENT_BYTES,
  UploadCancelledError,
  UploadFailedError,
  attachmentMimeType,
  uploadPortalProjectFile,
} from '../../lib/api/uploads';
import { sizePair, uploadPercent } from '../../lib/upload-queue';
import { uploadRefusal } from '../chat/pane/Composer';
import { UploadBar } from '../storage/UploadProgress';
import { useA6T } from '../work/DueDatePicker';
import './portal-file-upload.css';

/**
 * 55-14a — a client sends a file to the studio from the portal's Files page (Figma 644:35633).
 *
 * One file at a time, up to 100 MB, through the existing client upload door
 * (`/portal/upload-sessions`, purpose `client_upload`). The server decides: it holds the file to
 * the client's own projects, the blocked-type list, the size limit, the quota and the daily
 * allowance. The checks here only spare the client a wait; a refusal the server gives is shown
 * the same calm way.
 */

export interface PortalUploadProject {
  readonly id: string;
  readonly name: string;
}

/**
 * A refusal shown as a card above the list: too big, a blocked type, a plain failure, or — once
 * the file arrived — blocked by the virus check (`virus`) or refused by the safety check
 * (`refused`: not the type its name says, or something inside it). QA-FIX S4: the last two come
 * from the server's final verdict, so "sent" and a failure are never both said about one file.
 */
export interface PortalUploadProblem {
  readonly id: number;
  readonly kind: 'too_big' | 'blocked' | 'failed' | 'virus' | 'refused';
  readonly name: string;
}

export interface PortalUploading {
  readonly file: File;
  readonly projectId: string;
  readonly sent: number;
}

/** Why a finished upload failed, in the three shapes the page words differently. */
export function problemKind(error: unknown): PortalUploadProblem['kind'] {
  if (error instanceof UploadFailedError && error.reason === 'rejected') {
    return error.blockedReason === 'malware' ? 'virus' : 'refused';
  }
  const refusal = uploadRefusal(error);
  if (refusal !== null) return refusal.reason === 'too_large' ? 'too_big' : 'blocked';
  if (error instanceof ApiRequestError && error.fieldErrors().has('sizeBytes')) return 'too_big';
  return 'failed';
}

/** The local pre-check: the same limit and type list the server applies, before any byte moves. */
export function localProblem(file: File): PortalUploadProblem['kind'] | null {
  if (file.size > MAX_ATTACHMENT_BYTES) return 'too_big';
  if (file.size < 1) return 'failed';
  return attachmentMimeType(file) === null ? 'blocked' : null;
}

export function usePortalFileUpload(
  api: ApiClient,
  organizationSlug: string,
  projects: readonly PortalUploadProject[],
) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const nextProblem = useRef(0);
  const [uploading, setUploading] = useState<PortalUploading | null>(null);
  const [problems, setProblems] = useState<readonly PortalUploadProblem[]>([]);
  const [asking, setAsking] = useState<File | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [sentName, setSentName] = useState<string | null>(null);

  const addProblem = useCallback((kind: PortalUploadProblem['kind'], name: string) => {
    nextProblem.current += 1;
    const problem = { id: nextProblem.current, kind, name };
    setProblems((current) => [problem, ...current].slice(0, 3));
  }, []);

  const send = useCallback(
    async (file: File, projectId: string) => {
      const abort = new AbortController();
      controller.current = abort;
      // QA-FIX S4: a new attempt clears what an earlier one said about the same file.
      setSentName(null);
      setProblems((current) => current.filter((problem) => problem.name !== file.name));
      setUploading({ file, projectId, sent: 0 });
      try {
        // QA-FIX S4: "sent" only once the safety check and the virus scan have passed (or are
        // still running after the wait, when the studio gets it as soon as they pass).
        const fileId = await uploadPortalProjectFile(
          api,
          organizationSlug,
          { projectId, file },
          {
            signal: abort.signal,
            untilReady: true,
            onProgress: (sent) =>
              setUploading((current) => (current?.file === file ? { ...current, sent } : current)),
          },
        ).catch((error: unknown) => {
          if (error instanceof UploadFailedError && error.reason === 'still_checking') return null;
          throw error;
        });
        if (fileId !== null) setFresh((current) => new Set(current).add(fileId));
        setSentName(file.name);
        await queryClient.invalidateQueries({
          queryKey: ['portal-files', organizationSlug, projectId],
        });
      } catch (error) {
        if (!(error instanceof UploadCancelledError) && !abort.signal.aborted) {
          addProblem(problemKind(error), file.name);
        }
      } finally {
        if (controller.current === abort) controller.current = null;
        setUploading((current) => (current?.file === file ? null : current));
      }
    },
    [addProblem, api, organizationSlug, queryClient],
  );

  /** A file picked or dropped: checked here, then sent, or the project asked for first. */
  const take = useCallback(
    (file: File) => {
      if (uploading !== null) return;
      const local = localProblem(file);
      if (local !== null) {
        addProblem(local, file.name);
        return;
      }
      const only = projects.length === 1 ? projects[0] : undefined;
      if (only) void send(file, only.id);
      else if (projects.length > 1) setAsking(file);
    },
    [addProblem, projects, send, uploading],
  );

  const choose = useCallback(() => input.current?.click(), []);

  const chooseAgain = useCallback(
    (problemId: number) => {
      setProblems((current) => current.filter((problem) => problem.id !== problemId));
      choose();
    },
    [choose],
  );

  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setUploading(null);
  }, []);

  const confirmProject = useCallback(
    (projectId: string) => {
      const file = asking;
      setAsking(null);
      if (file) void send(file, projectId);
    },
    [asking, send],
  );

  const picker = <FilePicker inputRef={input} onPick={take} />;

  return {
    picker,
    choose,
    take,
    uploading,
    cancel,
    problems,
    chooseAgain,
    asking,
    confirmProject,
    dismissAsking: () => setAsking(null),
    fresh,
    sentName,
  };
}

function FilePicker({
  inputRef,
  onPick,
}: {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onPick: (file: File) => void;
}) {
  const ta = useA6T();
  return (
    <input
      ref={inputRef}
      type="file"
      className="tm-pt-visually-hidden"
      tabIndex={-1}
      aria-label={ta('PortalFilesScreen.fileInputLabel')}
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) onPick(file);
      }}
    />
  );
}

/** Drag-and-drop over the list: the dashed lime area while a file is held over the page. */
export function useFileDrop(onDrop: (file: File) => void, enabled: boolean) {
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  const holdsFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  return {
    over: over && enabled,
    handlers: {
      onDragEnter: (event: DragEvent) => {
        if (!enabled || !holdsFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setOver(true);
      },
      onDragOver: (event: DragEvent) => {
        if (!enabled || !holdsFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      },
      onDrop: (event: DragEvent) => {
        if (!enabled) return;
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        const file = event.dataTransfer.files[0];
        if (file) onDrop(file);
      },
    },
  };
}

export function DropArea({ projectName }: { readonly projectName: string | null }) {
  const ta = useA6T();
  return (
    <div className="tm-pfu-drop" aria-hidden="true">
      <span className="tm-pfu-drop__arrow">↓</span>
      <p className="tm-pfu-drop__title">
        {ta('PortalFilesScreen.dropTitle', {
          project: projectName ?? ta('PortalFilesScreen.dropYourProject'),
        })}
      </p>
      <p className="tm-pfu-drop__hint">{ta('PortalFilesScreen.dropHint')}</p>
    </div>
  );
}

/** "Files can be up to 100 MB … or send <studio> a message." with the link in its place. */
function withLink(text: string, link: ReactNode): ReactNode {
  const at = text.indexOf('{link}');
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      {link}
      {text.slice(at + '{link}'.length)}
    </>
  );
}

export function UploadProblemCard({
  problem,
  organizationSlug,
  providerName,
  onChooseAgain,
}: {
  readonly problem: PortalUploadProblem;
  readonly organizationSlug: string;
  readonly providerName: string;
  readonly onChooseAgain: (problemId: number) => void;
}) {
  const ta = useA6T();
  const titleKey = {
    too_big: 'PortalFilesScreen.tooBigTitle',
    blocked: 'PortalFilesScreen.blockedTitle',
    failed: 'PortalFilesScreen.failedTitle',
    virus: 'PortalFilesScreen.virusTitle',
    refused: 'PortalFilesScreen.blockedTitle',
  }[problem.kind];
  const body =
    problem.kind === 'too_big'
      ? withLink(
          ta('PortalFilesScreen.tooBigBody'),
          <Link className="tm-pfu-problem__link" href={`/${organizationSlug}/portal/chat`}>
            {ta('PortalFilesScreen.tooBigLink', { studio: providerName })}
          </Link>,
        )
      : problem.kind === 'blocked'
        ? `${ta('PortalFilesScreen.blockedBody')} ${ta('UploadOutcome.accepted')}`
        : problem.kind === 'virus'
          ? ta('PortalFilesScreen.virusBody', { studio: providerName })
          : problem.kind === 'refused'
            ? ta('PortalFilesScreen.refusedBody')
            : ta('PortalFilesScreen.failedBody');
  return (
    <div className="tm-pfu-problem" role="alert">
      <span className="tm-pfu-problem__glyph" aria-hidden="true">
        !
      </span>
      <div className="tm-pfu-problem__text">
        <p className="tm-pfu-problem__title">{ta(titleKey, { name: problem.name })}</p>
        <p className="tm-pfu-problem__body">{body}</p>
      </div>
      <button
        type="button"
        className="tm-pt-btn tm-pt-btn--quiet tm-pfu-problem__again"
        onClick={() => onChooseAgain(problem.id)}
      >
        {ta('PortalFilesScreen.chooseAnother')}
      </button>
    </div>
  );
}

/** The row of the file being sent: name, "Uploading · 14.2 of 31.0 MB", the bar, Cancel. */
export function UploadingRow({
  uploading,
  projectName,
  onCancel,
}: {
  readonly uploading: PortalUploading;
  readonly projectName: string;
  readonly onCancel: () => void;
}) {
  const ta = useA6T();
  const { file, sent } = uploading;
  const sizes = sizePair(sent, file.size);
  const percent = uploadPercent(sent, file.size);
  // QA-FIX S4: all bytes are sent; the safety check and virus scan decide before "sent" is said.
  const checking = file.size > 0 && sent >= file.size;
  return (
    <tr className="tm-pfu-row tm-pfu-row--uploading">
      <td className="tm-pfu-cell--file">
        <p className="tm-pt-file__name">{file.name}</p>
        <p className="tm-pt-mono">
          {checking
            ? ta('UploadProgress.checking')
            : ta('PortalFilesScreen.uploadingMeta', {
                sent: sizes.sent,
                total: sizes.total,
                unit: ta(`UploadProgress.unit${sizes.unit}`),
              })}
        </p>
      </td>
      <td className="tm-pfu-cell--project">{projectName}</td>
      <td className="tm-pfu-cell--progress" colSpan={3}>
        <span className="tm-pfu-progress">
          <UploadBar name={file.name} percent={percent} />
          <span className="tm-pt-mono">{percent} %</span>
        </span>
      </td>
      <td className="tm-pfu-cell--actions">
        <button
          type="button"
          className="tm-pt-btn tm-pt-btn--quiet"
          aria-label={ta('PortalFilesScreen.cancelUploadLabel', { name: file.name })}
          onClick={onCancel}
        >
          {ta('PortalFilesScreen.cancelUpload')}
        </button>
      </td>
    </tr>
  );
}

/** "Which project?" — only when the client has more than one project. */
export function WhichProjectDialog({
  file,
  projects,
  onUpload,
  onCancel,
}: {
  readonly file: File;
  readonly projects: readonly PortalUploadProject[];
  readonly onUpload: (projectId: string) => void;
  readonly onCancel: () => void;
}) {
  const ta = useA6T();
  const titleId = useId();
  const selectId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open && typeof node.showModal === 'function') node.showModal();
  }, []);
  const sizes = sizePair(file.size, file.size);
  return (
    <dialog
      ref={dialog}
      className="tm-pfu-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <form
        noValidate
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (projectId) onUpload(projectId);
        }}
      >
        <h2 id={titleId} className="tm-pfu-dialog__title">
          {ta('PortalFilesScreen.dialogTitle')}
        </h2>
        <p className="tm-pfu-dialog__file">
          <span>{file.name}</span>{' '}
          <span className="tm-pt-mono">
            {sizes.total} {ta(`UploadProgress.unit${sizes.unit}`)}
          </span>
        </p>
        <label className="tm-pfu-dialog__label" htmlFor={selectId}>
          {ta('PortalFilesScreen.whichProject')}
        </label>
        <select
          id={selectId}
          className="tm-pfu-dialog__select"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <div className="tm-pfu-dialog__actions">
          <button type="submit" className="tm-pt-btn tm-pt-btn--ink">
            {ta('PortalFilesScreen.dialogUpload')}
          </button>
          <button type="button" className="tm-pt-btn tm-pt-btn--quiet" onClick={onCancel}>
            {ta('PortalFilesScreen.dialogCancel')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
