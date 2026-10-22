#!/usr/bin/env bun
/**
 * `bun run surface:host`: the WebKit host's own guarantees, in real windows. `surface:probe` and
 * `surface:e2e` check what the window renders and what the CLI produces; this checks what the host
 * lets through, and its lifecycle.
 *
 * It drives `draftgate-harness.app` over `wkSession.ts`'s FIFO channel: every window is off every
 * screen, SIGKILLed at a deadline, and exits if this process dies. The review build runs only where it
 * exits before AppKit starts. Run it alone: all three verifiers build `surface/dist/` (CLAUDE.md).
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { processGone } from '../../cli/src/child';
import { orphanedHosts } from './processes';
import { reviewPlan } from '../../cli/src/reviewPlan';
import { PROTOCOL_VERSION, parseWireDecision } from '../../cli/src/surfaces/windowProtocol';
import { HOST_LAYOUT, buildHost } from '../../cli/src/reviewHost';
import { SCENARIOS, mismatches, requestFor, stylesFor } from './probe';
import { FIXTURE, INJECTED, JIRA_CONTEXT, SHORTCUT_GRACE_PAST_MS, SURFACE, placeCaret, reporter, until, waitUntilRendered } from './shared';
import { MODIFIER, WKSession, engineRefused, launchHost, type HostMessage, type LaunchedHost } from './wkSession';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { windowTitle } = require(join(SURFACE, 'windowTitle.cjs')) as {
  windowTitle(destination: string, toolName?: string): string;
};

const report = reporter();
const { check, note, drain, finish } = report;
const OUT = join(SURFACE, 'probe-result', 'host');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const apps = await buildHost(HOST_LAYOUT);
const TOOL = 'mcp__atlassian__addCommentToJiraIssue';
const LIVE_APPROVE = '.dg-btn-primary:not([disabled])';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Jira review of the shared fixture, as the CLI would write it. */
function jiraRequest(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocol: PROTOCOL_VERSION,
    destination: 'jira',
    toolName: TOOL,
    context: JIRA_CONTEXT,
    fields: reviewPlan('jira', {}).map((f) => ({ ...f, value: FIXTURE })),
    theme: 'light',
    timeoutMs: 600_000,
    ...over,
  });
}

/**
 * A surface directory of the host's own: every `.cjs` (so a new one cannot be forgotten) and
 * `contract.json` beside a `dist/` that is empty, or a copy of the real one.
 */
function bareSurface(dir: string, dist: 'empty' | 'copy'): string {
  rmSync(dir, { recursive: true, force: true });
  if (dist === 'copy') cpSync(join(SURFACE, 'dist'), join(dir, 'dist'), { recursive: true });
  else mkdirSync(join(dir, 'dist'), { recursive: true });
  for (const f of readdirSync(SURFACE).filter((n) => n.endsWith('.cjs') || n === 'contract.json')) {
    copyFileSync(join(SURFACE, f), join(dir, f));
  }
  return dir;
}

interface Opened {
  /** The channel directory, where the harness keeps its own placement file. */
  control: string;
  decisionPath: string;
  host: LaunchedHost;
  session: WKSession;
  /** Has the host exited yet? */
  alive(): boolean;
  /** Still up, and nothing decided. */
  undecided(): boolean;
  done(): void;
}

/**
 * A harness window on `request`, attached and (unless `rendered: false`) rendered, with a decision
 * path armed. The preflight asks for it unrendered: a hidden window never draws a frame.
 */
async function open(
  name: string,
  {
    request = jiraRequest(),
    env = {},
    surface = SURFACE,
    windowState,
    rendered = true,
    showWhenAsked = false,
  }: {
    request?: string;
    env?: Record<string, string>;
    surface?: string;
    windowState?: object;
    rendered?: boolean;
    /** The window waits for `session.show()` instead of coming forward when its page has loaded. */
    showWhenAsked?: boolean;
  } = {}
): Promise<Opened> {
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  const requestPath = join(dir, 'request.json');
  const decisionPath = join(dir, 'decision.json');
  writeFileSync(requestPath, request);
  const channel = WKSession.channel(join(dir, 'control'), { showWhenAsked });
  if (windowState) writeFileSync(join(channel.dir, 'window.json'), JSON.stringify(windowState));
  const host = launchHost(
    apps.harness.bin,
    { ...channel.env, DRAFTGATE_REQUEST: requestPath, DRAFTGATE_DECISION: decisionPath, ...env },
    { timeoutMs: 45_000, surface }
  );
  let exited = false;
  void host.exited.then(() => (exited = true));
  const session = await Promise.race([
    WKSession.attach(channel.dir),
    host.exited.then((how) => {
      throw new Error(`the host exited before attaching (${JSON.stringify(how)}): ${host.stderr()}`);
    }),
  ]);
  // A window that has not come forward draws no frame, which "rendered" waits for.
  if (rendered && !showWhenAsked) await waitUntilRendered(session, name);
  return {
    control: channel.dir,
    decisionPath,
    host,
    session,
    alive: () => !exited,
    undecided: () => !exited && !existsSync(decisionPath),
    done: () => {
      session.close();
      host.kill();
    },
  };
}

