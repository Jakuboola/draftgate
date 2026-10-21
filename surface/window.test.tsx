/**
 * The review window, mounted: the one file that renders the real React tree, on happy-dom
 * (registered here, unregistered afterwards). Source-text tests, pure modules and the real window
 * (`harness/probe.ts`, `harness/e2e.ts`, `harness/host.ts`) leave two gaps, and both cost an
 * approval:
 *
 *  1. Wiring. The keydown effect runs before the `editorError` early return, so unless it is torn
 *     down, `⌘↵` on the "editor could not load this draft" screen still approves.
 *  2. What the editor does with a document it cannot hold. TipTap 3.31 substitutes an empty
 *     document and says nothing: a blank editor under a live Approve.
 *
 * One file, because `mock.module` in bun is registry-wide and does not reliably come back for a
 * module another file has already imported. Section 1 runs the real `Editor`. From section 2 on,
 * every describe that mounts `App` installs its own stub in `beforeAll`: one that installs none
 * would inherit whichever stub ran last, which may throw or fire an edit on mount.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Editor as TipTapEditor } from '@tiptap/core';
import type { PluginKey } from '@tiptap/pm/state';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

GlobalRegistrator.register();

import { Component, useEffect, useState, type ReactNode } from 'react';
import * as realEditor from './src/Editor';
import { markTypes, profiles } from '../core/src/index';
import { render as renderBody } from '../core/src/render';
import { editorDocFor, fromEditorDoc, lostInMarkdown, markdownFor, toEditorDoc } from '../core/src/editor';
import type { Warning } from '../core/src/index';
import * as realSettled from './src/settledWarnings';
import * as realShortcutGrace from './src/shortcutGrace';
import { useSettledWarnings } from './src/settledWarnings';
import { rangeOfPath } from './src/lostHighlight';
import { LINK } from './src/linkEditor';
import { bubbleInstalled } from './src/GuardedBubbleMenu';
import {
  PROTOCOL_VERSION,
  type HumanDecision,
  type WireRequest,
} from '../cli/src/surfaces/windowProtocol';

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/**
 * The default settle delay for every mounted `App` here: 0, so an arriving warning shows on the
 * render that brings it instead of after the shipped 600ms (`SETTLE_MS`). No mounted-App test
 * asserts the withholding: the `Harness` describe below drives the hook with its own delays, and
 * `surface/settledWarnings.test.ts` sweeps the deadline as a pure property. `App` takes no delay
 * parameter, so the module is wrapped below rather than given a prop only tests would set. A test
 * that must show something happens WITHOUT the delay raises it, and `afterEach` puts it back.
 */
const SETTLE_TEST_MS = 0;
let settleDefaultMs = SETTLE_TEST_MS;

/*
 * Installed before anything imports `App`, which is why `mountApp` imports it lazily. Every other
 * export is forwarded, so a file that loads this module later still gets the real one; only the
 * default delay changes. The real hook is destructured first: read through the live `import * as`
 * namespace inside the factory, `useSettledWarnings` resolves to this wrapper, which then calls
 * itself and the file hangs with no output.
 */
const {
  settle: realSettle,
  arrivals: realArrivals,
  SETTLE_MS: REAL_SETTLE_MS,
  useSettledWarnings: realUseSettledWarnings,
} = realSettled;
mock.module('./src/settledWarnings', () => ({
  settle: realSettle,
  arrivals: realArrivals,
  SETTLE_MS: REAL_SETTLE_MS,
  useSettledWarnings: (warnings: Warning[], delayMs?: number) =>
    realUseSettledWarnings(warnings, delayMs ?? settleDefaultMs),
}));

/**
 * The `⌘↵` grace, shortened the same way; `SHORTCUT_GRACE_MS` is asserted at its real value below.
 * A negative test ("`⌘↵` did nothing while the preview was open") passes trivially inside the
 * grace, so every press here that is not about the grace waits it out with `pastShortcutGrace()`.
 */
const SHORTCUT_TEST_MS = 20;
const { SHORTCUT_GRACE_MS, useShortcutArmed: realUseShortcutArmed } = realShortcutGrace;
mock.module('./src/shortcutGrace', () => ({
  SHORTCUT_GRACE_MS,
  useShortcutArmed: (graceMs?: number) => realUseShortcutArmed(graceMs ?? SHORTCUT_TEST_MS),
}));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait out the `⌘↵` grace, so a press after this is a reviewer's and not a stray. */
async function pastShortcutGrace() {
  await wait(SHORTCUT_TEST_MS + 10);
}

/**
 * Let React flush its render and any async work settle. `setImmediate` rounds (happy-dom's
 * `requestAnimationFrame` is one), because bun clamps a zero timeout to about 1ms and this runs
 * some 280 times; then one real timer round LAST, so TipTap's `setTimeout(..., 0)` work (autofocus,
 * `create`, a bubble's update after a `focus()` frame) runs inside the test that caused it rather
 * than drawing onto the next test's `<body>`.
 */
async function settle(rounds = 6) {
  for (let i = 1; i < rounds; i++) await new Promise((r) => setImmediate(r));
  await wait(0);
}

/**
 * Every root this file mounts, so `afterEach` can take them down. `App` listens for `keydown` on
 * `window`, so a root left mounted would answer the next test's `⌘↵` too: two approvals.
 */
const roots: { unmount(): void }[] = [];

afterEach(() => {
  settleDefaultMs = SETTLE_TEST_MS;
  for (const root of roots.splice(0)) root.unmount();
  document.body.replaceChildren();
});

/** The button whose visible text contains `text`. */
function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(text)
  );
  expect(found, `no button whose text contains "${text}"`).toBeDefined();
  return found as HTMLButtonElement;
}

/**
 * Unfurl the footer's warning list, which starts furled, so its repair buttons are in the DOM. A
 * test that forgets fails here rather than in the behaviour it is about.
 */
async function unfurlWarnings(container: HTMLElement): Promise<void> {
  const lead = container.querySelector('.dg-warnbar') as HTMLButtonElement | null;
  expect(lead, 'there is no warning row to unfurl').not.toBeNull();
  lead!.click();
  await settle();
}

/**
 * Replace `Editor` with a stub that hands back its `onChange`, so a test can drive an edit. Returns
 * a box, because the callback does not exist until the component mounts.
 */
function stubEditorCapturingChange(): { fire(doc: unknown): void; install(): void } {
  let onChange: (doc: unknown) => void = () => {};
  return {
    fire: (doc) => onChange(doc),
    /*
     * Call from the describe's own `beforeAll`, never at describe scope: a describe body runs at
     * collection time, so every describe's stub would register before any test ran and the last one
     * in the file would win for all of them.
     */
    install: () => {
      mock.module('./src/Editor', () => ({
        Editor: (props: { onChange: (doc: unknown) => void; highlight?: unknown }) => {
          onChange = props.onChange;
          // Serialised so the pointing tests can read what the editor was asked to draw.
          return (
            <div data-testid="stub-editor" data-highlight={JSON.stringify(props.highlight ?? null)} />
          );
        },
      }));
    },
  };
}

/** What the stub was last asked to highlight, or `null`. See `stubEditorCapturingChange`. */
function highlightOf(container: HTMLElement): { path: number[]; nonce: number } | null {
  return JSON.parse(
    container.querySelector('[data-testid="stub-editor"]')?.getAttribute('data-highlight') ?? 'null'
  );
}

/**
 * A bare URL ending a line, as the agent wrote it. It trips `slack/url-swallows-next-line` on
 * `canonical` and not on the body the window shows, because loading rewrites the URL into
 * `[url](url)`, one of that warning's own two repairs. So it exercises the silenced row
 * (`silencedWarnings`); tests that want the live warning type it (`TYPED_BARE_URL`).
 */
const BARE_URL = 'See https://example.com/a\nnext line\n';

/**
 * The same shape as a reviewer types it: plain text with no link mark, because `Link` has
 * `autolink: false`. It serialises to `"See https://example.com/a\nnext line"` and renders the
 * warning with both its repairs. Fired through `stubEditorCapturingChange`: a real keystroke in
 * happy-dom cannot produce a ProseMirror transaction.
 */
const TYPED_BARE_URL = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'See https://example.com/a' },
        { type: 'hardBreak' },
        { type: 'text', text: 'next line' },
      ],
    },
  ],
};

/** A Slack draft with nothing to say about it, for tests that then TYPE what they want to test. */
const CLEAN_SLACK = 'Just prose, nothing to convert.\n';

/**
 * Mount a clean Slack draft and type a bare URL into it: the only route to
 * `slack/url-swallows-next-line` and its two repair buttons (see `TYPED_BARE_URL`).
 */
async function typeBareUrl(
  editor: { fire(doc: unknown): void },
  doc: unknown = TYPED_BARE_URL
): Promise<HTMLElement> {
  const el = await mountApp(CLEAN_SLACK, 'slack');
  editor.fire(doc);
  await settle();
  return el;
}

/**
 * What an approval nobody edited looks like on the wire. `fields` carries every shown field, always
 * (an absent or empty map is a stale bundle the CLI denies), and `edited: false` says no human
 * changed anything. For an ordinary draft `shown` is byte-identical to `canonical`, trailing newline
 * included (`matchTrailingNewline`), so the CLI logs no `after` for a draft nobody touched.
 */
const approvedUntouched = (
  shown: string,
  destination: WireRequest['destination'] = 'jira'
) => [
  {
    action: 'approve' as const,
    fields: { [bodyKeyFor(destination)]: shown },
    edited: false,
    bodyEdited: false,
    silenced: [] as string[],
    fixes: [],
  },
];

/** Click Approve and let the decision settle. */
async function clickApprove(container: HTMLElement): Promise<void> {
  buttonWithText(container, 'Approve').click();
  await settle();
}

/** A container in the document, plus React's console noise silenced while it mounts. */
async function mount(node: ReactNode): Promise<HTMLElement> {
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  // React logs a caught boundary error through console.error; that is expected in both describes,
  // and its stack would otherwise bury the assertion output.
  const realError = console.error;
  console.error = () => {};
  const root = createRoot(container);
  roots.push(root);
  root.render(node);
  await settle();
  console.error = realError;
  return container;
}

/**
 * The field a destination's body lives in: one spelling for the request, `approvedUntouched` and
 * `sentBody`.
 */
const bodyKeyFor = (destination: WireRequest['destination']): string =>
  profiles[destination].bodyField;

/** Every decision the window has submitted through the bridge, in order. */
let decisions: HumanDecision[] = [];

/** The body the window submitted: the decision's entry for the destination's body field. */
const sentBody = (
  d: HumanDecision | undefined,
  destination: WireRequest['destination'] = 'jira'
): string | undefined =>
  (d as { fields?: Record<string, string> } | undefined)?.fields?.[bodyKeyFor(destination)];

/** The prose lines a case wants beside the draft, before they become plan entries. */
type ProseLines = readonly { field: string; value: string }[];

function stubBridge(
  /** `null` means the payload carries no body field. */
  canonical: string | null,
  destination: WireRequest['destination'] = 'jira',
  audience?: WireRequest['audience'],
  destinationLabel?: string,
  routeInferred?: WireRequest['routeInferred'],
  prose?: ProseLines,
  /** Only the stale-bundle test passes this. */
  protocol: number = PROTOCOL_VERSION,
  toolName = 'mcp__test__addCommentToJiraIssue'
) {
  const request: WireRequest = {
    // Never a literal: `useReview` refuses another protocol, so a literal would turn every mounted
    // test into the stale-bundle screen at the next bump.
    protocol,
    destination,
    toolName,
    context: { issueIdOrKey: 'SUPPORT-1' },
    ...(audience ? { audience } : {}),
    ...(destinationLabel ? { destinationLabel } : {}),
    ...(routeInferred ? { routeInferred } : {}),
    // The route's plan: the prose lines, then the body unless there is none.
    fields: [
      ...(prose ?? []).map((line) => ({ ...line, kind: 'line' as const })),
      ...(canonical === null
        ? []
        : [{ field: bodyKeyFor(destination), kind: 'markdown' as const, value: canonical }]),
    ],
    timeoutMs: 600_000,
  };
  (window as unknown as { draftgate: unknown }).draftgate = {
    request: () => Promise.resolve(request),
    decide: (d: HumanDecision) => decisions.push(d),
  };
}

async function mountApp(
  canonical: string | null,
  destination: WireRequest['destination'] = 'jira',
  audience?: WireRequest['audience'],
  destinationLabel?: string,
  routeInferred?: WireRequest['routeInferred'],
  prose?: ProseLines,
  protocol?: number,
  toolName?: string
): Promise<HTMLElement> {
  const { App } = await import('./src/App');
  stubBridge(canonical, destination, audience, destinationLabel, routeInferred, prose, protocol, toolName);
  return mount(<App />);
}

function pressCmdEnter({ repeat = false }: { repeat?: boolean } = {}) {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, repeat, bubbles: true, cancelable: true })
  );
}

// ---------------------------------------------------------------------------
// 1. The real `Editor`.
// ---------------------------------------------------------------------------

/** Stands in for `App`'s own `EditorBoundary`: the same shape, reporting upward. */
class Boundary extends Component<
  { children: ReactNode; onError(error: Error): void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

async function mountEditor(doc: unknown): Promise<{ error: Error | null; body: Element | null; text: string }> {
  const { Editor } = await import('./src/Editor');
  let error: Error | null = null;
  const container = await mount(
    <Boundary onError={(e) => (error = e)}>
      <Editor doc={doc as never} onChange={() => {}} toolbar={renderBody('x', 'jira').toolbar}
        rendersMedia codeSpanMarks="link-only" />
    </Boundary>
  );
  const body = container.querySelector('.ProseMirror');
  return { error, body, text: body?.textContent ?? '' };
}

/**
 * TipTap's `enableContentCheck` defaults to false, and then `Editor.createDoc()` catches the error,
 * builds an EMPTY fallback and emits `contentError`; with no handler nothing happens and
 * `.ProseMirror` holds `<p><br></p>`. `enableContentCheck: true` alone does not fix it, since the
 * catch still swaps in the empty document: the window handles `onContentError` and re-throws into
 * `EditorBoundary`. Otherwise the footer reads "Exactly what you see above will be sent" under a
 * blank editor, and approving sends the canonical body nobody saw. Reachable only through drift:
 * `mapNodeToPm` maps anything unregistered to a fallback, and `schema.test.ts` keeps that true.
 */
describe('a document this schema cannot hold', () => {
  const unknownNode = {
    type: 'doc',
    content: [{ type: 'nosuchnode', content: [{ type: 'text', text: 'text nobody would see' }] }],
  };

  test('reports upward instead of rendering an empty editor', async () => {
    const { error, body, text } = await mountEditor(unknownNode);
    expect(error, 'the boundary never fired, so the footer would have stayed live').not.toBeNull();
    expect(error?.message).toContain('Invalid JSON content');
    // And it did not settle into a blank editable body, which IS the failure mode.
    expect(body).toBeNull();
    expect(text).toBe('');
  });
});

describe('and a document it CAN hold still loads', () => {
  // The negative control: without it every assertion above passes for a window that refuses
  // everything.
  test('a real draft renders its text and reports no error', async () => {
    const body = '# Title\n\n- [ ] one\n- [x] two\n\nSome prose.\n';
    const { error, text } = await mountEditor(editorDocFor(renderBody(body, 'jira')));
    expect(error).toBeNull();
    expect(text).toContain('Title');
    expect(text).toContain('Some prose.');
  });

  test('and an image in a heading', async () => {
    const { error, text } = await mountEditor(
      editorDocFor(renderBody('# Title ![i](https://example.com/a.png)\n', 'slack'))
    );
    expect(error).toBeNull();
    expect(text).toContain('Title');
  });

  /*
   * Here, with the real `Editor`: section 2 stubs it. `rangeOfPath` returning the right numbers
   * proves nothing about whether the plugin is registered or its decorations reach the view.
   */
  test('the highlight extension actually paints the node it is given', async () => {
    const { Editor } = await import('./src/Editor');
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Intro line.' }] },
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }],
        },
      ],
    };
    const container = await mount(
      <Editor
        doc={doc as never}
        onChange={() => {}}
        toolbar={renderBody('x', 'slack').toolbar}
        rendersMedia
        codeSpanMarks="link-only"
        highlight={{ path: [1], nonce: 1 }}
      />
    );
    await settle();
    const marked = container.querySelector('.dg-lost-highlight');
    expect(marked, 'the decoration never reached the document').not.toBeNull();
    // On the blockquote, not on the paragraph above it: the off-by-one this feature has to avoid.
    expect(marked?.tagName.toLowerCase()).toBe('blockquote');
    expect(marked?.textContent).toBe('quoted');
  });

  test('and paints nothing at all for a path that does not resolve', async () => {
    const { Editor } = await import('./src/Editor');
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] };
    const container = await mount(
      <Editor
        doc={doc as never}
        onChange={() => {}}
        toolbar={renderBody('x', 'slack').toolbar}
        rendersMedia
        codeSpanMarks="link-only"
        highlight={{ path: [7], nonce: 1 }}
      />
    );
    await settle();
    expect(container.querySelector('.dg-lost-highlight')).toBeNull();
  });
});

