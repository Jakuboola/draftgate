/**
 * Tests for the probe's judgement. `checkReport` is a pure function over a parsed report, so it runs
 * here; launching the window is `bun run surface:probe`'s.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkReport, clearScenarioOutputs, samePixels, stylesFor, OPENABLE_KEYS, SCENARIOS, WINDOW_MIN,
  type Report, type Scenario,
} from './probe';
import { HARNESS, SURFACE } from './shared';
import { VIEWPORT, launchHost } from './wkSession';

/** Collect what the checker decided, instead of printing it. */
function judge(scenario: Scenario, report: Report) {
  const results: { ok: boolean; label: string; detail?: string }[] = [];
  const notes: string[] = [];
  checkReport(
    scenario,
    report,
    stylesFor(scenario),
    (ok, label, detail) => results.push({ ok, label, detail }),
    (text) => notes.push(text)
  );
  const matching = (needle: string) => results.filter((r) => r.label.includes(needle));
  return {
    results,
    notes,
    failures: results.filter((r) => !r.ok),
    failed: (needle: string) => results.some((r) => !r.ok && r.label.includes(needle)),
    passed: (needle: string) => results.some((r) => r.ok && r.label.includes(needle)),
    /** Whether the check ran at all -- distinct from having passed. */
    checked: (needle: string) => matching(needle).length > 0,
    /** The detail of the first matching check; a renamed check fails by name, not with a TypeError. */
    detailOf: (needle: string) => matching(needle)[0]?.detail,
  };
}

const SCENARIO: Scenario = {
  destination: 'jira',
  canonical: '# hi\n',
  counts: { prosemirror: 1, h1: 1 },
};

function reportFor(overrides: Partial<Report['dom']> = {}, rest: Partial<Report> = {}): Report {
  return {
    // Asserted on every scenario: the harness's own bundle, on a store that persists nothing.
    isolation: { bundleId: 'io.github.jakuboola.draftgate.harness', persistentStore: false },
    // Asserted on every scenario: the CSP engine's own refusal says the policy is live
    // (`Report.cspRefusal`).
    cspRefusal:
      "'draftgate://review/index.html' violates the following Content Security Policy directive: " +
      '"connect-src \'none\'" (effective connect-src, enforce)',
    dom: {
      destination: 'jira',
      counts: { prosemirror: 1, h1: 1 },
      styles: {},
      // Asserted on every scenario too: the theme asked for (light by default) and the selection.
      theme: 'light',
      selection: { hasFocus: true, collapsed: false },
      // `null`, not absent: `Census` declares it. Typography scenarios override it.
      font: null,
      links: [],
      linkTargets: [],
      // `[]`, not absent: an absent ledger would mean zero checks (`Report.dom.setup`).
      setup: [],
      diagnostics: {},
      renderedImage: null,
      ...overrides,
    },
    cspViolations: [],
    consoleErrors: [],
    ...rest,
  };
}