/**
 * Click Approve & send and read back what the window wrote, through the CLI's own parser. The click
 * ends the window, so the channel closes under the reply; the exit and the file are the evidence.
 */
async function approveAndRead(w: Opened) {
  void w.session.evaluate(INJECTED.clickSelector, LIVE_APPROVE).catch(() => undefined);
  return readDecision(w, await w.host.exited);
}

/** What the window wrote, through the CLI's own parser, and how it exited. */
function readDecision<How>(w: Opened, how: How) {
  const raw: unknown = existsSync(w.decisionPath) ? JSON.parse(readFileSync(w.decisionPath, 'utf8')) : null;
  return { how, raw, decision: parseWireDecision(raw) };
}

/** Run a host binary that must exit on its own, and say how. No channel: it never gets that far. */
async function exitOf(bin: string, env: Record<string, string>, surface = SURFACE) {
  const started = Date.now();
  const host = launchHost(bin, env, { timeoutMs: 15_000, surface });
  const how = await host.exited;
  return { ...how, ms: Date.now() - started, stderr: host.stderr() };
}

/** A `connect-src` refusal only WebKit's CSP engine could have raised: a TRUSTED violation event. */
const isConnectRefusal = (m: HostMessage) => engineRefused(m, 'connect-src');

type State = Record<string, unknown> & {
  webProcess: number | null;
  zoomLevel: number;
  pageZoom: number;
  hostCollectionBehavior: number;
};
/** The two `NSWindowCollectionBehavior` bits the host asks for, as AppKit numbers them. */
const COLLECTION = { canJoinAllSpaces: 1 << 0, fullScreenAuxiliary: 1 << 8 } as const;
const stateOf = (s: WKSession) => s.op<State>('state');
/** A key equivalent sent to the APP, as a menu shortcut arrives, rather than to the focused view. */
const appKey = (s: WKSession, key: string) => s.op('key', { key, modifiers: MODIFIER.command, via: 'app' });