/**
 * A real checkbox click in the real editor must not trip `lostInMarkdown`. ProseMirror keeps a
 * trailing empty paragraph so a reviewer can click below the last block, and markdown cannot carry
 * it. Unit tests build documents with `toEditorDoc`, which produces no such node; only a real
 * TipTap instance does (`probe.ts` checks the same in a real window).
 */
describe('the real editor, ticking a real checkbox', () => {
  test('produces a document the loss check passes', async () => {
    const doc = editorDocFor(renderBody('- [ ] one\n- [x] two\n', 'jira'));
    let latest: unknown = null;
    const { Editor } = await import('./src/Editor');
    const container = await mount(
      <Editor
        doc={doc as never}
        onChange={(d) => (latest = d)}
        toolbar={renderBody('x', 'jira').toolbar}
        rendersMedia
        codeSpanMarks="link-only"
      />
    );

    const boxes = container.querySelectorAll('input[type=checkbox]');
    expect(boxes.length, 'the fixture must actually render checkboxes').toBe(2);
    (boxes[0] as HTMLInputElement).click();
    await settle();

    expect(latest, 'the click must reach onUpdate, or this test proves nothing').not.toBeNull();
    // The trailing empty paragraph the unit tests' documents never hold.
    const top = (latest as { content: { type: string }[] }).content;
    expect(top[top.length - 1]!.type).toBe('paragraph');

    const body = fromEditorDoc(latest as never);
    expect(body).toContain('- [x] one');
    expect(
      lostInMarkdown(latest as never, toEditorDoc(body, { mediaPlacement: 'block' })),
      'ticking a checkbox must not block the send'
    ).toEqual([]);
    expect(renderBody(body, 'jira', latest as never).blocked).toBe(false);
  });
});

/**
 * Pasted text stays text. TipTap's paste rules use their own regexes, not the converter's: they
 * link a URL through linkifyjs (keeping a trailing `_`), strike `a ~~ b ~~ c` and italicise a SQL
 * star. `Editor.tsx` sets `enablePasteRules: false`. Driven through the real `<Editor>` with
 * `view.pasteText`, ProseMirror's own paste path.
 */
describe('pasting into the real editor', () => {
  const pasteInto = async (body: string, pasted: string, selectAll = false) => {
    const { Editor } = await import('./src/Editor');
    let latest: unknown = null;
    const container = await mount(
      <Editor
        doc={editorDocFor(renderBody(body, 'github')) as never}
        onChange={(d) => (latest = d)}
        toolbar={renderBody('x', 'github').toolbar}
        rendersMedia
        codeSpanMarks="any"
      />
    );
    const editor = (container.querySelector('.ProseMirror') as unknown as { editor: TipTapEditor }).editor;
    if (selectAll) editor.commands.selectAll();
    else editor.commands.focus('end');
    editor.view.pasteText(pasted);
    await settle();
    return latest;
  };

  test('a URL, a tilde pair and a SQL star all arrive as the characters pasted', async () => {
    for (const pasted of ['see https://x.com/a_ ok', 'a ~~ b ~~ c', 'SELECT * FROM t WHERE a * 2']) {
      const doc = await pasteInto('Start.', pasted);
      expect(JSON.stringify(doc), pasted).toContain(pasted);
      expect([...markTypes(doc as never)], pasted).toEqual([]);
    }
  });

  test('...while pasting a URL over selected text still links that text', async () => {
    const doc = JSON.stringify(await pasteInto('click here', 'https://x.com/a', true));
    expect(doc).toContain('"text":"click here"');
    expect(doc).toContain('"href":"https://x.com/a"');
  });
});

/*
 * A link's TARGET is shown, not only its text. The text can name one host and the href another, and
 * with the href drawn nowhere a look-alike reviews as your own URL.
 */
describe("a link's real address is on screen", () => {
  const LABEL = 'https://id.example.org/reset';
  const HREF = 'https://id-example.evil.test/reset';
  const BODY = `Reset here: [${LABEL}](${HREF}) today.\n`;

  // `replace` hands the editor a new `doc`, as an accepted repair does, which remounts it.
  const mountLinked = async (destination: 'jira' | 'slack' | 'linear' | 'github') => {
    const { Editor } = await import('./src/Editor');
    const r = renderBody(BODY, destination);
    let replace: () => void = () => {};
    function Linked() {
      const [doc, setDoc] = useState(() => editorDocFor(r));
      replace = () => setDoc(editorDocFor(r));
      return (
        <Editor doc={doc as never} onChange={() => {}} toolbar={r.toolbar}
          rendersMedia={r.rendersMedia} codeSpanMarks={r.codeSpanMarks} />
      );
    }
    const container = await mount(<Linked />);
    const editor = (container.querySelector('.ProseMirror') as unknown as { editor: TipTapEditor }).editor;
    return { container, editor, replace: () => replace() };
  };
  // The position just inside the link's text, found in the real document rather than counted.
  const caretInLink = (editor: TipTapEditor) => {
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (at === -1 && node.isText && node.text === LABEL) at = pos + 3;
    });
    return at;
  };

  // Show the formatting bubble over a range, then change the range: that change arms its delay.
  const armBubbleDelay = async (editor: TipTapEditor) => {
    const at = caretInLink(editor);
    editor.chain().setTextSelection({ from: at, to: at + 2 }).run();
    await wait(300);
    expect(document.body.querySelectorAll('.dg-bubble')).toHaveLength(1);
    editor.chain().setTextSelection({ from: at, to: at + 4 }).run();
  };

  test('the caret in a link puts its full target in a bubble, on every destination', async () => {
    for (const d of ['jira', 'slack', 'linear', 'github'] as const) {
      const { editor } = await mountLinked(d);
      const at = caretInLink(editor);
      expect(at, d).toBeGreaterThan(0);
      editor.chain().focus().setTextSelection(at).run();
      await settle();
      const bubble = document.body.querySelector('.dg-linktarget');
      expect(bubble, d).not.toBeNull();
      expect(bubble!.querySelector('.dg-linktarget-url')!.textContent, d).toBe(HREF);
      // Outside the link it goes away, so it cannot be mistaken for the next link's address.
      editor.chain().focus().setTextSelection(2).run();
      await settle();
      expect(document.body.querySelector('.dg-linktarget'), d).toBeNull();
    }
  });

  test('a selection crossing two links names BOTH targets, not whichever comes first', async () => {
    const { Editor } = await import('./src/Editor');
    const r = renderBody('[a.com](https://a.com/) and [b.com](https://evil.test/)\n', 'github');
    const container = await mount(
      <Editor doc={editorDocFor(r) as never} onChange={() => {}} toolbar={r.toolbar}
        rendersMedia={r.rendersMedia} codeSpanMarks={r.codeSpanMarks} />
    );
    const editor = (container.querySelector('.ProseMirror') as unknown as { editor: TipTapEditor }).editor;
    editor.chain().focus().selectAll().run();
    await settle();
    const urls = [...document.body.querySelectorAll('.dg-linktarget-url')].map((e) => e.textContent);
    expect(urls).toEqual(['https://a.com/', 'https://evil.test/']);
  });

  /*
   * TipTap debounces the formatting bubble over a range by 250ms and the timer outlives the editor,
   * so an unmount inside that window would leave a visible toolbar on <body> for good
   * (`GuardedBubbleMenu.tsx`). Without the installed check in `shouldShow` this test fails with one
   * orphaned `.dg-bubble`. No `focus()`: its frame races the editor's deferred destroy, which is not
   * this test's subject.
   */
  test('unmounting mid-selection leaves no orphaned bubble behind', async () => {
    const { editor } = await mountLinked('jira');
    await armBubbleDelay(editor);
    for (const root of roots.splice(0)) root.unmount();
    await wait(300);
    expect(document.body.querySelectorAll('.dg-bubble, .dg-linktarget')).toHaveLength(0);
  });

  /*
   * The same timer across a repair: the old editor is destroyed before its bubble lets go of it, so
   * its plugin is still in its state and only `isDestroyed` refuses the late `show()`. Without that
   * half the shared bubble element comes back visible while the new editor holds no selection.
   */
  test('a repair inside the bubble delay leaves no bubble the new editor did not ask for', async () => {
    const { editor, replace } = await mountLinked('jira');
    await armBubbleDelay(editor);
    replace();
    await wait(300);
    expect(editor.isDestroyed).toBe(true);
    expect(document.body.querySelectorAll('.dg-bubble, .dg-linktarget')).toHaveLength(0);
  });

  /*
   * The focus timer on the link-target bubble: focused with the caret in a link, then unmounted in
   * the same task. The unmount unregisters the plugin while the editor still lives (its destroy is
   * deferred), so only the installed check refuses the late `show()`. `BubbleMenu`'s cleanup takes
   * its element out on the next frame, which would hide a missing guard behind timer order; frames
   * are held back here so the guard is all that stands between the timer and an orphan.
   */
  test('a focus just before an unmount leaves no link-target bubble behind', async () => {
    const { editor } = await mountLinked('jira');
    editor.chain().setTextSelection(caretInLink(editor)).run();
    await settle();
    const realFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0;
    try {
      document.body.querySelector('.dg-linktarget')?.remove();
      editor.view.dom.blur();
      editor.view.focus();
      for (const root of roots.splice(0)) root.unmount();
      expect(editor.isDestroyed).toBe(false);
      await wait(50);
      expect(document.body.querySelectorAll('.dg-linktarget')).toHaveLength(0);
    } finally {
      window.requestAnimationFrame = realFrame;
    }
  });

  // The key is this mount's own, so a bubble remounted on a live editor cannot answer for the plugin
  // it replaced: the old key is no longer installed once its plugin is unregistered.
  test('a bubble unregistered from a live editor is no longer installed', async () => {
    const { editor } = await mountLinked('jira');
    await armBubbleDelay(editor);
    // By name: the key is private to the mount, so the plugin it named is found in the state.
    const keyOf = (name: string) =>
      editor.state.plugins.find((p) => (p as unknown as { key: string }).key.startsWith(`${name}$`))
        ?.spec.key as PluginKey;
    const formatting = keyOf('formattingBubble');
    expect(bubbleInstalled(editor, formatting)).toBe(true);
    editor.unregisterPlugin(formatting);
    expect(editor.isDestroyed).toBe(false);
    expect(bubbleInstalled(editor, formatting)).toBe(false);
    expect(bubbleInstalled(editor, keyOf('linkTarget'))).toBe(true);
  });

  test('every bubble in the window is a GuardedBubbleMenu', () => {
    const src = join(import.meta.dir, 'src');
    const direct = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f) && f !== 'GuardedBubbleMenu.tsx')
      .filter((f) => /@tiptap\/react\/menus|@tiptap\/extension-(bubble|floating)-menu/.test(readFileSync(join(src, f), 'utf8')));
    expect(direct).toEqual([]);
  });

  test('hovering the text shows the target too, and the document carries no title for it', async () => {
    const { container, editor } = await mountLinked('slack');
    const titled = container.querySelector('.ProseMirror a [title], .ProseMirror a[title]');
    expect(titled?.getAttribute('title')).toBe(HREF);
    expect(titled?.textContent).toBe(LABEL);
    // A decoration, never a mark attribute: the body the reviewer sends is unchanged.
    expect(JSON.stringify(editor.getJSON())).toContain('"title":null');
  });
});

/**
 * A link Linear turns into a mention is drawn as one, and the draft is not touched.
 *
 * Probed: Linear stores `[Label](profile URL)` and the bare URL as a user mention and draws
 * `@<display name>`. The window cannot know the display name, so it shows the label, or the slug at
 * the end of a bare URL, behind Linear's `@`. On Slack the same text is two links.
 */
describe('a Linear profile link is drawn as a mention', () => {
  const HREF = 'https://linear.app/acme/profiles/jane.doe';
  const BODY = `Hi [Jane](${HREF}) and ${HREF} today.\n`;

  const mountDraft = async (body: string, destination: 'slack' | 'linear') => {
    const { Editor } = await import('./src/Editor');
    const r = renderBody(body, destination);
    const container = await mount(
      <Editor doc={editorDocFor(r) as never} onChange={() => {}} toolbar={r.toolbar}
        rendersMedia={r.rendersMedia} mentions={r.mentions} codeSpanMarks={r.codeSpanMarks} />
    );
    const editor = (container.querySelector('.ProseMirror') as unknown as { editor: TipTapEditor }).editor;
    return { container, editor };
  };
  // What a link draws: its text minus what the sheet hides. happy-dom applies no stylesheet, so the
  // hidden range is subtracted by its class; the probe measures `display: none` in WebKit.
  const drawn = (a: Element) => {
    const clone = a.cloneNode(true) as Element;
    for (const h of clone.querySelectorAll('.dg-mlink-hidden')) h.remove();
    return clone.textContent;
  };

  test('on Linear both forms are mentions, showing the label and the slug', async () => {
    const { container } = await mountDraft(BODY, 'linear');
    const links = [...container.querySelectorAll('.ProseMirror a')];
    expect(links.map(drawn)).toEqual(['Jane', 'jane.doe']);
    expect(container.querySelectorAll('.ProseMirror .dg-mlink-start.dg-mlink-at')).toHaveLength(2);
    // The mention's class, so the sheet's mention rule draws it, on everything that is shown.
    for (const a of links) {
      for (const span of a.querySelectorAll('span:not(.dg-mlink-hidden)')) {
        expect(span.classList.contains('dg-mtok-user'), span.outerHTML).toBe(true);
      }
    }
    const hidden = [...container.querySelectorAll('.ProseMirror .dg-mlink-hidden')];
    expect(hidden.map((h) => h.textContent)).toEqual(['https://linear.app/acme/profiles/']);
  });

  test('and the body sent is exactly what an undecorated load sends', async () => {
    const { editor } = await mountDraft(BODY, 'linear');
    const r = renderBody(BODY, 'linear');
    // Both forms stay links: the decoration changed no character and no mark.
    expect(markdownFor(r, editor.getJSON() as never)).toBe(`Hi [Jane](${HREF}) and [${HREF}](${HREF}) today.\n`);
    expect(markdownFor(r, editor.getJSON() as never)).toBe(markdownFor(r, editorDocFor(r)));
  });

  test('a label split by formatting is ONE mention with one `@`', async () => {
    const { container } = await mountDraft(`Hi [Ja**ne**](${HREF}).\n`, 'linear');
    expect(container.querySelectorAll('.ProseMirror .dg-mlink-start')).toHaveLength(1);
    expect(container.querySelectorAll('.ProseMirror .dg-mlink-at')).toHaveLength(1);
  });

  test('the `@name` in a mention link is not ALSO a token', async () => {
    // As the strip counts it: one mention. The link draws two decorations, its text and its first
    // character; a token scan over the label would add a third.
    const { mentionPillDecorations } = await import('./src/mentionPills');
    const { editor } = await mountDraft(`Hi [@jane](${HREF}) and @ada.\n`, 'linear');
    const found = mentionPillDecorations(editor.state, profiles.linear.mentions);
    expect(found.map((d) => editor.state.doc.textBetween(d.from, d.to))).toEqual(['@ada', '@jane', '@']);
  });

  test('a label that already starts with `@` gets no second one', async () => {
    const { container } = await mountDraft(`Hi [@Jane](${HREF}).\n`, 'linear');
    expect(container.querySelectorAll('.ProseMirror .dg-mlink-start')).toHaveLength(1);
    expect(container.querySelectorAll('.ProseMirror .dg-mlink-at')).toHaveLength(0);
  });

  test('a label starting with an emoji keeps it whole', async () => {
    // The `@` sits on the first code point; a span ending mid-surrogate would draw two U+FFFD.
    const { container } = await mountDraft(`Hi [\u{1F44B} Jane](${HREF}).\n`, 'linear');
    expect(container.querySelector('.ProseMirror .dg-mlink-start')!.textContent).toBe('\u{1F44B}');
  });

  test('an ordinary link on Linear is not a mention', async () => {
    const { container } = await mountDraft('See [docs](https://linear.app/acme/issue/HELP-1).\n', 'linear');
    expect(container.querySelectorAll('.ProseMirror .dg-mlink-start, .ProseMirror .dg-mtok')).toHaveLength(0);
  });

  test('on Slack the same text is two links and nothing more', async () => {
    const { container } = await mountDraft(BODY, 'slack');
    const links = [...container.querySelectorAll('.ProseMirror a')];
    expect(links.map((a) => a.textContent)).toEqual(['Jane', HREF]);
    expect(
      container.querySelectorAll('.ProseMirror .dg-mtok, .ProseMirror [class*="dg-mlink"]')
    ).toHaveLength(0);
  });
});

