#!/usr/bin/env bun
/**
 * End to end: the real CLI, the real review window, a real click, the real payload.
 *
 * `bun run surface:e2e`
 *
 * Not in `bun test`: this opens one window per flow (`main()` lists them), off every screen. Run it
 * after touching the surface, the host, the wire protocol, or the orchestration.
 *
 *   cli/test/windowSurface.test.ts     process and file handling, against a fake app
 *   surface/harness/probe.ts           what renders, and whether the stylesheet applied
 *   this file                          the whole path, including the shape of the payload
 *
 * `runCli` stands in for the person, concurrently with the CLI, which does not return until someone
 * decides. Each flow hands the CLI a live harness nonce, so it spawns the harness build of the host
 * (`cli/src/surfaces/webkit.ts`), whose FIFO channel is how a flow clicks (`wkSession.ts`). Only
 * here is a timed-out review that exits 2 with the window still on screen visible: `timeout`.
 */

import { spawn } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  render,
  toEditorDoc,
  fromEditorDoc,
  baselineFor,
  walk,
  collect,
  JSM_BLOCKQUOTE_ALLOWED,
  SUGGESTED_FIX_CODE,
  type AdfDocument,
  type AdfNode,
} from '../../core/src/index';
import {
  BLOCKED_FIXTURE,
  FIXTURE,
  INJECTED,
  JIRA_CONTEXT,
  ROOT,
  SETTLE_PAST_MS,
  releaseNonces,
  reporter,
  survivingNonces,
  until,
  waitUntilRendered,
  placeCaret,
  type Injected,
} from './shared';
import { orphanedHosts, pgrep } from './processes';
import { MODIFIER, WKSession } from './wkSession';
import { processGone } from '../../cli/src/child';
import { HARNESS_BUNDLE_ID, HOST_LAYOUT, HOST_NAME, buildHost } from '../../cli/src/reviewHost';
import { buildDigest, parseAuditLog } from '../../cli/src/digest';
import { surfaceLayout } from '../../cli/src/surfaces/bundleStamp';
import { themePreferencePath } from '../../cli/src/themePreference';

const CLI = join(ROOT, 'cli', 'src', 'main.ts');


/** Where a driven flow's nonce goes, under `scratch`: one name for the writer and the survivor check. */
const NONCE_DIR = 'harness';

const scratch = mkdtempSync(join(tmpdir(), 'draftgate-e2e-'));

const { check, drain, finish } = reporter();

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  /** What the drive's action saw, for a flow that asserts on it (`watch`). */
  observed?: unknown;
}

/** What `watch` saw of a WebKit window the CLI's own deadline ended. */
interface Watched {
  webProcess: number | null;
  /** The host said it left on its own, because its parent was gone: the CLI did not kill it. */
  orphaned: boolean;
}

/**
 * Click one selector in the review window, and say whether anything matched. The probe's `el.click()`
 * (`injected.cjs`): the real React handler, page bridge and `writeDecision`.
 */
const click = (session: WKSession, selector: string) =>
  session.evaluate<boolean>(INJECTED.clickSelector, selector);

const present = (session: WKSession, selector: string) =>
  session.evaluate<boolean>(INJECTED.isPresent, selector);

/**
 * A click that ends the window, sent without waiting for an answer. Measured: `writeDecision`
 * destroys the window and quits the app before a reply comes back, so an awaited call hangs until
 * the attach timeout. The decision file and the CLI's exit code prove the click.
 */
const clickAndLetGo = (session: WKSession, selector: string) =>
  session.evaluateNoWait(INJECTED.clickSelector, selector);

/** The footer's send button, while it is live. */
const LIVE_APPROVE = '.dg-btn-primary:not([disabled])';

/** Click a control, or throw naming what was not there, so a missed click fails as the gesture. */
async function clickOrThrow(session: WKSession, selector: string, complaint: string): Promise<void> {
  if (!(await click(session, selector))) throw new Error(complaint);
}

/**
 * Approve the draft, and fail if Approve is not live. Not "approve, or close if you cannot": with
 * Approve wrongly dead that would report a clean drive while the flow died on `JSON.parse('')`.
 */
async function approve(session: WKSession): Promise<void> {
  // Not `clickOrThrow`: the approving click destroys the window, so an awaited reply never comes.
  // After `driveWindow`'s render wait, a missing LIVE_APPROVE can only mean it is disabled.
  if (!(await present(session, LIVE_APPROVE))) {
    throw new Error(
      'Approve was not live, so this draft was not approvable at all -- either the footer changed ' +
        'or something is blocking a draft that should send'
    );
  }
  clickAndLetGo(session, LIVE_APPROVE);
}

/**
 * Close the window with no decision, as a reviewer who will not send does, and fail if Approve was
 * live. For the flows whose claim is that the window refused (`blockedStaysBlocked`,
 * `emptyStaysBlocked`, `title-clear-blocks`, `show-me`). `window.close()`: the host quits with its last
 * window and exits 0 with no decision file, which `readDecision` reads as "the human closed the
 * window" (`surface:host` checks both ways of closing).
 */
async function closeUndecided(session: WKSession): Promise<void> {
  if (await present(session, LIVE_APPROVE)) {
    throw new Error(
      'Approve was LIVE on a draft that must not be sendable -- the window is offering to send it'
    );
  }
  session.evaluateNoWait(INJECTED.closeWindow);
}

/**
 * What each flow does to the window, once attached; what it resolves to reaches the flow as
 * `Run.observed`. Every one that changes the draft waits for visible proof the change reached React
 * before approving: a tick can reach the DOM and not React (`check-approve`). A step that cannot
 * proceed throws, and `runCli` reports it naming the action.
 */
