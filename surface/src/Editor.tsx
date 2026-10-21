/**
 * The one TipTap editor, shared by all four destinations. The canonical form is markdown with a
 * constrained vocabulary, every node of which maps 1:1 to a TipTap node; destination differences are
 * CSS, applied by `data-destination` on the root.
 *
 * The editor can hold more than markdown expresses: TipTap's schema is more permissive than GFM, and
 * `fromEditorDoc` serialises the result without complaint. Measured, document in -> markdown out:
 *
 *   taskItem > [paragraph, blockquote]   ->  "- [ ] x> quoted"      the two runs are concatenated;
 *                                            the quote is gone and the line re-parses as text
 *   tableCell > bulletList               ->  "| - a |\n| --- |"      the list flattens into the
 *                                            cell and the row becomes the header
 *   listItem > heading                   ->  "- ## H"
 *
 * The first is reachable (`TaskItem` is `nested: true` with content `paragraph block*`: Enter in a
 * task item, then a blockquote). `core/test/editor.test.ts` pins all three. The extension set stays
 * permissive and the window warns instead: `core/src/editor.ts`'s `lostInMarkdown` re-parses the
 * serialised markdown and `render()` turns a lost structure into a blocking `body/structure-lost`,
 * which disables Approve. One mechanism covers every shape. `surface/window.test.tsx` pins the
 * wiring, including that `⌘↵` refuses too.
 *
 * The extension set is the vocabulary and nothing more: heading, paragraph, table, lists, task
 * lists, blockquote, code block, rule, hard break, image, and text with strong/em/code/strike/link
 * plus mention. `underline` is off because markdown has no underline, though the destinations do.
 * Probed:
 *  - Jira renders the mark (`<ins>`); Linear accepts `{"type":"underline"}` into `bodyData`.
 *  - Each vendor's own markdown serialiser drops it: after writing an underline mark into a Linear
 *    comment, `body` came back with `**BOLDCTL**` intact and the underlined run flattened to text.
 *  - draftgate is markdown end to end (`editorDocToAdf` is exported and never called).
 * Enabled, `fromEditorDoc` would drop the mark, `edited` would stay false and approving would send the
 * original bytes while the reviewer looked at an underline.
 *
 * `link.openOnClick` is off: a click puts the cursor in the link (the host denies navigation anyway).
 * `linkTarget.tsx` shows where the link goes, because the text can name a different host.
 */

import { useEffect } from 'react';
import { EditorContent, Extension, useEditor, type JSONContent } from '@tiptap/react';
import type { Extensions } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { BubbleToolbar } from './BubbleToolbar';
import { LinkTarget, LinkTitles } from './linkTarget';
import { Toolbar } from './Toolbar';
import StarterKit from '@tiptap/starter-kit';
import { Code } from '@tiptap/extension-code';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Image } from '@tiptap/extension-image';
import { deferredImage, isRemoteImage } from './deferredImage';
import { LostHighlight, rangeOfPath, setHighlight, HIGHLIGHT_MS } from './lostHighlight';
import { TableKit } from '@tiptap/extension-table';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Mention } from '@tiptap/extension-mention';
import { createLowlight, common } from 'lowlight';
import { pmMarkName, TOOLBAR_MARKS } from '../../core/src/index';
import type { CodeSpanMarks, PmNode, ToolbarSupport } from '../../core/src/index';
import { CODE_MARK_COMBINES_WITH } from '../../core/src/adfSchema';
import { mentionPills } from './mentionPills';
import { NO_MENTIONS, type MentionSupport } from '../../core/src/mentionTokens';

const lowlight = createLowlight(common);

/**
 * `data-language` on the `<pre>` so CSS can print a language label where the destination draws one
 * (Slack does; Jira's reader does not, only its editor's language picker), and the `language-x` class
 * for the highlight palette. One function for both paths: `renderHTML` (serialisation, clipboard) and
 * the node view below (live DOM) must agree, and only the node view is probed.
 */
function codeAttrs(node: { attrs?: Record<string, unknown> }) {
  const lang = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
  return { language: lang, dataLanguage: lang || null, className: lang ? `language-${lang}` : null };
}