/*
 * Slack's own link, `<url|label>`, edits like any other link and goes out in Slack's form.
 *
 * Through the real `<Editor>`: typed text by `tr.insertText`, which is what ProseMirror's own input
 * handling dispatches, and a new address by `LINK.apply`, the link dialog's own command. Asserted on
 * the body the window sends (`markdownFor`), which for Slack is the payload.
 */
describe("Slack's <url|label> in the real editor", () => {
  const BODY = 'Update: <https://e.test/issue/ABC-1|ABC-1> is done\n';

  const mountSlack = async () => {
    const { Editor } = await import('./src/Editor');
    const r = renderBody(BODY, 'slack');
    let latest: unknown = null;
    const container = await mount(
      <Editor doc={editorDocFor(r) as never} onChange={(d) => (latest = d)} toolbar={r.toolbar}
        rendersMedia={r.rendersMedia} mentions={r.mentions} codeSpanMarks={r.codeSpanMarks} />
    );
    const editor = (container.querySelector('.ProseMirror') as unknown as { editor: TipTapEditor }).editor;
    // Where the label starts, found in the real document rather than counted.
    let label = -1;
    editor.state.doc.descendants((node, pos) => {
      if (label === -1 && node.isText && node.text === 'ABC-1') label = pos;
    });
    expect(label, 'the label must be its own text node, or this proves nothing').toBeGreaterThan(0);
    return { r, container, editor, label, sent: () => markdownFor(r, latest as never) };
  };

  test('drawn as a link reading the label, with the real address in the target bubble', async () => {
    const { container, editor, label } = await mountSlack();
    const links = [...container.querySelectorAll('.ProseMirror a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['ABC-1', 'https://e.test/issue/ABC-1']]);
    editor.chain().focus().setTextSelection(label + 2).run();
    await settle();
    expect(document.body.querySelector('.dg-linktarget-url')?.textContent).toBe('https://e.test/issue/ABC-1');
  });

  test('typing over the label sends `<url|newlabel>`', async () => {
    const { editor, label, sent } = await mountSlack();
    editor.view.dispatch(editor.state.tr.insertText('DEF', label, label + 'ABC'.length));
    await settle();
    expect(sent()).toBe('Update: <https://e.test/issue/ABC-1|DEF-1> is done\n');
  });

  test('a new address through the link dialog keeps Slack\'s form', async () => {
    const { editor, label, sent } = await mountSlack();
    editor.chain().focus().setTextSelection(label + 2).run();
    LINK.apply(editor as never, LINK.normalise('https://e.test/issue/ABC-2')!);
    await settle();
    expect(sent()).toBe('Update: <https://e.test/issue/ABC-2|ABC-1> is done\n');
  });
});

/**
 * `⌘↵` acts on the footer only while the footer is what the reviewer is looking at. It listens on
 * `window`, and two sub-dialogs take the same keystroke: the repair preview, where it would send
 * the unrepaired draft the reviewer was asked to replace (`blocked` does not save this, since a
 * repair is offered on an approvable draft; see `⌘↵ while a repair preview is open`), and the link
 * row, whose own Enter handler races this one.
 */
describe('the keyboard shortcut and the dialogs that are not the footer', () => {
  test('a keystroke from inside the link row is left to the link row', async () => {
    decisions = [];
    const container = await mountApp('Plain text.\n', 'slack');
    // The row is not open, so this synthesises the same thing the guard reads: an event whose
    // target is inside `.dg-linkrow`. Opening the real row needs a selection in the editor, which
    // is a different test's subject.
    const row = document.createElement('div');
    row.className = 'dg-linkrow';
    const input = document.createElement('input');
    row.append(input);
    container.append(row);
    await pastShortcutGrace();
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })
    );
    await settle();
    expect(decisions).toEqual([]);
  });

  /*
   * StarterKit's HardBreak binds `Mod-Enter` too. Unclaimed, `<p>Plain text.</p>` becomes
   * `<p><br>Plain text.</p>` while the same event goes on to approve.
   */
  test('Mod-Enter approves and inserts NOTHING into the draft', async () => {
    decisions = [];
    const container = await mountApp('Plain text.\n', 'slack');
    const body = container.querySelector('.ProseMirror') as HTMLElement;
    const before = body.innerHTML;
    expect(before).toContain('Plain text.');
    expect(before).not.toContain('<br');

    await pastShortcutGrace();
    body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })
    );
    await settle();

    expect(body.innerHTML).toBe(before);
    expect(decisions).toEqual(approvedUntouched('Plain text.\n', 'slack'));
  });

  test('and Shift-Enter still inserts one, which is where a hard break comes from', async () => {
    decisions = [];
    const container = await mountApp('Plain text.\n', 'slack');
    const body = container.querySelector('.ProseMirror') as HTMLElement;
    body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
    );
    await settle();
    expect(body.innerHTML).toContain('<br');
    // And it is an edit, not a decision.
    expect(decisions).toEqual([]);
  });
});

/**
 * A real review shows and focuses an always-on-top window over whatever the reviewer was typing
 * into, so no caret goes in the draft and `⌘↵` is ignored for a grace after every show or focus.
 * The grace is `SHORTCUT_TEST_MS` here; the shipped value is asserted on its own.
 */
describe('the shortcut is dead for a moment after the window appears', () => {
  test('the shipped grace is about a second', () => {
    expect(SHORTCUT_GRACE_MS).toBe(1000);
  });

  test('the window regaining focus starts the grace again', async () => {
    decisions = [];
    await mountApp('Plain text.\n', 'slack');
    await pastShortcutGrace();
    window.dispatchEvent(new Event('focus'));
    pressCmdEnter();
    await settle();
    expect(decisions, 'a ⌘↵ right after the window regained focus approved').toEqual([]);

    // The positive control: without it, "no decision" passes for a shortcut that is broken.
    await pastShortcutGrace();
    pressCmdEnter();
    await settle();
    expect(decisions).toEqual(approvedUntouched('Plain text.\n', 'slack'));
  });

  test('and so does the window being shown again', async () => {
    decisions = [];
    await mountApp('Plain text.\n', 'slack');
    await pastShortcutGrace();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.visibilityState).toBe('visible');
    pressCmdEnter();
    await settle();
    expect(decisions, 'a ⌘↵ right after the window was shown again approved').toEqual([]);

    await pastShortcutGrace();
    pressCmdEnter();
    await settle();
    expect(decisions).toEqual(approvedUntouched('Plain text.\n', 'slack'));
  });

  test('a HELD ⌘↵ -- repeats that outlast the grace -- never approves', async () => {
    // Pressed in the other app and still down when this window took the keyboard: what arrives is
    // repeats, and the first one after the grace must not approve.
    decisions = [];
    await mountApp('Plain text.\n', 'slack');
    await pastShortcutGrace();
    pressCmdEnter({ repeat: true });
    await settle();
    expect(decisions, 'a repeat of a held ⌘↵ approved').toEqual([]);
  });

  test('a CLICK on Approve is not delayed: a click is aimed', async () => {
    decisions = [];
    const container = await mountApp('Plain text.\n', 'slack');
    // Restart the grace, so the click lands inside it however long the mount took.
    window.dispatchEvent(new Event('focus'));
    buttonWithText(container, 'Approve').click();
    await settle();
    expect(decisions).toEqual(approvedUntouched('Plain text.\n', 'slack'));
  });

  test('nothing is focused on open, so typing elsewhere cannot land in the draft', async () => {
    const container = await mountApp('Plain text.\n', 'slack');
    // Past the point TipTap's own `autofocus` would have applied, which is deferred.
    await settle();
    const editor = container.querySelector('.ProseMirror');
    expect(editor, 'no editor mounted, so this test is measuring nothing').not.toBeNull();
    expect(container.contains(document.activeElement)).toBe(false);
  });
});

/**
 * The audience banner: who receives this, from data the CLI supplied. Mounted, because both
 * failures are wiring: a banner drawn for the wrong shape, and an "unavailable" choice that is a
 * real control (`addCommentToJiraIssue` has no audience parameter, probed). It informs and never
 * gates: a public reply to a customer is the normal case.
 */
describe('the audience banner', () => {
  const publicAudience = {
    kind: 'public' as const,
    label: 'Reply to customer',
    detail: 'The reporter sees this in the portal.',
    unavailable: 'Add internal note',
  };

  test('a public audience is drawn, and named the way the destination names it', async () => {
    const c = await mountApp('Hello.\n', 'jira', publicAudience);
    const banner = c.querySelector('.dg-audience');
    expect(banner).not.toBeNull();
    expect(banner?.className).toContain('dg-audience-public');
    expect(banner?.textContent).toContain('Reply to customer');
  });

  test('the unavailable choice is TEXT, never a control', async () => {
    const c = await mountApp('Hello.\n', 'jira', publicAudience);
    const off = c.querySelector('.dg-audience-off');
    expect(off?.textContent).toContain('Add internal note');
    // Not a button, not a link, and nothing that takes focus: the tool cannot do this, so the
    // window must not look as though clicking would make it.
    expect(off?.tagName).toBe('SPAN');
    expect(c.querySelectorAll('.dg-audience button, .dg-audience a').length).toBe(0);
    expect(off?.getAttribute('tabindex')).toBeNull();
  });

  test('it does NOT disable Approve -- a public reply is the normal case', async () => {
    const c = await mountApp('Hello.\n', 'jira', publicAudience);
    expect(buttonWithText(c, 'Approve').disabled).toBe(false);
  });

  test('`unknown` draws a banner too, but not the missing-tab line', async () => {
    // The loud half of the failure direction: no operator config must not mean no banner.
    const c = await mountApp('Hello.\n', 'jira', {
      kind: 'unknown',
      label: 'Audience unknown',
      detail: 'draftgate does not know whether SUPPORT is a service desk.',
    });
    const banner = c.querySelector('.dg-audience');
    expect(banner?.className).toContain('dg-audience-unknown');
    expect(banner?.textContent).toContain('SUPPORT');
    expect(c.querySelector('.dg-audience-off')).toBeNull();
  });

  /**
   * Answering "service desk" turns the banner public before the reviewer decides, since that fact
   * may change what they do next. Mounted, because the window recomputes by asking the profile
   * again through `audienceFor`; a recompute from a `kind` in JSX would pass a source-text test.
   */
  describe('answering the audience question', () => {
    // Shaped as `jiraAudience` builds it: the question and both labels come from the profile, so
    // this fixture carries them rather than the window inventing any of it.
    const unknown = {
      kind: 'unknown' as const,
      label: 'Audience unknown',
      detail: 'draftgate does not know whether SUPPORT is a service desk.',
      ask: {
        question: 'Is SUPPORT a service desk?',
        options: [
          { label: 'Yes -- customers read replies', value: 'service_desk' },
          { label: 'No -- record it as internal', value: 'software' },
        ],
      },
    };

    const answer = async (container: HTMLElement, text: string) => {
      const btn = [...container.querySelectorAll('.dg-audience-answer')].find((b) =>
        (b.textContent ?? '').includes(text)
      ) as HTMLButtonElement | undefined;
      expect(btn, `no answer button matching "${text}"`).toBeDefined();
      btn!.click();
      await settle();
    };

    test('an unknown audience offers the question, naming the project', async () => {
      const c = await mountApp('Hello.\n', 'jira', unknown);
      const ask = c.querySelector('.dg-audience-ask');
      expect(ask?.textContent).toContain('SUPPORT');
      expect(c.querySelectorAll('.dg-audience-answer').length).toBe(2);
    });

    test('answering "service desk" turns the banner PUBLIC on the spot', async () => {
      const c = await mountApp('Hello.\n', 'jira', unknown);
      await answer(c, 'customers read replies');
      const banner = c.querySelector('.dg-audience');
      expect(banner?.className).toContain('dg-audience-public');
      expect(banner?.textContent).toContain('Reply to customer');
      // And the question is gone: it has been answered.
      expect(c.querySelector('.dg-audience-ask')).toBeNull();
    });

    test('answering "internal" leaves a receipt with an UNDO, not an empty header', async () => {
      // That answer removes the audience, and a click never overwrites an existing entry, so without
      // this row a mis-click could not be corrected. Nothing is written until the decision is sent.
      const c = await mountApp('Hello.\n', 'jira', unknown);
      await answer(c, 'record it as internal');
      const banner = c.querySelector('.dg-audience');
      expect(banner).not.toBeNull();
      expect(banner?.className).toContain('dg-audience-answered');
      expect(banner?.textContent).toContain('Undo');
    });

    test('and UNDO puts the question back, so a mis-click costs nothing', async () => {
      decisions = [];
      const c = await mountApp('Hello.\n', 'jira', unknown);
      await answer(c, 'record it as internal');
      // `answer()` matches `.dg-audience-answer` by substring, and Undo carries that class.
      await answer(c, 'Undo');
      expect(c.querySelector('.dg-audience-ask')).not.toBeNull();
      // And nothing is carried into the decision afterwards.
      await clickApprove(c);
      expect('classifyProject' in decisions[0]!).toBe(false);
    });

    test('and an UNANSWERED question sends no classification at all', async () => {
      decisions = [];
      const c = await mountApp('Hello.\n', 'jira', unknown);
      await clickApprove(c);
      expect('classifyProject' in decisions[0]!).toBe(false);
    });

    test('the answer rides the APPROVAL, and it NAMES the destination it is about', async () => {
      decisions = [];
      const c = await mountApp('Hello.\n', 'jira', unknown);
      await answer(c, 'customers read replies');
      await clickApprove(c);
      expect(decisions).toHaveLength(1);
      // The destination comes from `request.destination`, so the CLI can refuse an answer about
      // another destination and `sanitiseDecision` need not guess a bare string's vocabulary.
      expect(decisions[0]?.classifyProject).toEqual({
        destination: 'jira',
        value: 'service_desk',
      });
    });

    /*
     * An inferred route stays unknown, in the one place the renderer asks the profile. The profile
     * puts no question to an inferred internal-note tool, so this fixture carries one: the
     * recompute is the wiring under test, and without `routeInferred` on it the banner would flip
     * to "Internal note -- the reporter never sees this" for a server nobody mapped, though the CLI
     * refuses to say so.
     */
    test('an INFERRED internal-note tool stays unknown after "service desk"', async () => {
      const STRANGER = 'mcp__some_vendor_jira__jira_add_internal_note';
      const c = await mountApp(
        'Hello.\n', 'jira', unknown, undefined,
        { matchedEntry: 'mcp__jsm__jira_add_internal_note' }, undefined, undefined, STRANGER
      );
      await answer(c, 'customers read replies');
      const banner = c.querySelector('.dg-audience');
      expect(banner?.className).toContain('dg-audience-unknown');
      expect(banner?.textContent).toContain(STRANGER);
      expect(banner?.textContent).not.toContain('never sees');
    });

    test('a PUBLIC audience asks nothing -- there is nothing missing', async () => {
      const c = await mountApp('Hello.\n', 'jira', publicAudience);
      expect(c.querySelector('.dg-audience-ask')).toBeNull();
    });
  });

  test('a stale renderer given no audience still reviews normally', async () => {
    // The field is additive and optional (no protocol bump), so its absence must be inert rather
    // than an error state.
    const c = await mountApp('Hello.\n', 'jira');
    expect(c.querySelector('.dg-audience')).toBeNull();
    expect(c.querySelector('.ProseMirror')?.textContent).toContain('Hello.');
  });
});