const ACTIONS: Record<string, (session: WKSession, cliPid: number | undefined) => Promise<unknown>> = {
  approve,

  /** Ask macOS what it calls this window's app while it is up, then approve. See `windowIsDraftgate`. */
  identify: async (session, cliPid) => {
    const seen = await appIdentity(cliPid);
    check(seen?.name === HOST_NAME, `macOS calls the window's app "${HOST_NAME}"`, `lsappinfo saw ${JSON.stringify(seen)}`);
    // The CLI hands a live harness the harness build, which has its own id; the review build's is
    // `host.test.ts`'s, read off its Info.plist, and a human's check.
    check(seen?.bundleId === HARNESS_BUNDLE_ID, `its bundle id is ${HARNESS_BUNDLE_ID}`, JSON.stringify(seen));
    await approve(session);
  },

  /*
   * Note the WebContent pid (launchd's child, so invisible to an orphan check by parent), wait for
   * the CLI's own timer to end the review, and note whether the host left on its own.
   */
  watch: async (session): Promise<Watched> => {
    const { webProcess } = await session.op<{ webProcess: number | null }>('state');
    const timer = new Promise<void>((resolve) => setTimeout(resolve, 30_000).unref());
    await Promise.race([session.gone, timer]);
    return { webProcess, orphaned: session.orphaned };
  },

  /** A reviewer who reads a blocked draft and closes the window. See `closeUndecided`. */
  'close-undecided': closeUndecided,

  /*
   * Build a shape markdown cannot carry, then ask the window to point at it. One Shift+Enter takes a
   * clean draft to blocked, and no fixture can carry the shape, so this is the only route to
   * `body/structure-lost` in a browser.
   */
  'show-me': async (session) => {
    await placeCaret(session, INJECTED.caretToTrailingParagraph, 'the caret could not be put in the empty paragraph below the list');
    // An AppKit key event, so TipTap's own keymap makes the `hardBreak`.
    await session.press('Enter', MODIFIER.shift);
    // Then more text, so the break is interior: a trailing `hardBreak` serialises like no break, so
    // `edited` stays false and `lostInMarkdown` never runs.
    await session.insertText('and this one after it');
    await waitForSelector(session, '.dg-edited', 'the Shift+Enter never reached the editor');

    // Blocking, so never withheld by the arrival delay (`settledWarnings.ts`).
    await waitForSelector(
      session,
      '.dg-status[data-blocked="true"]',
      'a <hardBreak> markdown cannot carry did not block the draft'
    );
    const disabled = await session.evaluate<boolean>(INJECTED.isPresent, '.dg-btn-primary:disabled');
    check(disabled, 'Approve is disabled, so the reviewer must fix the shape rather than send it');

    // `.dg-warnlink` is "Show me", the only action a warning with no repair offers.
    await clickOrThrow(session, '.dg-warnlink', 'the blocking warning offered no "Show me"');
    await waitForSelector(session, '.dg-lost-highlight', 'clicking "Show me" outlined nothing');

    const box = await session.evaluate<{
      width: number;
      height: number;
      text: string;
      tag: string;
    } | null>(INJECTED.paintedBox, '.dg-lost-highlight');
    check(box !== null, 'the outline is in the document');
    // A painted box: the class can land on the `<br>` the `hardBreak` renders as, which has none.
    check(
      (box?.width ?? 0) > 0 && (box?.height ?? 0) > 0,
      'the outline has a PAINTED box, so the reviewer can actually see where to look',
      `rect was ${box?.width}x${box?.height} on <${box?.tag}>`
    );
    /*
     * On the block that holds the break. Measured, the editor at this point is:
     *
     *     <ul><li><p>One line the reviewer will break.</p></li></ul>
     *     <p class="dg-lost-highlight"><br>and this one after it</p>
     *
     * `caretToTrailingParagraph` lands in the empty paragraph TipTap keeps after the last block, so
     * the break is made there.
     */
    check(
      (box?.text ?? '').includes('and this one after it'),
      'the outline covers the block holding the break, not another one',
      `<${box?.tag}> ${box?.width}x${box?.height} covering ${JSON.stringify(box?.text)}`
    );

    // Blocked, so there is nothing to approve: the reviewer closes, which the CLI reads as a denial.
    await closeUndecided(session);
  },

  /*
   * A title holding a line break: the box draws it, and typing onto the title sends the break back,
   * not the picture. The mapping runs in `onChange`, which happy-dom never fires (`window.test.tsx`
   * sees only the drawing).
   */
  'title-break-edit-approve': async (session) => {
    const shown = await session.evaluate<string | null>(INJECTED.proseFieldValue);
    if (shown !== 'Export fails\u240Asee #12') {
      throw new Error(`the title box showed ${JSON.stringify(shown)}, not the break drawn as \u240A`);
    }
    if (!(await session.evaluate<boolean>(INJECTED.focusProseField))) {
      throw new Error('the title field could not be focused, so typed text would go nowhere');
    }
    await session.insertText(' again');
    await waitForSelector(session, '.dg-edited', 'the title edit never registered as an edit');
    await approve(session);
  },

  /*
   * Type into the title, not the body. In happy-dom a dispatched `input` event never runs React's
   * handler, so it cannot reach `setProse` (measured: element, container and body listeners all
   * fired); AppKit's `insertText:` does. A title-only edit must make the review edited, though
   * `edited` is computed from the body everywhere else.
   */
  'title-edit-approve': async (session) => {
    if (!(await session.evaluate<boolean>(INJECTED.focusProseField))) {
      throw new Error('the title field could not be focused, so typed text would go nowhere');
    }
    await session.insertText(' on empty tables');
    // The badge appears only if a prose edit counted as an edit.
    await waitForSelector(session, '.dg-edited', 'the title edit never registered as an edit');
    await approve(session);
  },

  /*
   * Empty the title, and find that you cannot send it. Prose fields are unlabelled, so the
   * placeholder is the only thing naming which box to fix; `prose/empty` blocks because Jira answers
   * 400 to an empty summary and writes nothing. A placeholder renders only on an empty input, which
   * only a real browser shows.
   */
  'title-clear-blocks': async (session) => {
    if (!(await session.evaluate<boolean>(INJECTED.selectProseField))) {
      throw new Error('the title field could not be focused and selected, so it cannot be emptied');
    }
    // A real Backspace: assigning `value` does not reach React.
    await session.press('Backspace');
    await waitForSelector(
      session,
      '.dg-status[data-blocked="true"]',
      'emptying the title did not block the draft'
    );

    const disabled = await session.evaluate<boolean>(INJECTED.isPresent, '.dg-btn-primary:disabled');
    check(disabled, 'Approve is dead, so an empty title cannot be sent by clicking');

    const shows = await session.evaluate<{ value: string; placeholder: string } | null>(
      INJECTED.proseFieldShows
    );
    check(shows !== null, 'the emptied field is still on screen rather than gone');
    check(
      shows?.value === '',
      'the field really is empty, so the placeholder is what a reviewer sees',
      JSON.stringify(shows?.value)
    );
    // An empty box with no placeholder is a nameless input.
    check(
      shows?.placeholder === 'fields.summary',
      'the empty field names itself, since no label does',
      JSON.stringify(shows?.placeholder)
    );

    // `closeUndecided` also checks no live Approve exists: a footer that rendered both a disabled
    // and an enabled button would pass either check alone.
    await closeUndecided(session);
  },

  /*
   * Type over the start of a Slack link's label, then approve. The start, because ProseMirror gives
   * replacing text the marks running across the selection, and a link ends at its last character.
   */
  'slack-label-edit': async (session) => {
    if (!(await session.evaluate<boolean>(INJECTED.selectText, 'ABC'))) {
      throw new Error('the label ABC-1 was not drawn as text in the draft');
    }
    await session.insertText('DEF');
    await waitForSelector(session, '.dg-edited', 'typing over the label never registered as an edit');
    await approve(session);
  },

  'edit-approve': async (session) => {
    // `insertText` reaches the focused editor as keyboard input does, so ProseMirror's transaction
    // and TipTap's `onUpdate` both run.
    if (!(await session.evaluate<boolean>(INJECTED.focusEditor))) {
      throw new Error('the editor could not be focused, so typed text would go nowhere');
    }
    await session.insertText('EDITED BY THE REVIEWER. ');
    // The badge is the signal that onUpdate ran.
    await waitForSelector(session, '.dg-edited', 'the probe edit never registered');
    await approve(session);
  },

  /*
   * A repair, then Enter at the end of the draft: the warning must not come back. The only flow with
   * a keystroke after a repair (`warn-fix-approve` approves at once); Enter at the end appends a node
   * markdown may not carry back.
   */
  'repair-then-type': async (session) => {
    // Typed, not loaded -- see `typeBareUrl`.
    await typeBareUrl(session, 'https://example.org');
    await clickOrThrow(session, '.dg-warnbar', 'no warning to unfurl');
    await waitForSelector(session, '.dg-warn', 'unfurling revealed no rows');
    await clickOrThrow(session, '.dg-warn-fix', 'no per-warning repair offered');
    await clickOrThrow(session, '.dg-modal .dg-btn-primary', 'the preview had nothing to confirm');
    await waitForSelector(
      session,
      '.dg-status[data-severity="ok"]',
      'the repair did not clear the warning, so the sequel cannot be tested'
    );

    await placeCaret(session, INJECTED.caretToEnd, 'the caret could not be put at the end of the draft');
    await session.press('Enter');
    await waitForSelector(session, '.dg-edited', 'the Enter never reached the editor');

    // Past the settle delay: a returning warning is a fresh arrival, withheld for `SETTLE_MS`
    // (`settledWarnings.ts`), so checking sooner would pass on one still settling.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_PAST_MS));
    check(
      !(await present(session, '.dg-warnbar')),
      'the repaired warning stayed gone through the next keystroke',
      'it came back: the repair does not survive an edit'
    );
    await approve(session);
  },

  'check-approve': async (session) => {
    // A real click on a real checkbox, through TaskItem's own node view.
    await clickOrThrow(session, '.ProseMirror input[type=checkbox]', 'no task checkbox to toggle');
    // The badge is the transaction having reached React, not only the DOM.
    await waitForSelector(session, '.dg-edited', 'the checkbox toggle never registered as an edit');
    await approve(session);
  },

  /*
   * The two repair flows differ only in which control opens the preview and what counts as proof: a
   * per-warning repair (`Warning.fixes`) on an unblocked draft, or the blocked draft's repair.
   */
  'warn-fix-approve': async (session) => {
    // Typed, not loaded: see `typeBareUrl`. The payload carries a PLACEHOLDER for it.
    await typeBareUrl(session, 'https://example.org');
    return reviewRepair(session, {
      // The list is furled by default; the blocked draft's repair is a link on the strip itself.
      unfurl: '.dg-warnbar',
      open: '.dg-warn-fix',
      complaint: 'no per-warning repair to review',
      proofs: [
        { selector: '.dg-edited', complaint: 'the warning repair changed nothing' },
        // The only warning is the one repaired, so the strip goes green at once: a list that held
        // the repaired warning for its settle delay passes the edit check and fails this one.
        {
          selector: '.dg-status[data-severity="ok"]',
          complaint: 'the repair applied but the strip still reports a problem',
        },
        { selector: '.dg-warnbar', complaint: 'the repaired warning is still on screen', gone: true },
      ],
    });
  },

  'fix-approve': (session) =>
    reviewRepair(session, {
      open: '.dg-warnlink',
      complaint: 'no suggested fix to review',
      proofs: [
        {
          // The strip's blocked state going away: the fix applied and the draft re-rendered clean.
          // The strip is always present, so the selector reads state, not existence.
          selector: '.dg-status[data-blocked="true"]',
          complaint: 'the fix applied but did not unblock the draft',
          gone: true,
        },
      ],
    }),

  'classify-approve': async (session) => {
    // Through the real button and bridge: the flow is about what the CLI does with the answer.
    await clickOrThrow(session, '.dg-audience-answer', 'no audience answer button to click');
    // The banner turning public is the recompute, and it must happen before the approval.
    await waitForSelector(
      session,
      '.dg-audience-public',
      'the banner did not become public after answering'
    );
    await approve(session);
  },

  'theme-choose': async (session) => {
    // Two clicks on the switcher, `system` -> `light` -> `dark`, then approve: the choice must ride
    // the decision for the CLI to keep, since the WebKit host's own storage does not persist.
    for (const _ of [1, 2]) await clickOrThrow(session, '.dg-theme-toggle', 'no theme switcher to click');
    const shown = await session.evaluate<string | null>(INJECTED.readTheme);
    if (shown !== 'dark') throw new Error(`two clicks on the switcher left the window ${shown}, not dark`);
    await approve(session);
  },

  'theme-remembered': async (session) => {
    // A fresh window keeps nothing of the last one: the only thing that can make this window dark
    // is the CLI's copy of the last choice, carried on the request.
    const shown = await session.evaluate<string | null>(INJECTED.readTheme);
    if (shown !== 'dark') throw new Error(`the remembered theme did not apply: the window opened ${shown}`);
    await approve(session);
  },

  reject: async (session) => {
    // Two clicks: the reason field opens first.
    await clickOrThrow(
      session,
      '.dg-footer .dg-btn:not(.dg-btn-primary)',
      'no reject control in the footer'
    );
    await waitForSelector(session, '.dg-reject', 'the rejection reason field never opened');
    clickAndLetGo(session, '.dg-btn-danger');
  },
};

