'use client';

import { EditorContent, useEditor } from '@tiptap/react';

import { docExtensions } from './schema-extensions';

/**
 * Read-only view of an `html` document body. The HTML goes through the ProseMirror schema
 * (unknown nodes drop) — never `dangerouslySetInnerHTML`.
 */
export function DocBodyView({ html }: { html: string }) {
  const editor = useEditor(
    {
      editable: false,
      immediatelyRender: false,
      extensions: docExtensions(),
      content: html,
    },
    [html],
  );
  return <EditorContent editor={editor} dir="auto" className="tm-doc-body" />;
}