/*
 * A request with no body field is a review, not a refusal: a title-only `issue_write`, a
 * `create_pull_request` with no description. It opens a window with the prose and no draft, rather
 * than taking the hook's schema-drift fail-open with nobody having read the title.
 */
describe('a request carrying no body field', () => {
  const TITLE = [{ field: 'title', value: 'Export fails on empty tables' }];
  const bodyless = () => mountApp(null, 'github', undefined, undefined, undefined, TITLE);

  test('opens a real review: the prose is editable and Approve is live', async () => {
    const c = await bodyless();

    // Not the fatal screen.
    expect(c.textContent).not.toContain('This draft could not be loaded');
    const title = c.querySelector('input.dg-prose-field') as HTMLInputElement;
    expect(title.value).toBe('Export fails on empty tables');
    const approve = [...c.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Approve')
    ) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
  });

  test('says where the draft would be, rather than leaving a blank', async () => {
    const c = await bodyless();
    // A reviewer who reads a title and finds nothing under it has to be told nothing is missing.
    expect(c.textContent).toContain('No message body');
    // And the footer's promise stops implying a draft is part of what will be sent.
    expect(c.textContent).toContain('Exactly the fields above will be sent');
  });

  test('nothing about a BODY is wrong, so nothing is warned about', async () => {
    const c = await bodyless();
    // `renderNoBody`, not `render('')`: an empty body is a reviewer deleting the message, which
    // `body/empty` blocks. This is a payload that never carried one, and blocking it would put a
    // dead Approve in front of somebody reading a title they have no objection to.
    expect(c.textContent).toContain('No problems found');
  });

  /*
   * `current.canonical` is `''` here, and sending it would write `""` into a body field the agent
   * omitted: `prose/empty`'s probed 400 one field over. Asserted on the decision, where the
   * consequence shows.
   */
  test('and the approval carries NO body, only the prose', async () => {
    decisions = [];
    const c = await bodyless();
    await clickApprove(c);

    expect(decisions[0]).toMatchObject({
      action: 'approve',
      edited: false,
      // No entry for a body: the list had no block, so the map has none either.
      fields: { title: 'Export fails on empty tables' },
    });
    expect(Object.keys((decisions[0] as { fields: object }).fields)).toEqual(['title']);
  });
});

/**
 * A stale bundle refuses to review. The host cannot catch one: both sides of its protocol check
 * (`request.cjs`'s `parseRequest`) read `contract.json` at runtime, while the bundle's copy is
 * resolved at build time. A stale bundle sends an older decision shape, `sanitiseDecision` drops a
 * field it does not accept (`classifyProject` as a bare string, say), and the reviewer's audience
 * answer is lost with nothing written and nothing printed.
 */
describe('a request from another protocol', () => {
  test('cannot be approved, and says what to run', async () => {
    decisions = [];
    // Through `mountApp`, so the request is the same typed `WireRequest` every other test mounts.
    const container = await mountApp(
      'Hello.\n',
      'jira',
      undefined,
      undefined,
      undefined,
      undefined,
      PROTOCOL_VERSION + 1
    );

    expect(container.textContent).toContain('This draft could not be loaded');
    expect(container.textContent).toContain('bun run build:surface');
    // The fail-closed half, and the half a message alone does not prove: `Fatal` is reject-only, so
    // there is no Approve to click and no shortcut standing in for one.
    expect([...container.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([
      'Deny the send',
    ]);
    await pastShortcutGrace();
    pressCmdEnter();
    await settle();
    expect(decisions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. A stubbed `Editor`, from here to the end of the file (see the header).
// ---------------------------------------------------------------------------

/**
 * The fatal screen is reject-only, including by keyboard. A boundary around `<Editor>` alone would
 * leave a live Approve underneath; removing the footer alone would leave `⌘↵`, registered in an
 * effect that runs before the `editorError` early return. The `Editor` that throws is a stub
 * because no agent-authored input is known to make the real one throw.
 */
describe('the fatal screen the error boundary leaves behind', () => {
  beforeAll(() => {
    mock.module('./src/Editor', () => ({
      ...realEditor,
      Editor: () => {
        throw new Error('a node type the editor does not register');
      },
    }));
  });

  test('shows only a denial, and ⌘↵ does not approve', async () => {
    decisions = [];
    const container = await mountApp('# Draft nobody can see\n\nSend this.\n');

    // The precondition: the boundary fired and the footer is gone.
    expect(container.textContent).toContain('The editor could not load this draft');
    expect([...container.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([
      'Deny the send',
    ]);

    await pastShortcutGrace();
    pressCmdEnter();
    await settle();

    expect(
      decisions,
      'the fatal screen has no Approve button, and the shortcut that button advertises must not ' +
        'stand in for it: this would send a draft the reviewer could not read'
    ).toEqual([]);
  });

  test('the Deny button is still the way out', async () => {
    decisions = [];
    const container = await mountApp('Something.\n');
    (container.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(decisions).toEqual([
      {
        action: 'reject',
        reason:
          'draftgate could not display the draft for review: a node type the editor does not register',
      },
    ]);
  });
});

/**
 * An edit markdown cannot carry kills Approve, by button and by keyboard. A table cell is `block+`,
 * so a quote inside one is an ordinary gesture away, and `fromEditorDoc` writes `| x> quoted |`
 * with nothing thrown (pinned in `core/test/editor.test.ts`). `core` proves `render()` sets
 * `blocked`; this proves the wiring: `useReview.onChange` hands the document over, `blocked`
 * reaches the button, and `⌘↵` refuses too. The stub hands `onChange` the document directly,
 * because a headless TipTap cannot be typed into.
 */
describe('an edit markdown cannot carry takes Approve away', () => {
  /** The document the stub will report, set per test before mounting. */
  let edited: unknown = null;

  beforeAll(() => {
    mock.module('./src/Editor', () => ({
      Editor: ({ onChange }: { onChange: (doc: unknown) => void }) => {
        // One shot, after mount, exactly as a keystroke would arrive.
        useEffect(() => {
          if (edited !== null) onChange(edited);
        }, []);
        return <div data-testid="stub-editor" />;
      },
    }));
  });

  const p = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
  const QUOTE_IN_A_CELL = {
    type: 'doc',
    content: [
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{ type: 'tableHeader', content: [p('x'), { type: 'blockquote', content: [p('quoted')] }] }],
          },
        ],
      },
    ],
  };

  const approveButton = (container: HTMLElement) =>
    [...container.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Approve')
    ) as HTMLButtonElement | undefined;

  test('Approve is disabled, and the reason is on screen', async () => {
    decisions = [];
    edited = QUOTE_IN_A_CELL;
    const container = await mountApp('- [ ] x\n');
    await settle();

    const approve = approveButton(container);
    expect(approve, 'the footer should still be present -- this is not the fatal screen').toBeDefined();
    expect(approve!.disabled).toBe(true);
    expect(container.textContent).toContain('blockquote');
  });

  test('and ⌘↵ does not approve either', async () => {
    decisions = [];
    edited = QUOTE_IN_A_CELL;
    await mountApp('- [ ] x\n');
    await settle();

    await pastShortcutGrace();
    pressCmdEnter();
    await settle();

    expect(
      decisions,
      'the keyboard path is part of the control it stands in for: approving here sends a document ' +
        'the reviewer was never shown'
    ).toEqual([]);
  });

  test('an ordinary edit still approves, so the guard is not simply always on', async () => {
    decisions = [];
    edited = {
      type: 'doc',
      content: [p('An ordinary edited paragraph.')],
    };
    const container = await mountApp('- [ ] x\n');
    await settle();

    expect(approveButton(container)!.disabled).toBe(false);
    await pastShortcutGrace();
    pressCmdEnter();
    await settle();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ action: 'approve' });
  });
});

/**
 * The destination line renders when the profile composed one, and not otherwise. `probe.ts`
 * asserts its painted weight and colour; happy-dom mounts no stylesheet.
 */
describe('the destination line', () => {
  beforeAll(stubEditorCapturingChange().install);

  test('names the place, above the raw routing fields it summarises', async () => {
    const el = await mountApp(
      'hi\n',
      'jira',
      undefined,
      'acme-dev.atlassian.net / SUPPORT-123'
    );
    const row = el.querySelector('.dg-destination');
    expect(row?.querySelector('dt')?.textContent).toBe('destination');
    expect(row?.querySelector('dd')?.textContent).toBe('acme-dev.atlassian.net / SUPPORT-123');
    // Inside the one context container, so it shares its padding and border rather than drifting.
    expect(el.querySelector('.dg-context > .dg-destination')).not.toBeNull();
    // The raw fields it summarises are still there.
    expect(el.querySelector('.dg-context')?.textContent).toContain('SUPPORT-1');
  });

  test('and renders nothing at all when the profile could not compose one', async () => {
    // An unconfigured site gets no row at all, never a half-composed one.
    const el = await mountApp('hi\n', 'jira');
    expect(el.querySelector('.dg-destination')).toBeNull();
    expect(el.querySelector('.dg-context')).not.toBeNull();
    // Its own inert stub: an inherited one could fire an edit on mount.
    expect(el.querySelector('.dg-edited'), 'an earlier describe edited this draft').toBeNull();
  });
});

/**
 * The warning row sits in the footer, beside the button it disables, so warnings coming and going
 * never move the draft. The layout is CSS (`surface/harness/tokens.test.ts`); this covers the
 * wiring: which warning reaches the row, the unfurl, and that a clean draft draws no warning chrome.
 */
describe('the footer\'s warning row', () => {
  /**
   * Two blocking warnings (a heading and a table in a blockquote, both
   * `jira/blockquote-child-rejected`, probed 400s) and one info (an external image). A fixture with
   * two cannot tell a count from a hard-coded `+1 more`.
   */
  const FIXTURE_WITH_THREE =
    '# T\n\n> ## Quoted heading\n>\n> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n\n' +
    '![i](https://example.com/a.png)\n';

  const editor = stubEditorCapturingChange();
  beforeAll(editor.install);

  test('a clean draft says so in green, and the strip is still there', async () => {
    // The strip is never absent: chrome that appeared with a warning would move the draft under the
    // cursor.
    const el = await mountApp('Just prose, nothing to convert.\n', 'slack');
    // The strip is the problem list, so its empty state says so.
    expect(el.querySelector('.dg-status-ok')?.textContent).toContain('No problems found');
    expect(el.querySelector('.dg-status')?.getAttribute('data-severity')).toBe('ok');
    // No warning chrome inside it, and nothing unfurled.
    expect(el.querySelector('.dg-warnbar'), 'a clean draft drew a warning row').toBeNull();
    expect(el.querySelector('.dg-warn')).toBeNull();
    expect(el.querySelector('.dg-status[data-blocked="true"]')).toBeNull();
    // And the footer's promise.
    expect(el.querySelector('.dg-hint')?.textContent).toBe(
      'Exactly what you see above will be sent.'
    );
    // The tool name is in the OS title bar only (`windowTitle.cjs`): a full MCP name here ellipses
    // to `mcp__claude_ai_Atlas…` and names nothing.
    expect(el.querySelector('.dg-tool')).toBeNull();
  });

  test('the strip carries the severity, which is what colours it', async () => {
    // `shell.css` paints the rail and the chip from `data-severity`, and `probe.ts` reads the
    // colours back. No `warning`-severity code survives the round trip on any destination, so a
    // load gives the info tier...
    const info = await mountApp('Look ![x](https://example.com/a.png) here\n', 'jira');
    expect(info.querySelector('.dg-status')?.getAttribute('data-severity')).toBe('info');

    // ...and `warning` is reached the only way it can be: the reviewer types one.
    const warned = await typeBareUrl(editor);
    expect(warned.querySelector('.dg-status')?.getAttribute('data-severity')).toBe('warning');

    const blocked = await mountApp('# T\n\n> ## Quoted heading\n', 'jira');
    expect(blocked.querySelector('.dg-status')?.getAttribute('data-severity')).toBe('error');
    expect(blocked.querySelector('.dg-status[data-blocked="true"]')).not.toBeNull();
  });

  test('and the routing sits on the header line, not in a strip of its own', async () => {
    // One line beside the destination's name, still the same `<dl>`.
    const el = await mountApp('hi\n', 'slack');
    const context = el.querySelector('.dg-context');
    expect(context, 'no routing at all').not.toBeNull();
    expect(context?.closest('.dg-header'), 'the routing is not on the header line').not.toBeNull();
  });

  test('a warning is on the row itself, so it is read without a click', async () => {
    const el = await typeBareUrl(editor);
    // The chip sits outside the toggle, so the action links can come between it and the message.
    const row = el.querySelector('.dg-status-row');
    expect(row?.querySelector('.dg-sev')?.textContent).toBe('warning');
    expect(row?.querySelector('.dg-warnbar-msg')?.textContent).toContain(
      'from the next line onto the link'
    );
  });

  test('and the actions sit between the severity and the message, not after the chevron', async () => {
    // Asserted, because CSS `order` or a stray JSX move would put them back unnoticed.
    const el = await mountApp('# T\n\n> ## Quoted heading\n', 'jira');
    const row = el.querySelector('.dg-status-row')!;
    const kinds = [...row.children].map((c) =>
      c.classList.contains('dg-sev')
        ? 'severity'
        : c.classList.contains('dg-warnlink')
          ? 'action'
          : c.classList.contains('dg-warnbar')
            ? 'message'
            : 'other'
    );
    expect(kinds[0]).toBe('severity');
    expect(kinds.at(-1)).toBe('message');
    expect(kinds.filter((k) => k === 'action').length).toBeGreaterThan(0);
    // Every action comes before the message.
    expect(kinds.lastIndexOf('action')).toBeLessThan(kinds.indexOf('message'));
  });

  test('clicking the row unfurls it, and clicking again puts it away', async () => {
    const el = await typeBareUrl(editor);
    const lead = el.querySelector('.dg-warnbar') as HTMLButtonElement;
    // Furled on arrival, so nothing covers the draft; the row itself carries the warning.
    expect(el.querySelector('.dg-warn')).toBeNull();
    expect(lead.getAttribute('aria-expanded')).toBe('false');
    lead.click();
    await settle();
    expect(el.querySelector('.dg-warn'), 'the list did not open').not.toBeNull();
    expect(lead.getAttribute('aria-expanded')).toBe('true');
    // The repairs come with it, which is the reason it is worth opening.
    expect(el.querySelectorAll('.dg-warn-fix').length).toBe(2);
    lead.click();
    await settle();
    expect(el.querySelector('.dg-warn')).toBeNull();
    // And the row still carries the warning, which is what makes closing it safe.
    expect(lead.textContent).toContain('Slack joins');
  });

  test('several warnings are counted on the row, and all of them are behind it', async () => {
    // The row shows the most severe plus how many more; the overlay scrolls (`max-height: 40vh` in
    // `shell.css`) rather than growing past the window.
    const el = await mountApp(FIXTURE_WITH_THREE, 'jira');
    const lead = el.querySelector('.dg-warnbar') as HTMLButtonElement;
    expect(lead.textContent).toContain('+2 more');
    lead.click();
    await settle();
    expect(el.querySelectorAll('.dg-warn').length).toBe(3);
  });

  test('the most severe warning is the one on the row', async () => {
    // A body info (an external image) and then a prose error (a break in a Jira summary): only the
    // window's own `sortWarnings` puts the error first, and the row shows `warnings[0]`. A reviewer
    // facing a dead Approve reads why without clicking.
    const el = await mountApp(
      'Look ![x](https://example.com/a.png) here\n', 'jira', undefined, undefined, undefined,
      [{ field: 'fields.summary', value: 'Export fails\non empty tables' }],
      undefined, 'mcp__atlassian__editJiraIssue'
    );
    expect(el.querySelector('.dg-warnbar')?.textContent, 'the fixture needs both warnings')
      .toContain('+1 more');
    expect(el.querySelector('.dg-status-row > .dg-sev')?.textContent).toBe('blocking');
    expect(el.querySelector('.dg-status[data-blocked="true"]')).not.toBeNull();
    expect(buttonWithText(el, 'Approve').disabled).toBe(true);
  });

  test('a blocked draft offers the whole-document repair beside the message, as a link', async () => {
    // Three properties:
    //  - outside the toggle, because a button inside a button is invalid markup and the inner one
    //    stops being reachable by keyboard;
    //  - on the verdict strip, because in the footer it read as a sibling of Approve;
    //  - a `.dg-warnlink` and not a `.dg-btn`, because a button's box is taller than this row's
    //    text and would grow the strip the moment a warning appeared.
    const el = await mountApp('# Title\n\n> ## Quoted heading\n', 'jira');
    const fix = buttonWithText(el, 'Review suggested fix');
    expect(fix.closest('.dg-warnbar'), 'the repair is nested inside the toggle').toBeNull();
    expect(fix.closest('.dg-status'), 'the repair is not on the verdict strip').not.toBeNull();
    expect(fix.className).toContain('dg-warnlink');
    expect(fix.className).not.toContain('dg-btn');
  });

  test('and the footer holds the decision and nothing else', async () => {
    // In the footer, "Show me" and "Review suggested fix" would sit a few pixels from the one
    // action nobody can undo, styled identically to it. So the footer's buttons are exactly Reject
    // and Approve, on every draft.
    const el = await mountApp('# Title\n\n> ## Quoted heading\n', 'jira');
    const footerButtons = [...el.querySelectorAll('.dg-footer button')].map((b) =>
      (b.textContent ?? '').trim()
    );
    expect(footerButtons).toEqual(['Reject', 'Approve & send (⌘↵)']);
  });
});

/**
 * Nothing opens the list but the reviewer.
 *
 * The list is furled by default, and a warning arriving mid-edit must not unfurl anything over the
 * text being typed. That would be the jump this bar exists to remove, just sideways.
 */
describe('the list never opens itself', () => {
  const editor = stubEditorCapturingChange();
  beforeAll(editor.install);

  test('a warning arriving mid-edit reaches the row, and only the row', async () => {
    // A heading ladder (`### / ####`; `##` renders at its own weight), because `editorDocFor`
    // repairs most other Slack warnings on load: a bare URL comes back as `[url](url)`, an image as
    // the link Slack renders.
    const el = await mountApp('Just prose.\n', 'slack');
    expect(el.querySelector('.dg-warnbar'), 'the draft started with a warning').toBeNull();

    editor.fire(editorDocFor(renderBody('### Sub\n\n#### Deeper\n', 'slack')));
    await settle();

    expect(el.querySelector('.dg-warn'), 'it unfurled itself over the draft').toBeNull();
    expect(el.querySelector('.dg-warnbar-msg')?.textContent).toContain(
      'look the same in Slack'
    );
  });

  test('and a draft that becomes BLOCKED still only announces it on the row', async () => {
    // The loudest case and the most tempting to auto-open. The row carries the rail, the error ink
    // and the reason.
    const el = await mountApp('Some prose.\n', 'slack');
    editor.fire({ type: 'doc', content: [{ type: 'paragraph' }] });
    await settle();
    expect(el.querySelector('.dg-status[data-blocked="true"]')).not.toBeNull();
    expect(el.querySelector('.dg-warn'), 'a blocking warning unfurled the list').toBeNull();
    expect(buttonWithText(el, 'Approve').disabled).toBe(true);
  });
});

/**
 * "Show me": `body/structure-lost` is the only blocking warning with no repair, so the window's part
 * is to say where. An outline on the wrong node is worse than none, since it sends the reviewer to
 * edit innocent prose. `core` reports child indices and the renderer resolves them against the real
 * editor schema; these tests check the resolved range holds the node it claims.
 */
describe('showing the reviewer where a lost shape is', () => {
  beforeAll(stubEditorCapturingChange().install);

  /** A quote inside a table cell: one keystroke away, and markdown cannot carry it. */
  const QUOTE_IN_CELL = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Intro line.' }] },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableHeader',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'do the thing' }] },
                  {
                    type: 'blockquote',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  test('and the render carries it on the warning that has no repair', () => {
    const r = renderBody(fromEditorDoc(QUOTE_IN_CELL as never), 'slack', QUOTE_IN_CELL as never);
    const lostWarning = r.warnings.find((w) => w.code === 'body/structure-lost');
    expect(lostWarning, 'the draft did not report a lost structure').toBeDefined();
    expect(lostWarning?.fixes ?? [], 'this warning is not supposed to offer a repair').toEqual([]);
    // The table is child 1 of the doc, the row its 0, the cell the row's 0, the quote the cell's 1.
    expect(lostWarning?.editorPath).toEqual([1, 0, 0, 1]);
    expect(r.blocked).toBe(true);
  });

  /**
   * `rangeOfPath` accumulates real `nodeSize`s, and wrong arithmetic lands the outline on the wrong
   * text. So the check is that the range holds the node it claims (`nodeAt(from)`), not a
   * hand-built number.
   */
  test('the resolved range holds exactly the blockquote, in a real ProseMirror document', async () => {
    const { getSchema } = await import('@tiptap/core');
    const { editorExtensions } = await import('./src/Editor');
    const doc = getSchema(editorExtensions(true, undefined, 'link-only')).nodeFromJSON(QUOTE_IN_CELL);

    const range = rangeOfPath(doc, [1, 0, 0, 1]);
    expect(range, 'the path did not resolve in a document that holds it').not.toBeNull();
    const found = doc.nodeAt(range!.from);
    expect(found?.type.name).toBe('blockquote');
    expect(found?.textContent).toBe('quoted');
    // The range is the node's own extent, so an outline drawn on it covers the quote and nothing
    // either side of it.
    expect(range!.to - range!.from).toBe(found!.nodeSize);
  });

  /**
   * A path can resolve exactly to a `hardBreak` and still show nothing: it renders as `<br>`, which
   * has no box, so `outline` and `background` draw nothing. Asserted on the resolved node's
   * `isBlock` ("has a box to draw on"), not on a number.
   */
  test('an inline leaf widens to the block holding it, because a <br> has no box', async () => {
    const { getSchema } = await import('@tiptap/core');
    const { editorExtensions } = await import('./src/Editor');
    const schema = getSchema(editorExtensions(true, undefined, 'link-only'));

    // Every container a `hardBreak` can sit in, and the path each one actually reports -- taken
    // from `render()` rather than hand-written, so this cannot drift from what the window is given.
    const shapes: [string, unknown][] = [
      [
        'paragraph',
        { type: 'doc', content: [{ type: 'paragraph', content: [
          { type: 'text', text: 'a' }, { type: 'hardBreak' }] }] },
      ],
      // A list item carries its break (`- a` / two-space `b`), so the third container is a table
      // cell, which markdown writes on one line.
      [
        'a table cell',
        { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [
          { type: 'paragraph', content: [
            { type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] }] }] }] }] },
      ],
      [
        'a heading',
        { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [
          { type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] }] },
      ],
    ];

    for (const [label, json] of shapes) {
      const body = markdownFor(renderBody('', 'slack'), json as never);
      const lost = renderBody(body, 'slack', json as never).warnings.find(
        (w) => w.code === 'body/structure-lost'
      );
      expect(lost, `${label}: the shape did not report a loss, so this measures nothing`).toBeDefined();

      const doc = schema.nodeFromJSON(json as never);
      const range = rangeOfPath(doc, lost!.editorPath!);
      expect(range, `${label}: the reported path did not resolve`).not.toBeNull();
      const found = doc.nodeAt(range!.from)!;
      // The claim: something with a box, and it still contains the break that was lost.
      expect(found.isBlock, `${label}: outlined a node with nothing to draw`).toBe(true);
      expect(range!.to - range!.from).toBe(found.nodeSize);
    }
  });

  test('a path that no longer resolves draws NOTHING rather than guessing', async () => {
    // The ordinary case: the reviewer can type between the render that produced the path and the
    // click that uses it.
    const { getSchema } = await import('@tiptap/core');
    const { editorExtensions } = await import('./src/Editor');
    const doc = getSchema(editorExtensions(true, undefined, 'link-only')).nodeFromJSON(QUOTE_IN_CELL);

    expect(rangeOfPath(doc, [9])).toBeNull();
    expect(rangeOfPath(doc, [1, 0, 0, 1, 0, 5])).toBeNull();
    expect(rangeOfPath(doc, [-1])).toBeNull();
    // And an empty path, which would otherwise resolve to the whole document and outline the lot.
    expect(rangeOfPath(doc, [])).toBeNull();
  });

  test('the window offers the link only for a warning that knows where it is', async () => {
    // Slack's fixture warnings come from the markdown and carry no path. A heading ladder
    // (`### / ####`), since `slack/image-becomes-link` is silenced by the round trip.
    const el = await mountApp('### Three\n\n#### Four\n', 'slack');
    expect(el.querySelector('.dg-warnbar'), 'no warning at all, so this proves nothing').not.toBeNull();
    expect([...el.querySelectorAll('.dg-warnlink')].map((b) => b.textContent)).not.toContain('Show me');
  });
});

