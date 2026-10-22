/**
 * Shared scaffolding for the verifiers: `probe.ts` checks what the window renders, `e2e.ts` what the
 * whole CLI path produces. Here: the reporter, the nonce lifecycle, the fixtures and the Jira
 * context. Not the spawn helpers: `probe.ts` launches the host (`wkSession.ts`'s `launchHost`) and
 * `e2e.ts` the CLI, and they measure different things.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NONCE_FILE } from '../../cli/src/harnessNonce';

// Two levels: this file lives in `surface/harness/`, so the repo root is two up.
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The app directory -- `index.html`, `contract.json`, the `.cjs` rules, `src/`, `host/`. */
export const SURFACE = join(ROOT, 'surface');

/** This directory. `injected.cjs` lives here, and so does everything that only verifies. */
export const HARNESS = join(SURFACE, 'harness');

/**
 * The scripts the verifiers run in the renderer, typed once for all of them. Loaded with `require`:
 * each export is stringified with `toString()`, and bun's transpiler minifies (`return false` comes
 * back `return !1`) and would inline a module-scope constant (`injectedScripts.test.ts`).
 */
export interface Injected {
  /** Has the window rendered enough to measure? */
  isRendered: () => boolean;
  /**
   * The whole measurement: counts, computed styles, fonts, storage, selection. `spec.stylesOnly`
   * returns just the computed-style reads, for the forced-hover loop.
   */
  takeCensus: (spec: unknown) => unknown;
  /** The document's own image: deferred, or loaded. */
  renderedImage: () => unknown;
  /** Do these URLs actually load under the policy? */
  loadImages: (sources: Record<string, string>) => unknown;
  /** Select a run of text the way a person dragging across it would. */
  selectText: (needle: string, opts?: { preventScroll?: boolean; collapsed?: boolean }) => Promise<{ top: number; bottom: number } | null>;
  /** Click a toggle and wait for what it reveals. */
  openControl: (toggle: string, reveals: string) => { ok: boolean; detail?: string };
  /** Click one selector, reporting whether anything matched. */
  clickSelector: (selector: string) => boolean;
  /** Is anything matching this selector in the document? */
  isPresent: (selector: string) => boolean;
  /** Resolve after the frame holding the rendered draft has been committed. */
  afterTwoFrames: () => boolean;
  /** The theme the renderer settled on. */
  readTheme: () => string | null;
  /**
   * Ask the renderer to `fetch` its own URL -- refused unless `connect-src 'none'` is gone. Reports
   * the url it tried, so a caller can tell the refusal it caused from one it should fail on.
   */
  probeConnectSrc: () => { url: string };
  /** Put the caret in the editor, so inserted text lands there. */
  focusEditor: () => boolean;
  /** Real layout of the context strip: how many pairs, whether any two collide, and its height. */
  contextLayout: () => {
    pairs: number;
    values: { shown: number; wanted: number }[];
    overlaps: number;
    height: number;
    clipped: number;
  } | null;
  /** Focus the first prose field (a title) and put the caret at its end. */
  focusProseField: () => boolean;
  focusEditText: (index: number) => boolean;
  /** Each patch edit's textarea: text out of sight, lines held, inner height. See `editTextFit`. */
  editTextFit: () => { hidden: number; lines: number; height: number }[];
  /** What the first prose field holds, or null when the review has none. */
  proseFieldValue: () => string | null;
  /** Focus the first prose field and select all of it, so one keystroke can empty it. */
  selectProseField: () => boolean;
  /** What the first prose field SHOWS -- its value and the placeholder behind it. */
  proseFieldShows: () => { value: string; placeholder: string } | null;
  /**
   * Put the caret at the END of the draft's last text, where a reviewer's last keystroke lands.
   * False until the editor's own selection is there: ask again (`until`).
   */
  caretToEnd: () => boolean;
  /**
   * Put the caret in the empty paragraph after a draft ending in a list. False until the editor has
   * made that paragraph and taken the caret into it: ask again.
   */
  caretToTrailingParagraph: () => boolean;
  /** Close the window as a reviewer who decides not to send does. */
  closeWindow: () => boolean;
  /**
   * The painted size of an element, from real layout, plus the text it covers: a `<br>` carrying
   * the highlight class is present and has no box. See `paintedBox`.
   */
  paintedBox: (
    selector: string
  ) => { width: number; height: number; text: string; tag: string } | null;
  /** Where a code block's text starts, its widest line number's ink width, and its number column's box. See `codeLayout`. */
  codeLayout: () => {
    lines: number;
    widest: number;
    textLeft: number | null;
    ch: number;
    border: number;
    lastNumberTop: number | null;
    lastLineTop: number | null;
    column: { top: number; bottom: number; left: number };
  } | null;
  /** Every table's width, first-row cells and border, and the editor's content width. See `tableLayout`. */
  tableLayout: () => { content: number; dpr: number; tables: { width: number; columns: number[]; border: number }[] };
  /** How far each table wrapper scrolls sideways, and the draft's overhang. See `tableOverflow`. */
  tableOverflow: () => { body: number | null; wrappers: { moved: number; overhang: number }[] };
  /** The gap between each pair of blocks, upper's bottom to lower's top. See `gapsBetween`. */
  gapsBetween: (pairs: [upper: string, lower: string, px: number][]) => (number | null)[];
  /** The first task item's checkbox against its text, in real layout. See `taskLayout`. */
  taskLayout: () => { lineHeight: number; boxCentre: number; rowHeight: number; textHeight: number } | null;
  /** The full toolbar over a scrolled draft, in steps. See `scrollPane` and the ones after it. */
  scrollPane: (needle?: string) => Promise<boolean>;
  toolbarInView: () => {
    scrollTop: number;
    pane: { top: number; bottom: number };
    bar: { top: number; bottom: number };
    background: string;
    samples: number;
    covered: number;
  } | null;
  selectionMarks: () => { selected: string; within: string[]; scrollTop: number | null };
  caretInView: () => Promise<{ top: number; bottom: number; barBottom: number; paneBottom: number } | null>;
  topmostAt: (selector: string) => { top: number; bottom: number; onTop: boolean } | null;
  stackedAt: (upper: string, lower: string) => { top: number; bottom: number; upperOnTop: boolean } | null;
  /** What holds the keyboard, or `null` for the page itself (nothing, on open). */
  focusedControl: () => { tag: string } | null;
  // The WebKit host's own checks (`host.ts`). See their docstrings in `injected.cjs`.
  hostBridgeShape: () => { present: boolean; frozen: boolean; replaced: boolean; keys: string[] };
  hostBridgeRequest: () => Promise<{ destination: string; fields: number | null } | null>;
  hostSubframeAttack: (step: 'request' | 'decide') => Promise<{ created: boolean; wrapperInFrame: string; handlerInFrame: string; request: string }>;
  hostTryToLeave: (how: 'https' | 'self' | 'open' | 'blank' | 'download' | 'form') => string;
  hostWhere: () => { href: string; shell: boolean };
  hostReads: () => Promise<{ scheme: string; https: string; xhr: string }>;
  hostScriptPolicy: () => Promise<{ evaluated: string; inline: string; worker: string }>;
  hostPermissions: () => Promise<{ notification: string; media: string; geolocation: string }>;
  hostSetTitle: (title: string) => string;
  hostForgeRefusal: (text: string, dispatchedUrl: string) => { console: boolean; security: boolean; dispatched: boolean };
  hostContextMenus: (read: boolean) => { seen: number; cancelled: number };
  hostCentre: (selector: string) => { x: number; y: number } | null;
  hostCodeFace: (selector: string) => { family: string; text: string; own: number; menlo: number; uiMonospace: number } | null;
  hostStorage: () => string[] | null;
  hostVisibility: () => string;
  /** The bundled Lato against Slack's own files, in this engine (`lato.ts`). */
  latoAdvances: (
    fonts: { slackUpright: string; slackItalic: string; ownUpright: string },
    sizes: number[],
    widths: number[],
    at: number,
    sentences: string[],
    paragraph: string
  ) => Promise<LatoAdvances>;
  /** `CSS.forcePseudoState(['hover'])` by cascade rewrite, for the WebKit host (`wkSession.ts`). */
  wkForceHover: (selector: string, on: boolean) => boolean;
  /** A real italic or a slant, by its advances, for the WebKit host (`probe.ts`). */
  wkItalicAdvances: (selector: string) => Promise<{ family: string; style: string; italic: number; upright: number; italicFaceLoaded: boolean } | null>;
  /** `CSS.getPlatformFontsForNode` by width, for the WebKit host (`wkSession.ts`). */
  wkFacesByWidth: (selector: string) => Promise<{ familyName: string; isCustomFont: boolean; glyphCount: number }[] | null>;
  hostEditorText: () => string | null;
  hostControlsDrawn: () => boolean;
  hostDraftState: () => { draft: string | null; lines: string[]; edits: string[]; textStyle: string | null; edited: boolean };
  hostFocusedIs: (selector: string, index: number) => boolean;
  hostKeydowns: (arm: boolean) => number;
  hostWindowFocusEvents: (arm: boolean) => number;
}