describe('checkReport', () => {
  test('a clean report produces no failures', () => {
    expect(judge(SCENARIO, reportFor()).failures).toEqual([]);
  });

  test("a link's drawn text and the target bubble's address are compared exactly", () => {
    const scenario: Scenario = {
      ...SCENARIO,
      links: [{ text: 'ABC-1', href: 'https://e.test/a' }],
      linkTargets: ['https://e.test/a'],
    };
    const drawn = { links: [{ text: 'ABC-1', href: 'https://e.test/a' }], linkTargets: ['https://e.test/a'] };
    expect(judge(scenario, reportFor(drawn)).failures).toEqual([]);
    // The raw characters, which is what a span the converter left as text draws.
    const raw = { ...drawn, links: [{ text: '<https://e.test/a|ABC-1>', href: null }] };
    expect(judge(scenario, reportFor(raw)).failed('links read and open')).toBe(true);
    expect(judge(scenario, reportFor({ ...drawn, linkTargets: [] })).failed('link-target bubble shows')).toBe(true);
  });

  test('a wrong node count fails, and names what it expected', () => {
    const j = judge(SCENARIO, reportFor({ counts: { prosemirror: 1, h1: 3 } }));
    expect(j.failed('node counts')).toBe(true);
    expect(j.failures[0]!.detail).toContain('h1: expected 1, got 3');
  });

  test('a CSP violation fails -- the policy blocking our own bundle is the failure the custom scheme prevents', () => {
    const j = judge(SCENARIO, reportFor({}, { cspViolations: ['Refused to load the script'] }));
    expect(j.failed('CSP violations')).toBe(true);
  });

  test('a console error fails', () => {
    expect(judge(SCENARIO, reportFor({}, { consoleErrors: ['error: boom'] })).failed('console errors')).toBe(true);
  });

  test('the wrong destination stylesheet fails', () => {
    expect(judge(SCENARIO, reportFor({ destination: 'slack' })).failed('styled itself')).toBe(true);
  });

  /*
   * The preconditions every scenario's assertions rest on: a lost selection, a fixture reworded
   * past `selectText`'s needle, a renamed `aria-label` that `clickToOpen` misses. OS focus is not
   * one: `bubble: 1` passes with `document.hasFocus()` false, so `collapsed` is the discriminator.
   */
  describe('the setup a scenario asked for', () => {
    const selecting: Scenario = { ...SCENARIO, selectText: 'hi', counts: { bubble: 1 } };
    const missed = { counts: { bubble: 0 } };

    test('a step that did not take effect fails, carrying the harness reason', () => {
      // Discarded, a failed step would present as a count mismatch or a CSP regression.
      const j = judge(selecting, reportFor({
        ...missed,
        setup: [{ step: 'selectText', arg: 'hi', ok: false, detail: 'the fixture prose has probably changed' }],
      }));
      expect(j.failed('setup: selectText(hi)')).toBe(true);
      expect(j.detailOf('setup: selectText(hi)')).toContain('fixture prose');
      // And the downstream count failure is left as the bare fact it is.
      expect(j.detailOf('node counts')).toBe('bubble: expected 1, got 0');
    });

    test('a clickToOpen that clicked but revealed nothing fails as itself', () => {
      const j = judge(SCENARIO, reportFor({
        setup: [{ step: 'clickToOpen', arg: 'emoji', ok: false, detail: 'clicked, but nothing matching .dg-emoji-btn appeared in 5s' }],
      }));
      expect(j.failed('setup: clickToOpen(emoji)')).toBe(true);
      expect(j.detailOf('setup: clickToOpen(emoji)')).toContain('appeared in 5s');
    });

    test('steps that took effect pass and say so', () => {
      const j = judge(selecting, reportFor({
        counts: { bubble: 1 },
        setup: [{ step: 'selectText', arg: 'hi', ok: true }],
      }));
      expect(j.passed('setup: selectText(hi)')).toBe(true);
      expect(j.failures).toEqual([]);
    });

    test('a collapsed selection fails, and says to re-run idle', () => {
      const j = judge(selecting, reportFor({ ...missed, selection: { hasFocus: false, collapsed: true } }));
      expect(j.failed('still selected at census time')).toBe(true);
      expect(j.detailOf('still selected at census time')).toContain('COLLAPSED');
      expect(j.detailOf('still selected at census time')).toContain('idle machine');
    });

    test('a live selection with a missing bubble is a REAL failure -- focus is irrelevant', () => {
      // bubble=1 is observed passing with `hasFocus` false.
      for (const hasFocus of [true, false]) {
        const j = judge(selecting, reportFor({ ...missed, selection: { hasFocus, collapsed: false } }));
        expect(j.passed('still selected at census time')).toBe(true);
        expect(j.failed('node counts')).toBe(true);
        expect(j.failures.every((f) => !f.detail?.includes('idle machine'))).toBe(true);
      }
    });

    test('a scenario that asks for no selection is not checked for one', () => {
      const j = judge(SCENARIO, reportFor({ selection: { hasFocus: false, collapsed: true } }));
      expect(j.checked('still selected at census time')).toBe(false);
    });
  });

  describe('the theme a scenario asked for', () => {
    test('is asserted directly, not inferred from colour values', () => {
      // Inferred from colours, it would fail as six wrong colours rather than naming the cause.
      const j = judge({ ...SCENARIO, theme: 'dark' }, reportFor({ theme: 'light' }));
      expect(j.failed('booted in the dark theme')).toBe(true);
      expect(j.detailOf('booted in the dark theme')).toContain('data-theme was light');
    });

    test('light is the default, and an unset data-theme fails rather than passing', () => {
      expect(judge(SCENARIO, reportFor({ theme: null })).failed('booted in the light theme')).toBe(true);
      expect(judge(SCENARIO, reportFor()).passed('booted in the light theme')).toBe(true);
    });
  });

  describe('computed styles', () => {
    const styled: Scenario = { ...SCENARIO, checkStyles: true };

    test('a matching computed style passes', () => {
      const j = judge(styled, reportFor({
        styles: { '.ProseMirror h1': { fontSize: '24px', lineHeight: '28px', fontWeight: '600', marginBottom: '0px' } },
      }));
      expect(j.passed('.ProseMirror h1')).toBe(true);
    });

    test('a mismatched computed style fails -- a stylesheet that ships but does not apply', () => {
      const j = judge(styled, reportFor({
        styles: { '.ProseMirror h1': { fontSize: '32px', lineHeight: '28px', fontWeight: '600', marginBottom: '0px' } },
      }));
      expect(j.failed('.ProseMirror h1')).toBe(true);
      expect(j.failures.some((f) => f.detail?.includes('expected 24px, got 32px'))).toBe(true);
    });

    test('a selector with no element fails rather than passing vacuously', () => {
      const j = judge(styled, reportFor({ styles: {} }));
      expect(j.failures.length).toBeGreaterThan(0);
      expect(j.failures.every((f) => f.detail === 'no such element to read from')).toBe(true);
    });

    // WebKit's 1/64px layout unit is forgiven, and no more: see `samePixels`.
    test('a length a layout unit out passes, and one well past it fails', () => {
      const h1 = (fontSize: string) => ({ fontSize, lineHeight: '28px', fontWeight: '600', marginBottom: '0px' });
      expect(judge(styled, reportFor({ styles: { '.ProseMirror h1': h1('24.0156px') } })).passed('.ProseMirror h1')).toBe(true);
      expect(judge(styled, reportFor({ styles: { '.ProseMirror h1': h1('24.05px') } })).failed('.ProseMirror h1')).toBe(true);
    });
  });


  describe('leading-block margins', () => {
    const leads: Scenario = {
      ...SCENARIO,
      canonical: '- one\n',
      counts: { prosemirror: 1 },
      leadingBlock: {
        selector: '.ProseMirror ul',
        marginTop: '14px',
        label: 'even as the FIRST block in the document',
      },
    };

    test('the measured margin passes', () => {
      expect(judge(leads, reportFor({ styles: { '.ProseMirror ul': { marginTop: '14px' } } })).failed('top margin')).toBe(false);
    });

    test('a flattened margin fails -- a blanket :first-child reset', () => {
      expect(judge(leads, reportFor({ styles: { '.ProseMirror ul': { marginTop: '0px' } } })).failed('top margin')).toBe(true);
    });
  });

  describe('images', () => {
    const withImages: Scenario = {
      ...SCENARIO,
      imageSources: { dataUri: 'data:image/png;base64,AAAA', https: 'https://example.test/x.png' },
    };
    const loading: Scenario = { ...withImages, loadsImage: true };
    const okCsp = { dataUri: { loaded: true, naturalWidth: 1 }, https: { loaded: true, naturalWidth: 800 } };
    /** The state the window reports when the reviewer has NOT asked for the image. */
    const waiting = {
      deferred: { url: 'https://example.com/a.png', hasButton: true },
      loaded: null,
    };

    test('a data: image that loads passes; the https result is only noted', () => {
      const j = judge(withImages, reportFor({
        images: { dataUri: { loaded: true, naturalWidth: 1 }, https: { loaded: false, naturalWidth: 0 } },
        renderedImage: waiting,
      }));
      expect(j.failed('data: image LOADS')).toBe(false);
      // Offline must not fail a run: a policy block would surface as a CSP violation instead.
      expect(j.failures).toEqual([]);
      expect(j.notes.some((n) => n.includes('https: image did not load'))).toBe(true);
    });

    test('a data: image that does NOT load fails -- img-src is a deliberate security trade', () => {
      const j = judge(withImages, reportFor({
        images: { dataUri: { loaded: false, naturalWidth: 0 }, https: { loaded: true, naturalWidth: 800 } },
        renderedImage: waiting,
      }));
      expect(j.failed('data: image LOADS')).toBe(true);
    });

    // No remote image before the reviewer clicks "Load image": a fetch at render time happens
    // before any decision, and a rejection cannot take it back.

    test('an image FETCHED before the reviewer acted is a failure', () => {
      const j = judge(withImages, reportFor({
        images: okCsp,
        renderedImage: { deferred: null, loaded: { src: 'https://example.com/a.png', complete: true, naturalWidth: 640 } },
      }));
      expect(j.failed('NO image was fetched')).toBe(true);
    });

    test('a placeholder with no load control is a failure -- deferral must not be refusal', () => {
      const j = judge(withImages, reportFor({
        images: okCsp,
        renderedImage: { deferred: { url: 'https://example.com/a.png', hasButton: false }, loaded: null },
      }));
      expect(j.failed('control to load it')).toBe(true);
    });

    test('an ELIDED url is a failure, because reading the host is the whole point', () => {
      const j = judge(withImages, reportFor({
        images: okCsp,
        renderedImage: { deferred: { url: 'https://example.com/a...', hasButton: true }, loaded: null },
      }));
      expect(j.failed('whole URL')).toBe(true);
    });

    test('waiting, with a control and the full url, passes', () => {
      const j = judge(withImages, reportFor({ images: okCsp, renderedImage: waiting }));
      expect(j.failures).toEqual([]);
    });

    test('a scenario that CLICKS load must end up with a real <img>', () => {
      const j = judge(loading, reportFor({
        images: okCsp,
        renderedImage: { deferred: null, loaded: { src: 'https://example.com/a.png', complete: false, naturalWidth: 0 } },
      }));
      expect(j.failures).toEqual([]);
      expect(j.passed('clicking "Load image" fetched it')).toBe(true);
    });

    test('...and if the click did nothing, that fails', () => {
      const j = judge(loading, reportFor({ images: okCsp, renderedImage: waiting }));
      expect(j.failed('clicking "Load image" fetched it')).toBe(true);
    });

    test("a loaded fixture image that WORKS fails, because its URL serves nothing", () => {
      const j = judge(loading, reportFor({
        images: okCsp,
        renderedImage: { deferred: null, loaded: { src: 'https://example.com/a.png', complete: true, naturalWidth: 640 } },
      }));
      // If it ever loads, the fixture changed and `img: 1` means something else.
      expect(j.failed('broken')).toBe(true);
    });

    test('no image state reported at all fails', () => {
      const j = judge(withImages, reportFor({ images: okCsp, renderedImage: null }));
      expect(j.failed('reported its image state')).toBe(true);
    });
  });
});