async function section(title: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n${title}`);
  try {
    await body();
  } catch (e) {
    check(false, `${title}: the section ran to its end`, (e as Error).stack ?? String(e));
  }
  drain();
}

/*
 * Off every display, behind a locked screen or on a sleeping one, WebKit reports `visibilityState:
 * hidden` and stops `requestAnimationFrame`. The harness build switches that off
 * (`DGHarnessKeepDrawing`); if a WebKit drops the switch, one window asked first stops the run.
 */
{
  const w = await open('preflight', { rendered: false });
  let visibility = 'never read';
  try {
    // The window comes forward through `-show` once its page has loaded.
    await until(async () => (visibility = await w.session.evaluate<string>(INJECTED.hostVisibility)) === 'visible', { timeoutMs: 10_000 });
  } finally {
    w.done();
  }
  if (visibility !== 'visible') {
    console.log(
      `\nThe harness window is ${visibility}, so WebKit draws nothing and no check below can be trusted. ` +
        "The harness turns WebKit's occlusion detection off so that it draws off-screen; see its stderr " +
        'for whether this WebKit still offers that.\n'
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------------------------

await section('the bridge and the page (a decision path armed throughout)', async () => {
  const w = await open('security');
  const s = w.session;
  const untouched = w.undecided;
  try {
    const shape = await s.evaluate<ReturnType<typeof INJECTED.hostBridgeShape>>(INJECTED.hostBridgeShape);
    check(shape.present && shape.frozen && !shape.replaced, 'window.draftgate is there, frozen, and cannot be replaced', JSON.stringify(shape));
    check(JSON.stringify(shape.keys) === '["decide","request"]', 'it offers request and decide, and nothing else', JSON.stringify(shape.keys));
    const req = await s.evaluate<{ destination: string; fields: number | null } | null>(INJECTED.hostBridgeRequest);
    check(req?.destination === 'jira' && req.fields === 1, 'the main frame is handed the request', JSON.stringify(req));

    const sub = await s.evaluate<Awaited<ReturnType<typeof INJECTED.hostSubframeAttack>>>(INJECTED.hostSubframeAttack, 'request');
    // Vacuity control: the raw handler is in every frame, so the host's frame check is what refuses.
    check(sub.created && sub.handlerInFrame === 'object' && sub.wrapperInFrame === 'undefined',
      'an about:blank subframe exists, sees the raw handler, and has no wrapper', JSON.stringify(sub));
    check(sub.request === 'refused', "the subframe's request for the draft gets nothing", sub.request);
    await s.evaluate(INJECTED.hostSubframeAttack, 'decide');
    await sleep(400);
    check(untouched(), "the subframe's approval wrote no decision, and the window stayed");

    const downloads = join(homedir(), 'Downloads');
    const before = existsSync(downloads) ? new Set(readdirSync(downloads)) : new Set<string>();
    for (const how of ['https', 'self', 'open', 'blank', 'download', 'form'] as const) {
      const said = await s.evaluate<string>(INJECTED.hostTryToLeave, how);
      await sleep(300);
      const where = await s.evaluate<{ href: string; shell: boolean }>(INJECTED.hostWhere);
      const stayed = where.href === 'draftgate://review/index.html' && where.shell && untouched();
      check(stayed && (how !== 'open' || said === 'null'), `leaving by ${how} is refused, and the review stays`, JSON.stringify({ said, where }));
    }
    const arrived = existsSync(downloads) ? readdirSync(downloads).filter((n) => !before.has(n)) : [];
    check(arrived.length === 0, 'the <a download> left nothing in ~/Downloads', arrived.join(', '));

    const reads = await s.evaluate<{ scheme: string; https: string; xhr: string }>(INJECTED.hostReads);
    check(reads.scheme === 'refused' && reads.xhr === 'refused', 'fetch and XHR of draftgate:// are refused', JSON.stringify(reads));
    check(reads.https === 'refused', 'fetch of https is refused', reads.https);
    const policy = await s.evaluate<{ evaluated: string; inline: string; worker: string }>(INJECTED.hostScriptPolicy);
    check(policy.evaluated === 'refused', 'eval is refused (script-src)', policy.evaluated);
    check(policy.inline === 'no', 'an inline script does not run', policy.inline);
    check(policy.worker === 'refused', 'a worker is refused (worker-src)', policy.worker);
    // The positive control for the absences above: a refusal only the CSP engine can report. Polled:
    // the event travels on its own.
    const refused = await until(() => s.hasMessage(isConnectRefusal), { timeoutMs: 2000 });
    check(refused, 'the CSP engine itself refused a connect-src read (trusted securitypolicyviolation)',
      s.allMessages().map((m) => m.text).join('\n'));
    // ...and the page cannot fake it. The harness hears the engine in a world of its own and sets
    // `trusted` itself, so a refusal posted on the console channel (the real one's text, re-pointed)
    // and a violation event the page dispatches both arrive untrusted.
    const real = s.allMessages().find(isConnectRefusal)?.text ?? '';
    const realUrl = /^'([^']*)'/.exec(real)?.[1] ?? '';
    const posted = 'draftgate://review/forged-posted';
    const dispatched = 'draftgate://review/forged-dispatched';
    const reach = await s.evaluate<{ console: boolean; security: boolean; dispatched: boolean }>(
      INJECTED.hostForgeRefusal, real.replace(realUrl, posted), dispatched);
    check(reach.console && !reach.security && reach.dispatched,
      "the page reaches the harness's console channel and not its CSP one, and can dispatch its own violation", JSON.stringify(reach));
    await until(() => s.hasMessage((m) => m.text.includes(posted)) && s.hasMessage((m) => m.text.includes(dispatched)), { timeoutMs: 2000 });
    const forged = s.allMessages().filter((m) => m.text.includes(posted) || m.text.includes(dispatched));
    check(realUrl !== '' && forged.length === 2 && forged.every((m) => m.trusted === false),
      "a refusal the PAGE posts claiming trust, and a violation it dispatches, are both recorded untrusted", JSON.stringify(forged));

    const perms = await s.evaluate<{ notification: string; media: string; geolocation: string }>(INJECTED.hostPermissions);
    check(perms.notification === 'denied', 'Notification.requestPermission is denied', perms.notification);
    check(perms.media !== 'GRANTED' && perms.geolocation !== 'GRANTED', 'media capture and geolocation are not granted', JSON.stringify(perms));

    const st = await stateOf(s);
    check(st.persistentStore === false, 'the website data store is non-persistent: nothing is kept between reviews');
    check(st.inspectable === false, 'the web view is not inspectable');
    check(st.allowsLinkPreview === false, 'link previews are off (a preview LOADS the link)');
    check(st.allowsMagnification === false, 'pinch magnification is off');
    check(st.hostLevel === 3, 'the host asks for a floating window (alwaysOnTop)', String(st.hostLevel));
    // What the host asks for only; following a desktop switch needs a person to see.
    check(st.hostCollectionBehavior === (COLLECTION.canJoinAllSpaces | COLLECTION.fullScreenAuxiliary),
      'the host asks for a window on every desktop and over a full-screen app (CanJoinAllSpaces | FullScreenAuxiliary, nothing else)',
      String(st.hostCollectionBehavior));
    check(st.title === windowTitle('jira', TOOL), 'the title bar says what windowTitle.cjs composed', String(st.title));
    // The title bar is the only place a review names its tool. Measured: the page retitles itself,
    // WebKit takes it, and the bar keeps the composed title.
    const claimed = 'a title the page chose';
    await s.evaluate(INJECTED.hostSetTitle, claimed);
    const reached = await until(async () => (await stateOf(s)).pageTitle === claimed, { timeoutMs: 2000 });
    const after = await stateOf(s);
    check(reached, 'the page retitled itself, and WebKit took it (so the next check can fail)', String(after.pageTitle));
    check(after.title === windowTitle('jira', TOOL), 'a page that retitles itself leaves the title bar as composed', String(after.title));
    check(untouched(), 'after all of it: no decision, and the window is still up');
  } finally {
    w.done();
  }
});

await section('a review: the menus, zoom, the context menu, undo, and an approval', async () => {
  const w = await open('review');
  const s = w.session;
  try {
    const errors = s.allMessages().filter((m) => m.level === 'error');
    check(errors.length === 0, 'the page logged no error while loading', errors.map((m) => m.text).join('\n'));

    // The menu bar the host builds, labels and accelerators: the standard app menu, Edit and View,
    // and an empty menu named for the destination. No Reload and no DevTools anywhere.
    const cmd = 1 << 20, shift = 1 << 17, option = 1 << 19;
    const want = [
      ['draftgate', [['About draftgate', '', 0], ['Services', '', 0], ['Hide draftgate', 'h', cmd], ['Hide Others', 'h', cmd | option], ['Show All', '', 0], ['Quit draftgate', 'q', cmd]]],
      ['Edit', [['Undo', 'z', cmd], ['Redo', 'z', cmd | shift], ['Cut', 'x', cmd], ['Copy', 'c', cmd], ['Paste', 'v', cmd], ['Paste and Match Style', 'v', cmd | option | shift], ['Select All', 'a', cmd]]],
      ['View', [['Actual Size', '0', cmd], ['Zoom In', '+', cmd], ['Zoom Out', '-', cmd]]],
      ['jira', []],
    ];
    type Item = { title: string; key: string; modifiers: number; ours: boolean };
    const menus = await s.op<{ title: string; items: Item[] }[]>('menus');
    // The host tags its items (`DGMenuTag`), telling them from the ones AppKit appends to Edit by
    // itself (AutoFill, Start Dictation, Emoji & Symbols) without matching English titles.
    const got = menus.map((m) => [m.title, m.items.filter((i) => i.ours).map((i) => [i.title, i.key, i.key ? i.modifiers : 0])]);
    check(JSON.stringify(got) === JSON.stringify(want), "the host's menu bar is the expected one, item for item: no Reload, no DevTools",
      `want ${JSON.stringify(want)}\ngot  ${JSON.stringify(got)}`);
    const appended = menus.every((m) => {
      const firstForeign = m.items.findIndex((i) => !i.ours);
      return firstForeign === -1 || m.items.slice(firstForeign).every((i) => !i.ours);
    });
    check(appended, 'anything else in a menu is appended after the host\'s items, never among them',
      JSON.stringify(menus.map((m) => [m.title, m.items.map((i) => `${i.ours ? '' : '+'}${i.title}`)])));

    // Through NSApplication, so each is the menu's key equivalent, as a reviewer's key arrives.
    await appKey(s, '+');
    let st = await stateOf(s);
    check(st.zoomLevel === 0.5 && Math.abs(st.pageZoom - Math.pow(1.2, 0.5)) < 1e-9, 'Cmd+Plus zooms in one step (level 0.5, 1.2^0.5)', JSON.stringify(st));
    await appKey(s, '-');
    await appKey(s, '-');
    st = await stateOf(s);
    check(st.zoomLevel === -0.5, 'Cmd+Minus zooms out a step at a time', String(st.zoomLevel));
    await appKey(s, '0');
    st = await stateOf(s);
    check(st.zoomLevel === 0 && st.pageZoom === 1, 'Cmd+0 is Actual Size', JSON.stringify(st));

    await s.evaluate(INJECTED.hostContextMenus, false);
    const at = await s.evaluate<{ x: number; y: number } | null>(INJECTED.hostCentre, '.ProseMirror');
    const { x, y } = at ?? { x: 100, y: 100 };
    await s.click(x, y, { right: true });
    let seen = { seen: 0, cancelled: 0 };
    await until(async () => (seen = await s.evaluate<{ seen: number; cancelled: number }>(INJECTED.hostContextMenus, true)).seen > 0, { timeoutMs: 2000 });
    // A menu that did open would be built on the next turn of the host's run loop; give it one.
    await sleep(300);
    st = await stateOf(s);
    // `seen` is the vacuity control: a right-click that never reached the page opens no menu either.
    check(seen.seen >= 1 && seen.cancelled === seen.seen && st.menusOpened === 0,
      'a right-click in the draft reaches the page, is cancelled there, and opens no menu', JSON.stringify({ seen, menusOpened: st.menusOpened, lastMenu: st.lastMenu }));

    await placeCaret(s, INJECTED.caretToEnd, 'the caret could not be put at the end of the draft');
    await s.insertText(' UNDONE-BY-CMD-Z');
    const typed = (await s.evaluate<string | null>(INJECTED.hostEditorText)) ?? '';
    // Through the window, so `performKeyEquivalent:` hands it to the page first, as for a real
    // Cmd+Z; the Edit menu's Undo is the fallthrough. The menu route needs a key window, which an
    // inactive app has none of (`makeKeyWindow` leaves `isKeyWindow` false). Zoom's items target
    // the host, so they can go through the app.
    await s.key('z', 'keyDown', MODIFIER.command);
    let undone = typed;
    await until(async () => !(undone = (await s.evaluate<string | null>(INJECTED.hostEditorText)) ?? '').includes('UNDONE-BY-CMD-Z'), { timeoutMs: 2000 });
    check(typed.includes('UNDONE-BY-CMD-Z') && !undone.includes('UNDONE-BY-CMD-Z'),
      'Cmd+Z reaches the editor\'s history', JSON.stringify({ typed: typed.slice(-40), undone: undone.slice(-40) }));

    check(await s.evaluate<boolean>(INJECTED.isPresent, LIVE_APPROVE), 'Approve & send is live');
    const { how, raw, decision } = await approveAndRead(w);
    check(how.code === 0, 'the approval exits 0', `${JSON.stringify(how)} ${w.host.stderr()}`);
    const fields = reviewPlan('jira', {}).map((f) => f.field);
    check(decision?.action === 'approve' && JSON.stringify(Object.keys((decision as { fields?: object }).fields ?? {})) === JSON.stringify(fields),
      'it wrote one approval the CLI accepts, reporting every shown field', JSON.stringify(raw));
  } finally {
    w.done();
  }
});

/*
 * A window that comes forward focuses nothing, and a ⌘↵ or a ⌘J in its first second does nothing
 * (`-show`, `.claude/rules/window.md`; `draftKey.ts`). Four windows come forward through `-show` once
 * their controls exist, so WebKit has one to focus; a fifth when its page loads, as a review's does.
 * Each waits out its mount's grace, then becomes key, whose `focus` event restarts the grace, so the
 * first presses fall inside a grace only coming forward started. Stray typing, Tabs included, is
 * pressed inside the grace and again past it. Then ⌘J past the grace puts the caret where the
 * reviewer edits first, changing nothing, and a ⌘↵ approves exactly what was shown. A second window
 * per shape types after ⌘J, the control: without it "nothing reached the draft" passes for a key
 * that focuses nothing. The windows run at once; none is ever key.
 */
await section('a window that comes forward focuses nothing: stray typing changes nothing, ⌘↵ waits, and ⌘J lets the keyboard in', async () => {
  const BODY = '# Deploy postmortem\n\nThe deploy is done.\n';
  const TITLE = 'Nightly export fails on empty tables';
  // Typed as somebody mid-sentence in another app types: letters, a space, a Return, more letters,
  // and the Tab and Shift-Tab a terminal running Claude Code is pressed with.
  const STRAY = [...'now afadfdf', 'Enter', 'x', 'Tab', 'y', 'Shift-Tab', 'z'];
  const markdown = [{ field: 'commentBody', kind: 'markdown', value: BODY }];
  const EDITOR = '.dg-compose .ProseMirror';
  // `boxes`: a patch, whose edit boxes a Tab moves between.
  const shapes: { name: string; reaches?: string; request: string; target: string; typed: string; boxes?: true }[] = [
    { name: 'markdown body', reaches: "the toolbar's text-style select", request: jiraRequest({ fields: markdown }), target: EDITOR, typed: 'commentBody' },
    {
      name: 'title and body', reaches: "the title's <input>", target: EDITOR, typed: 'description',
      request: jiraRequest({ fields: [{ field: 'summary', kind: 'line', value: TITLE }, { field: 'description', kind: 'markdown', value: BODY }] }),
    },
    { name: 'plain body', reaches: 'the textarea', request: jiraRequest({ fields: [{ field: 'commentBody', kind: 'text', value: BODY }] }), target: 'textarea.dg-plain-body', typed: 'commentBody' },
    {
      name: 'patch', reaches: "the title's <input>", target: 'textarea.dg-edit-text', typed: 'patch.0.new_string', boxes: true,
      request: JSON.stringify(requestFor('linear-patch', SCENARIOS['linear-patch']!)),
    },
    // No `reaches`: a review's page has not drawn when it loads, so nothing is there to reach.
    { name: 'markdown body, forward when it loaded', request: jiraRequest({ fields: markdown }), target: EDITOR, typed: 'commentBody' },
  ];
  type DraftState = ReturnType<typeof INJECTED.hostDraftState>;
  type Shape = (typeof shapes)[number];
  type Check = ReturnType<typeof report.sub>['check'];

  /** Bring a window forward as a review's comes, and wait out the grace that started. */
  const comeForward = async (shape: Shape, tag: string, check: Check) => {
    const drawnFirst = shape.reaches !== undefined;
    const w = await open(`${tag}-${shape.name.replace(/\W+/g, '-')}`, { request: shape.request, showWhenAsked: drawnFirst });
    const s = w.session;
    if (drawnFirst) {
      const drawn = await until(() => s.evaluate<boolean>(INJECTED.hostControlsDrawn), { timeoutMs: 10_000 });
      check(drawn, `${shape.name}: the page drew its controls, ${shape.reaches} first, before the window came forward`);
    }
    const before = await s.evaluate<DraftState>(INJECTED.hostDraftState);
    await sleep(SHORTCUT_GRACE_PAST_MS);
    await s.evaluate(INJECTED.hostWindowFocusEvents, true);
    if (drawnFirst) await s.show();
    await s.becomeKey();
    const focusEvent = await until(async () => (await s.evaluate<number>(INJECTED.hostWindowFocusEvents, false)) > 0, { timeoutMs: 2000 });
    check(focusEvent, `${shape.name}: becoming key gave the page its window focus event, which restarts the grace`);
    return { w, s, before };
  };
  /** ⌘J, and whether the focus went where the reviewer edits first. */
  const draftKeyFocuses = async (s: WKSession, shape: Shape) => {
    await s.press('j', MODIFIER.command);
    return until(() => s.evaluate<boolean>(INJECTED.hostFocusedIs, shape.target, 0), { timeoutMs: 2000 });
  };
  /** A ⌘↵, once the grace has passed: it approves. Not awaited: it ends the window. */
  const approveByKey = async (w: Opened) => {
    void w.session.key('Enter', 'keyDown', MODIFIER.command).catch(() => undefined);
    return readDecision(w, await Promise.race([w.host.exited, sleep(5000).then(() => null)]));
  };
  const shownFields = (shape: Shape) =>
    Object.fromEntries((JSON.parse(shape.request) as { fields: { field: string; value: string }[] }).fields.map((f) => [f.field, f.value]));

  const stray = async (shape: Shape, { check }: { check: Check }) => {
    const { w, s, before } = await comeForward(shape, 'stray', check);
    try {
      // Inside the grace the reply comes back; one that approved ends the window under it.
      const answered = await s.press('Enter', MODIFIER.command).then(() => true, () => false);
      const waited = answered && w.undecided();
      check(waited, `${shape.name}: a ⌘↵ in the first second after it came forward decided nothing`);
      if (!waited) return;
      await s.press('j', MODIFIER.command);
      const typedAtTheWindow = async (when: string) => {
        for (const key of STRAY) await (key === 'Shift-Tab' ? s.press('Tab', MODIFIER.shift) : s.press(key));
        const focused = await s.evaluate<{ tag: string } | null>(INJECTED.focusedControl);
        check(focused === null, `${shape.name}: ${when}, nothing in the page holds the focus`, JSON.stringify(focused));
        const after = await s.evaluate<DraftState>(INJECTED.hostDraftState);
        check(JSON.stringify(after) === JSON.stringify(before), `${shape.name}: ${when}, typing at the window, Tabs included, changed nothing in the draft or its fields`,
          `before ${JSON.stringify(before)}\nafter  ${JSON.stringify(after)}`);
      };
      await typedAtTheWindow('after a ⌘J inside the grace');
      await sleep(SHORTCUT_GRACE_PAST_MS);
      await typedAtTheWindow('past the grace');

      const inDraft = await draftKeyFocuses(s, shape);
      const focused = await s.evaluate<{ tag: string } | null>(INJECTED.focusedControl);
      check(inDraft, `${shape.name}: ⌘J past the grace put the focus in ${shape.target}`, JSON.stringify(focused));
      await s.press('j', MODIFIER.command);
      const after = await s.evaluate<DraftState>(INJECTED.hostDraftState);
      check(JSON.stringify(after) === JSON.stringify(before), `${shape.name}: ⌘J, pressed twice, changed nothing`,
        `before ${JSON.stringify(before)}\nafter  ${JSON.stringify(after)}`);

      // Still past the grace: focusing an element does not restart it. So the grace refused the first
      // ⌘↵, not nothing listening, and nothing above reached the payload.
      const { how, raw, decision } = await approveByKey(w);
      check(how?.code === 0 && decision?.action === 'approve' && decision.edited === false && JSON.stringify(decision.fields) === JSON.stringify(shownFields(shape)),
        `${shape.name}: the ⌘↵ past the grace approves exactly what was shown, unedited`, `${JSON.stringify(how)} ${JSON.stringify(raw)}`);
    } finally {
      w.done();
    }
  };

  /** The control: after ⌘J a typed character reaches the field ⌘J chose, and the payload. */
  const typed = async (shape: Shape, { check }: { check: Check }) => {
    const { w, s } = await comeForward(shape, 'typed', check);
    try {
      await sleep(SHORTCUT_GRACE_PAST_MS);
      const inDraft = await draftKeyFocuses(s, shape);
      check(inDraft, `${shape.name}: ⌘J past the grace put the focus in ${shape.target}, where the next key goes`);
      if (!inDraft) return;
      if (shape.boxes) {
        // The previews between the edit boxes take no stop.
        await s.press('Tab');
        const second = await s.evaluate<boolean>(INJECTED.hostFocusedIs, shape.target, 1);
        await s.press('Tab', MODIFIER.shift);
        const first = await s.evaluate<boolean>(INJECTED.hostFocusedIs, shape.target, 0);
        check(second && first, `${shape.name}: Tab moves to the next edit box and Shift-Tab back`, JSON.stringify({ second, first }));
      }
      await s.press('Q');
      const { how, raw, decision } = await approveByKey(w);
      const shown = shownFields(shape);
      const sent = decision?.action === 'approve' && decision.edited === true ? decision.fields : undefined;
      const others = Object.keys(shown).filter((k) => k !== shape.typed);
      check(how?.code === 0 && sent?.[shape.typed]?.includes('Q') === true && others.every((k) => sent[k] === shown[k]),
        `${shape.name}: after ⌘J a typed character is sent in ${shape.typed}, and only there`, `${JSON.stringify(how)} ${JSON.stringify(raw)}`);
    } finally {
      w.done();
    }
  };

  // Each window reports into its own channel, printed in the order above whichever finishes first.
  const runs = shapes.flatMap((shape) =>
    [stray, typed].map((run) => {
      const sub = report.sub();
      return run(shape, sub)
        .catch((e: Error) => sub.check(false, `${shape.name}: the window ran to its end`, e.stack ?? String(e)))
        .then(() => sub.lines);
    })
  );
  for (const lines of await Promise.all(runs)) lines.forEach((line) => console.log(line));
});

/*
 * A WebKit defect: the first `data-destination` (and `data-audience`) leaves the shell, body and
 * compose frame holding the custom properties from before it -- Jira's compose frame in the shell's
 * grey, GitHub's radius 4px, JSM's internal note with no ground. `App.tsx` touches the root on the
 * next frame. Read back once per destination, theme and audience the probe names, against the
 * probe's own expectations.
 */
await section('the first destination and audience restyle what was already drawn', async () => {
  const STALE = ['.dg-shell', '.dg-body', '.dg-compose'];
  const seen = new Set<string>();
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    const want = Object.fromEntries(Object.entries(stylesFor(scenario)).filter(([sel]) => STALE.includes(sel)));
    const key = `${scenario.destination} ${scenario.theme ?? 'light'} ${scenario.audience?.kind ?? ''}`;
    if (Object.keys(want).length === 0 || seen.has(key)) continue;
    seen.add(key);
    const w = await open(`restyle-${name}`, { request: JSON.stringify(requestFor(name, scenario)) });
    try {
      const read = await w.session.evaluate<{ styles: Record<string, Record<string, string> | null> }>(INJECTED.takeCensus, {
        nodes: {},
        stylesOnly: true,
        styles: Object.fromEntries(Object.entries(want).map(([sel, props]) => [sel, Object.keys(props)])),
      });
      const wrong = Object.entries(want).flatMap(([sel, props]) =>
        mismatches(props, read.styles[sel] ?? {}).map((m) => `${sel} ${m}`)
      );
      check(wrong.length === 0, `${key.trim()} (${name}): ${STALE.filter((s) => want[s]).join(', ')} as the probe expects`, wrong.join('\n'));
    } finally {
      w.done();
    }
  }
  check(seen.size >= 8, `enough of the probe's destinations, themes and audiences were opened to mean something (${seen.size})`);
});