/** What `latoAdvances` measured; `lato.ts` prints it. Widths in CSS px, deltas bundled minus Slack's. */
export interface LatoAdvances {
  glyphsTested: number;
  bySize: {
    size: number;
    /** The characters whose advance alone differs between the two files. */
    glyphsDiffering: string;
    /** The largest width difference over the sentences, kerned and with kerning off. */
    sentenceDeltaKerned: number;
    sentenceDeltaUnkerned: number;
    /** The box widths at which the paragraph wraps at a different word. */
    wrapsDiffering: number[];
  }[];
  pairsTested: number;
  /** Every pair whose width differs. */
  pairs: { pair: string; delta: number }[];
  /** Each sentence in italic: the bundled upright slanted, the bundled italic, Slack's italic. */
  italic: { synthetic: number; real: number; slack: number }[];
  /** The box widths at which each italic wraps the paragraph at a different word than Slack's. */
  italicWrapsDiffering: { real: number[]; synthetic: number[] };
  /** Where the two kerning-off paragraphs are drawn, bundled first. */
  ink: { left: number; width: number; height: number; tops: [number, number] };
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
export const INJECTED = require(join(HARNESS, 'injected.cjs')) as Injected;

/** The Jira target both verifiers address. Real-shaped ids, so a payload looks like a real one. */
export const JIRA_CONTEXT = {
  cloudId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  issueIdOrKey: 'SUPPORT-123',
} as const;

/**
 * The torture fixture, plus a heading ladder: the committed one stops at `##`, and Slack draws
 * `##` through `######` at one size. Appended here because the core tests and their goldens
 * also read `docs/torture-fixture.md`.
 */
export const FIXTURE =
  readFileSync(join(ROOT, 'docs', 'torture-fixture.md'), 'utf8') +
  `
## Heading two, again

### Heading three

#### Heading four

##### Heading five

###### Heading six
`;

/** A draft Jira will not accept: a heading and a table inside a blockquote, both verified 400s. */
export const BLOCKED_FIXTURE = readFileSync(
  join(ROOT, 'core', 'test', 'fixtures', 'blockquote-hostile.md'),
  'utf8'
);

/**
 * Long enough that a warning arriving would certainly have been shown. `SETTLE_MS` is 600ms.
 * Restated, not imported: `surface/src/settledWarnings.ts` is DOM-typed under
 * `surface/tsconfig.json`, and the harness is node-typed under the root config.
 */
export const SETTLE_PAST_MS = 900;

/**
 * Past `SHORTCUT_GRACE_MS` (1000, `surface/src/shortcutGrace.ts`, asserted in `window.test.tsx`),
 * restated for the reason `SETTLE_PAST_MS` is. `host.ts` waits the grace out; raising the grace past
 * this fails its "past the grace a ⌘↵ approves".
 */
export const SHORTCUT_GRACE_PAST_MS = 1300;

/**
 * Every nonce file this process has written, so it can take them all away again. A live one makes
 * the CLI spawn the harness build (`cli/src/harnessNonce.ts`), which a FIFO can drive to Approve.
 * Only `e2e.ts` writes them; the probe and `surface:host` spawn the harness build themselves.
 */
const written = new Set<string>();
let cleanupRegistered = false;

/**
 * Delete every nonce file written by this run. Idempotent. Called from each verifier's `finally`
 * and from an `exit` handler, since a `finally` does not run on a signal; neither covers SIGKILL,
 * so the gate also refuses a stale file.
 */
export function releaseNonces(): void {
  for (const path of written) rmSync(path, { force: true });
  written.clear();
}

/**
 * Wait until the review window has rendered enough to measure or click (`isRendered`), or throw.
 * `when` names the moment, since the callers fail for different reasons.
 */
export async function waitUntilRendered(session: {
  evaluate<T>(fn: (...a: never[]) => unknown, ...args: unknown[]): Promise<T>;
}, when: string): Promise<void> {
  if (!(await until(() => session.evaluate<boolean>(INJECTED.isRendered)))) {
    throw new Error(`the window never finished rendering ${when}`);
  }
}

/**
 * Which directories under `root` still hold a live nonce, and whether `root` was there at all.
 * `e2e.ts` ends by asserting this is empty: a surviving nonce is a live key to the harness build, in
 * a git-ignored directory. Beside `writeNonce`, so the writer and the checker name one directory.
 * `existed` is the vacuity guard: an empty list from a missing directory means nobody looked.
 */
export function survivingNonces(root: string): { live: string[]; existed: boolean } {
  if (!existsSync(root)) return { live: [], existed: false };
  return {
    live: readdirSync(root).filter((d) => existsSync(join(root, d, NONCE_FILE))),
    existed: true,
  };
}

/**
 * Write a fresh nonce into `dir/nonce`, registered for the sweep, and return it: the key a harness
 * hands the CLI so it spawns the HARNESS build (`wkSession.ts`'s `harnessEnv`). Written late and
 * taken away the moment the run that needs it is over.
 */
export function writeNonce(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const nonce = randomUUID();
  const noncePath = join(dir, NONCE_FILE);
  writeFileSync(noncePath, nonce);
  written.add(noncePath);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.on('exit', releaseNonces);
    // `process.exit()` from the reporter runs `exit` handlers; a signal does not, unless we ask.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(signal, () => {
        releaseNonces();
        process.exit(1);
      });
    }
  }
  return nonce;
}

