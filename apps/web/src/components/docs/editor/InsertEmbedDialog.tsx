'use client';

import type { Editor } from '@tiptap/core';
import { useState, type FormEvent } from 'react';

import { useTOr } from '../../../lib/i18n/use-t-or';
import { EditorDialog } from './InsertImageDialog';
import { isEmbeddableUrl } from './schema-extensions';
import { normaliseHref } from './SelectionToolbar';

export interface InsertEmbedDialogProps {
  readonly editor: Editor;
  readonly onClose: () => void;
}

/**
 * Embed a link (Figma 486:29019). A Figma, YouTube or Vimeo address (the SPEC §3 host allowlist,
 * the same check the server makes) becomes an embed block that shows the live frame; any other
 * address becomes a link card — the link on its own line, opened in a new tab.
 */
export function InsertEmbedDialog({ editor, onClose }: InsertEmbedDialogProps) {
  const tOr = useTOr();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);

  function insert(event: FormEvent) {
    event.preventDefault();
    const href = normaliseHref(value);
    if (!href || href.startsWith('/') || href.startsWith('mailto:')) {
      setInvalid(true);
      return;
    }
    const chain = editor.chain().focus();
    if (isEmbeddableUrl(href)) chain.insertContent({ type: 'embed', attrs: { url: href } });
    else
      chain.insertContent({
        type: 'paragraph',
        content: [{ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }],
      });
    chain.run();
    onClose();
  }

  return (
    <EditorDialog title={tOr('DocEditor.embedTitle', 'Embed a link')} onClose={onClose}>
      <form noValidate onSubmit={insert} className="tm-doced__embedform">
        <label className="tm-docshare__label" htmlFor="tm-doc-embed-url">
          {tOr('DocEditor.embedLabel', 'Figma, YouTube or Vimeo link')}
        </label>
        <input
          id="tm-doc-embed-url"
          type="text"
          inputMode="url"
          dir="ltr"
          className="tm-doced__input"
          aria-invalid={invalid || undefined}
          placeholder="https://"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
          }}
        />
        {invalid ? (
          <p className="tm-doced__problem" role="alert">
            {tOr('DocEditor.embedInvalid', 'Paste a full web address that starts with https://')}
          </p>
        ) : (
          <p className="tm-docshare__note">
            {tOr(
              'DocEditor.embedNote',
              'Other links are added as a link card that opens in a new tab.',
            )}
          </p>
        )}
        <div className="tm-docshare__actions">
          <button type="button" className="tm-docshare__btn" onClick={onClose}>
            {tOr('DocEditor.cancel', 'Cancel')}
          </button>
          <button type="submit" className="tm-docshare__btn" data-tone="ink">
            {tOr('DocEditor.embedInsert', 'Embed')}
          </button>
        </div>
      </form>
    </EditorDialog>
  );
}