/*
 * WebKit names no instance, so the evidence for the family's own italic is the italic's own
 * advances and a loaded italic face of that family covering the em's weight.
 */
describe("the italic is the family's own, not a synthetic slant", () => {
  const WK = 'own italic face';
  const scenario: Scenario = { ...SCENARIO, fontFamily: { family: 'Lato', resolves: true, italic: true } };
  const face = { familyName: 'Lato', isCustomFont: true, glyphCount: 6 };
  const advances = (over: Partial<NonNullable<Report['dom']['italicAdvances']>> = {}) => ({
    family: 'Lato', style: 'italic', italic: 30.4, upright: 32.9, italicFaceLoaded: true, ...over,
  });
  const wk = (italicAdvances: Report['dom']['italicAdvances']) =>
    judge(scenario, reportFor({ face: [face], italicAdvances }));

  test("the family's own italic, at the em's weight, passes", () => {
    expect(wk(advances()).passed(WK)).toBe(true);
  });

  test("a synthetic slant fails: the upright's advances", () => {
    expect(wk(advances({ italic: 32.9 })).failed(WK)).toBe(true);
  });

  test("no italic face covering the weight fails, whatever the advances -- another weight's italic", () => {
    expect(wk(advances({ italicFaceLoaded: false })).failed(WK)).toBe(true);
  });

  test('an upright em, or no reading at all, fails', () => {
    expect(wk(advances({ style: 'normal' })).failed(WK)).toBe(true);
    expect(wk(null).failed(WK)).toBe(true);
  });

  test('a scenario that does not ask is not checked', () => {
    const plain: Scenario = { ...SCENARIO, fontFamily: { family: 'Lato', resolves: true } };
    expect(judge(plain, reportFor({ face: [face] })).checked(WK)).toBe(false);
  });
});