/**
 * Type a bare URL into the draft, replacing a `PLACEHOLDER` the payload put there. The only route to
 * `slack/url-swallows-next-line`, the one warning offering a per-warning repair: loading `https://x`
 * rewrites it to `[https://x](https://x)`, one of that warning's own repairs, while typed text stays
 * text (`Link` has `autolink: false` in `Editor.tsx`).
 */
async function typeBareUrl(session: WKSession, url: string): Promise<void> {
  if ((await session.evaluate<ReturnType<Injected['selectText']>>(INJECTED.selectText, 'PLACEHOLDER')) === null) {
    throw new Error('the PLACEHOLDER the URL replaces was not in the draft');
  }
  await session.insertText(url);
  await waitForSelector(session, '.dg-edited', 'the typed URL never registered as an edit');
  // The warning arrives, and an arrival is withheld for `SETTLE_MS`.
  await new Promise((resolve) => setTimeout(resolve, SETTLE_PAST_MS));
  await waitForSelector(session, '.dg-warnbar', 'the typed URL produced no warning at all');
}

/** Open a repair preview, confirm it, wait for the proof it changed something, then approve. */
async function reviewRepair(
  session: WKSession,
  step: {
    /** Pressed first, when the control that opens the preview is behind something. */
    unfurl?: string;
    open: string;
    complaint: string;
    /** Everything true once confirmed: "the draft changed" and "the strip says clean" are separate. */
    proofs: { selector: string; complaint: string; gone?: boolean }[];
  }
): Promise<void> {
  if (step.unfurl) {
    await clickOrThrow(session, step.unfurl, 'the warning bar would not unfurl');
    await waitForSelector(session, '.dg-warn', 'unfurling the bar revealed no warning rows');
  }
  await clickOrThrow(session, step.open, step.complaint);
  await waitForSelector(session, '.dg-modal', 'the repair preview never opened');
  await clickOrThrow(session, '.dg-modal .dg-btn-primary', 'the preview had nothing to confirm');
  for (const proof of step.proofs) {
    await waitForSelector(session, proof.selector, proof.complaint, { gone: proof.gone });
  }
  await approve(session);
}

/** Wait for a selector to appear (or, with `gone`, to go), and throw naming what did not happen. */
async function waitForSelector(
  session: WKSession,
  selector: string,
  complaint: string,
  { gone = false }: { gone?: boolean } = {}
): Promise<void> {
  const held = await until(async () => (await present(session, selector)) !== gone);
  if (!held) throw new Error(`${complaint} (${selector} never ${gone ? 'went' : 'appeared'})`);
}

/** Attach to the window this flow's CLI is showing, and drive it, concurrently with the CLI. */
async function driveWindow(
  attach: () => Promise<WKSession>,
  action: string,
  cliPid: number | undefined
): Promise<unknown> {
  const perform = ACTIONS[action];
  if (!perform) throw new Error(`no such action: ${action}`);
  const session = await attach();
  try {
    // The attach can complete before the footer exists. `isRendered` requires `.dg-footer .dg-btn`,
    // so afterwards "no live primary" can only mean disabled.
    await waitUntilRendered(session, 'so there was nothing to click');
    return await perform(session, cliPid);
  } catch (e) {
    // A broken gesture still closes the window, or the CLI waits out `DEFAULT_TIMEOUT_MS` (600s).
    // Closed as `closeUndecided` does, so the CLI reads a rejection and the flow fails on its own
    // assertions.
    session.evaluateNoWait(INJECTED.closeWindow);
    throw e;
  } finally {
    session.close();
  }
}

/**
 * Run the CLI as a caller would, optionally with the harness driving the window. `auditTo` opts a
 * flow out of `--no-audit` to read back what was logged; it is a path inside `scratch`, never the
 * reviewer's own log.
 */