const CodeBlock = CodeBlockLowlight.extend({
  renderHTML({ node, HTMLAttributes }) {
    const { dataLanguage, className } = codeAttrs(node);
    return [
      'pre',
      { ...HTMLAttributes, 'data-language': dataLanguage },
      ['code', { class: className }, 0],
    ];
  },

  /**
   * Line numbers, in a gutter beside the code. MEASURED: Slack renders a fenced block with a
   * language label, highlighting and numbered lines (a self-DM probe), so the column is fidelity.
   * A node view is the only way: `renderHTML` emits one `<pre><code>` with no per-line element for a
   * CSS counter. The gutter is safe inside an editable node because `contentDOM` is the `<code>`, the
   * gutter is `contenteditable=false` and `aria-hidden`, and `ignoreMutation` claims mutations inside
   * it (repainting would otherwise read as an external edit). Rendered for every destination, hidden
   * unless its sheet opts in; `shell.css` says which have.
   */
  addNodeView() {
    return ({ node }) => {
      // The type name, not the node: capturing `node` would keep its original content reachable for
      // the life of the view.
      const typeName = node.type.name;
      const dom = document.createElement('pre');
      const gutter = document.createElement('span');
      const code = document.createElement('code');

      gutter.className = 'dg-linenos';
      gutter.setAttribute('aria-hidden', 'true');
      gutter.contentEditable = 'false';
      dom.append(gutter, code);

      // Write an attribute only when it changes: `setAttribute` queues a MutationRecord even for the
      // same value, and `ignoreMutation` claims only the gutter, so ProseMirror would re-read the
      // block from the DOM on every keystroke.
      const setAttr = (el: Element, name: string, value: string | null) => {
        if (value === null) {
          if (el.hasAttribute(name)) el.removeAttribute(name);
        } else if (el.getAttribute(name) !== value) {
          el.setAttribute(name, value);
        }
      };

      const paint = (n: typeof node) => {
        const { dataLanguage, className } = codeAttrs(n);
        setAttr(dom, 'data-language', dataLanguage);
        setAttr(code, 'class', className);
        // `textContent` of the node, not of the DOM (mid-update, and decorated). Counted with
        // `indexOf`: `split('\n')` would allocate ~200 substrings per keystroke for a pasted snippet.
        const text = n.textContent ?? '';
        let lines = 1;
        for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lines++;
        if (gutter.childElementCount === lines) return;
        // One element per line: measured, a newline-joined string computes `white-space: normal`
        // in the gutter and every number renders on one line.
        gutter.replaceChildren(
          ...Array.from({ length: lines }, (_, i) => {
            const el = document.createElement('span');
            el.textContent = String(i + 1);
            return el;
          })
        );
      };

      paint(node);

      return {
        dom,
        contentDOM: code,
        update: (updated) => {
          if (updated.type.name !== typeName) return false;
          paint(updated);
          return true;
        },
        ignoreMutation: (mutation) =>
          gutter === mutation.target || gutter.contains(mutation.target as Node),
      };
    };
  },
}).configure({ lowlight });

/**
 * `Image`, but a remote one is not fetched until the reviewer asks: an `<img src="https://…">` in a
 * draft is a GET to a host the agent chose, and a URL can carry data out (`deferredImage.ts` has the
 * argument). A node view, because the placeholder becomes a real `<img>` on click. `data:` and
 * `blob:` sources render plainly: no request to defer. The node's name, attributes and schema are
 * unchanged, so `core`'s mapping and the goldens are unaffected.
 */
const DeferredImage = Image.extend({
  addNodeView() {
    return ({ node }) => {
      const src = typeof node.attrs.src === 'string' ? node.attrs.src : '';
      const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : '';
      if (!isRemoteImage(src)) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = alt;
        return { dom: img };
      }
      return { dom: deferredImage({ src, alt }) };
    };
  },
});

/**
 * `Mod-Enter` is Approve's (`App.tsx`), not HardBreak's. Without this one keystroke inserts a `<br>`
 * and then approves (`surface/window.test.tsx`: `<p>Plain text.</p>` -> `<p><br>Plain text.</p>`).
 * The sent body would stay right only because React batches `onUpdate` past the event, which is
 * undocumented, so the collision is removed. Priority above HardBreak's 100 and `() => true` stop
 * the insert; the event still bubbles to the window listener. `Shift-Enter` still inserts a break.
 */
export const ApproveShortcutOwnsModEnter = Extension.create({
  name: 'approveShortcutOwnsModEnter',
  priority: 1000,
  addKeyboardShortcuts: () => ({ 'Mod-Enter': () => true }),
});