/**
 * Slack's code, block and inline, is drawn in the bundled Roboto Mono, and the paragraph's check
 * sets that face aside without letting it stand in for the prose.
 */
describe('the code is drawn in the bundled code face', () => {
  const BLOCK = 'the code is rasterised in the bundled';
  const INLINE = 'inline code is rasterised in the bundled';
  const PROSE = 'the prose is rasterised in the bundled';
  const scenario: Scenario = {
    ...SCENARIO,
    fontFamily: { family: 'Lato', resolves: true },
    codeFont: 'Roboto Mono',
  };
  const face = (familyName: string, isCustomFont = true, glyphCount = 10) => ({
    familyName, isCustomFont, glyphCount,
  });
  const mono = face('Roboto Mono');
  const run = (dom: Partial<Report['dom']>) => judge(scenario, reportFor({ face: [face('Lato', true, 200), mono], ...dom }));

  test('Roboto Mono for the block and inline passes', () => {
    const j = run({ codeFace: [mono], inlineCodeFace: [mono] });
    expect(j.passed(BLOCK)).toBe(true);
    expect(j.passed(INLINE)).toBe(true);
    expect(j.passed(PROSE)).toBe(true);
  });

  test('a platform fallback such as Monaco fails', () => {
    expect(run({ codeFace: [face('Monaco', false)], inlineCodeFace: [mono] }).failed(BLOCK)).toBe(true);
    expect(run({ codeFace: [mono], inlineCodeFace: [face('Monaco', false)] }).failed(INLINE)).toBe(true);
  });

  test('another web font fails, and so does no reading at all', () => {
    expect(run({ codeFace: [face('Lato')], inlineCodeFace: null }).failed(BLOCK)).toBe(true);
    expect(run({ codeFace: [], inlineCodeFace: null }).failed(BLOCK)).toBe(true);
    expect(run({ codeFace: null, inlineCodeFace: null }).failed(BLOCK)).toBe(true);
  });

  test('a draft with no inline code is not held to one', () => {
    expect(run({ codeFace: [mono], inlineCodeFace: null }).checked(INLINE)).toBe(false);
  });

  test('the code face is set aside in the prose -- but cannot stand in for it', () => {
    // A paragraph drawn in Roboto Mono ALONE is wrong prose, not inline code.
    const j = judge(scenario, reportFor({ face: [mono], codeFace: [mono], inlineCodeFace: null }));
    expect(j.failed(PROSE)).toBe(true);
  });

  test('a scenario that names no code face is not checked', () => {
    const plain: Scenario = { ...SCENARIO, fontFamily: { family: 'Lato', resolves: true } };
    expect(judge(plain, reportFor({ face: [face('Lato', true, 200)] })).checked(BLOCK)).toBe(false);
  });
});

