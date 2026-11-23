'use client';

import { useMemo, useState } from 'react';
import { InlineAlert } from '@tmanage/ui';
import type { PreviewZip, PreviewZipEntry } from '../../lib/api/file-preview';
import { pluralPhrase } from '../../lib/i18n/plural';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { FormatIcon } from './format-icons';
import { formatSize } from './format-stage-helpers';
import './format-stages.css';
import { withNumerals } from '../../lib/i18n/display-format';

/**
 * V-24 (`467:27472` EN, `467:27847` AR; phone `467:27736` / `467:28107`): what is inside a ZIP.
 * The archive's own table of contents as a folder tree with sizes and dates. Nothing is extracted
 * or served — the line under the title says so — and comments on a ZIP are about the whole
 * package (the rail's general comment box), so this stage takes no pins.
 */

/** Files shown in an open folder before "N more files". */
export const FOLDER_PREVIEW = 3;

export interface ZipNode {
  readonly name: string;
  readonly path: string;
  readonly folder: boolean;
  readonly sizeBytes: number;
  readonly modifiedAt: string | null;
  /** Files anywhere below (folders only). */
  readonly fileCount: number;
  readonly children: readonly ZipNode[];
}

interface MutableNode {
  name: string;
  path: string;
  folder: boolean;
  sizeBytes: number;
  modifiedAt: string | null;
  fileCount: number;
  children: MutableNode[];
}

/** The flat list as a tree: folders first, then files, each by name. */
export function zipTree(entries: readonly PreviewZipEntry[]): readonly ZipNode[] {
  const root: MutableNode = {
    name: '',
    path: '',
    folder: true,
    sizeBytes: 0,
    modifiedAt: null,
    fileCount: 0,
    children: [],
  };
  const folders = new Map<string, MutableNode>([['', root]]);
  const folderFor = (path: string): MutableNode => {
    const existing = folders.get(path);
    if (existing) return existing;
    const parts = path.split('/').filter(Boolean);
    const parent = folderFor(parts.slice(0, -1).join('/'));
    const node: MutableNode = {
      name: parts[parts.length - 1] ?? path,
      path,
      folder: true,
      sizeBytes: 0,
      modifiedAt: null,
      fileCount: 0,
      children: [],
    };
    parent.children.push(node);
    folders.set(path, node);
    return node;
  };
  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    if (entry.folder) {
      folderFor(parts.join('/'));
      continue;
    }
    const parentPath = parts.slice(0, -1).join('/');
    folderFor(parentPath).children.push({
      name: parts[parts.length - 1]!,
      path: parts.join('/'),
      folder: false,
      sizeBytes: entry.sizeBytes,
      modifiedAt: entry.modifiedAt,
      fileCount: 0,
      children: [],
    });
    // Every folder above counts the file and its size.
    for (let depth = parts.length - 1; depth >= 0; depth -= 1) {
      const folder = folders.get(parts.slice(0, depth).join('/'));
      if (folder) {
        folder.fileCount += 1;
        folder.sizeBytes += entry.sizeBytes;
      }
    }
  }
  const sort = (nodes: MutableNode[]): ZipNode[] =>
    nodes
      .sort((a, b) => (a.folder !== b.folder ? (a.folder ? -1 : 1) : a.name.localeCompare(b.name)))
      .map((node) => ({ ...node, children: sort(node.children) }));
  return sort(root.children);
}

function useDateLabel(): (value: string | null) => string {
  const locale = useActiveLocale();
  return (value) => {
    if (!value) return '';
    const date = new Date(`${value}Z`);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(withNumerals(locale), {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }).format(date);
  };
}

