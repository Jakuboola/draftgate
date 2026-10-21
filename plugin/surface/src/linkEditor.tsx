/**
 * The URL affordance shared by the bubble menu and the full toolbar's Link button: prefill,
 * validate, refuse or apply. The validation must not exist twice: this is where reviewer input
 * becomes part of the outgoing payload, and `render()` only warns (`href.ts`, `link/unsafe-href`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import { normaliseHref } from './href';

/**
 * What a URL row is for. A second kind of row would differ in these values and nothing else, so it
 * is a second `UrlKind`, not a second component.
 */
export interface UrlKind {
  /** Where the existing value comes from when the row opens. */
  prefill(editor: TiptapEditor): string;
  normalise(raw: string): string | null;
  apply(editor: TiptapEditor, url: string): void;
  placeholder: string;
  label: string;
  refusal: string;
}

export const LINK: UrlKind = {
  prefill: (e) => String(e.getAttributes('link').href ?? ''),
  normalise: normaliseHref,
  apply: (e, href) => e.chain().focus().extendMarkRange('link').setLink({ href }).run(),
  placeholder: 'https://…',
  label: 'Link address',
  refusal: 'Use an http, https or mailto address.',
};

// There is no image kind: draftgate cannot upload (see `ToolbarInsert` in `core/src/profiles/index.ts`).

export function useUrlEditor(editor: TiptapEditor | null, kind: UrlKind) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const open = useCallback(() => {
    setValue(editor ? kind.prefill(editor) : '');
    setEditing(true);
  }, [editor, kind]);

  const apply = useCallback(() => {
    if (!editor) return;
    const url = kind.normalise(value);
    if (url === null) {
      // Refused, not swallowed (`href.ts`).
      inputRef.current?.setCustomValidity(kind.refusal);
      inputRef.current?.reportValidity();
      return;
    }
    kind.apply(editor, url);
    setEditing(false);
  }, [editor, kind, value]);

  const clear = useCallback(() => {
    editor?.chain().focus().extendMarkRange('link').unsetLink().run();
    setEditing(false);
  }, [editor]);

  const cancel = useCallback(() => {
    setEditing(false);
    editor?.chain().focus().run();
  }, [editor]);

  return { kind, editing, value, setValue, inputRef, open, apply, clear, cancel };
}

export type UrlEditor = ReturnType<typeof useUrlEditor>;

export function UrlInput({ url, canRemove }: { url: UrlEditor; canRemove?: boolean }) {
  return (
    <div className="dg-linkrow">
      <input
        ref={url.inputRef}
        className="dg-linkrow-input"
        type="text"
        value={url.value}
        placeholder={url.kind.placeholder}
        aria-label={url.kind.label}
        onChange={(e) => {
          // Clear the refusal, or the field stays `:invalid` for its lifetime and keeps flagging a
          // URL that is now fine.
          e.target.setCustomValidity('');
          url.setValue(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            url.apply();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            url.cancel();
          }
        }}
      />
      <button type="button" className="dg-tb-btn" onClick={url.apply}>
        Apply
      </button>
      {canRemove && (
        <button type="button" className="dg-tb-btn" onClick={url.clear}>
          Remove
        </button>
      )}
    </div>
  );
}