/**
 * The audience kind reaches the root element, which is what lets a destination sheet paint it.
 * happy-dom mounts no stylesheet, so this proves the hook and not the paint;
 * `surface/harness/probe.ts` reads the painted ground back out of the real window.
 */
describe('the audience kind is published to the destination sheets', () => {
  beforeAll(stubEditorCapturingChange().install);

  const INTERNAL = {
    kind: 'internal' as const,
    label: 'Internal note',
    detail: 'The reporter never sees this.',
  };

  test('an internal note marks the root, so jira.css can give it Jira\'s own ground', async () => {
    await mountApp('Checked the queue table.\n', 'jira', INTERNAL);
    expect(document.documentElement.dataset.audience).toBe('internal');
  });

  test('and a public one is marked differently, never as internal', async () => {
    // The two must not collapse into one ground.
    await mountApp('Thanks for the report.\n', 'jira', {
      kind: 'public',
      label: 'Reply to customer',
      detail: 'The reporter sees this in the portal.',
    });
    expect(document.documentElement.dataset.audience).toBe('public');
  });

  test('and no audience leaves the attribute off entirely', async () => {
    await mountApp('hi\n', 'slack');
    expect(document.documentElement.dataset.audience).toBeUndefined();
  });
});

/**
 * The settle hook's wiring, mounted: a timer armed to an absolute deadline, and a ref written during
 * render that survives the re-render the timer causes. The rules themselves are pure and pinned in
 * `surface/settledWarnings.test.ts`.
 */
describe('the warning list settles rather than flickering', () => {
  // Fabricated codes: this describe tests settling, so any code will do -- hence the cast.
  const w = (code: string, severity: Warning['severity']): Warning => ({
    code: code as Warning['code'],
    severity,
    message: code,
  });

  /** A component that does exactly what `Review` does with the hook, and nothing else. */
  let push: ((next: Warning[]) => void) | null = null;

  function Harness({ initial }: { initial: Warning[] }) {
    const [live, setLive] = useState(initial);
    push = setLive;
    const shown = useSettledWarnings(live, DELAY_MS);
    return (
      <ul data-testid="shown">
        {shown.map((x) => (
          <li key={x.code}>{x.code}</li>
        ))}
      </ul>
    );
  }

  const codes = (el: HTMLElement) =>
    [...el.querySelectorAll('li')].map((li) => li.textContent);

  /** The delay `Harness` passes explicitly. A check for withholding runs 10ms into it. */
  const DELAY_MS = 40;

  /**
   * Poll until the list reads `expected`, for a second at most. The hook's timer re-renders through
   * React's scheduler, so a fixed sleep past the deadline can still read the render before it.
   */
  const eventually = async (el: HTMLElement, expected: string[], why?: string) => {
    for (let i = 0; i < 200 && JSON.stringify(codes(el)) !== JSON.stringify(expected); i++) {
      await wait(5);
    }
    expect(codes(el), why).toEqual(expected);
  };

  test('the first render shows immediately -- a loaded draft never waits to be judged', async () => {
    const el = await mount(<Harness initial={[w('a/one', 'warning')]} />);
    expect(codes(el)).toEqual(['a/one']);
  });

  test('a non-blocking warning waits for the typing to stop, then appears', async () => {
    const el = await mount(<Harness initial={[]} />);
    push!([w('slack/url-swallows-next-line', 'warning')]);
    await wait(10);
    expect(codes(el), 'it appeared mid-keystroke, which is the flicker').toEqual([]);
    await eventually(
      el, ['slack/url-swallows-next-line'], 'it never arrived, which would be a warning nobody sees'
    );
  });

  test('a blocking warning shows while a new non-blocking one beside it still waits', async () => {
    // Each warning keeps its own clock, and a blocking one never waits: it has already killed
    // Approve.
    const el = await mount(<Harness initial={[]} />);
    push!([w('body/empty', 'error'), w('a/slow', 'warning')]);
    await wait(10);
    expect(codes(el)).toEqual(['body/empty']);
    await eventually(el, ['body/empty', 'a/slow']);
  });

  test('a code that leaves and returns waits again rather than snapping back', async () => {
    // The ref carries arrival stamps across renders and must forget a code that left: carried
    // forward, a warning that flickered once would reappear instantly ever after.
    const el = await mount(<Harness initial={[]} />);
    push!([w('a/one', 'warning')]);
    await eventually(el, ['a/one'], 'it never settled, so the return proves nothing');
    push!([]);
    await wait(10);
    expect(codes(el), 'a warning that stopped being true stayed on screen').toEqual([]);
    push!([w('a/one', 'warning')]);
    await wait(10);
    expect(codes(el), 'it snapped back on its old clock').toEqual([]);
    await eventually(el, ['a/one']);
  });
});

/**
 * Applying a repair changes the verdict at once. Only a warning's arrival waits and a repair
 * removes one, so the row goes on the render the click causes; otherwise "Apply fix" would look
 * like it did nothing.
 */
