/**
 * Before/after for the one-click fix.
 *
 * The fix is offered, never applied silently: auto-sanitising was rejected for cause, because the
 * reviewer would then be approving text the agent did not write without being told. A diff is what
 * makes "one click" honest -- you can see that the sanitiser only ever degrades structure and never
 * drops a word.
 */

import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { collapseUnchanged, lineDiff } from '../../core/src/lineDiff';

export interface FixDiffProps {
  before: string;
  after: string;
  /**
   * What the reviewer chose, shown as the heading.
   *
   * Named rather than fixed, because this preview serves BOTH a blocked draft's
   * whole-document repair and a single warning's -- and when a warning names more than one repair,
   * the heading is the only thing that says which one is about to be applied.
   */
  title: string;
  /** One line saying what this repair does. It differs by fix kind, so it is not hardcoded here. */
  note: string;
  onApply(): void;
  onCancel(): void;
}

export function FixDiff({ before, after, title, note, onApply, onCancel }: FixDiffProps) {
  // `before`/`after` are fixed while the modal is open, but the editor behind it keeps re-rendering
  // the tree this sits in, which would rebuild the LCS table each time.
  const rows = useMemo(() => collapseUnchanged(lineDiff(before, after)), [before, after]);
  const panel = useRef<HTMLDivElement>(null);

  /*
   * Move focus into the dialog, onto the panel and not a button. `aria-modal` does not touch tab
   * order: focus would stay on the repair link behind the backdrop, `.dg-modal` is last in DOM order,
   * and tabbing to "Apply fix" would walk through the editor, whose keystrokes applying then discards.
   * Not the primary button: that would arm Enter on a repair that replaces the document and discards
   * undo history (`App.tsx` keeps `⌘↵` off while a repair is pending). The panel arms nothing.
   */
  useEffect(() => {
    panel.current?.focus();
  }, []);

  /*
   * The trap, on the backdrop so it sees bubbled keystrokes; it only fires while focus is inside
   * (the effect above), so wrapping the two edges keeps Tab in. Escape closes: with Tab trapped,
   * Cancel would otherwise be the only way out.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const stops = [...(panel.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    const edge = event.shiftKey ? stops[0] : stops[stops.length - 1];
    if (stops.length === 0 || document.activeElement !== edge) return;
    event.preventDefault();
    (event.shiftKey ? stops[stops.length - 1] : stops[0])?.focus();
  };

  return (
    <div
      className="dg-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={onKeyDown}
    >
      {/* `tabIndex={-1}` so the effect above can focus it without putting it in the tab cycle. */}
      <div className="dg-modal" ref={panel} tabIndex={-1}>
        <h2>{title}</h2>
        <p className="dg-modal-note">{note}</p>
        <pre className="dg-diff">
          {rows.map((row, i) =>
            row.kind === 'gap' ? (
              <span key={i} className="dg-diff-gap">
                {`  … ${row.count} unchanged line${row.count === 1 ? '' : 's'}\n`}
              </span>
            ) : (
              <span key={i} className={`dg-diff-${row.kind}`}>
                {`${row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' '} ${row.text}\n`}
              </span>
            )
          )}
        </pre>
        <div className="dg-actions">
          <button type="button" className="dg-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="dg-btn dg-btn-primary" onClick={onApply}>
            Apply fix
          </button>
        </div>
      </div>
    </div>
  );
}
