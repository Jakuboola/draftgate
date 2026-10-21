/**
 * The editor's controls: one table, one button, one state subscription, shared by `Toolbar.tsx` and
 * `BubbleToolbar.tsx` so the labels, glyphs, command chains and the `onMouseDown` selection guard
 * live once. Keyed by the `ToolbarMark`/`ToolbarBlock` unions, so a capability with no control here
 * is a compile error rather than a throw inside the window's render.
 */

import { useEditorState, type Editor as TiptapEditor } from '@tiptap/react';
import type { ReactElement } from 'react';
import {
  Bold,
  Italic,
  Strikethrough,
  CodeXml,
  Link as LinkIcon,
  Smile,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  SquareCode,
  Table as TableIcon,
  Minus,
  Undo2,
  Redo2,
  type LucideIcon,
} from 'lucide-react';
import type { ToolbarBlock, ToolbarMark } from '../../core/src/index';

/*
 * Icons: Lucide (ISC), bundled. Slack and Linear publish no icon package, and Atlassian's
 * (`@atlaskit/icon`) would drag `@atlaskit/tokens`, `@atlaskit/tile` and `@compiled/react` into a
 * bundle that has zero `@atlaskit`. Toolbar icons are chrome, so one set serves all four
 * destinations; the destination idiom comes through the colour tokens. Every glyph goes through
 * `ico()`, which sets one size and stroke for both toolbars, and `Glyph` is branded so a letterform
 * (`node: 'B'`) is a compile error. `surface/harness/probe.ts` also counts one `<svg>` per button.
 * The elements are built once at module load, not per render.
 */
declare const GLYPH_BRAND: unique symbol;

/** A toolbar glyph: an element `ico()` produced, and nothing else (the cast there is the one assertion). */
export type Glyph = ReactElement & { readonly [GLYPH_BRAND]: true };

export const ico = (Icon: LucideIcon, size = 16): Glyph =>
  (<Icon size={size} strokeWidth={1.75} aria-hidden focusable="false" />) as Glyph;

/**
 * A button's face: everything `ToolbarButton` reads. Split from `Control` because a popover control
 * has no command. `active`, `disabled` and `onRun` are props: the caller knows what clicking does.
 */
export interface ControlFace {
  label: string;
  node: Glyph;
}

/** A face plus the command behind it. Only these go into `ALL_CONTROLS`'s state subscription. */
export interface Control extends ControlFace {
  /** What `isActive` is asked about, when it differs from the key. Absent: not a toggle (Undo, Redo). */
  activeAs?: string;
  run: (e: TiptapEditor) => void;
  can: (e: TiptapEditor) => boolean;
}

/*
 * `can()` without `.chain().focus()`: it runs for every control on every transaction, selection
 * changes included. Each `.chain()` builds a second command map (100+ closures) and `focus` in a
 * can-chain is always `true`, so dropping it roughly halves the work.
 */
const MARK_ENTRIES: [Exclude<ToolbarMark, 'link'>, Control][] = [
  ['bold', { label: 'Bold', node: ico(Bold), activeAs: 'bold',
    run: (e) => e.chain().focus().toggleBold().run(), can: (e) => e.can().toggleBold() }],
  ['italic', { label: 'Italic', node: ico(Italic), activeAs: 'italic',
    run: (e) => e.chain().focus().toggleItalic().run(), can: (e) => e.can().toggleItalic() }],
  ['strike', { label: 'Strikethrough', node: ico(Strikethrough), activeAs: 'strike',
    run: (e) => e.chain().focus().toggleStrike().run(), can: (e) => e.can().toggleStrike() }],
  // `CodeXml` is the `</>` shape, and stays distinct from `SquareCode` below: bare chevrons for the
  // inline mark, boxed ones for the block.
  ['code', { label: 'Inline code', node: ico(CodeXml), activeAs: 'code',
    run: (e) => e.chain().focus().toggleCode().run(), can: (e) => e.can().toggleCode() }],
];

/**
 * The two controls that open a popover rather than run a command, so `ControlFace`. `link` is here
 * because both toolbars draw it and would drift; `emoji` sits beside it. Each toolbar supplies its
 * own `onRun`.
 */
export const LINK_CONTROL: ControlFace = { label: 'Link', node: ico(LinkIcon) };
export const EMOJI_CONTROL: ControlFace = { label: 'Emoji', node: ico(Smile) };

export const MARK_CONTROLS = Object.fromEntries(MARK_ENTRIES) as Record<
  Exclude<ToolbarMark, 'link'>,
  Control
>;

/** Fixed, so the selector does not rebuild it per run. */
const TABLE_SHAPE = { rows: 3, cols: 3, withHeaderRow: true };

