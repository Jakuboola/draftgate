/**
 * The WebKit host's source and its two binaries, read rather than run (`surface:host` runs them).
 * Built once into a scratch directory:
 *
 *  - the review binary's selector table carries nothing that evaluates script, synthesises input
 *    or reads a WebContent pid, and the harness binary carries all of it (the vacuity control);
 *  - each file reads exactly the environment it should;
 *  - the rules come from the shared CommonJS modules;
 *  - the bundles are what `reviewHost.ts` says they are.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HARNESS_BUNDLE_ID,
  HOST_BUNDLE_ID,
  MIN_MACOS,
  buildHost,
  hostLayout,
  type HostApps,
} from '../../cli/src/reviewHost';
import { ROOT, SURFACE } from './shared';

const MAIN = readFileSync(join(SURFACE, 'host', 'draftgate.m'), 'utf8');
const HARNESS = readFileSync(join(SURFACE, 'host', 'harness.m'), 'utf8');

let scratch: string;
let apps: HostApps;
/** Each binary's selector table, and each bundle's Info.plist, read once. */
let sent: { review: Set<string>; harness: Set<string> };
let plists: { review: Record<string, unknown>; harness: Record<string, unknown> };

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'draftgate-host-'));
  apps = await buildHost(hostLayout(ROOT, scratch));
  sent = { review: selectors(apps.review.bin), harness: selectors(apps.harness.bin) };
  const plist = (app: string) =>
    JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }));
  plists = { review: plist(apps.review.app), harness: plist(apps.harness.app) };
}, 60_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Every selector a binary's Objective-C code sends: its `__objc_methname` section. */
function selectors(bin: string): Set<string> {
  const out = execFileSync('otool', ['-v', '-s', '__TEXT', '__objc_methname', bin], { encoding: 'utf8' });
  return new Set(out.split('\n').map((l) => l.replace(/^[0-9a-f]+\s+/, '').trim()).filter(Boolean));
}

/**
 * What only a harness may do: run script in the page, synthesise input, take a picture, and load
 * the page again (a review has no Reload: it would discard the reviewer's edits).
 */
const HARNESS_ONLY = [
  'callAsyncJavaScript:arguments:inFrame:inContentWorld:completionHandler:',
  'takeSnapshotWithConfiguration:completionHandler:',
  'reload',
  'sendEvent:',
  'insertText:',
  'keyEventWithType:location:modifierFlags:timestamp:windowNumber:context:characters:charactersIgnoringModifiers:isARepeat:keyCode:',
  'mouseEventWithType:location:modifierFlags:timestamp:windowNumber:context:eventNumber:clickCount:pressure:',
];
/** Nothing in either build may do these at all. */
const NEITHER = [
  'evaluateJavaScript:completionHandler:',
  'evaluateJavaScript:inFrame:inContentWorld:completionHandler:',
];

describe('the review binary cannot drive its own window', () => {
  test('its selector table is real, so the absences below mean something', () => {
    expect(sent.review.size).toBeGreaterThan(100);
    expect(sent.review.has('addScriptMessageHandlerWithReply:contentWorld:name:')).toBe(true);
  });

  test.each(HARNESS_ONLY)('the review build never sends %s', (sel) => {
    expect(sent.review.has(sel)).toBe(false);
  });

  test.each(HARNESS_ONLY)('...and the harness build does, so that absence is not vacuous (%s)', (sel) => {
    expect(sent.harness.has(sel)).toBe(true);
  });

  test.each(NEITHER)('neither build sends %s', (sel) => {
    expect(sent.review.has(sel)).toBe(false);
    expect(sent.harness.has(sel)).toBe(false);
  });

  // Ordered in with no first responder, AppKit picks one through the key-view loop and WebKit
  // focuses the page's first control. `surface:host` fails with the call removed or moved after.
  test('the review build makes its web view first responder before ordering the window in', () => {
    expect(sent.review.has('makeFirstResponder:')).toBe(true);
    const show = MAIN.slice(MAIN.indexOf('- (void)show {'));
    const body = show.slice(0, show.indexOf('\n}\n'));
    const picked = body.indexOf('[_window makeFirstResponder:_webView]');
    expect(picked).toBeGreaterThan(0);
    expect(picked).toBeLessThan(body.indexOf('[_window makeKeyAndOrderFront:nil]'));
  });

  test("a harness window never takes this Mac's focus: only the review build activates", () => {
    const activation = ['activate', 'activateIgnoringOtherApps:', 'activateWithOptions:', 'activateFromApplication:options:'];
    expect(sent.review.has('activate')).toBe(true);
    expect(activation.filter((sel) => sent.harness.has(sel))).toEqual([]);
  });

  test("the WebContent pid is SPI, and only the harness's source names it", () => {
    expect(MAIN).not.toContain('_webProcessIdentifier');
    expect(HARNESS).toContain('_webProcessIdentifier');
  });
});