/** The probe pins the host's content size over the harness channel (`WKSession.setViewport`). */
describe('the pinned viewport', () => {
  test('is fixed, so screenshots stay comparable between runs and machines', () => {
    expect(VIEWPORT).toEqual({ width: 1040, height: 828 });
  });

  // A scenario about a narrow window (`linear-tables-narrow`) sets its own, and it has
  // to be one a reviewer could have: `geometry.cjs`'s floor is the host window's `minSize`.
  test("a scenario's own is never smaller than the smallest window the host allows", () => {
    const own = Object.entries(SCENARIOS).filter(([, s]) => s.viewport);
    expect(own.length).toBeGreaterThan(0);
    for (const [name, s] of own) {
      expect([name, s.viewport!.width >= WINDOW_MIN.width, s.viewport!.height >= WINDOW_MIN.height]).toEqual([name, true, true]);
    }
  });

  // `tablesScroll` needs a table wider than the editor, which the pinned viewport never has.
  test('a scenario that checks tables scroll sets a viewport of its own', () => {
    const scrolling = Object.entries(SCENARIOS).filter(([, s]) => s.tablesScroll);
    expect(scrolling.length).toBeGreaterThan(0);
    for (const [name, s] of scrolling) expect([name, s.viewport !== undefined]).toEqual([name, true]);
  });
});