export const BLOCK_CONTROLS: Record<ToolbarBlock, Control> = {
  bulletList: { label: 'Bulleted list', node: ico(List), activeAs: 'bulletList',
    run: (e) => e.chain().focus().toggleBulletList().run(), can: (e) => e.can().toggleBulletList() },
  orderedList: { label: 'Numbered list', node: ico(ListOrdered), activeAs: 'orderedList',
    run: (e) => e.chain().focus().toggleOrderedList().run(), can: (e) => e.can().toggleOrderedList() },
  taskList: { label: 'Task list', node: ico(ListTodo), activeAs: 'taskList',
    run: (e) => e.chain().focus().toggleTaskList().run(), can: (e) => e.can().toggleTaskList() },
  blockquote: { label: 'Quote', node: ico(Quote), activeAs: 'blockquote',
    run: (e) => e.chain().focus().toggleBlockquote().run(), can: (e) => e.can().toggleBlockquote() },
  codeBlock: { label: 'Code block', node: ico(SquareCode), activeAs: 'codeBlock',
    run: (e) => e.chain().focus().toggleCodeBlock().run(), can: (e) => e.can().toggleCodeBlock() },
  // `insertTable`'s can-probe builds a 3x3 table (~22 nodes) per keystroke to return `true`
  // unconditionally (its body sits behind `if (dispatch)`), so the constant is stated.
  table: { label: 'Table', node: ico(TableIcon), activeAs: 'table',
    run: (e) => e.chain().focus().insertTable(TABLE_SHAPE).run(), can: () => true },
  rule: { label: 'Divider', node: ico(Minus), activeAs: 'horizontalRule',
    run: (e) => e.chain().focus().setHorizontalRule().run(), can: (e) => e.can().setHorizontalRule() },
};

/**
 * Undo and redo are not a profile capability: they produce nothing the destination sees, so they are
 * universal, and not toggles (no `activeAs`).
 */
export const HISTORY_CONTROLS: Record<string, Control> = {
  undo: { label: 'Undo', node: ico(Undo2),
    run: (e) => e.chain().focus().undo().run(), can: (e) => e.can().undo() },
  redo: { label: 'Redo', node: ico(Redo2),
    run: (e) => e.chain().focus().redo().run(), can: (e) => e.can().redo() },
};

/** Built once. Rebuilding it inside the selector would cost three `Object.values` calls per run. */
const ALL_CONTROLS: [string, Control][] = [
  ...MARK_ENTRIES,
  ...Object.entries(BLOCK_CONTROLS),
  ...Object.entries(HISTORY_CONTROLS),
];

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6];

/** The heading level the caret sits in, or 0. One walk of `$from`, not six `isActive` probes. */
function headingLevel(e: TiptapEditor): number {
  const { $from } = e.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === 'heading') {
      const level = Number(node.attrs.level);
      return HEADING_LEVELS.includes(level) ? level : 0;
    }
  }
  return 0;
}

export interface ControlState {
  active: Record<string, boolean>;
  enabled: Record<string, boolean>;
  link: boolean;
  /** The level the caret is ACTUALLY in, 1-6 -- never intersected with what a destination draws. */
  heading: number;
}

/*
 * Module scope: `useEditorState`'s memo deps include the selector's identity, so a fresh arrow per
 * render would re-run every `can()` probe on each render as well as each transaction.
 */
const fullSelector = ({ editor: e }: { editor: TiptapEditor | null }): ControlState | null => {
  if (!e) return null;
  const active: Record<string, boolean> = {};
  const enabled: Record<string, boolean> = {};
  for (const [id, c] of ALL_CONTROLS) {
    if (c.activeAs) active[id] = e.isActive(c.activeAs);
    enabled[id] = c.can(e);
  }
  return { active, enabled, link: e.isActive('link'), heading: headingLevel(e) };
};

/** Marks only: what the bubble menu needs, without the block and history probes it does not. */
const markSelector = ({ editor: e }: { editor: TiptapEditor | null }): ControlState | null => {
  if (!e) return null;
  const active: Record<string, boolean> = {};
  for (const [id, c] of MARK_ENTRIES) active[id] = e.isActive(c.activeAs!);
  return { active, enabled: {}, link: e.isActive('link'), heading: 0 };
};

/**
 * Which controls are active and enabled, subscribed rather than read in render: React does not
 * re-render on a pure selection change, so `aria-pressed` and the styling would go stale.
 */
export function useControlState(editor: TiptapEditor | null, marksOnly = false): ControlState | null {
  return useEditorState({ editor, selector: marksOnly ? markSelector : fullSelector });
}

interface ToolbarButtonProps {
  control: ControlFace;
  /** The button's own class, so each toolbar keeps its container's idiom. */
  className: string;
  active?: boolean;
  disabled?: boolean;
  onRun(): void;
}

/**
 * One button, so the selection guard is the component's. `onMouseDown` preventDefault keeps mousedown
 * from collapsing the selection. Per button, not on a container: TipTap attaches a container's
 * `onMouseDown` natively, so a descendant's `stopPropagation` cannot suppress it and the bubble's
 * link field could not be clicked into.
 */
export function ToolbarButton({ control, className, active, disabled, onRun }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={className}
      aria-label={control.label}
      title={control.label}
      // Only for real toggles. Undo and Redo have no `activeAs` and must not claim a pressed state.
      {...(active === undefined ? {} : { 'aria-pressed': active })}
      disabled={disabled}
      onClick={onRun}
      onMouseDown={(e) => e.preventDefault()}
    >
      {control.node}
    </button>
  );
}