/*
 * The sheets' stacks are `tokens.test.ts`'s; the face WebKit draws is asked here, by width, since
 * `font-family` computes to the declared list.
 */
await section('code in Jira, Linear and GitHub draws in Menlo', async () => {
  for (const name of ['jira', 'linear', 'github']) {
    const w = await open(`mono-${name}`, { request: JSON.stringify(requestFor(name, SCENARIOS[name]!)) });
    try {
      for (const selector of ['.ProseMirror :not(pre) > code', '.ProseMirror pre']) {
        const face = await w.session.evaluate<ReturnType<typeof INJECTED.hostCodeFace>>(INJECTED.hostCodeFace, selector);
        check(face !== null && Math.abs(face.own - face.menlo) < 0.01 && Math.abs(face.menlo - face.uiMonospace) > 0.5,
          `${name} ${selector}: drawn in Menlo, not ui-monospace's SF Mono`, JSON.stringify(face));
      }
    } finally {
      w.done();
    }
  }
});

/*
 * `draftgate://` storage keeps nothing between reviews, so the last choice comes in on the request
 * and a new one leaves on the decision.
 */
await section('the theme the CLI remembered applies, and a new choice leaves on the decision', async () => {
  const w = await open('theme', { request: jiraRequest({ theme: undefined, rememberedTheme: 'dark' }) });
  try {
    const stored = await w.session.evaluate<string[] | null>(INJECTED.hostStorage);
    check((stored ?? []).length === 0, "the window's own storage holds nothing on open", JSON.stringify(stored));
    check((await w.session.evaluate<string | null>(INJECTED.readTheme)) === 'dark', 'the remembered dark theme is the one drawn');
    // `dark` -> `system` in core's cycle.
    await w.session.evaluate(INJECTED.clickSelector, '.dg-theme-toggle');
    const { decision } = await approveAndRead(w);
    check(decision?.theme === 'system', 'the switcher\'s new choice rides the approval', JSON.stringify(decision));
  } finally {
    w.done();
  }
});

