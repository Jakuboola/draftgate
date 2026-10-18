/**
 * The WebKit host's harness channel, from the verifier's side.
 *
 * The host has no debugging port, and so no gate to put in front of one. Its verifier half is a
 * different BINARY -- `draftgate-harness.app`, built from `surface/host/harness.m` beside
 * `draftgate.m` -- and that binary opens two FIFOs in `$DRAFTGATE_HARNESS` and answers one JSON
 * object per line. This file is the other end.
 *
 * What the channel can do, and what each op maps to, is `harness.m`'s header and `handle:`. What
 * it cannot: WebKit's own console messages (only the page's `console.*`, errors and
 * `securitypolicyviolation` events reach it), and anything that needs the window to be REALLY key
 * -- a menu item with no target. `becomeKey` is what WebKit sees of becoming key, and no more.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { fontFacts } from './fontFile';
// The CLI's own spelling of the two variables, so the gate and the harness cannot drift apart: a
// renamed one here would have the CLI ignore the harness and open a REAL window on the screen.
import { HARNESS_ENV, HARNESS_NONCE_ENV } from '../../cli/src/surfaces/webkit';
import { INJECTED, bundledFaces, writeNonce } from './shared';

/** The `modifiers` bits `WKSession.key` and `press` take: the set the flows are written in. */
export const MODIFIER = { option: 1, control: 2, command: 4, shift: 8 } as const;

/** A bundled face's CSS family -> the family its font file declares, read once per run. */
let fileFamilies: Map<string, string> | null = null;
function fileFamilyOf(cssFamily: string): string {
  if (!fileFamilies) {
    fileFamilies = new Map();
    for (const face of bundledFaces()) {
      if (!face.file || fileFamilies.has(face.family.toLowerCase())) continue;
      try {
        fileFamilies.set(face.family.toLowerCase(), fontFacts(readFileSync(face.file)).family);
      } catch {
        // a face whose file cannot be read keeps its CSS name, and the check says what it saw
      }
    }
  }
  return fileFamilies.get(cssFamily.toLowerCase()) ?? cssFamily;
}

/**
 * The viewport every verifier window is pinned to, so screenshots stay comparable between runs and
 * machines: the host's content size, set through the `viewport` op.
 */
export const VIEWPORT = { width: 1040, height: 828 } as const;

/** A window's content size, as `setViewport` takes it. */
export type Viewport = { width: number; height: number };

/**
 * The one expression this harness ever evaluates: a function's own SOURCE, applied to JSON.
 *
 * `toString()` gives back the source and the source runs in the page, where nothing from this
 * process's scope exists -- so each injected function has to be self-contained, which
 * `harness/injectedScripts.test.ts` enforces. It also means a backtick in an injected body is a
 * character in an interpolated STRING and never re-parsed as source, which is the whole reason
 * `injected.cjs` holds functions rather than templates.
 */
export function expressionFor(fn: (...args: never[]) => unknown, args: unknown[]): string {
  return `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(', ')})`;
}

/** One face that drew a node's text: `wkFacesByWidth`'s answer, in the fields the probe reads. */
export interface PlatformFont {
  /** The family, never an instance: WebKit names none (`wkFacesByWidth`). */
  familyName: string;
  /** A web font, as against a face the platform supplied. */
  isCustomFont: boolean;
  glyphCount: number;
}

/**
 * The WebKit harness's isolation facts: the bundle the loader launched, and whether its website
 * data store persists (a read-back of the host's configuration, not an observation).
 */
export interface Isolation {
  persistentStore: boolean;
  bundleId: string;
}

/** A page message as the harness reports it: a `console.*` call, a page error or a CSP violation. */
export interface HostMessage {
  /** `security` for a CSP refusal, `javascript` for a page error, `console` for a `console.*` call. */
  source: string;
  level: string;
  text: string;
  /**
   * Set by the HARNESS on every message, never taken from what the page posted: true only for a
   * `securitypolicyviolation` the CSP engine raised (`isTrusted`), heard in the harness's own
   * content world (`harness.m`'s `SECURITY_SCRIPT`), which no page script can post to.
   */
  trusted?: boolean;
  /** The harness's own numbering, which keeps a seeded message from being counted twice. */
  seq: number;
}

/**
 * A refusal the CSP engine itself raised for `directive` -- of `url`, when one is given. The ONE
 * spelling of it, for the probe's positive control and `surface:host`'s: `trusted` is the
 * harness's own word for it (above), and the directive is read where the harness writes it, as
 * `(effective <directive>, <disposition>)`.
 */
export function engineRefused(m: HostMessage, directive: string, url?: string): boolean {
  return (
    m.source === 'security' &&
    m.trusted === true &&
    m.text.includes(`(effective ${directive},`) &&
    (url === undefined || m.text.includes(url))
  );
}

type Reply = { id: number; ok: boolean; value?: unknown; error?: string };