/** Indent a detail block under its `FAIL` line. */
export const indent = (s: string) => s.split('\n').map((l) => `          ${l}`).join('\n');

/** An assert-and-count reporter: `check`, and a `finish` that prints the tally and sets the exit code. */
export function reporter() {
  let failures = 0;
  const lines: string[] = [];

  const checkInto = (into: string[]) => (ok: boolean, label: string, detail = '') => {
    if (!ok) failures++;
    into.push(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail && !ok ? `\n${indent(detail)}` : ''}`);
  };
  const check = checkInto(lines);

  return {
    check,
    note: (text: string) => lines.push(`        ${text}`),
    /**
     * An isolated channel with the same two methods, for one of several things running at once:
     * `probe.ts` runs `CONCURRENCY` scenarios together, and checks printed as decided would
     * interleave under the wrong scenario heading. `failures` counts where a check is decided;
     * `lines` is the caller's to drain in its own order.
     */
    sub() {
      const own: string[] = [];
      return {
        lines: own,
        check: checkInto(own),
        note: (text: string) => own.push(`        ${text}`),
      };
    },
    /** Print what has accumulated since the last drain, and clear it. */
    drain: () => {
      lines.forEach((l) => console.log(l));
      lines.length = 0;
    },
    failures: () => failures,
    finish(what: string) {
      console.log(failures === 0 ? `\nAll ${what} passed.\n` : `\n${failures} FAILED.\n`);
      process.exit(failures === 0 ? 0 : 1);
    },
  };
}

/**
 * Put the caret where one of `injected.cjs`'s caret helpers puts it, or fail with `complaint`. The
 * helpers answer true only once the editor's own selection is there (ProseMirror can write its
 * selection back over the DOM's, `caretToEnd`), so this asks until they do.
 */
export async function placeCaret(
  session: { evaluate<T>(fn: () => boolean): Promise<T> },
  helper: () => boolean,
  complaint: string
): Promise<void> {
  if (!(await until(() => session.evaluate<boolean>(helper)))) throw new Error(complaint);
}

/** Wait for `condition` to hold, polling: a sleep long enough for the slowest window wastes a fast one's. */
export async function until(
  condition: () => Promise<boolean> | boolean,
  { timeoutMs = 15_000, everyMs = 25 } = {}
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** The window's stylesheets, where every face is declared. */
export const STYLES = join(SURFACE, 'src', 'styles');

export interface BundledFace {
  /** The sheet that declares it. */
  sheet: string;
  /** `''` when the rule names none. */
  family: string;
  /** The weight range -- one number twice for a static face, `100 900` for a variable one. */
  min: number;
  max: number;
  style: string;
  /** Every `url()` in its `src`, verbatim. */
  urls: string[];
  /** The first `url()` resolved as Vite resolves it: against the sheet, else a package. */
  file: string | null;
}

/**
 * Every `@font-face` the window can bundle: from every sheet in `styles/` and every package
 * stylesheet `main.tsx` imports, so no route bundles a face unchecked. Raw: a face missing a field
 * is still a face, and `fontAssets.test.ts` has to see it.
 */
export function bundledFaces(): BundledFace[] {
  const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const main = readFileSync(join(SURFACE, 'src', 'main.tsx'), 'utf8');
  const sheets = [
    ...readdirSync(STYLES)
      .filter((f) => f.endsWith('.css'))
      .map((f) => join(STYLES, f)),
    // A bare specifier is a package's sheet; a relative one is already in the list above.
    ...[...main.matchAll(/import ['"]([^.'"][^'"]*\.css)['"]/g)].map((m) => join(ROOT, 'node_modules', m[1]!)),
  ];
  return sheets.flatMap((sheet) =>
    [...stripComments(readFileSync(sheet, 'utf8')).matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
      const body = m[1]!;
      const weight = /font-weight:\s*(\d{3})(?:\s+(\d{3}))?/.exec(body);
      const urls = [...body.matchAll(/url\(['"]?([^)'"]+)['"]?\)/g)].map((u) => u[1]!);
      const first = urls[0];
      return {
        sheet,
        family: /font-family:\s*['"]?([^;'"]+)/.exec(body)?.[1]?.trim() ?? '',
        min: Number(weight?.[1] ?? 400),
        max: Number(weight?.[2] ?? weight?.[1] ?? 400),
        style: /font-style:\s*(\w+)/.exec(body)?.[1] ?? 'normal',
        urls,
        file: first === undefined ? null : first.startsWith('.') ? join(dirname(sheet), first) : join(ROOT, 'node_modules', first),
      };
    })
  );
}