async function runCli(args: string[], action?: string, auditTo?: string): Promise<Run> {
  // Under `NONCE_DIR`, so the surviving-nonce check sees it.
  const nonceDir = join(scratch, NONCE_DIR, action ?? 'unattended');
  const started = Date.now();

  // `--no-audit` by default: harness reviews must not reach the real ~/.draftgate/audit.jsonl.
  const child = spawn('bun', [CLI, ...args, ...(auditTo ? ['--audit', auditTo] : ['--no-audit'])], {
    cwd: ROOT,
    env: {
      ...process.env,
      // Keep the harness out of the reviewer's real ~/.draftgate (`draftgateHome()`).
      DRAFTGATE_HOME: join(scratch, 'home'),
      // For every flow, the unclicked `timeout` too: without it the CLI opens the real review
      // window, on the operator's screen.
      ...WKSession.harnessEnv(nonceDir),
    },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: string) => (stdout += c));
  child.stderr.on('data', (c: string) => (stderr += c));

  // Started here and awaited at the end, so a drive that throws does not stop the CLI being
  // observed. Its outcome is its promise (no flag a `.catch` writes), so nothing can be read early.
  const driving = action
    ? driveWindow(() => WKSession.attach(nonceDir), action, child.pid).then(
        (observed) => ({ failure: null, observed }),
        (e: Error) => ({ failure: e.message, observed: undefined })
      )
    : null;

  const run = await new Promise<Run>((resolve, reject) => {
    child.on('error', reject);

    child.on('exit', (code) => {
      // Now, not in the `finally` that removes `scratch`, which an interrupted run never reaches.
      releaseNonces();
      resolve({ code: code ?? -1, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });

  // Awaited: a step whose failure ended the review settles just after the CLI exits.
  const drove = driving ? await driving : null;
  if (action) {
    check(drove?.failure === null, `the harness drove the window (${action})`, drove?.failure ?? '');
    // Printed now: a flow's later `JSON.parse` of an empty stdout would die before its own `drain()`.
    drain();
  }
  return drove ? { ...run, observed: drove.observed } : run;
}

function payload(file: string, body: string) {
  const path = join(scratch, file);
  writeFileSync(path, JSON.stringify({ ...JIRA_CONTEXT, commentBody: body }, null, 2));
  return path;
}

/** The same, Slack-shaped: that tool reads `message` off a `channel_id`. */
function slackPayload(file: string, body: string) {
  const path = join(scratch, file);
  writeFileSync(path, JSON.stringify({ channel_id: 'C1', message: body }, null, 2));
  return path;
}

/** The CLI arguments for a Slack review, beside `JIRA`. */
const SLACK = ['--dest', 'slack'];

const JIRA = ['--dest', 'jira'];

// ---------------------------------------------------------------------------

async function approveUnedited() {
  console.log('\napprove, unedited');
  const unedited = join(scratch, 'unedited.jsonl');
  const run = await runCli(
    ['review', ...JIRA, '--in', payload('unedited.json', FIXTURE)],
    'approve',
    unedited
  );

  check(run.code === 0, 'exit 0', run.stderr);
  const sent = JSON.parse(run.stdout);
  check(sent.contentFormat === 'adf', "contentFormat is 'adf'");
  check(sent.cloudId === JIRA_CONTEXT.cloudId, 'cloudId survives');
  check(sent.issueIdOrKey === JIRA_CONTEXT.issueIdOrKey, 'issueIdOrKey survives');
  check(!run.stderr.includes('(edited)'), 'reported as NOT edited');

  /*
   * An approval sends what was shown: the round trip, edited or not. The round trip rewrites the
   * markdown (a bare URL becomes `[url](url)`) and for Jira the two renders are identical, asserted:
   * a duplicated link mark for a bare URL would fail here.
   */
  const jiraRender = render(FIXTURE, 'jira');
  const fromOriginal = JSON.stringify(jiraRender.converted);
  const roundTrip = fromEditorDoc(toEditorDoc(FIXTURE));
  const fromRoundTrip = JSON.stringify(render(roundTrip, 'jira').converted);
  check(roundTrip !== FIXTURE, 'the round trip really does rewrite the markdown');
  check(fromOriginal === fromRoundTrip, 'for Jira the two renders are identical');
  check(sent.commentBody === fromRoundTrip, 'the body the reviewer READ was sent');

  /*
   * This fixture silences nothing on Jira (`jira/external-image-embedded` survives the round trip),
   * so the log says `[]`, not absent (`HumanDecision`). `jira-silenced` in `probe.ts` covers a code
   * that is silenced.
   */
  const row = JSON.parse(readFileSync(unedited, 'utf8').trim().split('\n').pop()!);
  check(row.edited === false, 'the log says no HUMAN edited it');
  check(
    Array.isArray(row.silenced) && row.silenced.length === 0,
    'the log records that nothing was silenced, as [] rather than as absent',
    `silenced was ${JSON.stringify(row.silenced)}`
  );
  /*
   * `after` is the markdown that went out: the profile-aware round trip (`baselineFor`), not the
   * naive `roundTrip` above. They differ by four bytes on this fixture (the destination's media
   * placement) and render to the same ADF, so only a text comparison tells them apart.
   */
  const shown = baselineFor(jiraRender).body;
  check(
    typeof row.after === 'string' && row.after === shown,
    'and `after` records what actually went out, which is not the same as `before`',
    `after was ${JSON.stringify(row.after)}`
  );
}

/**
 * What macOS calls the app of the window a CLI launched: `lsappinfo`'s display name and bundle id
 * for a child of `cliPid`. By pid: asking by bundle id also finds a real review open in another
 * session.
 */
async function appIdentity(cliPid: number | undefined): Promise<{ name: string | null; bundleId: string | null } | null> {
  if (cliPid === undefined) return null;
  for (const pid of await pgrep(['-P', String(cliPid)])) {
    const asn = execFileSync('lsappinfo', ['find', `pid=${pid}`], { encoding: 'utf8' }).trim().split(/\s+/)[0];
    if (!asn) continue;
    const info = execFileSync('lsappinfo', ['info', asn], { encoding: 'utf8' });
    // The display name is the first quoted string of the report; the bundle id is labelled.
    return { name: /"([^"]*)"/.exec(info)?.[1] ?? null, bundleId: /bundleID="([^"]*)"/.exec(info)?.[1] ?? null };
  }
  return null;
}

/**
 * The window a review opens is called draftgate, asked of macOS while it is up. Under the harness
 * that is the harness build (same name, its own id); the review build's identity is its `Info.plist`.
 * `lsappinfo` reports the name despite `LSUIElement`.
 */
async function windowIsDraftgate() {
  console.log('\nthe review window is draftgate');
  // The name and bundle-id checks run inside the `identify` action, while the window is up.
  const run = await runCli(['review', ...JIRA, '--in', payload('identity.json', FIXTURE)], 'identify');
  check(run.code === 0, 'exit 0', run.stderr);
}

/**
 * A bundle older than its source is rebuilt before the window opens, and the review then works
 * (`cli/test/surfaceBundle.test.ts` covers it over a fake window). One recorded hash in the stamp is
 * changed, as an edit after the build would, without touching the working tree. The stamp must come
 * back identical: same source, same hashes.
 */
async function staleBundleRebuilds() {
  console.log('\na stale bundle is rebuilt before the review');
  const { stampFile, builtRenderer: page } = surfaceLayout(ROOT);
  const before = JSON.parse(readFileSync(stampFile, 'utf8'));
  const pageBuilt = statSync(page).mtimeMs;
  check(typeof before.inputs['surface/src/main.tsx'] === 'string', 'the stamp records the renderer entry');
  writeFileSync(
    stampFile,
    JSON.stringify({ ...before, inputs: { ...before.inputs, 'surface/src/main.tsx': '0'.repeat(64) } })
  );

  const run = await runCli(['review', ...JIRA, '--in', payload('stale.json', FIXTURE)], 'approve');

  check(run.code === 0, 'exit 0: the review ran on the rebuilt window', run.stderr);
  check(
    run.stderr.includes('surface/src/main.tsx changed since it was built') && run.stderr.includes('rebuilding'),
    'stderr says the window was rebuilt, and why',
    run.stderr
  );
  check(JSON.parse(run.stdout || '{}').contentFormat === 'adf', 'the approved payload reached stdout, and nothing else did');
  check(statSync(page).mtimeMs > pageBuilt, 'the page was really rebuilt');
  const after = JSON.parse(readFileSync(stampFile, 'utf8'));
  check(after.stamp === before.stamp, 'the stamp came back identical: same source, same inputs, same hashes');
}

/**
 * A line break in an agent-written title: drawn, warned about (GitHub stores it, so a
 * warning and not a block), and still in the payload after the reviewer types onto the title.
 */
async function titleBreakEditApprove() {
  console.log('\na line break in the TITLE: drawn, and still sent after an edit');
  const file = join(scratch, 'title-break.json');
  writeFileSync(
    file,
    JSON.stringify({ owner: 'Jakuboola', repo: 'draftgate', method: 'create', title: 'Export fails\nsee #12', body: 'Body.\n' })
  );
  const run = await runCli(
    ['review', '--dest', 'github', '--in', file, '--prose-field', 'title'],
    'title-break-edit-approve'
  );
  check(run.code === 0, 'exit 0: a warning, not a block', run.stderr);
  const sent = JSON.parse(run.stdout || '{}');
  check(
    sent.title === 'Export fails\nsee #12 again',
    'the break is sent as a break, beside the reviewer\'s text, and never as the picture',
    JSON.stringify(sent.title)
  );
}

/**
 * A title edited in the real window reaches the payload, and makes the review edited.
 * `cli/test/review.test.ts` covers the CLI writing prose edits and `surface/window.test.tsx` the
 * rendering; only here does a real keystroke reach `fields.summary` in the payload.
 */
async function titleEditApprove() {
  console.log('\ntype into the TITLE, approve, and check the payload');
  const log = join(scratch, 'title-edit.jsonl');
  const file = join(scratch, 'title.json');
  const decisionPath = join(scratch, 'title-edit.decision.json');
  writeFileSync(
    file,
    JSON.stringify({
      ...JIRA_CONTEXT,
      // `__export__` loads as `**export**`: an untouched body the editor rewrites, for the check below.
      fields: { summary: 'Export fails', description: 'We found the cause in the __export__ step.\n', status: 'Open' },
    })
  );
  const run = await runCli(
    [
      'review', '--dest', 'jira', '--in', file,
      '--body-field', 'fields.description',
      '--prose-field', 'fields.summary',
      // Read-only beside it, and it must come back untouched.
      '--context-field', 'fields.status',
      // What the hook adapter reads, and tells the agent of an edit.
      '--decision', decisionPath,
    ],
    'title-edit-approve',
    log
  );

  check(run.code === 0, 'exit 0', run.stderr);
  check(run.stderr.includes('(edited)'), 'a TITLE-only edit reports as edited');
  const sent = JSON.parse(run.stdout);
  check(
    sent.fields.summary === 'Export fails on empty tables',
    "the reviewer's title is in the payload",
    JSON.stringify(sent.fields.summary)
  );
  check(sent.fields.status === 'Open', 'the read-only status is untouched', JSON.stringify(sent.fields));
  check(
    typeof sent.fields.description === 'string' && sent.fields.description.includes('found the cause'),
    'the body survived beside it',
  );

  // The audit log: both sides of the title change; only what changed is recorded, so no `status`.
  const line = JSON.parse(readFileSync(log, 'utf8').trimEnd().split('\n').pop()!);
  check(line.edited === true, 'the log says edited');
  check(
    Array.isArray(line.prose) && line.prose.length === 1 &&
      line.prose[0].field === 'fields.summary' &&
      line.prose[0].before === 'Export fails' &&
      line.prose[0].after === 'Export fails on empty tables',
    'the log carries the title before AND after',
    JSON.stringify(line.prose)
  );

  // What the agent is told: the title, and no body, because the reviewer did not touch it. The
  // window's `bodyEdited`, not `edited` (which a title sets), decides; the control is that the sent
  // body does differ from the draft, by the editor's own normalisation.
  check(typeof line.after === 'string', 'the control: the body sent differs from the draft', JSON.stringify(line));
  const decision = JSON.parse(readFileSync(decisionPath, 'utf8'));
  check(
    JSON.stringify(decision.sentLines) ===
      JSON.stringify([{ field: 'fields.summary', value: 'Export fails on empty tables' }]),
    'the decision file names the changed title for the agent',
    JSON.stringify(decision.sentLines)
  );
  check(!('sentBody' in decision), 'and no body, which the reviewer did not edit', JSON.stringify(decision));
}

/**
 * A call carrying a title and no body (`issue_write`, `method: "create"`): reviewed for real, and the
 * payload gains no body. Read as body-only it would report `body/missing-field` and leave through
 * `decide.ts`'s schema-drift hatch unreviewed. `window.test.tsx` and `cli/test/review.test.ts` (from a
 * stub) cover the halves; only here does the real stdout show `writeBodyPath` invents nothing.
 */
async function titleOnlyApprove() {
  console.log('\nreview a call with a TITLE and no body, and check nothing invents one');
  const log = join(scratch, 'title-only.jsonl');
  const file = join(scratch, 'title-only.json');
  const input = {
    owner: 'Jakuboola',
    repo: 'draftgate',
    method: 'create',
    title: 'Nightly export fails on empty tables',
  };
  writeFileSync(file, JSON.stringify(input));
  const run = await runCli(
    [
      'review', '--dest', 'github', '--in', file,
      '--prose-field', 'title',
      '--context-field', 'method',
    ],
    'approve',
    log
  );

  check(run.code === 0, 'exit 0: a call with prose and no body IS reviewable', run.stderr);
  const sent = JSON.parse(run.stdout);
  check(
    sent.title === 'Nightly export fails on empty tables',
    'the title reaches the payload',
    JSON.stringify(sent.title)
  );
  // On a `convert-and-replace` destination an invented body would go out as a converted document.
  check(!('body' in sent), 'no body field was invented', JSON.stringify(Object.keys(sent)));
  check(
    JSON.stringify(sent) === JSON.stringify(input),
    'and nothing else moved either',
    JSON.stringify(sent)
  );

  // `before` is absent, not empty: `before: ''` would read as an approved empty message.
  const line = JSON.parse(readFileSync(log, 'utf8').trimEnd().split('\n').pop()!);
  check(line.outcome === 'approved', 'the log records the approval', line.outcome);
  check(!('before' in line), 'and records NO body rather than an empty one', JSON.stringify(line));
}

/**
 * A title emptied in the real window is refused by the window (`prose/empty`: Jira answers 400 to an
 * empty summary and writes nothing). The CLI's backstop behind it is for a surface that never asks
 * core, and `cli/test/review.test.ts` exercises it.
 */
async function titleClearRefused() {
  console.log('\nEMPTY the title: blocked in the window, so nothing is ever submitted');
  const log = join(scratch, 'title-clear.jsonl');
  const file = join(scratch, 'title-clear.json');
  writeFileSync(
    file,
    JSON.stringify({
      ...JIRA_CONTEXT,
      fields: { summary: 'Export fails', description: 'We found the cause.\n', status: 'Open' },
    })
  );
  const run = await runCli(
    [
      'review', '--dest', 'jira', '--in', file,
      '--body-field', 'fields.description',
      '--prose-field', 'fields.summary',
    ],
    'title-clear-blocks',
    log
  );

  check(run.code === 1, 'exit 1: an empty title is not sendable', run.stderr);
  check(run.stdout.trim() === '', 'nothing reached stdout, so no payload was produced');

  // A rejection ("closed without a decision"), not the CLI's backstop: nothing was submitted.
  const line = JSON.parse(readFileSync(log, 'utf8').trimEnd().split('\n').pop()!);
  check(line.outcome === 'rejected', 'the log records a rejection', JSON.stringify(line.outcome));
  check(
    typeof line.before === 'string' && line.before.includes('found the cause'),
    'the log kept the body that was under review',
  );
}

async function approveEdited() {
  console.log('\napprove, after a real edit');
  const log = join(scratch, 'hand-edit.jsonl');
  const run = await runCli(
    ['review', ...JIRA, '--in', payload('edited.json', FIXTURE)],
    'edit-approve',
    log
  );

  check(run.code === 0, 'exit 0', run.stderr);
  check(run.stderr.includes('(edited)'), 'reported as edited');
  const sent = JSON.parse(run.stdout);
  check(
    JSON.stringify(sent.commentBody).includes('EDITED BY THE REVIEWER'),
    "the reviewer's text is in the payload"
  );
  check(sent.cloudId === JIRA_CONTEXT.cloudId, 'cloudId still survives an edit');

  // A real typed edit logs `fixes: []`, not absent: `[]` makes it a rewrite, and absent would log
  // every hand edit in the real UI as `unknown`.
  const line = JSON.parse(readFileSync(log, 'utf8').trimEnd().split('\n').pop()!);
  check(Array.isArray(line.fixes) && line.fixes.length === 0,
    'a typed edit logs fixes as an EMPTY array, not as absent', JSON.stringify(line.fixes));
  const digest = buildDigest(parseAuditLog(readFileSync(log, 'utf8')), { limit: 0 });
  check(digest.totals.rewritten === 1, 'the digest counts it as a rewrite',
    JSON.stringify(digest.totals));
  check(digest.totals.editedKindUnknown === 0, 'and not as unknown');
}

/**
 * Slack's own link syntax, `<url|label>` and `<url>`, from the window to the payload.
 *
 * The probe's `slack-angle-links` covers the drawing. Unedited, the agent's bytes go out and nothing
 * is recorded as changed (`_it_` stays `_it_`, `<url>` stays `<url>`); edited, Slack's form.
 */
const SLACK_LINKS =
  'Update: <https://e.test/issue/ABC-1/some-slug|ABC-1> is done, see <https://example.com/b|*bold* _it_ label> ' +
  'and <https://example.com/c>.\n';

async function slackLinksUnedited() {
  console.log("\nSlack's <url|label>, approved unedited");
  const log = join(scratch, 'slack-links.jsonl');
  const run = await runCli(['review', ...SLACK, '--in', slackPayload('slack-links.json', SLACK_LINKS)], 'approve', log);

  check(run.code === 0, 'exit 0', run.stderr);
  if (run.code !== 0) return;
  check(!run.stderr.includes('(edited)'), 'reported as NOT edited');
  const sent = JSON.parse(run.stdout);
  check(sent.message === SLACK_LINKS, 'the payload is the bytes the agent wrote', JSON.stringify(sent.message));
  const row = JSON.parse(readFileSync(log, 'utf8').trimEnd().split('\n').pop()!);
  check(row.after === undefined, 'and the log records no change on the way', JSON.stringify(row.after));
}

async function slackLabelEdited() {
  console.log("\nSlack's <url|label>, the label typed over");
  const run = await runCli(['review', ...SLACK, '--in', slackPayload('slack-label.json', SLACK_LINKS)], 'slack-label-edit');

  check(run.code === 0, 'exit 0', run.stderr);
  if (run.code !== 0) return;
  check(run.stderr.includes('(edited)'), 'reported as edited');
  const sent = JSON.parse(run.stdout);
  check(
    sent.message === SLACK_LINKS.replace('|ABC-1>', '|DEF-1>'),
    "the payload carries <url|newlabel>, in Slack's own form, and nothing else changed",
    JSON.stringify(sent.message)
  );
}

/**
 * A task checkbox, from click to payload. A document invalid under the editor's schema
 * (`taskItem > text`) makes ProseMirror throw out of the MutationObserver with no transaction, so the
 * box shows ticked and the task goes out unchecked. `surface/schema.test.ts` covers validity and
 * `probe.ts`'s `jira-task-toggle` the badge; only here does `state: 'DONE'` reach the payload.
 */
async function checkboxApprove() {
  console.log('\napprove, after ticking a task checkbox');
  const run = await runCli(
    ['review', ...JIRA, '--in', payload('checkbox.json', '- [ ] one\n- [x] two\n')],
    'check-approve'
  );

  check(run.code === 0, 'exit 0', run.stderr);
  check(run.stderr.includes('(edited)'), 'a checkbox toggle counts as an edit');

  const sent = JSON.parse(run.stdout);
  const body: AdfDocument = JSON.parse(sent.commentBody);
  const states = collect(body, (n) => n.type === 'taskItem').map((t) => t.node.attrs?.state);
  check(states.length === 2, 'both task items survive', JSON.stringify(states));
  check(states[0] === 'DONE', 'the item the reviewer ticked is sent as DONE', JSON.stringify(states));
  check(states[1] === 'DONE', 'and the one that was already ticked stays DONE', JSON.stringify(states));
  // A repaired-but-emptied task item passes the state check alone (`core/test/hoistMedia.test.ts`).
  check(
    JSON.stringify(body).includes('"one"') && JSON.stringify(body).includes('"two"'),
    'with both labels intact'
  );
}

async function reject() {
  console.log('\nreject');
  const run = await runCli(
    ['review', ...JIRA, '--in', payload('reject.json', FIXTURE), '--json'],
    'reject'
  );

  check(run.code === 1, 'exit 1');
  // Stdout carries the payload and nothing else, so a denial must leave it completely empty.
  check(run.stdout === '', 'stdout is empty', JSON.stringify(run.stdout.slice(0, 80)));
  const denial = JSON.parse(run.stderr);
  check(denial.outcome === 'rejected', 'outcome is rejected');
  // A vague denial makes the agent retry the identical send.
  check(typeof denial.guidance === 'string' && denial.guidance.length > 20, 'carries guidance');

  // Every check above also passes when the Reject button is gone or inert: a window closed with no
  // decision reads as a rejection too. Only the reason tells a click from "The review window closed
  // without a decision."
  check(
    typeof denial.reason === 'string' && !denial.reason.includes('closed without a decision'),
    'the REJECT BUTTON produced this, not a window that closed',
    `reason: ${JSON.stringify(denial.reason)} -- the reject flow fell through to the CLI's ` +
      'absent-decision fallback, which passes every other check in this flow'
  );
}

async function timeout() {
  console.log('\ntimeout');
  // Nobody clicks; the drive only notes the WebContent process (see `watch`).
  const run = await runCli(
    ['review', ...JIRA, '--in', payload('timeout.json', FIXTURE), '--timeout', '5', '--json'],
    'watch'
  );

  check(run.code === 2, 'exit 2');
  check(run.stdout === '', 'stdout is empty');
  check(JSON.parse(run.stderr).outcome === 'timeout', 'outcome is timeout');
  check(run.elapsedMs < 12_000, `denied promptly (${(run.elapsedMs / 1000).toFixed(1)}s)`);

  // Polled: the SIGKILL normally lands well under 200ms. The host by its build, and the WebContent
  // by pid: WebKit's helpers are system services, not in the build dir, so without it this is vacuous.
  const { webProcess, orphaned } = (run.observed as Watched | undefined) ?? { webProcess: null, orphaned: false };
  const contentGone = () => webProcess !== null && processGone(webProcess);
  // The cheap syscall first, so the process-table scan runs only once the WebContent has gone.
  await until(() => contentGone() && orphanedHosts().length === 0, { timeoutMs: 2_000, everyMs: 50 });
  const hosts = orphanedHosts();
  check(webProcess !== null, 'the window named its WebContent process while it was up');
  // A harness host exits within half a second of losing its parent, so "nothing is left" holds
  // either way; the review build has no such watch. The host says when it leaves on its own.
  check(!orphaned, "the CLI's deadline killed the host: it did not have to notice its parent was gone");
  check(hosts.length === 0, 'no orphaned review host', hosts.join(', '));
  check(contentGone(), `its WebContent process ${webProcess} went with it`);
}

/**
 * A blocked draft, its one-click fix, and the approval: the payload, then the audit log line. The
 * only check of the whole chain (`applyFix`, the page bridge and validator, the decision file,
 * `parseWireDecision`, `runReview`, `appendAudit`); a `?? []` anywhere on it fails here.
 */
async function blockedThenFixed() {
  console.log('\nblocked draft, one-click fix, then approve, then the audit log');
  const log = join(scratch, 'audit.jsonl');
  const run = await runCli(
    ['review', ...JIRA, '--in', payload('blocked.json', BLOCKED_FIXTURE)],
    'fix-approve',
    log
  );

  check(run.code === 0, 'exit 0 after the fix', run.stderr);
  if (run.code !== 0) return;
  check(run.stderr.includes('(edited)'), 'the fix counts as an edit');

  const adf: AdfDocument = JSON.parse(JSON.parse(run.stdout).commentBody);

  // A heading or table in a blockquote is a live 400; checked against the schema module's list.
  const inBlockquote: string[] = [];
  walk(adf, (node, _path, parent) => {
    if (parent?.type === 'blockquote') inBlockquote.push(node.type);
  });
  check(inBlockquote.length > 0, 'the blockquote survived');
  check(
    inBlockquote.every((t) => JSM_BLOCKQUOTE_ALLOWED.has(t)),
    'every blockquote child is allow-listed',
    inBlockquote.join(', ')
  );

  // The sanitiser degrades structure and never drops text.
  const text = collect(adf, (n: AdfNode) => n.type === 'text')
    .map(({ node }) => node.text ?? '')
    .join('');
  const lost = [
    'Heading inside a blockquote',
    'Plain paragraph is fine',
    'Intro paragraph',
    'Outro',
  ].filter((w) => !text.includes(w));
  check(lost.length === 0, 'no text was lost by the fix', `lost: ${lost.join(', ')}`);

  const raw = readFileSync(log, 'utf8');
  const line = JSON.parse(raw.trimEnd().split('\n').pop()!);
  const fix = line.fixes?.[0];

  check(line.outcome === 'approved', 'logged as approved');
  check(line.edited === true, 'logged as edited');
  check(Array.isArray(line.fixes) && line.fixes.length === 1, 'exactly one repair recorded',
    JSON.stringify(line.fixes));
  check(fix?.code === SUGGESTED_FIX_CODE,
    `the repair is identified as ${SUGGESTED_FIX_CODE}`, JSON.stringify(fix));
  check(typeof fix?.label === 'string' && fix.label.length > 0,
    'and carries the label the reviewer clicked');
  // The warnings shown before the fix: they describe the draft the agent wrote.
  check(Array.isArray(line.warnings) && line.warnings.length > 0,
    'the warnings that fired are recorded', JSON.stringify(line.warnings));
  check(typeof line.before === 'string' && typeof line.after === 'string',
    'both sides of the edit are stored');
  check(line.before !== line.after, 'and they differ');

  // The reader agrees with the writer.
  const digest = buildDigest(parseAuditLog(raw), { limit: 1 });
  check(digest.totals.repaired === 1, 'the digest counts it as a repair', JSON.stringify(digest.totals));
  check(digest.totals.rewritten === 0, 'and NOT as a rewrite');
  check(digest.totals.editedKindUnknown === 0, 'and not as unknown either');
  check(digest.repairs[0]?.code === SUGGESTED_FIX_CODE, 'and groups it under the right code');
}

/**
 * A repair applied, then one more keystroke: the repair survives the reviewer carrying on typing.
 * The draft is one bare URL and one line under it, so the only warning is the one repaired.
 */
async function repairThenType() {
  console.log('\nrepair, then keep typing');
  // `PLACEHOLDER` (see `typeBareUrl`) is the whole first line: the shape where the baseline round
  // trip equals the repair.
  const body = 'PLACEHOLDER\nThis line is what that URL swallows.\n';
  const run = await runCli(
    ['review', ...SLACK, '--in', slackPayload('repair-then-type.json', body)],
    'repair-then-type'
  );

  check(run.code === 0, 'exit 0', run.stderr);
  if (run.code !== 0) return;
  check(run.stderr.includes('(edited)'), 'the whole sequence counts as an edit');
  const sent = JSON.parse(run.stdout);
  check(
    !/example\.org\nThis line/.test(sent.message),
    'the repaired shape is what was sent, not the original',
    JSON.stringify(sent.message)
  );
}

/**
 * A per-warning repair, applied and followed to the payload and the log. Unlike `blockedThenFixed`'s
 * `suggestedFix`, the offer comes from `Warning.fixes` on an approvable draft and is logged under the
 * warning's code, which the digest groups by. The probe's `slack-warn-fix` only opens the preview.
 */
async function warnFixApprove() {
  console.log('\nper-warning repair, applied then approved');
  const log = join(scratch, 'warn-fix.jsonl');
  const body = 'See PLACEHOLDER\nNext sentence here.\n';
  const run = await runCli(
    ['review', ...SLACK, '--in', slackPayload('warn-fix.json', body)],
    'warn-fix-approve',
    log
  );

  check(run.code === 0, 'exit 0', run.stderr);
  if (run.code !== 0) {
    check(false, 'the flow cannot continue', run.stderr.slice(-800));
    return;
  }
  check(run.stderr.includes('(edited)'), 'applying a repair counts as an edit');

  const sent = JSON.parse(run.stdout);
  // The repair is an explicit link or a blank line; the bare URL followed by prose must not survive.
  check(sent.message !== body, 'the payload is not the original draft', JSON.stringify(sent.message));
  check(
    !/example\.org\nNext sentence/.test(sent.message),
    'the shape the warning named is gone from what was sent',
    JSON.stringify(sent.message)
  );

  const line = JSON.parse(readFileSync(log, 'utf8').trimEnd().split('\n').pop()!);
  check(Array.isArray(line.fixes) && line.fixes.length === 1, 'exactly one repair recorded',
    JSON.stringify(line.fixes));
  check(line.fixes?.[0]?.code === 'slack/url-swallows-next-line',
    'recorded under the WARNING\'s code, which is what the digest groups by',
    JSON.stringify(line.fixes));
  check(typeof line.fixes?.[0]?.label === 'string' && line.fixes[0].label.length > 0,
    'and carries the label the reviewer clicked');

  const digest = buildDigest(parseAuditLog(readFileSync(log, 'utf8')), { limit: 0 });
  check(digest.totals.repaired === 1, 'the digest counts it as a repair', JSON.stringify(digest.totals));
  check(digest.totals.rewritten === 0, 'and NOT as a hand rewrite');
}

async function blockedStaysBlocked() {
  console.log('\nblocked draft, no fix applied');
  // `close-undecided` asserts Approve is dead, then closes, as a reviewer of a blocked draft does.
  const run = await runCli(
    ['review', ...JIRA, '--in', payload('stays-blocked.json', BLOCKED_FIXTURE), '--json'],
    'close-undecided'
  );

  check(run.code === 1, 'exit 1: a blocked draft cannot be approved');
  check(run.stdout === '', 'nothing reached stdout');

  // Exit 1 with empty stdout is also a crashed window, a failed load or `runReview`'s backstop; the
  // reason "closed without a decision" says the window disabled Approve.
  const denial = JSON.parse(run.stderr);
  check(
    denial.reason?.includes('closed without a decision'),
    'because Approve was DISABLED, not because a later layer caught it',
    `reason: ${JSON.stringify(denial.reason)}`
  );
}

async function emptyStaysBlocked() {
  console.log('\nemptied draft, on the destination with no empty-body code of its own');
  // `body/empty` lives in `render()`, not in a profile; `core/test/render.test.ts` ("every
  // destination blocks a blank body") holds it for each. This window holds the other half: a guard
  // only in `runReview` would offer a live Approve and deny after the click.
  const file = join(scratch, 'empty-github.json');
  writeFileSync(file, JSON.stringify({ owner: 'Jakuboola', repo: 'draftgate', body: '   ' }));
  const run = await runCli(['review', '--dest', 'github', '--in', file, '--json'], 'close-undecided');
  check(run.code === 1, 'github: exit 1');
  check(run.stdout === '', 'github: nothing reached stdout');
  // Exit 1 alone cannot tell a disabled Approve from a backstop denying the click: the reason can.
  const denial = JSON.parse(run.stderr);
  check(
    denial.reason?.includes('closed without a decision'),
    'github: the WINDOW disabled Approve, rather than a later layer denying the click',
    `reason: ${JSON.stringify(denial.reason)}`
  );
}

/**
 * "Ask once and remember", end to end: a real click, and the file it writes. Unit tests cover the
 * rule, the recompute and the wire; only here does the answer reach disk. `DRAFTGATE_HOME` is
 * scratch, so the audience starts unknown.
 */
async function classifyThenApprove() {
  console.log('\nanswer the audience question, then approve');
  const run = await runCli(
    [
      'review',
      ...JIRA,
      // Named, as the hook names it: an unnamed caller is `unknown` on the tool and is never asked
      // the project question. Every Jira audience claim was probed against this tool.
      '--tool',
      'mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue',
      '--in',
      payload('classify.json', 'Thanks for the report.\n'),
    ],
    'classify-approve'
  );

  check(run.code === 0, 'exit 0', run.stderr);
  // The drive already required the banner to turn public before approving.
  check(
    run.stderr.includes('remembered that SUPPORT is service_desk'),
    'the CLI says it remembered the answer',
    run.stderr
  );

  const file = join(scratch, 'home', 'jira-projects.json');
  const written = existsSync(file);
  check(written, 'jira-projects.json was written', file);
  if (written) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const site = saved.sites?.[JIRA_CONTEXT.cloudId];
    check(
      site?.projects?.SUPPORT === 'service_desk',
      'and it records SUPPORT as a service desk, under this cloudId',
      JSON.stringify(saved)
    );
    // Stamped as the reviewer's, so a later click can correct it (`JiraProjectSource`).
    check(
      site?.sources?.SUPPORT === 'reviewer',
      'and marks it as the reviewer\'s answer, not a measurement',
      JSON.stringify(site?.sources)
    );
    // 0600, like everything else draftgate keeps: this file names the projects a team supports.
    check((statSync(file).mode & 0o777) === 0o600, 'written 0600');
  }
}

/**
 * The theme a reviewer chose survives to the next review through the CLI: the host's `draftgate://`
 * storage keeps nothing, so the choice rides the decision into `theme.json` and the next request.
 * The file is removed afterwards, so no later flow opens in a theme it did not ask for.
 */
async function themeChoiceRemembered() {
  console.log('\nchoose a theme, approve, and the next review opens in it');
  const file = themePreferencePath({ DRAFTGATE_HOME: join(scratch, 'home') });
  rmSync(file, { force: true });
  try {
    const first = await runCli(['review', ...JIRA, '--in', payload('theme-payload.json', 'Theme check.\n')], 'theme-choose');
    check(first.code === 0, 'exit 0', first.stderr);
    const kept = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    check(kept?.theme === 'dark', 'the surface kept the choice in theme.json', JSON.stringify(kept));
    if (kept) check((statSync(file).mode & 0o777) === 0o600, 'written 0600');
    const second = await runCli(['review', ...JIRA, '--in', payload('theme-payload-2.json', 'Theme check again.\n')], 'theme-remembered');
    check(second.code === 0, 'the next review, on a fresh profile, opened dark and approved', second.stderr);
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * "Show me" points at something a reviewer can see, in real layout. `body/structure-lost` is the only
 * warning that says where and has no repair; `tokens.test.ts` checks only the declared rule. A
 * `Decoration.node` on the `<br>` a `hardBreak` renders has no box, which neither a DOM count nor
 * happy-dom can see, so `paintedBox` reads `getBoundingClientRect`. The flow ends by closing: Approve
 * is disabled (the `show-me` action).
 */
async function showMePointsAtSomethingVisible() {
  console.log('\nblocked by an edit, and "Show me" outlines something you can see');
  // A list, so `caretToTrailingParagraph` lands in the empty paragraph TipTap keeps after it, where a
  // break that begins a paragraph is lost. `a\nb` keeps its `hardBreak`, and a break inside a list
  // item is carriable.
  const body = '- One line the reviewer will break.\n';
  const run = await runCli(
    ['review', ...SLACK, '--in', slackPayload('show-me.json', body)],
    'show-me'
  );

  check(run.code === 1, 'exit 1: a draft markdown cannot carry is not approvable', run.stderr);
  check(!run.stdout.trim(), 'nothing reached stdout');
}

async function main() {
  console.log('draftgate surface, end to end');
  // Built up front: a review's build line on stderr would break a `--json` flow's parse.
  await buildHost(HOST_LAYOUT);
  try {
    await approveUnedited();
    drain();
    await windowIsDraftgate();
    drain();
    await staleBundleRebuilds();
    drain();
    await approveEdited();
    await titleEditApprove();
    drain();
    await titleBreakEditApprove();
    drain();
    await titleClearRefused();
    drain();
    await titleOnlyApprove();
    drain();
    await checkboxApprove();
    drain();
    await slackLinksUnedited();
    drain();
    await slackLabelEdited();
    drain();

    await classifyThenApprove();
    drain();
    await themeChoiceRemembered();
    drain();
    await reject();
    drain();
    await timeout();
    drain();
    await blockedThenFixed();
    drain();
    await warnFixApprove();
    await repairThenType();
    drain();
    await blockedStaysBlocked();
    drain();
    await emptyStaysBlocked();
    drain();
    await showMePointsAtSomethingVisible();
    drain();
    // Before `scratch` goes: a surviving nonce is a live key to the harness build for whatever
    // inherits the variable next, and an interrupted run never reaches the `finally`.
    console.log('\nnothing left behind');
    const nonces = survivingNonces(join(scratch, NONCE_DIR));
    check(
      nonces.live.length === 0,
      'no drive nonce survived the run',
      `still live: ${nonces.live.join(', ')}`
    );
    // A driven flow ran, so the directory must be there: the check above looked somewhere real.
    check(
      nonces.existed,
      `the nonce directory ${NONCE_DIR}/ was found, so the check above looked somewhere real`,
      'no driven flow wrote a nonce anywhere under scratch -- the check above cannot fail'
    );
    drain();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  finish('end-to-end checks');
}

main();