/**
 * Keep the caret out from under the pinned toolbar.
 *
 * ProseMirror scrolls the selection into view by measuring it against each ancestor's box.
 * `.dg-toolbar` is sticky at the top of `.dg-body` (`shell.css`), so a line under it already counts
 * as visible and the reviewer types into a line they cannot see. `scrollThreshold` and
 * `scrollMargin` move every ancestor's top edge down by the toolbar's height (the other sides are
 * ProseMirror's defaults, 0 and 5). The height is read in `handleScrollToSelection`, which returns
 * `false` so ProseMirror scrolls as usual: it is current when the toolbar wraps or the link row opens.
 */
const PinnedToolbarClearance = Extension.create({
  name: 'pinnedToolbarClearance',
  addProseMirrorPlugins() {
    let clearance = 0;
    return [
      new Plugin({
        props: {
          handleScrollToSelection(view) {
            // The toolbar `Editor` renders beside its own `EditorContent`, below.
            const content = view.dom.closest('.draftgate-editor');
            clearance =
              content?.parentElement?.querySelector<HTMLElement>(':scope > .dg-toolbar')?.offsetHeight ?? 0;
            return false;
          },
          scrollThreshold: { get top() { return clearance; }, right: 0, bottom: 0, left: 0 },
          scrollMargin: { get top() { return clearance + 5; }, right: 5, bottom: 5, left: 5 },
        },
      }),
    ];
  },
});

/**
 * The `code` mark, in the two shapes the two document models need.
 *
 * TipTap's `Code` ships `excludes: '_'` (every other mark), so `strong` cannot sit on a code span
 * whatever the ADF says: marks the converter carries are dropped again by this schema on load.
 * `.extend()`, not an `extendMarkSchema` extension: read out of `@tiptap/core` 3.31.3, `getSchema`
 * writes `excludes` over that hook's result, so the hook cannot reach it and silently does nothing.
 * That is why `@tiptap/extension-code` is a direct dependency (StarterKit does not re-export it);
 * `code: false` below hands the mark to this file.
 *
 * `RenderResult.codeSpanMarks === 'any'` selects this mark; otherwise `RestrictedCode` below is used
 * (Jira). The send is safe either way (`convert()` re-strips and
 * `jira/code-span-emphasis-lost` discloses it), but the exclusion makes Bold across a code span bold
 * the words and leave the span, which is what Jira renders.
 */
const CombinableCode = Code.extend({ excludes: '' });

/**
 * What a code span may not carry where ADF's rule applies, derived from `TOOLBAR_MARKS` and the
 * probed `CODE_MARK_COMBINES_WITH` (`pmMarkName` maps ADF spelling to TipTap's). `'_'` is one mark
 * too many: ADF's `code` combines with `link` (probed 201), `[`x`](url)` is ordinary agent markdown,
 * and under `'_'` it is `Invalid collection of marks for node text: link,code`, so
 * `enableContentCheck` would send the draft to `EditorBoundary` (reject-only) on a body Jira accepts.
 * `surface/schema.test.ts` pins the string.
 */
const CODE_COMBINES = [...CODE_MARK_COMBINES_WITH].map(pmMarkName);
export const CODE_EXCLUDES = TOOLBAR_MARKS.filter(
  (mark) => mark !== 'code' && !CODE_COMBINES.includes(mark)
).join(' ');
const RestrictedCode = Code.extend({ excludes: CODE_EXCLUDES });

/**
 * How a link was spelled in the draft, on the link mark: `core`'s converter sets `angle` on Slack's
 * `<url|label>` and `<url>`, and the writer spells it back (`writeAngleLink`); `setLink` merges into
 * the mark's attributes, so an edited address keeps the spelling. Declared because ProseMirror drops
 * a mark attribute its schema does not name (`surface/schema.test.ts` asserts the body that comes
 * out). Drawn as `data-angle`, never read back from HTML: a pasted link is ordinary everywhere.
 */
const AngleLinkSpelling = Extension.create({
  name: 'draftgateAngleLinkSpelling',
  addGlobalAttributes() {
    return [
      {
        types: ['link'],
        attributes: {
          angle: {
            default: null,
            parseHTML: () => null,
            renderHTML: (attributes) => (attributes.angle ? { 'data-angle': attributes.angle } : {}),
          },
        },
      },
    ];
  },
});