export class WKSession {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** Settles the one `ready` line the host sends when both ends of the channel are open. */
  private onReady: () => void = () => {};
  /** Every page message, by the harness's number: those before attach are seeded, the rest pushed. */
  private readonly received = new Map<number, HostMessage>();
  /**
   * Did the window leave on its OWN because its parent was gone (`harness.m`'s parent watch)? The
   * one way to tell that from a caller that killed it, which says nothing at all.
   */
  orphaned = false;
  /** Settles when the host's end of the channel closes: the window is gone, however it went. */
  readonly gone: Promise<void>;
  private settleGone: () => void = () => {};
  private buffer = '';
  private closed: Error | null = null;

  private constructor(private readonly input: WriteStream) {
    this.gone = new Promise((resolve) => (this.settleGone = resolve));
  }

  /**
   * Make the channel in `dir` -- emptied first, so nothing of an earlier run is read -- as the two
   * FIFOs `harness.m` opens, and the env that points a harness host at them.
   */
  static channel(dir: string, { showWhenAsked = false } = {}): { env: Record<string, string>; dir: string } {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    execFileSync('mkfifo', [join(dir, 'in'), join(dir, 'out')]);
    // The window then waits for `show` (`harness.m`'s `DGHarnessShowsWhenAsked`).
    if (showWhenAsked) writeFileSync(join(dir, 'show-when-asked'), '');
    return { env: { [HARNESS_ENV]: dir }, dir };
  }

  /**
   * The env that has the CLI hand a review to the HARNESS binary, on a channel in `dir`: the two
   * FIFOs and a live nonce beside them, which `cli/src/surfaces/webkit.ts` checks before it spawns
   * that binary. The nonce is registered with `shared.ts`'s sweep, so it goes the moment the run is
   * over and the surviving-nonce checks see it if it does not.
   */
  static harnessEnv(dir: string): Record<string, string> {
    return { ...WKSession.channel(dir).env, [HARNESS_NONCE_ENV]: writeNonce(dir) };
  }