describe('applying a repair', () => {
  const editor = stubEditorCapturingChange();
  beforeAll(editor.install);

  async function applyFirstRepair(el: HTMLElement): Promise<void> {
    await unfurlWarnings(el);
    buttonWithText(el, 'Write it as an explicit link').click();
    await settle();
    buttonWithText(el, 'Apply fix').click();
    await settle();
  }

  test('the warning is gone immediately, without waiting out the settle delay', async () => {
    const el = await typeBareUrl(editor);
    expect(el.querySelector('.dg-warnbar'), 'nothing to repair, so this proves nothing').not.toBeNull();

    await unfurlWarnings(el);
    buttonWithText(el, 'Write it as an explicit link').click();
    await settle();
    // A minute's delay from the click on, so only a removal that skips the wait passes.
    settleDefaultMs = 60_000;
    buttonWithText(el, 'Apply fix').click();
    await settle();

    expect(el.querySelector('.dg-warnbar'), 'the repaired warning was still on screen').toBeNull();
    expect(el.querySelector('.dg-status')?.getAttribute('data-severity')).toBe('ok');
    expect(el.querySelector('.dg-status-ok')).not.toBeNull();
  });

  test('and the draft really was repaired, which is the other half of the claim', async () => {
    // Without this the test above passes for a window that hides warnings on any click.
    const el = await typeBareUrl(editor);
    await applyFirstRepair(el);
    expect(el.querySelector('.dg-edited'), 'no edit was registered').not.toBeNull();

    decisions = [];
    await clickApprove(el);
    expect(decisions).toHaveLength(1);
    expect(sentBody(decisions[0], 'slack')).toContain(
      '[https://example.com/a](https://example.com/a)'
    );
    // And the repair is recorded under its own identity, which is what `draftgate digest` groups by.
    expect((decisions[0] as { fixes?: { label: string }[] }).fixes?.[0]?.label).toBe(
      'Write it as an explicit link'
    );
  });

  test('the modal closes, and nothing is left drawn over the draft', async () => {
    const el = await typeBareUrl(editor);
    await applyFirstRepair(el);
    expect(el.querySelector('.dg-modal')).toBeNull();
    expect(el.querySelector('.dg-warn'), 'the unfurled list outlived the warning it held').toBeNull();
  });
});

/**
 * Two ways the "Show me" outline could point at the wrong node without going through
 * `lostHighlight.ts`.
 */
describe('pointing at a lost shape cannot point at the wrong one', () => {
  const QUOTE_IN_CELL = {
    type: 'doc',
    content: [
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableHeader',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
                  { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'q' }] }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const editor = stubEditorCapturingChange();
  beforeAll(editor.install);

  test('the path follows the draft, so an edit above the shape does not misdirect it', async () => {
    /*
     * `editorPath` indexes the editor's current document, so a block inserted above the lost shape
     * moves the outline with it. The wiring under test: the window hands down the live row's path,
     * not one cached elsewhere.
     */
    const el = await mountApp('hi\n', 'slack');
    editor.fire(QUOTE_IN_CELL);
    await settle();
    expect(
      el.querySelector('.dg-warnbar-msg')?.textContent,
      'the draft is not reporting a lost shape'
    ).toContain('markdown cannot express');

    // Push the offending shape one block further down.
    editor.fire({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'new first block' }] },
        ...QUOTE_IN_CELL.content,
      ],
    });
    // No wait for `SETTLE_MS` anywhere: `body/structure-lost` blocks, and a blocking warning is
    // never withheld -- the row on screen is the one this render produced.
    await settle();
    buttonWithText(el, 'Show me').click();
    await settle();

    // `[1, 0, 0, 1]`, the position in the CURRENT document -- not `[0, 0, 0, 1]`, where it was
    // before the edit.
    expect(highlightOf(el)?.path).toEqual([1, 0, 0, 1]);
  });

  test('and a pointer into a replaced document is dropped rather than reused', async () => {
    /*
     * `applyFix` swaps `doc` wholesale and the rebuilt editor re-runs the highlight effect, so a
     * pointer still held would outline whatever now sits at the old path. Two edits reach it, since
     * `body/structure-lost` offers "Show me" and never a repair: point at a lost shape, edit it into
     * a different problem that has a repair, and apply that.
     */
    const el = await mountApp('hi\n', 'jira');
    editor.fire(QUOTE_IN_CELL);
    await settle();
    buttonWithText(el, 'Show me').click();
    await settle();
    expect(highlightOf(el), 'nothing was highlighted, so this proves nothing').not.toBeNull();

    // A heading inside a blockquote: a probed Jira 400, and one of the few blocking warnings that
    // does carry a whole-document repair.
    editor.fire({
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Quoted' }] }],
        },
      ],
    });
    await settle();
    buttonWithText(el, 'Review suggested fix').click();
    await settle();
    buttonWithText(el, 'Apply fix').click();
    await settle();

    expect(highlightOf(el), 'a pointer into the old document survived the repair').toBeNull();
  });

  test('an unfurled list closes itself once there is nothing left in it', async () => {
    // Unfurl, then edit until clean: a `warningsOpen` left true would let the next warning unfurl
    // itself across the draft.
    const el = await typeBareUrl(editor);
    await unfurlWarnings(el);
    expect(el.querySelector('.dg-warn')).not.toBeNull();

    editor.fire({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'clean' }] }] });
    await settle();
    expect(el.querySelector('.dg-warnbar'), 'the draft is not clean yet').toBeNull();

    editor.fire(QUOTE_IN_CELL);
    await settle();
    expect(el.querySelector('.dg-warn'), 'a new warning unfurled itself over the draft').toBeNull();
  });
});

/**
 * `edited` is sticky once `fixes` is non-empty (`useReview.ts`). The body sent is always the one on
 * screen, so what the stickiness protects is the audit log: an accepted repair logged with
 * `edited: false` lands in the digest's `unedited` bucket ("the gate found nothing to do") while
 * `fixes` says a repair was accepted.
 */
describe('a repair, and then one more keystroke', () => {
  const editor = stubEditorCapturingChange();
  beforeAll(editor.install);

  test('an accepted repair keeps `edited` true even when the text comes back to the baseline', async () => {
    /*
     * The only gesture that reaches the stickiness: a bare URL's repair is silenced on load, so this
     * accepts a blocked draft's whole-document `suggestedFix`, then edits the text back to what
     * arrived. The document equals `baseline` again, with a repair on the record.
     */
    const canonical = 'Intro.\n\n> ## Heading in a quote\n';
    const el = await mountApp(canonical, 'jira');

    buttonWithText(el, 'Review suggested fix').click();
    await settle();
    buttonWithText(el, 'Apply fix').click();
    await settle();
    expect(el.querySelector('.dg-edited'), 'the repair did not register as an edit').not.toBeNull();

    // Back to exactly what arrived: the document the editor held on load, re-fired.
    const loaded = renderBody(canonical, 'jira');
    const baseline = markdownFor(loaded, editorDocFor(loaded));
    editor.fire(editorDocFor(renderBody(baseline, 'jira')) as never);
    await settle();

    expect(
      el.querySelector('.dg-edited'),
      'the draft stopped counting as edited, so the accepted repair would be logged as untouched'
    ).not.toBeNull();
  });
});

/**
 * A repair applied after the reviewer kept typing carries their text. A repair body is built from
 * the body as it was then, and applying one replaces the whole document. A row is on screen only
 * while its warning is in the live render, so its `FixOffer` matches the editor's document. These
 * tests pin the consequence: the keystrokes are in the sent body.
 */
describe('a repair clicked while the reviewer keeps typing', () => {
  const editor = stubEditorCapturingChange();
  beforeAll(editor.install);

  /**
   * More text on the end, as one paragraph with hard breaks: three paragraphs serialise
   * blank-line-separated and the warning goes away, which is the removal case instead.
   */
  const TYPED_PAST = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'See https://example.com/a' },
          { type: 'hardBreak' },
          { type: 'text', text: 'next line' },
          { type: 'hardBreak' },
          { type: 'text', text: 'AND MORE' },
        ],
      },
    ],
  };

  /** An edit with no bare URL in it, so the warning is gone from the LIVE render. */
  const CLEANED = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'clean' }] }],
  };

  test('the repair applies to the CURRENT draft, so the keystrokes after it survive', async () => {
    const el = await typeBareUrl(editor);
    // Unfurled before the second edit, so the repair button on screen was first drawn against the
    // old body. That is the shape a stale row would break.
    await unfurlWarnings(el);
    editor.fire(TYPED_PAST);
    await settle();
    // The same code, so the row is still there and never had to settle again.
    expect(el.querySelector('.dg-warn'), 'the edit removed the row, so this tests nothing')
      .not.toBeNull();

    buttonWithText(el, 'Write it as an explicit link').click();
    await settle();
    buttonWithText(el, 'Apply fix').click();
    await settle();

    decisions = [];
    await clickApprove(el);
    expect(decisions).toHaveLength(1);
    const body = sentBody(decisions[0], 'slack');
    // Both halves: the repair applied, and nothing was discarded.
    expect(body, 'the repair did not apply').toContain(
      '[https://example.com/a](https://example.com/a)'
    );
    expect(body, "the reviewer's keystrokes were discarded by a pre-edit repair body").toContain(
      'AND MORE'
    );
  });

  test('a warning the edit removed takes its row with it, so there is nothing stale to click',
    async () => {
      // The display is a filter of the live list, so the row goes on the same render as its warning.
      const el = await typeBareUrl(editor);
      await unfurlWarnings(el);
      expect(el.querySelector('.dg-warn'), 'nothing was unfurled, so this proves nothing')
        .not.toBeNull();

      editor.fire(CLEANED);
      await settle();

      expect(el.querySelector('.dg-warn'), 'a row outlived the warning it describes').toBeNull();
      expect(el.querySelector('.dg-warnbar')).toBeNull();
      expect(el.querySelector('.dg-status')?.getAttribute('data-severity')).toBe('ok');
    });

  test('and the edit itself is still what would be sent', async () => {
    const el = await mountApp(BARE_URL, 'slack');
    editor.fire(CLEANED);
    await settle();
    decisions = [];
    await clickApprove(el);
    // The reviewer's own text, not the pre-edit body and not a repair of it.
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.action).toBe('approve');
    // With the trailing newline, because `matchTrailingNewline` ends the round trip the way the
    // draft this review opened with ended. See `approvedUntouched`.
    expect(sentBody(decisions[0], 'slack')).toBe('clean\n');
  });
});

/**
 * `⌘↵` while a repair preview is open, on a draft that is not blocked: a blocked draft has a
 * disabled Approve, so the test would pass without measuring the guard.
 */
describe('⌘↵ while a repair preview is open', () => {
  const editor = stubEditorCapturingChange();
  beforeAll(editor.install);

  test('the repair preview swallows ⌘↵ instead of approving the unrepaired draft', async () => {
    decisions = [];
    const container = await typeBareUrl(editor);
    await unfurlWarnings(container);

    const fix = container.querySelector('.dg-warn-fix') as HTMLButtonElement | null;
    expect(fix, 'the warning offered no repair, so this test is measuring nothing').not.toBeNull();
    fix!.click();
    await settle();
    expect(container.querySelector('.dg-modal'), 'the preview did not open').not.toBeNull();

    await pastShortcutGrace();
    pressCmdEnter();
    await settle();

    expect(
      decisions,
      'the reviewer was being asked whether to apply a repair, and the shortcut sent the version ' +
        'they were being asked to replace'
    ).toEqual([]);
    // And the modal is still up: the key did nothing at all, rather than doing something else.
    expect(container.querySelector('.dg-modal')).not.toBeNull();
  });

  test('and with the preview closed again it approves, so the shortcut still works', async () => {
    // The positive control: without it, "no decision" passes for a shortcut that is broken.
    decisions = [];
    const container = await typeBareUrl(editor);
    await unfurlWarnings(container);
    (container.querySelector('.dg-warn-fix') as HTMLButtonElement).click();
    await settle();
    // "Cancel" is the non-primary button in the modal's own action row.
    (container.querySelector('.dg-modal .dg-btn:not(.dg-btn-primary)') as HTMLButtonElement).click();
    await settle();
    expect(container.querySelector('.dg-modal')).toBeNull();

    await pastShortcutGrace();
    pressCmdEnter();
    await settle();
    // `edited: true` and the reviewer's own text: they typed the URL, so this is a hand edit and
    // the body is theirs. The repair was cancelled, so `fixes` stays empty.
    expect(decisions).toEqual([
      {
        action: 'approve' as const,
        fields: { message: 'See https://example.com/a\nnext line\n' },
        edited: true,
        bodyEdited: true,
        silenced: [] as string[],
        fixes: [],
      },
    ]);
  });
});

/**
 * What the round trip changed is on screen. Loading rewrites the draft, and the codes it silences
 * are not all improvements:
 *
 *   `slack/image-becomes-link`      `![x](u)` becomes `[x](u)`       -- the reader sees the same
 *   `slack/url-swallows-next-line`  the URL becomes an explicit link -- the reader sees better
 *   `jira/task-item-media-only`     a checkbox is destroyed          -- the reader sees worse
 *
 * `- [ ] ![i](u)` plus a normal item arrives as two checkboxes and is sent as one checkbox and a
 * loose image (`hoistMedia`). Nothing here classifies the codes as fixed or lost: nothing in a
 * `Warning` tells them apart.
 */