describe('each file reads exactly the environment it should', () => {
  const reads = (src: string) => [...src.matchAll(/(?:env|environment)\[@"([A-Z_]+)"\]/g)].map((m) => m[1]!).sort();

  test('draftgate.m: the three the CLI sets, and no others', () => {
    expect(reads(MAIN)).toEqual(['DRAFTGATE_DECISION', 'DRAFTGATE_REQUEST', 'DRAFTGATE_WINDOW_STATE']);
    // A harness build reads placement from its channel directory: the reviewer's file only outside it.
    const from = MAIN.indexOf('_windowStatePath = DGHarnessWindowStatePath();');
    const otherwise = MAIN.indexOf('#else', from);
    expect(from > 0 && MAIN.slice(otherwise, MAIN.indexOf('#endif', otherwise))).toContain('env[@"DRAFTGATE_WINDOW_STATE"]');
    expect(MAIN.slice(MAIN.lastIndexOf('#ifdef DG_HARNESS', from), otherwise)).not.toContain('DRAFTGATE_WINDOW_STATE');
  });

  test('harness.m: its channel directory, and nothing else', () => {
    expect(reads(HARNESS)).toEqual(['DRAFTGATE_HARNESS']);
    expect(HARNESS.startsWith('//') && HARNESS.includes('\n#ifdef DG_HARNESS\n')).toBe(true);
    expect(HARNESS.trimEnd().endsWith('#endif')).toBe(true);
  });
});

describe('the rules are the shared modules, not a copy', () => {
  test.each([
    ['request.cjs', 'parseRequest'],
    ['rendererBridge.cjs', 'sanitiseDecision'],
    ['geometry.cjs', 'reviewWindowBounds'],
    ['geometry.cjs', 'restoreBounds'],
    ['geometry.cjs', 'minimumSize'],
    ['geometry.cjs', 'zoomLevelAfter'],
    ['geometry.cjs', 'restoreZoomLevel'],
    ['windowTitle.cjs', 'windowTitle'],
  ])('it calls %s %s', (file, fn) => {
    expect(MAIN).toMatch(new RegExp(`call:@"${file.replace('.', '\\.')}" fn:@"${fn}"`));
  });

  test("no rule's own wording is restated", () => {
    for (const message of ['non-empty list of {field, kind, value}', 'is missing `destination`', 'rebuild the surface']) {
      expect(MAIN).not.toContain(message);
    }
  });

  test('the CSP is the contract\'s, served as a header', () => {
    expect(MAIN).toContain('_modules.contract[@"csp"]');
    expect(MAIN).toContain('@"Content-Security-Policy" : _csp');
  });
});

describe('the bundles', () => {
  test.each([
    ['review', HOST_BUNDLE_ID],
    ['harness', HARNESS_BUNDLE_ID],
  ] as const)('%s: named draftgate, its own id, the macOS floor, signed', (name, id) => {
    const plist = plists[name];
    expect(plist.CFBundleName).toBe('draftgate');
    expect(plist.CFBundleIdentifier).toBe(id);
    expect(plist.LSMinimumSystemVersion).toBe(MIN_MACOS);
    expect(plist.DraftgateInputsHash).toBe(apps.hash);
    expect(plist.CFBundleVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(() => execFileSync('codesign', ['--verify', apps[name].app], { stdio: 'pipe' })).not.toThrow();
  });

  test('only the harness is an agent app, so it never reaches the Dock', () => {
    expect(plists.harness.LSUIElement).toBe(true);
    expect(plists.review.LSUIElement).toBeUndefined();
  });

  test('the binary was built for the macOS floor and nothing older', () => {
    const out = execFileSync('otool', ['-l', apps.review.bin], { encoding: 'utf8' });
    expect(out).toMatch(new RegExp(`minos ${MIN_MACOS.replace('.', '\\.')}`));
  });
});