await section('closing without deciding is a rejection, both ways', async () => {
  for (const how of ['the page calls window.close()', 'the title bar closes the window'] as const) {
    const w = await open(how === 'the page calls window.close()' ? 'close-page' : 'close-window');
    try {
      if (how === 'the page calls window.close()') void w.session.evaluate(INJECTED.closeWindow).catch(() => undefined);
      else void w.session.op('close').catch(() => undefined);
      const exit = await w.host.exited;
      check(exit.code === 0 && !existsSync(w.decisionPath), `${how}: exit 0 and no decision file`, `${JSON.stringify(exit)} ${w.host.stderr()}`);
    } finally {
      w.done();
    }
  }
});

await section('a window that cannot review exits non-zero, naming why', async () => {
  const dir = join(OUT, 'errors');
  mkdirSync(dir, { recursive: true });
  const stale = join(dir, 'stale.json');
  writeFileSync(stale, jiraRequest({ protocol: PROTOCOL_VERSION - 1 }));
  // The review build too: this is decided before AppKit starts, so it shows nothing.
  for (const [which, bin] of [['review', apps.review.bin], ['harness', apps.harness.bin]] as const) {
    const r = await exitOf(bin, { DRAFTGATE_REQUEST: stale, DRAFTGATE_HARNESS: join(dir, 'unused') });
    check(r.code === 1 && r.stderr.includes(`draftgate-surface: request protocol ${PROTOCOL_VERSION - 1} is not ${PROTOCOL_VERSION}; rebuild the surface`),
      `${which} build: a request of another protocol is refused before any window`, JSON.stringify(r));
  }
  const unset = await exitOf(apps.review.bin, {});
  check(unset.code === 1 && unset.stderr.includes('draftgate-surface: DRAFTGATE_REQUEST is not set'), 'review build: no request at all is refused', JSON.stringify(unset));

  // A missing built window exits 1, not a "not found" page a reviewer could only close (a rejection).
  const bare = bareSurface(join(dir, 'no-dist'), 'empty');
  const good = join(dir, 'good.json');
  writeFileSync(good, jiraRequest());
  const channel = WKSession.channel(join(dir, 'no-dist-run'));
  const missing = await exitOf(apps.harness.bin, { DRAFTGATE_REQUEST: good, ...channel.env }, bare);
  check(missing.code === 1 && /draftgate-surface: load failed \(.*the built window is missing a file\)/.test(missing.stderr),
    'a surface with no built window exits 1: load failed', JSON.stringify(missing));

  const w = await open('crash');
  try {
    const pid = (await stateOf(w.session)).webProcess;
    check(typeof pid === 'number' && pid > 0, 'the harness names the WebContent process', String(pid));
    if (typeof pid === 'number') process.kill(pid, 'SIGKILL');
    const exit = await Promise.race([w.host.exited, sleep(5000).then(() => null)]);
    check(exit?.code === 1 && w.host.stderr().includes('draftgate-surface: renderer gone (WebContent terminated)'),
      'a killed WebContent exits the host 1: renderer gone', `${JSON.stringify(exit)} ${w.host.stderr()}`);
  } finally {
    w.done();
  }
});