const BASE_EXTENSIONS = [
  ApproveShortcutOwnsModEnter,
  StarterKit.configure({
    codeBlock: false, // replaced by the highlighting variant above
    code: false, // registered per destination -- see `CombinableCode`
    underline: false, // outside the vocabulary -- see the header
    link: { openOnClick: false, autolink: false },
  }),
  AngleLinkSpelling,
  CodeBlock,
  // Inline, as markdown's image is: a block `image` makes `heading > [text, image]` and
  // `taskItem > [text, image]` invalid, which loads without a content check and then throws out of
  // the MutationObserver on the first edit nearby (no transaction: no `edited`, and Approve sends the
  // pre-edit body). `core/src/prosemirror.ts` maps a block-position media to `paragraph > image`.
  DeferredImage.configure({ inline: true, allowBase64: true }),
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit.configure({ table: { resizable: true } }),
  // Rendered, not suggested: mentions arrive resolved, and autocomplete would need a directory this
  // window cannot reach (`connect-src 'none'`). `allow: () => false` stops `@` opening an empty popup.
  Mention.configure({ suggestion: { allow: () => false } }),
  // Draws where a warning points; no transaction touches the document (`lostHighlight.ts`).
  LostHighlight,
  // Every link's target as its hover title, without touching the document.
  LinkTitles,
  PinnedToolbarClearance,
];

/**
 * One extension set per mention descriptor, built once. Not to stop remounts (read out of
 * `@tiptap/react`: `Editor` passes `[doc]`, so remounts follow `doc` alone, and `useReview` replaces
 * it only on an applied fix) but to avoid spreading `BASE_EXTENSIONS` into fresh `Extension` objects
 * on every keystroke. Keyed on the descriptor's identity, sound because each is a module constant
 * (a profile's `mentions`, or `NO_MENTIONS`), so the map is bounded and retains no editor or scope.
 */
const BY_MENTIONS = new WeakMap<object, Map<string, Extensions>>();

/**
 * The extensions for one destination: the editor's vocabulary, derived from the profile and exported
 * so `surface/schema.test.ts` can build the schema and check it against `core`'s `PM_KNOWN` (a type
 * with no extension makes ProseMirror throw on load, `EditorBoundary` catches it and the window
 * degrades to reject-only). Not a module constant: with `Image` registered for a destination that
 * draws no picture, an HTML paste could put a node there that nothing else expects. With none
 * registered `enableContentCheck` makes the absence loud.
 */
export function editorExtensions(
  rendersMedia: boolean,
  /** `RenderResult.mentions`. Optional: the pill extension adds no node or mark, so no schema change. */
  mentions: MentionSupport = NO_MENTIONS,
  /** `RenderResult.codeSpanMarks`. Required: it changes the schema, so a default would decide silently. */
  codeSpanMarks: CodeSpanMarks
): Extensions {
  // One path with the `DeferredImage` filter written once: a second copy would let
  // `surface/schema.test.ts`'s vocabulary guard assert one path while the window runs the other.
  // The inner key is the two schema facts.
  let byShape = BY_MENTIONS.get(mentions);
  if (byShape === undefined) {
    byShape = new Map();
    BY_MENTIONS.set(mentions, byShape);
  }
  const key = `${rendersMedia}:${codeSpanMarks}`;
  let built = byShape.get(key);
  if (built === undefined) {
    // Registered for every destination: one with nothing to mark returns no decorations, and the
    // editor never has to know which halves of `MentionSupport` draw something.
    const withCode = [
      ...BASE_EXTENSIONS,
      mentionPills(mentions),
      codeSpanMarks === 'any' ? CombinableCode : RestrictedCode,
    ];
    built = rendersMedia ? withCode : withCode.filter((e) => e.name !== DeferredImage.name);
    byShape.set(key, built);
  }
  return built;
}