describe('the round trip cannot change the draft invisibly', () => {
  // `core/test/editor.test.ts` pins the conversion; this pins that the window says so.
  const CHECKBOX_DESTROYED = '- [ ] ![i](https://e.test/a.png)\n- [ ] a normal item\n';

  const editor = stubEditorCapturingChange();
  beforeAll(editor.install);

  test('a destroyed checkbox is reported on the strip, on a draft nobody touched', async () => {
    const el = await mountApp(CHECKBOX_DESTROYED, 'jira');
    const marker = el.querySelector('.dg-changed');
    expect(marker, 'nothing on the strip says the draft was rewritten').not.toBeNull();
    expect(marker?.textContent).toContain('1 changed on load');
  });

  test('and unfurling names it, in the warning\'s own words', async () => {
    const el = await mountApp(CHECKBOX_DESTROYED, 'jira');
    (el.querySelector('.dg-changed') as HTMLButtonElement).click();
    await settle();

    const head = el.querySelector('.dg-warn-silenced-head');
    expect(head, 'the silenced section has no heading').not.toBeNull();
    // The two clauses that are certainly true, and no third one guessing which kind this is.
    expect(head?.textContent).toContain("True of the agent's draft");
    expect(head?.textContent).toContain('not of what will be sent');

    const rows = [...el.querySelectorAll('.dg-warn-silenced')];
    expect(rows).toHaveLength(1);
    // `jira/task-item-media-only`'s own message. The reviewer is told a checkbox went, by the rule
    // that knows it -- this row invents no wording of its own.
    expect(rows[0]?.textContent).toContain('checkbox');
  });

  test('a silenced row says NOTE, in a word no live row uses', async () => {
    /*
     * Not a severity word: `WARNING` below a green `No problems found` leaves the reviewer unable to
     * place which body it is about (the colour is repainted per tier, pinned by `probe.ts`). Exactly
     * `note`, not merely different: `info` would pass a difference check on this tree, where
     * `jira/task-item-media-only` is silenced and `jira/external-image-embedded` stays live. See
     * `SILENCED_LABEL`.
     */
    const el = await mountApp(CHECKBOX_DESTROYED, 'jira');
    (el.querySelector('.dg-changed') as HTMLButtonElement).click();
    await settle();

    const chip = (row: Element | null) => row?.querySelector('.dg-sev')?.textContent;
    expect(chip(el.querySelector('.dg-warn-silenced'))).toBe('note');
    // The live row beside it keeps its severity word, which is what makes the pair readable.
    const live = [...el.querySelectorAll('.dg-warn')].find(
      (r) => !r.classList.contains('dg-warn-silenced')
    );
    expect(live, 'the fixture stopped producing a live warning, so this proves nothing').toBeDefined();
    expect(chip(live ?? null)).toBe('info');
  });

  test('a silenced row offers none of the repairs its warning carries', async () => {
    // A repair body built from `canonical` would replace the draft with a pre-normalisation one.
    // `BARE_URL`'s silenced code carries two repairs, so a row that drew them fails here. "Show me"
    // has the same `.dg-warn-fix` class, though no silenced code has a path to offer it: they come
    // from a render with no document.
    const candidate = renderBody(BARE_URL, 'slack').warnings.find(
      (w) => w.code === 'slack/url-swallows-next-line'
    );
    expect(candidate?.fixes, 'the silenced code has no repairs, so this proves nothing').toHaveLength(2);
    const el = await mountApp(BARE_URL, 'slack');
    (el.querySelector('.dg-changed') as HTMLButtonElement).click();
    await settle();
    const row = el.querySelector('.dg-warn-silenced');
    expect(row, 'the bare URL was not silenced on load').not.toBeNull();
    expect(row!.querySelector('.dg-warn-fix')).toBeNull();
  });

  test('the code reaches the decision, so the digest sees what the agent wrote', async () => {
    const el = await mountApp(CHECKBOX_DESTROYED, 'jira');
    decisions = [];
    await clickApprove(el);
    expect(decisions).toHaveLength(1);
    const d = decisions[0] as { silenced?: string[]; edited?: boolean };
    expect(d.silenced, 'the silenced code was not reported to the CLI').toEqual([
      'jira/task-item-media-only',
    ]);
    // NOT edited: draftgate rewrote this, not a human. The two facts travel separately for exactly
    // this reason -- the log must not book draftgate's own rewrite as a reviewer's prose.
    expect(d.edited).toBe(false);
    // And the body sent is the one that was shown: one checkbox, image hoisted out.
    expect(sentBody(decisions[0])).toBe('- [ ] a normal item\n\n![i](https://e.test/a.png)\n');
  });

  test('a draft the round trip leaves alone reports nothing, and says so as []', async () => {
    // `[]` and not absent: a reporting surface saying "nothing was silenced" is a positive claim,
    // and absence means a surface that cannot report at all. See `HumanDecision`.
    const el = await mountApp('Just prose.\n', 'jira');
    expect(el.querySelector('.dg-changed'), 'a clean draft claimed it was rewritten').toBeNull();
    decisions = [];
    await clickApprove(el);
    expect((decisions[0] as { silenced?: string[] }).silenced).toEqual([]);
  });

  test('the strip still says green when the only thing to report is the rewrite', async () => {
    // Green is a claim about the body being sent, which is true -- and it is exactly the body the
    // reviewer needs telling is not the one the agent wrote. So both, and the list still opens.
    const el = await mountApp('Look ![x](https://e.test/a.png) here\n', 'slack');
    expect(el.querySelector('.dg-status-ok'), 'the sent body has a problem, so this is the wrong fixture')
      .not.toBeNull();
    const marker = el.querySelector('.dg-changed');
    expect(marker, 'a rewritten draft looked completely clean').not.toBeNull();
    (marker as HTMLButtonElement).click();
    await settle();
    expect(el.querySelector('.dg-warn-silenced'), 'the list refused to open on a clean draft')
      .not.toBeNull();

    // This is the `edited === false` footer under a panel saying draftgate rewrote the draft, so it
    // names the body on screen and never "as written".
    expect(el.querySelector('.dg-hint')?.textContent).toBe(
      'Exactly what you see above will be sent.'
    );
  });

  test("a warning the REVIEWER edits away is never booked as draftgate's rewrite", async () => {
    /*
     * Whose work the row reports. A Slack heading ladder survives the round trip, so nothing is
     * silenced on load; flatten it by hand and the code leaves the live list. Compared against
     * `canonical`, the row would credit draftgate with the reviewer's edit and ship the code as
     * `silenced`, which `draftgate digest` reads as "the reviewer was NOT shown the warning".
     */
    const el = await mountApp('## Two\n\n### Three\n', 'slack');
    expect(
      el.querySelector('.dg-changed'),
      'the loaded draft silenced something, so this fixture cannot tell the candidate sets apart'
    ).toBeNull();

    // The reviewer's own repair: one heading level, so the ladder is gone.
    editor.fire(editorDocFor(renderBody('## Two\n\n## Three\n', 'slack')) as never);
    await settle();

    expect(
      el.querySelector('.dg-changed'),
      'the reviewer fixed it, and the window credited draftgate'
    ).toBeNull();
    expect(el.querySelector('.dg-warn-silenced')).toBeNull();

    decisions = [];
    await clickApprove(el);
    const d = decisions[0] as { silenced?: string[]; edited?: boolean };
    // `[]`, not the code: draftgate silenced nothing here. And `edited`, because a human did.
    expect(d.silenced, "the reviewer's repair was logged as draftgate's rewrite").toEqual([]);
    expect(d.edited).toBe(true);
  });

  test('an edit that brings the code BACK stops the row claiming it is gone', async () => {
    /*
     * The row is derived against the current body. Only `slack/url-swallows-next-line` can come
     * back: `markdownFor` always hoists media out of a Jira task item, while the editor does not
     * autolink, so a typed URL stays bare.
     */
    const el = await mountApp(BARE_URL, 'slack');
    expect(
      el.querySelector('.dg-changed'),
      'the loaded draft did not silence anything, so this tests nothing'
    ).not.toBeNull();

    editor.fire(TYPED_BARE_URL);
    await settle();

    expect(
      el.querySelector('.dg-changed'),
      'the code is true of the draft again, so nothing was silenced'
    ).toBeNull();
    // And it is a real warning now, on the row where something can be done about it.
    expect(el.querySelector('.dg-warnbar-msg')?.textContent).toContain(
      'from the next line onto the link'
    );
  });
});

/**
 * The repair preview is modal, and its captured body cannot go stale. `aria-modal` touches neither
 * the tab order nor focus, and `.dg-modal` is last in the DOM, so tabbing to "Apply fix" would walk
 * through the editor; typing there and applying would discard those keystrokes. Two guards:
 * `FixDiff` moves focus in and wraps Tab, which closes the path, and `App.tsx` closes the dialog
 * when the body its preview was computed against changes, which makes staleness unable to matter.
 */
describe('the repair preview is modal, and its body cannot go stale', () => {
  const editor = stubEditorCapturingChange();
  beforeAll(editor.install);

  /** Open the preview the way a reviewer does, and hand back the container. */
  async function openPreview(): Promise<HTMLElement> {
    // `decisions` outlives a test, so every "no decision" assertion here starts clean.
    decisions = [];
    const el = await typeBareUrl(editor);
    await unfurlWarnings(el);
    const fix = el.querySelector('.dg-warn-fix') as HTMLButtonElement | null;
    expect(fix, 'the warning offered no repair, so this test is measuring nothing').not.toBeNull();
    fix!.click();
    await settle();
    expect(el.querySelector('.dg-modal'), 'the preview did not open').not.toBeNull();
    return el;
  }

  const press = (key: string, shiftKey = false) =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
    );

  test('focus moves INTO the dialog when it opens', async () => {
    const el = await openPreview();
    // The panel, not "Apply fix": applying discards the editor's undo, and Enter would be one
    // keystroke away.
    expect(document.activeElement).toBe(el.querySelector('.dg-modal'));
  });

  test('Tab cannot leave the dialog, in either direction', async () => {
    const el = await openPreview();
    const cancel = el.querySelector('.dg-modal .dg-btn:not(.dg-btn-primary)') as HTMLButtonElement;
    const apply = buttonWithText(el, 'Apply fix');

    // Forward off the last stop wraps to the first, rather than into the editor behind.
    apply.focus();
    press('Tab');
    await settle();
    expect(document.activeElement, 'Tab off "Apply fix" escaped the dialog').toBe(cancel);

    // And backward off the first stop wraps to the last.
    cancel.focus();
    press('Tab', true);
    await settle();
    expect(document.activeElement, 'Shift+Tab off "Cancel" escaped the dialog').toBe(apply);
  });

  test('Escape closes it, because Tab no longer can', async () => {
    const el = await openPreview();
    press('Escape');
    await settle();
    expect(el.querySelector('.dg-modal'), 'Escape left the dialog up').toBeNull();
    // Cancelled, not applied: nothing was sent and the draft is untouched.
    expect(decisions).toEqual([]);
  });

  test('THE guard: a draft that changes underneath closes the preview', async () => {
    // Fired straight at the editor, so it stands for any path that edits the draft while the
    // dialog is up, including one the focus trap does not know about.
    const el = await openPreview();
    editor.fire({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See https://example.com/a' },
            { type: 'hardBreak' },
            { type: 'text', text: 'next line, and more the reviewer typed' },
          ],
        },
      ] as never,
    } as never);
    await settle();

    expect(
      el.querySelector('.dg-modal'),
      'the preview outlived the draft it was computed against, so Apply would discard the edit'
    ).toBeNull();
  });

  test('and the edit that closed it SURVIVES, which is the whole point', async () => {
    // The positive control: "the modal closed" also passes for a window that dropped the keystrokes.
    const el = await openPreview();
    editor.fire({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See https://example.com/a' },
            { type: 'hardBreak' },
            { type: 'text', text: 'next line, and more the reviewer typed' },
          ],
        },
      ] as never,
    } as never);
    await settle();

    decisions = [];
    await clickApprove(el);
    const sent = sentBody(decisions[0], 'slack') ?? '';
    expect(sent, 'the reviewer typed this and it did not go out').toContain(
      'and more the reviewer typed'
    );
  });
});

/**
 * The mention note is derived per render, so it goes when the reviewer deletes the mention.
 * `probe.ts` asserts it renders in the real window.
 */
describe('the mention note tracks the live draft', () => {
  const editor = stubEditorCapturingChange();
  beforeAll(() => editor.install());

  const PINGED = 'Heads up <@U0123ABCDEF> and <!here>, please look.\n';
  const docFor = (body: string) => editorDocFor(renderBody(body, 'slack')) as unknown;

  test('it is there on load, and names the blast radius', async () => {
    const el = await mountApp(PINGED, 'slack');
    const note = el.querySelector('.dg-mentions');
    expect(note, 'no mention note for a draft carrying two mentions').not.toBeNull();
    // A broadcast leads whatever else is present -- see `mentionNote`.
    expect(note!.textContent).toContain('notifies the channel');
    expect(note!.getAttribute('data-broadcast')).toBe('true');
  });

  test('deleting the ping drops the broadcast wording', async () => {
    const el = await mountApp(PINGED, 'slack');
    editor.fire(docFor('Heads up <@U0123ABCDEF>, please look.\n'));
    await settle();
    const note = el.querySelector('.dg-mentions');
    expect(note, 'one mention remains, so the note must too').not.toBeNull();
    expect(note!.textContent).toBe('1 mention');
    // The claim that would go stale.
    expect(note!.getAttribute('data-broadcast')).toBeNull();
  });

  test('deleting every mention removes the note entirely', async () => {
    const el = await mountApp(PINGED, 'slack');
    editor.fire(docFor('Heads up, please look.\n'));
    await settle();
    expect(
      el.querySelector('.dg-mentions'),
      'the note outlived the mentions it describes'
    ).toBeNull();
    // And the strip is still there.
    expect(el.querySelector('.dg-status')).not.toBeNull();
  });

  test('Jira gets the note from a CHIP, with no token patterns at all', async () => {
    // Jira has no token patterns (`[~accountid:x]` is not a token, probed), so this note can only
    // come from the `mention` node.
    const el = await mountApp(
      'Hi [@Ada Lovelace](mention:712020:5e0c4a1b-8d2f-4c3a-9b7e-1f6a2d8c4e90), look.\n',
      'jira'
    );
    const note = el.querySelector('.dg-mentions');
    expect(note, 'a Jira mention chip must be reported too').not.toBeNull();
    expect(note!.textContent).toBe('1 mention');
  });

  test("the panel carries the DESTINATION's caveat, not one sentence for all three", async () => {
    // With Slack's sentence in `mentionNote`, a Linear reviewer would be told draftgate "cannot turn
    // a Slack id into a name"; Linear's caveat is that the name is readable and unverifiable.
    for (const [destination, expected] of [
      ['slack', 'cannot turn a Slack id into a name'],
      ['linear', 'sends one it does not as plain text'],
    ] as const) {
      const body = destination === 'slack' ? 'Hi <@U0123ABCDEF>.\n' : 'Hi @ada.lovelace.\n';
      const el = await mountApp(body, destination);
      // The detail lives in the unfurled panel; the note is its toggle.
      el.querySelector<HTMLButtonElement>('.dg-mentions')!.click();
      await settle();
      const detail = el.querySelector('.dg-warn-mentions');
      expect(detail, `${destination}: no detail row`).not.toBeNull();
      expect(detail!.textContent, destination).toContain(expected);
    }
  });

  test('a Linear profile link is counted, with its own caveat, and the same link on Slack is not', async () => {
    const href = 'https://linear.app/acme/profiles/jane.doe';
    const body = `Hi [Jane](${href}) and ${href}.\n`;
    const el = await mountApp(body, 'linear');
    expect(el.querySelector('.dg-mentions')!.textContent).toBe('2 mentions');
    el.querySelector<HTMLButtonElement>('.dg-mentions')!.click();
    await settle();
    expect(el.querySelector('.dg-warn-mentions')!.textContent).toContain('A link to a Linear profile notifies');
    expect((await mountApp(body, 'slack')).querySelector('.dg-mentions')).toBeNull();
  });

  test("Linear's @slug is marked, and an email address in the same draft is not", async () => {
    // The residual the Linear pattern accepts is bounded, and the boundary that matters most is an
    // address: `@example.com` must not read as a mention.
    const el = await mountApp('Ask @ada.lovelace or mail someone@example.com.\n', 'linear');
    expect(el.querySelector('.dg-mentions')!.textContent).toBe('1 mention');
  });

  test('deleting a CHIP updates the note -- the count may not read a stale document', async () => {
    /*
     * `state.doc` is replaced only by the one-click fix (`useEditor`'s deps are `[doc]`, so a
     * per-keystroke update would remount the editor), so a count read off it is frozen at load.
     * Jira's note counts only structural chips, so it would keep saying "1 mention".
     */
    const el = await mountApp(
      'Hi [@Ada Lovelace](mention:712020:5e0c4a1b-8d2f-4c3a-9b7e-1f6a2d8c4e90), look.\n',
      'jira'
    );
    expect(el.querySelector('.dg-mentions')!.textContent).toBe('1 mention');

    editor.fire(editorDocFor(renderBody('Hi, look.\n', 'jira')) as unknown);
    await settle();
    expect(
      el.querySelector('.dg-mentions'),
      'the note outlived the chip it describes -- it is reading a document frozen at load'
    ).toBeNull();
  });

  test('and a chip ADDED by an edit is reported', async () => {
    // The mirror. Reachable through the one-click repair path, and by a paste.
    const el = await mountApp('Nothing yet.\n', 'jira');
    expect(el.querySelector('.dg-mentions')).toBeNull();
    editor.fire(
      editorDocFor(
        renderBody('Hi [@Ada Lovelace](mention:712020:5e0c4a1b), look.\n', 'jira')
      ) as unknown
    );
    await settle();
    expect(el.querySelector('.dg-mentions')?.textContent).toBe('1 mention');
  });

  test("Jira's own wiki mention syntax earns no note, because it will not ping", async () => {
    const el = await mountApp('Hey [~accountid:712020:5e0c4a1b] look.\n', 'jira');
    expect(
      el.querySelector('.dg-mentions'),
      'literal characters must not be reported as a notification'
    ).toBeNull();
  });
});

describe('an inferred destination says so', () => {
  beforeAll(stubEditorCapturingChange().install);

  /*
   * Here the destination is draftgate's guess, and everything on screen is built on it. The chip is
   * on the routing line, not in `.dg-status`, whose height is fixed.
   */
  test('the chip is drawn when the route was inferred', async () => {
    const el = await mountApp('hello\n', 'slack', undefined, undefined, {
      matchedEntry: 'mcp__claude_ai_Slack__slack_send_message',
    });
    const chip = el.querySelector('.dg-inferred');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain('inferred');
    // The hover names what it matched, so the reviewer can check the guess.
    expect(chip!.getAttribute('title')).toContain('inferred');
    expect(chip!.getAttribute('title')).toContain('mcp__claude_ai_Slack__slack_send_message');
  });

  test('and NOT drawn for an ordinary configured route', async () => {
    // A chip on every review would be ignored.
    const el = await mountApp('hello\n', 'slack');
    expect(el.querySelector('.dg-inferred')).toBeNull();
  });
});

/**
 * The other prose the agent wrote: a title is editable, everything else stays read-only in the
 * context strip. What can go wrong is the wiring between an `<input>` and the decision.
 */