await section('the CSP HEADER on its own enforces the policy', async () => {
  // A review carries the policy as the header and as a <meta>; stripping the <meta> leaves the header.
  const bare = bareSurface(join(OUT, 'header-only-surface'), 'copy');
  const index = join(bare, 'dist', 'index.html');
  const html = readFileSync(index, 'utf8');
  const stripped = html.replace(/<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>/i, '');
  writeFileSync(index, stripped);
  check(html !== stripped && !/Content-Security-Policy/i.test(stripped), 'the copy of index.html carries no <meta> policy');
  const w = await open('header-only', { surface: bare });
  try {
    const policy = await w.session.evaluate<{ evaluated: string; inline: string; worker: string }>(INJECTED.hostScriptPolicy);
    await w.session.evaluate(INJECTED.hostReads);
    const refused = await until(() => w.session.hasMessage(isConnectRefusal), { timeoutMs: 2000 });
    check(policy.evaluated === 'refused' && policy.inline === 'no' && refused,
      "eval, inline script and a connect-src read are refused by the header alone", JSON.stringify({ policy, refused }));
  } finally {
    w.done();
  }
});

await section("placement and zoom are remembered, on the harness's own file and never the reviewer's", async () => {
  const reviewers = join(OUT, 'state-reviewers-window.json');
  const saved = { x: 100, y: 120, width: 900, height: 700, zoomLevel: 1 };
  const w = await open('state', { windowState: saved, env: { DRAFTGATE_WINDOW_STATE: reviewers } });
  const scratch = join(w.control, 'window.json');
  try {
    let st = await stateOf(w.session);
    check(st.zoomLevel === 1 && Math.abs(st.pageZoom - 1.2) < 1e-9, 'a remembered zoom level opens the review at it', JSON.stringify(st));
    await appKey(w.session, '+');
    void w.session.op('close').catch(() => undefined);
    await w.host.exited;
    const after = JSON.parse(readFileSync(scratch, 'utf8'));
    check(after.zoomLevel === 1.5, 'the new level is written back', JSON.stringify(after));
    check(after.x === saved.x && after.y === saved.y && after.width === saved.width && after.height === saved.height,
      'the restored bounds are written back unchanged, in top-left coordinates', JSON.stringify(after));
    check(!existsSync(reviewers), "DRAFTGATE_WINDOW_STATE, the reviewer's own file, is never touched by a harness build");
  } finally {
    w.done();
  }
});

await section('nothing outlives a killed host', async () => {
  const w = await open('lifetime');
  try {
    const pid = (await stateOf(w.session)).webProcess;
    const t0 = performance.now();
    w.host.kill();
    const gone = await until(() => processGone(pid as number), { timeoutMs: 3000, everyMs: 2 });
    note(`WebContent ${pid} gone ${(performance.now() - t0).toFixed(1)} ms after SIGKILL of the host`);
    check(typeof pid === 'number' && gone, "the WebContent process goes with a SIGKILLed host (it is launchd's child, not ours)");
  } finally {
    w.done();
  }
});

// Every build this layout holds (`HostLayout.buildDir`): a host left by an earlier run is an orphan too.
const left = orphanedHosts();
check(left.length === 0, 'no harness host of this run is still running', left.join(', '));
drain();
finish('host checks');
