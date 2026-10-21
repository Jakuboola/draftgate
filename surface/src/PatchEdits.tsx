/**
 * A patch, edit by edit: what each operation applies at, read-only, and the text it writes, which the
 * reviewer may change. The payload carries edits against text only the destination holds
 * (`core/src/patch.ts`), so there is no whole message to draw, and the window says so first.
 *
 * The new text is a textarea holding the exact characters, not the editor. A fragment is spliced
 * into a document the window cannot see, and the editor's round trip rewrites one: measured on
 * Linear, it drops the `"\n\n"` that joins a fragment to its neighbours and the space at either end
 * of an inline insertion, and turns `<url>` into `[url](url)`. Characters in, the same characters
 * out, so an untouched edit is sent byte for byte. Below it, a read-only preview draws the text as
 * the destination's stylesheet does.
 *
 * Every label comes from the profile's grammar, through the wire (`PatchEdit`): the window names no
 * operation itself.
 */

import { useDeferredValue, useLayoutEffect, useMemo, useRef } from 'react';
import { editorDocFor, render, type DestinationName, type EditFieldValue } from '../../core/src/index';
import { Editor } from './Editor';
import { EditorBoundary } from './EditorBoundary';

export interface PatchEditsProps {
  destination: DestinationName;
  fields: readonly EditFieldValue[];
  /** The text on screen for each edit, in `fields` order (`App.tsx`'s `liveValue`). */
  values: readonly string[];
  onChange(field: string, text: string): void;
  /**
   * A preview that could not load: each sits in an `EditorBoundary`, and the caller takes the shell,
   * Approve included, as for the body editor (window.md).
   */
  onError(error: Error): void;
}

/** Grow a textarea to its text, wrapped lines included, borders counted. */
function fitToText(el: HTMLTextAreaElement | null): void {
  if (el === null) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

export function PatchEdits({ destination, fields, values, onChange, onError }: PatchEditsProps) {
  // The editor's facts come from the profile, not the text, so one render per destination.
  const facts = useMemo(() => render('', destination), [destination]);
  return (
    <section className="dg-edits" aria-label="Edits">
      <p className="dg-plain-note">
        Edits to text that already lives at the destination, which draftgate cannot read. This shows
        only what changes, in the order the edits apply: what each one applies at, and its new text,
        which is sent exactly as typed. Each preview draws the new text on its own.
      </p>
      {fields.map((f, i) => (
        <PatchEditCard
          key={f.field}
          facts={facts}
          field={f}
          value={values[i]!}
          onChange={onChange}
          onError={onError}
        />
      ))}
    </section>
  );
}

type EditorFacts = ReturnType<typeof render>;

function PatchEditCard({
  facts,
  field,
  value,
  onChange,
  onError,
}: {
  facts: EditorFacts;
  field: EditFieldValue;
  value: string;
  onChange(field: string, text: string): void;
  onError(error: Error): void;
}) {
  const { edit } = field;
  const n = edit.index + 1;
  // An empty replacement removes what it matches; an empty insertion is refused (`patch/empty-text`).
  const deletes = edit.empty === 'deletes' && value === '';
  /*
   * As tall as its text, every line of it: a textarea that scrolls hides characters that are sent.
   * Measured off the element, since wrapped lines count too; set before paint, and again whenever
   * its width changes (a resized window re-wraps the text). Width only: the height is ours.
   */
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => fitToText(area.current), [value]);
  useLayoutEffect(() => {
    const el = area.current;
    if (el === null) return;
    let width = el.clientWidth;
    const watch = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitToText(el);
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return (
    <div className="dg-edit" data-op={edit.op} data-deletes={deletes ? 'true' : undefined}>
      <div className="dg-edit-head">
        <span className="dg-edit-n">{n}</span>
        <span className="dg-edit-op">{deletes ? 'Delete' : edit.label}</span>
        {edit.flags.map((flag) => (
          <span key={flag} className="dg-edit-flag">
            {flag}
          </span>
        ))}
      </div>
      {edit.anchors.map((a) => (
        <div key={a.key} className="dg-edit-anchor" data-kept={a.kept ? 'true' : undefined}>
          <span className="dg-edit-anchor-label">{a.label}</span>
          {/* `title` is the payload key, as a prose field's is its path. */}
          <pre className="dg-edit-anchor-text" title={a.key}>
            {a.value}
          </pre>
        </div>
      ))}
      {edit.note !== undefined && <p className="dg-edit-note">{edit.note}</p>}
      <textarea
        ref={area}
        // One row to start from, so a one-line edit is one line tall; the effect grows it.
        rows={1}
        className="dg-edit-text"
        aria-label={`Edit ${n}: new text`}
        title={field.field}
        placeholder={
          edit.empty === 'deletes'
            ? 'Nothing: the text above is deleted.'
            : 'Empty: the tool refuses an insertion of nothing.'
        }
        value={value}
        spellCheck
        onChange={(e) => onChange(field.field, e.target.value)}
      />
      <EditorBoundary onError={onError}>
        <EditPreview facts={facts} text={value} />
      </EditorBoundary>
    </div>
  );
}

/**
 * The new text as the destination draws it, read-only. The editor remounts on a new document, so the
 * text is deferred: typing stays with the textarea and the preview catches up when React is idle.
 */
function EditPreview({ facts, text: typed }: { facts: EditorFacts; text: string }) {
  const text = useDeferredValue(typed);
  const doc = useMemo(() => (text.trim() === '' ? null : editorDocFor(facts, text)), [facts, text]);
  if (doc === null) return null;
  return (
    <div className="dg-edit-preview" aria-label="Preview">
      <span className="dg-edit-preview-label">Preview</span>
      <Editor
        doc={doc}
        toolbar={facts.toolbar}
        rendersMedia={facts.rendersMedia}
        mentions={facts.mentions}
        codeSpanMarks={facts.codeSpanMarks}
        readOnly
      />
    </div>
  );
}