// The window reports the bundle the loader launched and whether its store persists.
describe('isolation', () => {
  test("the review's bundle, a persistent store, or no report at all FAILS", () => {
    const LABEL = "never the review's bundle";
    const wk = (isolation: Report['isolation']) => judge(SCENARIO, reportFor({}, { isolation }));
    expect(wk({ bundleId: 'io.github.jakuboola.draftgate.harness', persistentStore: false }).passed(LABEL)).toBe(true);
    expect(wk({ bundleId: 'io.github.jakuboola.draftgate', persistentStore: false }).failed(LABEL)).toBe(true);
    expect(wk({ bundleId: 'io.github.jakuboola.draftgate.harness', persistentStore: true }).failed(LABEL)).toBe(true);
    expect(wk(undefined).failed(LABEL)).toBe(true);
  });
});

/**
 * Every control a scenario asks for is one the driver has. `Scenario.clickToOpen` is a `string` key
 * into `OPENABLE`, so the compiler accepts a missing one, and the scenario would fail on a missing
 * count that reads as a CSS or CSP regression. Which controls may be clicked is not restricted: a
 * probe run cannot approve anyway (below).
 */
describe('the probe only asks for controls the driver has', () => {
  test('OPENABLE really was read, so this cannot pass vacuously', () => {
    expect(OPENABLE_KEYS.length).toBeGreaterThanOrEqual(4);
    expect(OPENABLE_KEYS).toContain('emoji');
  });

  test('every clickToOpen a scenario names is one OPENABLE has', () => {
    // Flattened: `clickToOpen` also takes a sequence, and a nested array would compare as a string.
    const asked: string[] = [
      ...new Set(Object.values(SCENARIOS).flatMap((s) => [s.clickToOpen ?? []].flat())),
    ];
    expect(asked.length).toBeGreaterThanOrEqual(3);
    const unknown = asked.filter((k) => !OPENABLE_KEYS.includes(k));
    expect(
      unknown,
      'these scenarios name a control OPENABLE does not have, so the step will record it as ' +
        `unknown and the scenario will fail as something else: ${unknown.join(', ')}`
    ).toEqual([]);
  });
});