describe('prose fields beside the body', () => {
  beforeAll(stubEditorCapturingChange().install);

  /*
   * React's `onChange` never fires in this file, so nothing here types. `react-dom` is pulled in by
   * the static `import * as realEditor from './src/Editor'`, and ES imports hoist, so React DOM
   * initialises before `GlobalRegistrator.register()` installs happy-dom's globals; `mount`'s
   * dynamic import cannot undo that. Driven the standard way (the prototype value setter, then a
   * bubbling `input` event), the DOM value changes, React's handler does not run, and the next
   * render snaps the box back. The same code passes in a file importing only React, and one static
   * `react-dom/client` import breaks it. Click and keydown are unaffected. A keystroke test here
   * would assert the DOM it wrote itself: the typing outcomes are `title-edit-approve` and
   * `title-clear-blocks` in `surface/harness/e2e.ts`.
   */
  const PROSE = [{ field: 'fields.summary', value: 'Export fails' }] as const;

  const titleInput = (c: HTMLElement) =>
    c.querySelector('input.dg-prose-field') as HTMLInputElement;

  test('a tool with none renders no prose block at all', async () => {
    const c = await mountApp('Hello.\n', 'jira');
    expect(c.querySelector('.dg-prose')).toBeNull();
  });

  test('the field is shown with the agent\'s text, and NOTHING labels it on screen', async () => {
    const c = await mountApp('Hello.\n', 'jira', undefined, undefined, undefined, PROSE);
    expect(titleInput(c).value).toBe('Export fails');
    // No visible name: position identifies the field. The path is the hover (`title`), the
    // accessible name (`aria-label`) and the placeholder, which shows only once the box is empty.
    expect(c.querySelector('.dg-prose-name')).toBeNull();
    expect(titleInput(c).getAttribute('title')).toBe('fields.summary');
    expect(titleInput(c).getAttribute('aria-label')).toBe('fields.summary');
    expect(titleInput(c).getAttribute('placeholder')).toBe('fields.summary');
  });

  /*
   * An `<input>` strips CR and LF from what it displays, so the window draws the control picture,
   * `prose/line-break` warns, and an untouched field sends the agent's exact value.
   */
  test('a line break in the title is drawn as a picture, warned about, and sent as written', async () => {
    decisions = [];
    const title = 'Export fails\non empty tables';
    const c = await mountApp('Hello.\n', 'github', undefined, undefined, undefined, [
      { field: 'title', value: title },
    ]);
    expect(titleInput(c).value).toBe('Export fails\u240Aon empty tables');
    expect(c.querySelector('.dg-status')?.getAttribute('data-severity')).toBe('warning');
    // A warning on GitHub, which stores the break: Approve stays live, and what goes is the agent's.
    buttonWithText(c, 'Approve').click();
    await settle();
    expect(decisions).toHaveLength(1);
    expect((decisions[0] as { fields: Record<string, string> }).fields.title).toBe(title);
  });

  test('...and on a Jira summary, which refuses it, Approve is dead', async () => {
    decisions = [];
    const c = await mountApp(
      'Hello.\n', 'jira', undefined, undefined, undefined,
      [{ field: 'fields.summary', value: 'Export fails\non empty tables' }],
      undefined,
      // The tool the refusal was probed on: a PUT, which is what `editJiraIssue` makes.
      'mcp__atlassian__editJiraIssue'
    );
    expect(c.querySelector('.dg-status')?.getAttribute('data-blocked')).not.toBeNull();
    expect(buttonWithText(c, 'Approve').disabled).toBe(true);
  });

  // An unlabelled field identifies itself by its text, so an empty one needs the placeholder.
  test('an empty field still draws a box, and the placeholder names it', async () => {
    const c = await mountApp('Hello.\n', 'jira', undefined, undefined, undefined, [
      { field: 'fields.summary', value: '' },
    ]);
    // `extractProse` omits a field the payload lacks, so this is an agent's `""`: a thing to review.
    expect(titleInput(c).value).toBe('');
    expect(titleInput(c).getAttribute('placeholder')).toBe('fields.summary');
  });

  test('an untouched field approves as unedited, and still reports the key', async () => {
    decisions = [];
    const c = await mountApp('Hello.\n', 'jira', undefined, undefined, undefined, PROSE);
    await clickApprove(c);
    expect(decisions[0]).toMatchObject({
      action: 'approve',
      edited: false,
      // Reported though nothing changed: absence would mean a surface that cannot report.
      fields: { 'fields.summary': 'Export fails', commentBody: 'Hello.\n' },
    });
  });

  /*
   * Only a prose error merges into `blocked`. `prose/too-long` is a warning inside GitHub's
   * unresolved title bracket (1,024 accepted, 4,096 refused): a dead Approve there would assert a
   * cutoff nobody measured.
   */
  test('a GitHub title inside the unresolved bracket warns and leaves Approve live', async () => {
    decisions = [];
    const c = await mountApp('Hello.\n', 'github', undefined, undefined, undefined, [
      { field: 'title', value: 'x'.repeat(2_000) },
    ], undefined, 'mcp__claude_ai_Github_MCP__issue_write');
    expect(c.textContent).toContain('where between them it stops is not known');
    expect(buttonWithText(c, 'Approve').disabled).toBe(false);
    await clickApprove(c);
    expect(decisions[0]).toMatchObject({ action: 'approve' });
  });

  test('a Linear title past 512 is refused, so Approve is dead', async () => {
    decisions = [];
    const c = await mountApp('Hello.\n', 'linear', undefined, undefined, undefined, [
      { field: 'title', value: 'x'.repeat(513) },
    ], undefined, 'mcp__claude_ai_Linear__save_issue');
    expect(buttonWithText(c, 'Approve').disabled).toBe(true);
    expect(c.textContent).toContain('refuses a title over 512');
  });
});

/*
 * The theme is kept by the CLI: the host's own storage keeps nothing between reviews.
 * A click rides the decision for the CLI to keep, and the next request's `rememberedTheme` applies.
 */
describe('the theme choice travels through the CLI', () => {
  beforeAll(stubEditorCapturingChange().install);

  // Symmetric, and on both sides: the window leaves `data-theme` on <html> when it unmounts, so a
  // test that inherited the last one's could pass without the window ever applying its own.
  const clean = () => {
    delete document.documentElement.dataset.theme;
  };
  beforeEach(clean);
  afterEach(clean);

  /** `rememberedTheme` as the request carries it -- a string, since `request.cjs` checks only shape. */
  async function mountRemembering(rememberedTheme?: string): Promise<HTMLElement> {
    const { App } = await import('./src/App');
    stubBridge('Hello.\n', 'jira');
    const bridge = (window as unknown as { draftgate: { request(): Promise<WireRequest> } }).draftgate;
    const original = bridge.request;
    // Cast, because a request from outside is not typed: that is what the 'sepia' case is about.
    bridge.request = () =>
      original().then((r) => ({ ...r, ...(rememberedTheme ? { rememberedTheme } : {}) }) as WireRequest);
    return mount(<App />);
  }

  test('a click on the switcher rides the approval', async () => {
    decisions = [];
    const c = await mountRemembering();
    (c.querySelector('.dg-theme-toggle') as HTMLButtonElement).click();
    await settle();
    await clickApprove(c);
    // `system` is where a window with no choice starts, and `light` is the next in core's cycle.
    expect(decisions[0]?.theme).toBe('light');
  });

  test('no click, no theme on the decision: there is nothing new to keep', async () => {
    decisions = [];
    const c = await mountRemembering('dark');
    await clickApprove(c);
    expect('theme' in decisions[0]!).toBe(false);
  });

  test("the CLI's remembered theme applies", async () => {
    await mountRemembering('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  test('a theme the switcher has no face for is ignored, not a crash, from either field', async () => {
    let c = await mountRemembering('sepia');
    expect(c.querySelector('.dg-theme-toggle')).not.toBeNull();
    expect(document.documentElement.dataset.theme).toBe('light');
    for (const root of roots.splice(0)) root.unmount();
    // The explicit `theme` is as untyped on arrival as the remembered one.
    const { App } = await import('./src/App');
    stubBridge('Hello.\n', 'jira');
    const bridge = (window as unknown as { draftgate: { request(): Promise<WireRequest> } }).draftgate;
    const original = bridge.request;
    bridge.request = () => original().then((r) => ({ ...r, theme: 'sepia' }) as unknown as WireRequest);
    c = await mount(<App />);
    expect(c.querySelector('.dg-theme-toggle')).not.toBeNull();
  });
});

/*
 * A patch (`PatchEdits.tsx`): no body, one card per edit, the anchors read-only and the new text in
 * a textarea. Typing is `patch-edit-approve` in `surface/harness/e2e.ts` (React's `onChange` never
 * fires here; see "prose fields beside the body").
 */
describe('a review of a patch', () => {
  const edit = (
    index: number,
    op: string,
    label: string,
    anchors: { key: string; label: string; value: string; kept?: true }[],
    textKey: string,
    value: string,
    empty: 'deletes' | 'refused',
    flags: string[] = [],
    note?: string
  ) => ({
    field: `patch.${index}.${textKey}`,
    kind: 'edit' as const,
    edit: { index, op, label, anchors, flags, textKey, empty, ...(note ? { note } : {}) },
    value,
  });
  const EDITS = [
    edit(0, 'replace', 'Replace', [{ key: 'old_string', label: 'Replaces', value: 'Tuesday' }], 'new_string', 'Thursday', 'deletes'),
    edit(1, 'replace', 'Replace', [{ key: 'old_string', label: 'Replaces', value: 'TODO' }], 'new_string', '', 'deletes', ['every occurrence']),
    edit(2, 'append', 'Add at the end', [], 'text', '\n\n## Rollout\n\nShip on **Monday**.', 'refused'),
    edit(
      3, 'replace_range', 'Replace a range',
      [{ key: 'from', label: 'From (replaced)', value: '## Old' }, { key: 'to', label: 'Up to (kept)', value: '## Risks' }],
      'new_string', 'Gone.', 'deletes', [], 'draftgate cannot see the text in between.'
    ),
  ];

  async function mountPatch(edits: ReturnType<typeof edit>[] = EDITS): Promise<HTMLElement> {
    const { App } = await import('./src/App');
    const request: WireRequest = {
      protocol: PROTOCOL_VERSION,
      destination: 'linear',
      toolName: 'mcp__claude_ai_Linear__save_issue',
      context: { id: 'HELP-42' },
      fields: [{ field: 'title', kind: 'line', value: 'Rollout' }, ...edits],
      timeoutMs: 600_000,
    };
    (window as unknown as { draftgate: unknown }).draftgate = {
      request: () => Promise.resolve(request),
      decide: (d: HumanDecision) => decisions.push(d),
    };
    return mount(<App />);
  }

  const cards = (c: HTMLElement) => [...c.querySelectorAll('.dg-edit')] as HTMLElement[];

  test('says it shows the changes, not the whole text, and draws one card per edit in order', async () => {
    const c = await mountPatch();
    expect(c.textContent).toContain('which draftgate cannot read');
    expect(c.textContent).toContain('only what changes');
    // Not the body-less note: there is something to read.
    expect(c.textContent).not.toContain('No message body');
    expect(cards(c).map((e) => e.querySelector('.dg-edit-n')?.textContent)).toEqual(['1', '2', '3', '4']);
    expect(cards(c).map((e) => e.dataset.op)).toEqual(['replace', 'replace', 'append', 'replace_range']);
  });

  test('the anchors are read-only text, and the new text is a textarea holding the exact characters', async () => {
    const c = await mountPatch();
    const [first, , append, range] = cards(c);
    expect(first!.querySelector('.dg-edit-anchor-text')?.textContent).toBe('Tuesday');
    expect(first!.querySelector('.dg-edit-anchor-text')?.tagName).toBe('PRE');
    expect((first!.querySelector('textarea.dg-edit-text') as HTMLTextAreaElement).value).toBe('Thursday');
    // Separators included: the editor would drop them.
    expect((append!.querySelector('textarea.dg-edit-text') as HTMLTextAreaElement).value).toBe(
      '\n\n## Rollout\n\nShip on **Monday**.'
    );
    expect([...range!.querySelectorAll('.dg-edit-anchor-label')].map((l) => l.textContent)).toEqual([
      'From (replaced)',
      'Up to (kept)',
    ]);
    expect(range!.querySelector('.dg-edit-note')?.textContent).toContain('cannot see');
    // Each textarea names its path, as a prose field does.
    expect(first!.querySelector('textarea')?.getAttribute('title')).toBe('patch.0.new_string');
  });

  test('an empty replacement is drawn as a deletion, with its flag', async () => {
    const c = await mountPatch();
    const deletion = cards(c)[1]!;
    expect(deletion.dataset.deletes).toBe('true');
    expect(deletion.querySelector('.dg-edit-op')?.textContent).toBe('Delete');
    expect(deletion.querySelector('.dg-edit-flag')?.textContent).toBe('every occurrence');
    // The control: a replacement with text is not.
    expect(cards(c)[0]!.dataset.deletes).toBeUndefined();
  });

  test("a deleted range strikes what it replaces and not the anchor it keeps", async () => {
    const c = await mountPatch([
      edit(
        0, 'replace_range', 'Replace a range',
        [{ key: 'from', label: 'From (replaced)', value: '## Old' }, { key: 'to', label: 'Up to (kept)', value: '## Next', kept: true }],
        'new_string', '', 'deletes'
      ),
    ]);
    const card = cards(c)[0]!;
    expect(card.dataset.deletes).toBe('true');
    // The sheet strikes `.dg-edit-anchor:not([data-kept="true"])`; the attribute is what it keys on.
    expect([...card.querySelectorAll('.dg-edit-anchor')].map((a) => (a as HTMLElement).dataset.kept)).toEqual([
      undefined,
      'true',
    ]);
  });

  /*
   * A preview that cannot load (here `render()` overflowing on a 10,000-deep list) is the body
   * editor's failure one card over: the shell goes, Approve with it (window.md).
   */
  test('a preview that cannot load takes Approve away', async () => {
    decisions = [];
    const deep = Array.from({ length: 10_000 }, (_, i) => '  '.repeat(i) + '- x').join('\n');
    const c = await mountPatch([edit(0, 'append', 'Add at the end', [], 'text', deep, 'refused')]);
    expect(c.textContent).toContain('could not load');
    expect([...c.querySelectorAll('button')].some((b) => b.textContent?.includes('Approve'))).toBe(false);
  });

  test('a non-empty edit is previewed as the destination draws it; an empty one is not', async () => {
    const c = await mountPatch();
    expect(cards(c).map((e) => e.querySelector('.dg-edit-preview') !== null)).toEqual([true, false, true, true]);
  });

  test('approving untouched reports every edit, as shown, and no edit by a person', async () => {
    decisions = [];
    const c = await mountPatch();
    expect(c.textContent).toContain('Exactly these edits will be sent');
    await clickApprove(c);
    expect(decisions[0]).toMatchObject({ action: 'approve', edited: false, bodyEdited: false });
    expect((decisions[0] as { fields: Record<string, string> }).fields).toEqual({
      title: 'Rollout',
      'patch.0.new_string': 'Thursday',
      'patch.1.new_string': '',
      'patch.2.text': '\n\n## Rollout\n\nShip on **Monday**.',
      'patch.3.new_string': 'Gone.',
    });
  });

  test('an empty insertion blocks Approve, naming its edit', async () => {
    decisions = [];
    const c = await mountPatch([
      edit(0, 'insert_after', 'Insert after', [{ key: 'anchor', label: 'After', value: 'x' }], 'text', '', 'refused'),
    ]);
    const approve = buttonWithText(c, 'Approve');
    expect(approve.disabled).toBe(true);
    expect(c.querySelector('.dg-status')?.getAttribute('data-blocked')).toBe('true');
    expect(c.textContent).toContain('Edit 1 (Insert after) inserts nothing');
    approve.click();
    await settle();
    expect(decisions).toHaveLength(0);
  });
});