function Rows({
  nodes,
  depth,
  open,
  expanded,
  onToggle,
  onExpand,
}: {
  readonly nodes: readonly ZipNode[];
  readonly depth: number;
  readonly open: ReadonlySet<string>;
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (path: string) => void;
  readonly onExpand: (path: string) => void;
}) {
  const t = useT();
  const dateLabel = useDateLabel();
  const indent = { paddingInlineStart: `${12 + depth * 24}px` };
  return (
    <>
      {nodes.map((node) => {
        if (!node.folder) {
          return (
            <li key={node.path} className="tm-zip__row" style={indent}>
              <FormatIcon name="file" />
              <span className="tm-zip__name" dir="auto">
                {node.name}
              </span>
              <span className="tm-zip__size" dir="ltr">
                {formatSize(node.sizeBytes)}
              </span>
              <span className="tm-zip__date">{dateLabel(node.modifiedAt)}</span>
            </li>
          );
        }
        const isOpen = open.has(node.path);
        const files = node.children.filter((child) => !child.folder);
        const subfolders = node.children.filter((child) => child.folder);
        const showAll = expanded.has(node.path) || files.length <= FOLDER_PREVIEW + 1;
        const shown = showAll ? files : files.slice(0, FOLDER_PREVIEW);
        const hidden = files.length - shown.length;
        return (
          <li key={node.path} className="tm-zip__group">
            <button
              type="button"
              className="tm-zip__row tm-zip__row--folder"
              style={{ paddingInlineStart: `${depth * 24}px` }}
              aria-expanded={isOpen}
              onClick={() => onToggle(node.path)}
            >
              <FormatIcon
                name="chevron"
                className={isOpen ? undefined : 'tm-format-icon--closed'}
              />
              <FormatIcon name="folder" />
              <span className="tm-zip__name" dir="auto">
                {node.name}
              </span>
              <span className="tm-zip__count">
                {t(
                  node.fileCount === 1 ? 'ViewerFormats.zip.oneFile' : 'ViewerFormats.zip.files',
                ).replace('{count}', String(node.fileCount))}
              </span>
              <span className="tm-zip__size" dir="ltr">
                {formatSize(node.sizeBytes)}
              </span>
            </button>
            {isOpen ? (
              <ul className="tm-zip__list">
                <Rows
                  nodes={[...subfolders, ...shown]}
                  depth={depth + 1}
                  open={open}
                  expanded={expanded}
                  onToggle={onToggle}
                  onExpand={onExpand}
                />
                {hidden > 0 ? (
                  <li>
                    <button
                      type="button"
                      className="tm-zip__row tm-zip__row--more"
                      style={{ paddingInlineStart: `${12 + (depth + 1) * 24}px` }}
                      onClick={() => onExpand(node.path)}
                    >
                      <FormatIcon name="file" />
                      <span className="tm-zip__name">
                        {t('ViewerFormats.zip.more').replace('{count}', String(hidden))}
                      </span>
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </li>
        );
      })}
    </>
  );
}

export interface ZipListProps {
  readonly zip: PreviewZip;
  /** The ZIP's own size (what a download costs). */
  readonly sizeBytes: number | null;
}

export function ZipList({ zip, sizeBytes }: ZipListProps) {
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const tree = useMemo(() => zipTree(zip.entries), [zip.entries]);
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(tree.filter((node) => node.folder).map((node) => node.path)),
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const flip = (set: ReadonlySet<string>, path: string) => {
    const next = new Set(set);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  };
  const topFolders = tree.filter((node) => node.folder).length;
  // FIX6 item 9 (B12): "1 folder", not "1 folders" — each count in the locale's plural form.
  const files = pluralPhrase(tOr, locale, 'ViewerFormats.zip.fileCount', zip.fileCount, {
    one: '{count} file',
    other: '{count} files',
  });
  const title =
    topFolders === 0
      ? files
      : tOr('ViewerFormats.zip.titleIn', '{files} in {folders}')
          .replace('{files}', files)
          .replace(
            '{folders}',
            pluralPhrase(tOr, locale, 'ViewerFormats.zip.folderCount', topFolders, {
              one: '{count} folder',
              other: '{count} folders',
            }),
          );
  const totals = [
    t('ViewerFormats.zip.unpacked').replace('{size}', formatSize(zip.totalBytes)),
    sizeBytes !== null
      ? t('ViewerFormats.zip.download').replace('{size}', formatSize(sizeBytes))
      : null,
  ].filter(Boolean);

  return (
    <section className="tm-zip" aria-label={t('ViewerFormats.zip.label')}>
      <header className="tm-zip__head">
        <span className="tm-zip__orb" aria-hidden="true">
          <FormatIcon name="folder" />
        </span>
        <h2 className="tm-zip__title">{title}</h2>
        <span className="tm-format-chip">{totals.join(' · ')}</span>
      </header>
      <InlineAlert className="tm-format-notice">{t('ViewerFormats.zip.notice')}</InlineAlert>
      {zip.encrypted ? (
        <InlineAlert tone="warning" className="tm-format-notice">
          {t('ViewerFormats.zip.encrypted')}
        </InlineAlert>
      ) : null}
      <div className="tm-zip__columns" aria-hidden="true">
        <span>{t('ViewerFormats.zip.name')}</span>
        <span>{t('ViewerFormats.zip.size')}</span>
        <span>{t('ViewerFormats.zip.modified')}</span>
      </div>
      {tree.length === 0 ? (
        <p className="tm-zip__empty">{t('ViewerFormats.zip.empty')}</p>
      ) : (
        <ul className="tm-zip__list">
          <Rows
            nodes={tree}
            depth={0}
            open={open}
            expanded={expanded}
            onToggle={(path) => setOpen((current) => flip(current, path))}
            onExpand={(path) => setExpanded((current) => flip(current, path))}
          />
        </ul>
      )}
    </section>
  );
}