/**
 * A probe run has no route to an approval: its spawn names no decision path, the host's
 * `writeDecision` refuses without one, and `launchHost` inherits no `DRAFTGATE_` variable. Every
 * click goes through the real handler and bridge and writes nothing.
 *
 * Source text for the first two, because an absence cannot be exercised; scanned over the spawn's
 * env literal only, so prose naming the variable cannot fire it. The third is a real spawn:
 * `printenv NAME` exits 1 when NAME is not set.
 */
describe('a probe run cannot approve anything', () => {
  const probeSource = readFileSync(join(HARNESS, 'probe.ts'), 'utf8');
  const hostSource = readFileSync(join(SURFACE, 'host', 'draftgate.m'), 'utf8');
  const hostEnv = (() => {
    const at = probeSource.indexOf('launchHost(WEBKIT_HARNESS!, {');
    expect(at, 'probe.ts no longer spawns the host through `launchHost(WEBKIT_HARNESS!, {`').toBeGreaterThan(-1);
    return probeSource.slice(at, probeSource.indexOf('}, {', at));
  })();

  test('the env literal really was found, and it names no decision path', () => {
    expect(hostEnv).toContain('REQUEST_ENV');
    expect(hostEnv).toContain('channel.env');
    for (const token of ['DECISION_ENV', 'DRAFTGATE_DECISION']) expect(hostEnv.includes(token), token).toBe(false);
  });

  test("and the host's writeDecision refuses to write without one", () => {
    const at = hostSource.indexOf('- (void)writeDecision:');
    expect(at).toBeGreaterThan(-1);
    expect(hostSource.slice(at, hostSource.indexOf('\n}', at))).toContain('!_decisionPath');
  });

  test('and one exported in the shell does not reach the window', async () => {
    const saved = process.env.DRAFTGATE_DECISION;
    process.env.DRAFTGATE_DECISION = '/somewhere/decision.json';
    try {
      const run = launchHost('/usr/bin/printenv', {}, { timeoutMs: 5_000, surface: 'DRAFTGATE_DECISION' });
      expect((await run.exited).code, 'the window inherited DRAFTGATE_DECISION').toBe(1);
      // The control: what the caller names does arrive, so the 1 above is the strip and not a spawn that failed.
      const named = launchHost('/usr/bin/printenv', { DRAFTGATE_DECISION: '/x' }, { timeoutMs: 5_000, surface: 'DRAFTGATE_DECISION' });
      expect((await named.exited).code).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.DRAFTGATE_DECISION;
      else process.env.DRAFTGATE_DECISION = saved;
    }
  });
});

/**
 * A scenario judges its own run, never the last one. `probe-result/<scenario>/` is git-ignored, so
 * uncleared, a dead window leaves the previous run's screenshot beside this run's failure. The
 * report is assembled from channel answers, so it cannot be stale; `report.json` is for a person and
 * nothing reads it. Against a real directory, not a stub.
 */
describe('a stale artifact cannot be mistaken for this run', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'draftgate-probe-fresh-'));
  // Removed, or every run leaves it behind in $TMPDIR.
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const dir = join(scratch, 'jira');

  /** Everything a finished run leaves behind. */
  function seedLastRun() {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.json'), JSON.stringify({ dom: { destination: 'jira' } }));
    writeFileSync(join(dir, 'jira.png'), 'not really a png');
    writeFileSync(join(dir, 'request.json'), '{}');
  }

  test('the report and the screenshot are removed before the spawn', () => {
    seedLastRun();
    clearScenarioOutputs(dir);
    expect(existsSync(join(dir, 'report.json'))).toBe(false);
    expect(existsSync(join(dir, 'jira.png'))).toBe(false);
    // The input stays: `probe()` writes it just before the spawn.
    expect(existsSync(join(dir, 'request.json'))).toBe(true);
  });

  test('clearing a directory that is not there yet is fine', () => {
    expect(() => clearScenarioOutputs(join(scratch, 'never-run'))).not.toThrow();
  });
});

