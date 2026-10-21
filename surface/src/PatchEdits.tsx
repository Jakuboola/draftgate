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

import { useLayoutEffect, useMemo, useRef } from 'react';
import { editorDocFor, render, type DestinationName, type ReviewFieldValue } from '../../core/src/index';
import { Editor } from './Editor';

type EditField = Extract<ReviewFieldValue, { kind: 'edit' }>;

export interface PatchEditsProps {
  destination: DestinationName;
  fields: readonly EditField[];
  /** The text on screen for each edit, by path. */
  values: Readonly<Record<string, string>>;
  onChange(field: string, text: string): void;
}

const noop = () => {};

export function PatchEdits({ destination, fields, values, onChange }: PatchEditsProps) {
  return (
    <section className="dg-edits" aria-label="Edits">
      <p className="dg-plain-note">
        Edits to text that already lives at the destination, which draftgate cannot read. This shows
        only what changes, in the order the edits apply: what each one applies at, and its new text,
        which is sent exactly as typed. Each preview draws the new text on its own.
      </p>
      {fields.map((f) => (
        <PatchEditCard
          key={f.field}
          destination={destination}
          field={f}
          value={values[f.field] ?? f.value}
          onChange={onChange}
        />
      ))}
    </section>
  );
}

function PatchEditCard({
  destination,
  field,
  value,
  onChange,
}: {
  destination: DestinationName;
  field: EditField;
  value: string;
  onChange(field: string, text: string): void;
}) {
  const { edit } = field;
  const n = edit.index + 1;
  // An empty replacement removes what it matches; an empty insertion is refused (`patch/empty-text`).
  const deletes = edit.empty === 'deletes' && value === '';
  /*
   * As tall as its text, every line of it: a textarea that scrolls hides characters that are sent.
   * Measured off the element, since wrapped lines count too; set before paint.
   */
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = area.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [value]);
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
        <div key={a.key} className="dg-edit-anchor">
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
      <EditPreview destination={destination} text={value} />
    </div>
  );
}

/**
 * The new text as the destination draws it, read-only. Rebuilt per change of the text: the editor
 * remounts on a new document, which is cheap at the size of an edit.
 */
function EditPreview({ destination, text }: { destination: DestinationName; text: string }) {
  const shown = useMemo(() => {
    if (text.trim() === '') return null;
    const rendered = render(text, destination);
    return { rendered, doc: editorDocFor(rendered, text) };
  }, [destination, text]);
  if (shown === null) return null;
  const { rendered, doc } = shown;
  return (
    <div className="dg-edit-preview" aria-label="Preview">
      <span className="dg-edit-preview-label">Preview</span>
      <Editor
        doc={doc}
        onChange={noop}
        toolbar={rendered.toolbar}
        rendersMedia={rendered.rendersMedia}
        mentions={rendered.mentions}
        codeSpanMarks={rendered.codeSpanMarks}
        readOnly
      />
    </div>
  );
}