export interface EditorProps {
  /** The document to load. Identity-stable: changing it remounts and discards editor history. */
  doc: PmNode;
  /** Called with the editor's ProseMirror JSON on every change. Absent for a `readOnly` preview. */
  onChange?(doc: PmNode): void;
  /** What the toolbars may offer, from `RenderResult.toolbar`: only the profile knows (`ToolbarSupport`). */
  toolbar: ToolbarSupport;
  /**
   * Where to draw the outline, as child indices from the document root, plus a nonce. The nonce
   * makes a second click on the same button re-scroll: the path is unchanged, so the effect would
   * not re-run. `undefined` clears.
   */
  highlight?: { path: number[]; nonce: number };
  /** Whether this destination draws a picture for an image, from the profile (`editorExtensions`). */
  rendersMedia: boolean;
  /**
   * What this destination resolves into a mention, from `RenderResult.mentions`: a pill claims the
   * destination resolves the token. Jira declares none (probed, `core/src/profiles/jira.ts`).
   */
  mentions?: MentionSupport;
  /** Whether emphasis may span a code span here, from `RenderResult.codeSpanMarks` (`CombinableCode`). */
  codeSpanMarks: CodeSpanMarks;
  /**
   * A preview, not a composer: nothing typed reaches it and no toolbar is drawn. A patch's edit is
   * edited as characters (`PatchEdits.tsx`) and shown here as the destination draws them.
   */
  readOnly?: boolean;
}

export function Editor({
  doc,
  onChange,
  toolbar,
  highlight,
  rendersMedia,
  mentions,
  codeSpanMarks,
  readOnly = false,
}: EditorProps) {
  const editor = useEditor(
    {
      extensions: editorExtensions(rendersMedia, mentions, codeSpanMarks),
      content: doc as JSONContent,
      // Throw on a document this schema cannot hold. TipTap 3's default warns and substitutes an
      // EMPTY document: measured with an unknown node type, the boundary does not fire and
      // `.ProseMirror` holds `<p><br></p>`, while the footer says "sent exactly as written" and
      // approving sends the canonical body the reviewer never saw. The throw reaches
      // `EditorBoundary`, which removes the footer. Reachable only through drift (`mapNodeToPm`
      // maps unknown types to a fallback).
      enableContentCheck: true,
      // Pasted text stays text. TipTap's paste rules use their own regexes, not the converter's:
      // linkifyjs links `https://x.com/a_` and keeps the `_`, `a ~~ b ~~ c` is struck, and a pasted
      // `SELECT * FROM t WHERE a * 2` turns italic. Left as text, the writer escapes it
      // (`**x**` goes out as `\*\*x\*\*`). Pasting a URL over selected text is a plugin
      // (`linkOnPaste`), not a paste rule, and still links it.
      enablePasteRules: false,
      onContentError: ({ error }) => {
        throw error;
      },
      // Never focused on open: a caret would catch the rest of what the reviewer was typing. The
      // host must not hand the page an initial focus either (`draftgate.m`'s `-show`).
      autofocus: false,
      editable: !readOnly,
      onUpdate: ({ editor }) => onChange?.(editor.getJSON() as PmNode),
      editorProps: {
        attributes: { class: 'draftgate-body', spellcheck: 'true' },
      },
    },
    // Remount when the document is replaced wholesale: on each accepted repair
    // (`useReview.applyFix`, up to `maxAppliedFixes` times).
    [doc]
  );

  // Draw the outline, scroll it into view, take it away. `rangeOfPath` is `null` for a path that no
  // longer resolves (the reviewer typed since), which draws nothing: an outline on the wrong node
  // would send them to edit innocent prose. The scroll is DOM `scrollIntoView()`, because
  // ProseMirror's command moves the selection.
  useEffect(() => {
    if (!editor || !highlight) return;
    const range = rangeOfPath(editor.state.doc, highlight.path);
    if (!range) {
      // Clear rather than return: an earlier click may have drawn one, its timer is already
      // cancelled, and `DecorationSet.map` would carry the outline onto whatever is typed next.
      setHighlight(editor.view, null);
      return;
    }
    setHighlight(editor.view, range);
    editor.view.nodeDOM(range.from)?.parentElement?.scrollIntoView?.({ block: 'center' });
    const timer = setTimeout(() => {
      // A repair may have remounted the editor; dispatching into a destroyed view throws.
      if (!editor.isDestroyed) setHighlight(editor.view, null);
    }, HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [editor, highlight]);

  return (
    <>
      {/* Inside `Editor` so `App`'s error boundary covers the toolbars: one that threw while the
          footer stayed live would leave Approve on a window that cannot show the draft. */}
      {!readOnly && <Toolbar editor={editor} support={toolbar} />}
      {!readOnly && <BubbleToolbar editor={editor} marks={toolbar.marks} />}
      <LinkTarget editor={editor} />
      <EditorContent editor={editor} className="draftgate-editor" />
    </>
  );
}