/*
 * `stylesFor` adds `{ [leadingBlock.selector]: { marginTop: SAMPLED_ONLY } }` so the window samples
 * it, and `mismatches` filters SAMPLED_ONLY out: the generic loop could print "computed as
 * specified" having compared nothing.
 */
describe('a selector that is only sampled is not reported as compared', () => {
  const leads: Scenario = {
    ...SCENARIO,
    canonical: '- one\n',
    counts: { prosemirror: 1 },
    leadingBlock: {
      selector: '.ProseMirror ul',
      marginTop: '14px',
      label: 'even as the FIRST block in the document',
    },
  };

  test('no "computed as specified" line for a SAMPLED_ONLY-only selector', () => {
    const r = judge(leads, reportFor({ styles: { '.ProseMirror ul': { marginTop: '14px' } } }));
    expect(r.checked('.ProseMirror ul computed as specified')).toBe(false);
  });

  test('...while its real check still runs, and still fails when it should', () => {
    // Skipping the vacuous line must not skip the margin.
    expect(judge(leads, reportFor({ styles: { '.ProseMirror ul': { marginTop: '14px' } } }))
      .passed('top margin')).toBe(true);
    expect(judge(leads, reportFor({ styles: { '.ProseMirror ul': { marginTop: '0px' } } }))
      .failed('top margin')).toBe(true);
  });

  test('and a selector with any REAL property is still compared', () => {
    // No shipped map mixes a real property with SAMPLED_ONLY, so this builds one: `every` compares
    // it and fails on the colour, a `some` would skip it. The element is present, or "no such
    // element" answers first.
    const mixed: Scenario = {
      ...SCENARIO, canonical: 'x\n', counts: { prosemirror: 1 },
      styles: { '.ProseMirror p': { color: 'rgb(1, 2, 3)', marginTop: '(sampled only)' } },
    };
    const r = judge(mixed, reportFor({ styles: { '.ProseMirror p': { color: 'rgb(9, 9, 9)', marginTop: '0px' } } }));
    expect(r.checked('.ProseMirror p computed as specified')).toBe(true);
    expect(r.failed('.ProseMirror p computed as specified')).toBe(true);
  });

  test('the label of the leading-block check names the position it is about', () => {
    // `jira-leads-list` opens with the list, `jira-leads-paragraph` puts a paragraph above.
    const r = judge(leads, reportFor({ styles: { '.ProseMirror ul': { marginTop: '14px' } } }));
    expect(r.passed('even as the FIRST block in the document')).toBe(true);
    expect(SCENARIOS['jira-leads-list']!.leadingBlock!.label)
      .not.toBe(SCENARIOS['jira-leads-paragraph']!.leadingBlock!.label);
  });
});

/*
 * WebKit serialises lengths in its 1/64px layout unit: `23.996px` in Chromium is `23.995998px`
 * there. `samePixels` forgives that much and nothing else.
 */
describe('samePixels: a layout unit, and no more', () => {
  test.each([
    ['23.996px', '23.995998px'],
    ['23.996px', '23.984375px'],
    ['24.0001px', '24.00012px'],
    ['0px 8px', '0px 7.99px'],
    ['rgb(1, 2, 3)', 'rgb(1, 2, 3)'],
  ])('%s is %s', (a, b) => expect(samePixels(a, b)).toBe(true));

  test.each([
    ['24px', '24.03px'],
    ['rgb(1, 2, 3)', 'rgb(1, 2, 4)'],
    ['1em', '1.001em'],
    ['0px 8px', '0px'],
    ['block', 'inline'],
  ])('%s is not %s', (a, b) => expect(samePixels(a, b)).toBe(false));
});