  /** Attach to a host spawned with `channel(dir).env`. Each FIFO open blocks until both ends meet. */
  static async attach(ctl: string): Promise<WKSession> {
    const session = new WKSession(createWriteStream(join(ctl, 'in')));
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the WebKit host never opened its channel in 20s')), 20_000);
      session.onReady = () => (clearTimeout(timer), resolve());
    });
    const output = createReadStream(join(ctl, 'out'), { encoding: 'utf8' });
    output.on('data', (chunk: string) => session.receive(chunk));
    output.on('close', () => session.fail(new Error('the WebKit host closed its channel')));
    session.input.on('error', (e) => session.fail(e));
    await ready;
    for (const m of await session.op<HostMessage[]>('messages')) session.keep(m);
    return session;
  }

  private keep(m: HostMessage): void {
    this.received.set(m.seq, m);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line) as Reply & { event?: string; message?: HostMessage };
      if (m.event === 'ready') this.onReady();
      if (m.event === 'message' && m.message) this.keep(m.message);
      if (m.event === 'orphaned') this.orphaned = true;
      if (m.event) continue;
      const p = this.pending.get(m.id);
      if (!p) continue;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error ?? 'host error'));
    }
  }

  private fail(e: Error): void {
    this.closed ??= e;
    this.settleGone();
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  /** One command to the host. */
  op<T = unknown>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.nextId;
    const reply = new Promise<T>((resolve, reject) =>
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    );
    this.input.write(JSON.stringify({ id, op, ...params }) + '\n');
    return reply;
  }

  /**
   * Run a function IN the page and return its value, JSON-encoded there. The function is sent as
   * its own source text -- `injected.cjs`'s functions are -- so it must be self-contained.
   */
  async evaluate<T>(fn: (...args: never[]) => unknown, ...args: unknown[]): Promise<T> {
    let value: unknown;
    try {
      value = await this.op('eval', { expr: expressionFor(fn, args) });
    } catch (e) {
      throw new Error(`the renderer threw: ${(e as Error).message}`);
    }
    return (typeof value === 'string' ? JSON.parse(value) : undefined) as T;
  }

  /** Run `fn` in the page and do not wait: for a click that ends the window, whose reply never comes. */
  evaluateNoWait(fn: (...args: never[]) => unknown, ...args: unknown[]): void {
    void this.op('eval', { expr: expressionFor(fn, args) }).catch(() => undefined);
  }

  /**
   * One half of a key press, as the harness synthesises it: a character or a named key (`Enter`,
   * `Backspace`, `Tab`, `Escape`, `ArrowUp`), and `modifiers` as `MODIFIER`'s bits. An AppKit
   * key-down carries its characters, so a press is a down and an up and nothing between.
   */
  key(key: string, type: 'keyDown' | 'keyUp', modifiers = 0): Promise<unknown> {
    return this.op('key', { key, type, modifiers });
  }

  /** A whole press, down then up, each through the window as a real one arrives. */
  async press(key: string, modifiers = 0): Promise<void> {
    await this.key(key, 'keyDown', modifiers);
    await this.key(key, 'keyUp', modifiers);
  }

  /** A click at a point in the page's coordinates, landing on whatever is topmost there. */
  async click(x: number, y: number, { right = false } = {}): Promise<void> {
    await this.op(right ? 'rightClick' : 'click', { x, y });
  }

  /** Text as a keyboard types it, into whatever has the focus. */
  async insertText(text: string): Promise<void> {
    await this.op('insertText', { text });
  }

  /** Bring forward a window opened `showWhenAsked`, through the host's own `-show`. */
  async show(): Promise<void> {
    await this.op('show');
  }

  /** What WebKit sees of a review's window becoming key, and no more (`harness.m`'s `becomeKey`). */
  async becomeKey(): Promise<void> {
    await this.op('becomeKey');
  }

  /** Load the page again and wait for THAT load to finish (the harness answers its own navigation). */
  async reload(): Promise<void> {
    await this.op('reload');
  }

  async setViewport({ width, height }: Viewport = VIEWPORT): Promise<void> {
    await this.op('viewport', { width, height });
  }

  /** The view's pixels at 1x, the scale the probe's pictures are taken at. */
  async screenshot(): Promise<Buffer> {
    const shot = await this.op<{ png1x: string }>('snapshot');
    return Buffer.from(shot.png1x, 'base64');
  }

  /** `CSS.forcePseudoState`, `:hover` only, by cascade rewrite: see `injected.cjs`'s `wkForceHover`. */
  async forcePseudo(selector: string, pseudos: string[]): Promise<void> {
    if (pseudos.length > 0 && pseudos.join() !== 'hover') {
      throw new Error(`CSS.forcePseudoState(${pseudos.join()}): only :hover has a WebKit stand-in`);
    }
    const ok = await this.evaluate<boolean>(INJECTED.wkForceHover, selector, pseudos.length > 0);
    if (!ok) throw new Error(`nothing matched ${selector}, so no state could be forced on it`);
  }

  /**
   * `CSS.getPlatformFontsForNode`, by width, then by FILE. The width match in the page
   * (`injected.cjs`'s `wkFacesByWidth`) can say which `@font-face` drew the text; the family a
   * probe check names is the one the font FILE declares, as a rasteriser would report it. So a web
   * face's CSS family is translated into its file's own family, read off the file's name table
   * (`fontFile.ts`) -- `Inter Variable` into `Inter`, `Slack-Roboto-Mono` into `Roboto Mono`. The
   * rule (`.claude/rules/styles.md`): which typeface is asked of the file, never of `font-family`.
   * The width match itself stays weaker than a rasteriser's answer, and it names no instance.
   */
  async platformFonts(selector: string): Promise<PlatformFont[] | null> {
    const hits = await this.evaluate<PlatformFont[] | null>(INJECTED.wkFacesByWidth, selector);
    return hits?.map((f) => (f.isCustomFont ? { ...f, familyName: fileFamilyOf(f.familyName) } : f)) ?? null;
  }

  /**
   * The window's isolation facts, for the probe: whether its website data store persists (a
   * read-back of what the host configured -- a pin against a source change, not an observation of
   * where data went), and which bundle the loader launched, whose defaults domain it writes.
   */
  async isolation(): Promise<Isolation> {
    const st = await this.op<Isolation>('state');
    return { persistentStore: st.persistentStore, bundleId: st.bundleId };
  }

  /** Every page message so far, in the order the harness numbered them. */
  allMessages(): HostMessage[] {
    return [...this.received.entries()].sort(([a], [b]) => a - b).map(([, m]) => m);
  }

  hasMessage(matches: (m: HostMessage) => boolean): boolean {
    for (const m of this.received.values()) if (matches(m)) return true;
    return false;
  }

  close(): void {
    try {
      this.input.end();
    } catch {
      // already gone
    }
  }
}

export interface LaunchedHost {
  /** Everything it wrote to stderr so far. */
  stderr(): string;
  /** Resolves when it exits, with how. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(): void;
}

/**
 * Spawn a host binary with `env` added, SIGKILLed at `timeoutMs` whatever happens: the kill guard
 * every harness window runs under, beside the harness build's own exit when its parent is gone.
 *
 * No `DRAFTGATE_` variable is INHERITED: the window gets exactly the ones its caller names. So a
 * `DRAFTGATE_DECISION` left exported in the shell cannot turn a probe's click into an approval --
 * the probe names none, and `probe.test.ts` asserts both halves.
 */
export function launchHost(
  bin: string,
  env: Record<string, string>,
  { timeoutMs, surface }: { timeoutMs: number; surface: string }
): LaunchedHost {
  let err = '';
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DRAFTGATE_')));
  const child = spawn(bin, [surface], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...inherited, ...env } });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (c: string) => (err += c));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('error', (e) => {
      err += `could not spawn ${bin}: ${e.message}\n`;
      resolve({ code: null, signal: null });
    });
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const deadline = setTimeout(() => {
    err += `[harness] killed after ${timeoutMs}ms\n`;
    child.kill('SIGKILL');
  }, timeoutMs);
  deadline.unref();
  void exited.then(() => clearTimeout(deadline));
  return {
    stderr: () => err,
    exited,
    kill: () => {
      clearTimeout(deadline);
      child.kill('SIGKILL');
    },
  };
}
