/**
 * What `--doctor` says, and the one line a review is allowed to spend on the same subject.
 *
 * The report is the only place several of these facts reach a human, so the tests assert wording as
 * well as detection: a finding without its consequence ("registered twice" with no "two windows, and
 * a deny in either wins") is skimmed past.
 */

import { describe, expect, test } from 'bun:test';
import {
  AUDIENCE_SECTIONS,
  doctorReport,
  registrationNote,
  type ClassificationState,
  type DoctorInput,
  type OtherInstall,
} from '../src/doctor';
import { firesTwiceOf, type RegisteredHook, type RegistrationReport } from '../src/registration';
import { reviewDeadline } from '../src/reviewTimeout';
import type { ToolMap } from '../src/toolMap';
import { CLASSIFICATION_STORES } from '../../../cli/src/classificationStores';
import { hooksReport, type HooksReport, type ScopedSettings, type SettingsScope } from '../src/hookSwitches';
import type { ReleaseStatus } from '../../../cli/src/releaseCheck';
import { CLI_ENTRY } from '../../../cli/src/hookModes';
import { belowFloor } from '../../../cli/src/reviewHost';
import { shQuote } from '../src/hookCommand';
import { REMEDY } from '../../../core/src/remedies';

const MAP = {
  mcp__a__send: { destination: 'slack' },
  mcp__b__comment: { destination: 'jira' },
} as unknown as ToolMap;

const MATCHER = '^(?:mcp__a__send|mcp__b__comment)$';

/** One registered entry: the healthy default, with whatever a test is about laid over it. */
const entry = (over: Partial<RegisteredHook> = {}): RegisteredHook => ({
  source: '/user.json',
  matcher: MATCHER,
  timeout: 1260,
  failClosed: true,
  ...over,
});

function report(over: Partial<RegistrationReport> = {}): RegistrationReport {
  const ours = over.ours ?? [entry()];
  return {
    scanned: [{ path: '/user.json', present: true }],
    ours,
    firesTwice: firesTwiceOf(ours, Object.keys(MAP)),
    unregistered: [],
    unmapped: [],
    declinedStillMatched: [],
    opaqueMatchers: [],
    halvesNotInferred: [],
    others: [],
    shadowed: [],
    registeredTimeoutMs: 1_260_000,
    ...over,
  };
}

/**
 * A projects file that classifies something, so the audience section is quiet unless a test asks
 * for it; an empty default would put the "no classified sites" paragraph in every test's output.
 */
const PROJECTS: ClassificationState = {
  path: '/home/.draftgate/jira-projects.json',
  present: true,
  classified: 1,
  // Numbers; the report renders the sentence (`AudienceSection.counted`).
  // `cli/test/classificationStores.test.ts` pins the key set each store writes.
  counts: { sites: 1, projects: 3, serviceDesks: 2 },
};

/**
 * GitHub's equivalent, empty on purpose: `MAP` gates no GitHub tool, so the GitHub block does not
 * print, which every "the report says X and nothing else" assertion here assumes.
 */
const REPOS: ClassificationState = {
  path: '/home/.draftgate/github-repos.json',
  present: false,
  classified: 0,
  counts: { repos: 0, public: 0 },
};

/** One constructor for the report's input, so a new required `DoctorInput` field is added once. */
function run(
  over: Partial<RegistrationReport> = {},
  wantedMs = 1_200_000,
  input: Partial<DoctorInput> = {}
) {
  const r = report(over);
  return doctorReport({
    report: r,
    deadline: reviewDeadline(wantedMs, r.registeredTimeoutMs),
    toolMap: MAP,
    expectedMatchers: [MATCHER],
    configPath: '/home/.draftgate/config.json',
    configPresent: false,
    classifications: { jira: PROJECTS, github: REPOS },
    ...input,
  });
}

describe('doctorReport', () => {
  test('a healthy install is ok, and says where it is registered', () => {
    const { text, ok } = run();
    expect(ok).toBe(true);
    expect(text).toContain('REGISTERED in /user.json');
    expect(text).toContain('2/2 mapped tools');
    expect(text).toContain('No problems found.');
    expect(text).not.toContain('does not fail closed');
  });

  test('a registration that does not fail closed is a NOTE, and the exit code does not move', () => {
    // The bare shape is a working gate until its hook cannot start, so exiting 1 would fail a
    // working install. The note carries the consequence and the fix.
    const { text, ok } = run({
      ours: [entry({ failClosed: false })],
    });
    expect(ok).toBe(true);
    expect(text).toContain('No problems found.');
    expect(text).toContain('NOTE: this registration does not fail closed.');
    expect(text).toContain('runs the tool UNREVIEWED');
    expect(text).toContain('remove one in any other\n    file first. The entries:\n      /user.json');
  });

  test('...naming only the entries that need it', () => {
    const { text, ok } = run({
      ours: [
        entry(),
        entry({ source: '/proj.json', failClosed: false }),
      ],
    });
    // Twice registered is its own problem; the note is about the one that is bare.
    expect(ok).toBe(false);
    expect(text).toContain('remove one in any other\n    file first. The entries:\n      /proj.json\n');
    expect(text).not.toContain('remove one in any other\n    file first. The entries:\n      /user.json');
  });

  test('from another checkout it is a working install, with a note and no problem', () => {
    const { text, ok } = run({
      ours: [entry({ checkout: { root: '/main', worktree: false } })],
    });
    expect(ok).toBe(true);
    expect(text).toContain('REGISTERED in /user.json');
    expect(text).toContain('launches the checkout at /main, not this one');
    expect(text).toContain('Nothing to register');
    expect(text).not.toContain('nothing is being reviewed');
  });

  test('a registration for a WORKTREE, seen from the main checkout, is a problem', () => {
    // This registration stops launching when the worktree is removed; "Nothing to register" would
    // steer the operator away from the fix.
    const worktree = { root: '/wt', worktree: true };
    const { text, ok } = run({
      ours: [entry({ checkout: worktree })],
    });
    expect(ok).toBe(false);
    expect(text).toContain('PROBLEM: the registration launches the copy in a git WORKTREE');
    // THIS checkout's CLI by path: `draftgate` on PATH may be the worktree's own link.
    expect(text).toContain(`A checkout registers nothing: to put draftgate in place,\n    run ${REMEDY.installPlugin}.`);
    expect(text).not.toContain('Nothing to register');
  });

  test('registered for this checkout AND another is the duplicate, and no sibling note', () => {
    const { text, ok } = run({
      ours: [
        entry(),
        entry({ checkout: { root: '/main', worktree: false } }),
      ],
    });
    expect(ok).toBe(false);
    expect(text).toContain('registered 2 times');
    expect(text).not.toContain('Nothing to register');
  });

  // A decline is the operator's recorded choice, so it is a FACT and never moves the exit.
  test('declined tools are reported as a choice, and the install stays ok', () => {
    const { text, ok } = run({}, 1_200_000, { declined: ['slack_send_message'] });
    expect(ok).toBe(true);
    expect(text).toContain('1 tool(s) deliberately not gated (declined in tools.json):');
    expect(text).toContain('slack_send_message');
    expect(text).not.toContain('PROBLEM');
  });

  test('a stale matcher for a declined tool is a note, not a problem, and says register', () => {
    const { text, ok } = run({ declinedStillMatched: ['slack_send_message'] }, 1_200_000, {
      declined: ['slack_send_message'],
    });
    expect(ok).toBe(true);
    expect(text).toContain('still covers these declined tools');
    // The generic "paste is older" note would say the same thing less precisely; it stays quiet.
    expect(text).not.toContain('no registered matcher is byte-identical');
  });

  test('a decline of nothing routed is named, because the tool meant is still gated', () => {
    const { text, ok } = run({}, 1_200_000, {
      declined: ['slack_send_mesage'],
      declinedUnrouted: ['slack_send_mesage'],
    });
    expect(ok).toBe(true);
    expect(text).toContain('nothing draftgate routes uses that name');
  });

  test('no registration found leads, and does NOT overclaim that nothing is reviewed', () => {
    // `ours: []` is reachable on a working install: a plugin-provided hook, or `claude --settings
    // <file>`, which overrides these files entirely (both verified in 2.1.268).
    const { text, ok } = run({ ours: [], registeredTimeoutMs: undefined, unregistered: Object.keys(MAP) });
    expect(ok).toBe(false);
    expect(text).toContain('REGISTERED: not found');
    expect(text).toContain('plugin');
    expect(text).toContain('--settings');
    // One root cause, one problem and one remedy: the uncovered tools and the capped deadline
    // follow from it.
    expect(text).toContain('1 problem(s): registration not found.');
    expect(text.split(REMEDY.installPlugin).length - 1).toBe(1);
    expect(text).not.toContain('no registered matcher covers them');
  });

  test('an unregistered tool is named with the three things that do not happen', () => {
    const { text, ok } = run({ unregistered: ['mcp__b__comment'] });
    expect(ok).toBe(false);
    expect(text).toContain('mcp__b__comment');
    expect(text).toContain('no review, no window and no audit-log entry');
    // No section sign: a reader of the output has no document to follow it into.
    expect(text).not.toContain('§');
  });

  test('a duplicate registration is reported WITH its consequence', () => {
    // The consequence, not just the count: two windows open, and the one the reviewer ignores can
    // veto the one they used.
    const { text, ok } = run({
      ours: [
        entry(),
        entry({ source: '/proj.json', timeout: 660 }),
      ],
      registeredTimeoutMs: 660_000,
    });
    expect(ok).toBe(false);
    expect(text).toContain('registered 2 times');
    expect(text).toContain('CONCURRENTLY');
    expect(text).toContain('two review windows');
  });

  test('a shadowing deny rule is reported as outranking the gate, with both sides named', () => {
    const { text, ok } = run({
      shadowed: [{ tool: 'mcp__b__comment', rule: 'mcp__b__comment', source: '/user.json' }],
    });
    expect(ok).toBe(false);
    expect(text).toContain('outranks PreToolUse');
    expect(text).toContain('mcp__b__comment  <- "mcp__b__comment" in /user.json');
    // Not always a fault: an agent kept away from a destination on purpose is deliberate.
    expect(text).toContain('Intentional for an agent that must not reach the destination at all');
  });

  test('a clamped deadline explains the fail-open, not just the arithmetic', () => {
    const { text, ok } = run({
      ours: [entry({ timeout: 660 })],
      registeredTimeoutMs: 660_000,
    });
    expect(ok).toBe(false);
    expect(text).toContain('granted only 600s');
    expect(text).toContain('fail-open');
    expect(text).toContain(`Install the plugin: ${REMEDY.installPlugin}.`);
  });

  test("from the plugin, a clamp below its ceiling names setup, which replaces the shorter entry", () => {
    // The clamp is the shortest registration: here a leftover entry, not the plugin's own.
    const plugin = { root: '/plugin', record: { kind: 'read' as const, installs: [] }, userSettings: '/user.json' };
    const { text } = run({ ours: [entry({ timeout: 660 })], registeredTimeoutMs: 660_000 }, 1_200_000, { plugin });
    expect(text).toContain('granted only 600s');
    expect(text).toContain(`Another draftgate entry in Claude Code's settings has a shorter timeout: ${REMEDY.pluginSetup} replaces it.`);
    expect(text).not.toContain('Install the plugin:');
  });

  test('an opaque matcher is a NOTE, not a problem', () => {
    // Legitimate for an operator to write, but the reader must not assume the unmapped check ran.
    const { text, ok } = run({ opaqueMatchers: ['^mcp__.*$'] });
    expect(ok).toBe(true);
    expect(text).toContain('not an anchored alternation');
  });

  test('a name the matcher claims and nothing routes is reported as DENIED', () => {
    const { text, ok } = run({
      ours: [entry({ matcher: '^(?:mcp__a__send|mcp__b__comment|mcp__c__x)$' })],
      unmapped: ['mcp__c__x'],
    });
    expect(ok).toBe(false);
    expect(text).toContain('DENIED');
  });

  test('the "older paste" NOTE is withheld when a specific finding already said it', () => {
    // Below the `halvesNotInferred` paragraph it would be a second, less precise paragraph about
    // the same stale paste.
    const withSpecific = run({
      ours: [entry({ matcher: '^(?:mcp__a__send)$' })],
      halvesNotInferred: ['send'],
    });
    expect(withSpecific.text).not.toContain('byte-identical');

    // And it still fires when it is the only thing to say: the same names in a different order,
    // so coverage is complete and nothing else has a finding.
    const alone = run({
      ours: [entry({ matcher: '^(?:mcp__b__comment|mcp__a__send)$' })],
    });
    expect(alone.text).toContain('byte-identical');
    expect(alone.ok).toBe(true);
  });

  test('an unreadable settings file is listed and counts as a problem', () => {
    const { text, ok } = run({
      scanned: [{ path: '/user.json', present: true, problem: '/user.json is not valid JSON (x)' }],
    });
    expect(ok).toBe(false);
    expect(text).toContain('UNREADABLE');
  });

  test('two unreadable files are ONE problem, naming both', () => {
    // Not "2 problem(s): a settings file did not parse; a settings file did not parse."
    const { text } = run({
      scanned: [
        { path: '/user.json', present: true, problem: 'x' },
        { path: '/proj.json', present: true, problem: 'y' },
      ],
    });
    expect(text).toContain('1 problem(s): unreadable: /user.json, /proj.json.');
  });
});

/*
 * The review window: a Mac below the floor, or a host that needs building with no compiler, reviews
 * nothing -- a problem. A host that merely needs building is built by the next review, so a note.
 */
describe('the review window section', () => {
  const facts = (over: Partial<NonNullable<DoctorInput['host']>> = {}): NonNullable<DoctorInput['host']> => ({
    host: { state: 'current', apps: {} as never },
    macos: '27.0',
    verdict: { kind: 'current' },
    ...over,
  });

  test('a current host is said, and is ok', () => {
    const { text, ok } = run({}, undefined, { host: facts() });
    expect(ok).toBe(true);
    expect(text).toContain('the host is built from this source');
  });

  test('a stale host with the tools to build it is a NOTE, and ok', () => {
    const { text, ok } = run({}, undefined, { host: facts({ host: { state: 'stale', why: 'surface/host/draftgate.m changed' }, verdict: { kind: 'builds-on-review' } }) });
    expect(ok).toBe(true);
    expect(text).toContain('NOTE: the host is stale (surface/host/draftgate.m changed)');
    expect(text).toContain('The next review builds it first,\n    in about a second.\n');
  });

  test('a host that needs building with no Command Line Tools is a PROBLEM', () => {
    const { text, ok } = run({}, undefined, {
      host: facts({ host: { state: 'missing', why: 'it has not been built' }, verdict: { kind: 'no-compiler' } }),
    });
    expect(ok).toBe(false);
    expect(text).toContain('xcode-select --install');
  });

  test('a Mac below the floor is a PROBLEM whatever else is true', () => {
    const { text, ok } = run({}, undefined, {
      host: facts({ macos: '15.6', verdict: { kind: 'below-floor', why: 'the review window needs macOS 26.0 or newer, and this Mac runs macOS 15.6' } }),
    });
    expect(ok).toBe(false);
    expect(text).toContain('this Mac runs macOS 15.6');
    expect(text).not.toContain('the host is built from this source');
  });

  test('a machine without macOS is the same PROBLEM, and nothing calls it a Mac', () => {
    const why = belowFloor(null)!;
    const { text, ok } = run({}, undefined, { host: facts({ macos: null, verdict: { kind: 'below-floor', why } }) });
    expect(ok).toBe(false);
    expect(text).toContain(`PROBLEM: ${why}.`);
    expect(text).toContain('problem(s): no macOS the review window runs on.');
    expect(text).not.toMatch(/\bMac\b/);
  });

  test('not asked, nothing printed', () => {
    expect(run().text).not.toContain('Review window');
  });

  test('the window: built is said; one a review rebuilds is a NOTE; one nobody can rebuild is a PROBLEM', () => {
    expect(run({}, undefined, { window: { fresh: true, described: 'fresh', remedy: null } }).text).toContain(
      '  Review window\n    the window is built from this source.'
    );
    const stale = run({}, undefined, { window: { fresh: false, described: 'stale, it has not been built', remedy: null } });
    expect(stale.ok).toBe(true);
    expect(stale.text).toContain('NOTE: the window is stale, it has not been built. The next review rebuilds it first.');
    const absent = run({}, undefined, { window: { fresh: false, described: 'absent', remedy: 'Install it again.' } });
    expect(absent.ok).toBe(false);
    expect(absent.text).toContain('PROBLEM: no review can show its window, so every gated send asks instead.\n    Install it again.');
    expect(absent.text).toContain('the review window cannot be used');
  });
});

/**
 * The audience section: two gaps that look identical in the review window and are not.
 *
 * Both are reported and neither moves the exit code: `ok` means "something changes whether a
 * message gets reviewed", and an unprobed tool and an unclassified project both still open a window.
 */
describe('the Jira audience section', () => {
  const jira = (map: Record<string, { destination: string }>) =>
    run({}, 1_200_000, { toolMap: map as unknown as ToolMap });

  test('a gated Jira tool nobody probed is NAMED, and does not fail the check', () => {
    // `MAP`'s Jira entry is `mcp__b__comment`, which no matcher in the profile knows.
    const { text, ok } = run();
    expect(text).toContain('mcp__b__comment');
    expect(text).toContain('Audience unknown');
    /*
     * Bounded, not "on every review, whatever the project": `jiraAudience`'s project-type check
     * returns `undefined` before the unprobed fallthrough, so against a `software` project an
     * unprobed tool shows no banner at all.
     */
    expect(text).toContain('on a service desk, and on any');
    expect(text).toContain('no banner at all');
    expect(text).not.toContain('whatever the project');
    // The remedy that does not exist, unlike the project finding below it, which is a click away.
    expect(text).toContain('not fixable from any config file');
    expect(text).toContain('no click in the review window can answer it');
    expect(ok).toBe(true);
    expect(text).toContain('No problems found.');
  });

  test('a probed tool is not named, whatever its server prefix', () => {
    // The tool half carries the evidence, so an operator's own connector name keeps it.
    const { text } = jira({ mcp__whatever__addCommentToJiraIssue: { destination: 'jira' } });
    expect(text).toContain('All 1 gated Jira tool(s) have a probed audience.');
    expect(text).not.toContain('Audience unknown');
  });

  test('a worklog counts as probed, because "no audience" is an answer', () => {
    // Probed: a worklog reaches neither the platform nor the portal comment list.
    const { text } = jira({ mcp__x__addWorklogToJiraIssue: { destination: 'jira' } });
    expect(text).toContain('All 1 gated Jira tool(s) have a probed audience.');
  });

  test('no Jira tools gated means no section, rather than a section saying nothing', () => {
    const { text } = jira({ mcp__a__send: { destination: 'slack' } });
    expect(text).not.toContain('Jira audience');
  });

  test('an unclassified install is described as WORKING, and still exits 0', () => {
    const { text, ok } = run({}, 1_200_000, {
      classifications: {
        jira: {
          path: '/home/u/.draftgate/jira-projects.json',
          present: false,
          classified: 0,
          counts: { sites: 0, projects: 0, serviceDesks: 0 },
        },
        github: REPOS,
      },
    });
    expect(text).toContain('No classified sites');
    // The ask is the remedy, and it is automatic, so this does not read as "Jira reviews are broken".
    expect(text).toContain('remembers the answer');
    expect(text).toContain('working install');
    expect(ok).toBe(true);
  });

  test('a classified install reports the counts and the one case that does not self-heal', () => {
    const { text } = run();
    expect(text).toContain('1 classified site(s), 3 project(s), 2 service desk(s)');
    // A reviewer's click cannot overwrite a `jira`-signed row, so a wrong row stays wrong until the
    // site is re-classified.
    expect(text).toContain('re-classifying the site is the only correction');
  });

  test('but a projects file that LOST an entry is a problem, unlike the two above', () => {
    // A missing classification is a question that gets asked; a dropped one is a classification the
    // operator believes they have and do not.
    const { text, ok } = run({}, 1_200_000, {
      classifications: {
        jira: {
          ...PROJECTS,
          problem: '/p.json: kept 2 project(s); ignored 1 entry -- dev/SUP: "servicedesk"',
        },
        github: REPOS,
      },
    });
    expect(ok).toBe(false);
    expect(text).toContain('jira-projects unreadable');
    expect(text).toContain('dev/SUP');
  });
});

/**
 * The prose table, swept: per-destination divergence becomes a missing field, and this sweep fails
 * on it.
 *
 * The counting rule is `cli/test/classificationStores.test.ts`'s: `jiraProjectsSummary`'s partial
 * credit is a fact about the parser, not this report.
 */
describe('AUDIENCE_SECTIONS', () => {
  test('every section fills every field, so no destination inherits a blank', () => {
    for (const [name, section] of Object.entries(AUDIENCE_SECTIONS)) {
      expect(section, `${name} has no section`).toBeDefined();
      for (const [field, value] of Object.entries(section!)) {
        const filled = Array.isArray(value) ? value.length > 0 : String(value).length > 0;
        expect(filled, `${name}.${field} is empty`).toBe(true);
      }
    }
  });

  test('a report with NO classifications still describes the tools, and stays ok', () => {
    // `classifications` is optional, so this is reachable: the tools, and nothing about targets.
    const { text, ok } = run({}, 1_200_000, { classifications: undefined });
    expect(text).toContain('Jira audience');
    // The tool half is built from the tool map, which is always present.
    expect(text).toContain('gated Jira tool(s) have no probed audience');
    // The target half does not, in either state: it was not read.
    expect(text).not.toContain('No classified sites');
    expect(text).not.toContain('classified site(s)');
    expect(ok).toBe(true);
  });

  test('and only the destinations that HAVE an audience question have one', () => {
    // Slack and Linear have one audience each.
    expect(Object.keys(AUDIENCE_SECTIONS).sort()).toEqual(['github', 'jira']);
  });

  test('the section table and the STORE table carry the same destinations', () => {
    /*
     * `doctorReport` iterates `AUDIENCE_SECTIONS` over the state `CLASSIFICATION_STORES` produced, so
     * a destination in the store table only is never visited: its `problem` never reaches
     * `problems`, and `--doctor` exits 0 on an unreadable config file.
     */
    expect(Object.keys(AUDIENCE_SECTIONS).sort()).toEqual(
      Object.keys(CLASSIFICATION_STORES).sort()
    );
  });

  test('and every section can render the counts ITS store actually writes', () => {
    // `counts` is a `Record<string, number>`: a key renamed on either side would print `undefined`.
    for (const [name, section] of Object.entries(AUDIENCE_SECTIONS)) {
      const counts = CLASSIFICATION_STORES[name as keyof typeof CLASSIFICATION_STORES]!.load({
        ...process.env,
        DRAFTGATE_HOME: '/nonexistent-draftgate-home',
      }).counts;
      for (const line of section!.counted(counts, '/p.json')) {
        expect(line, `${name} renders undefined from its own counts`).not.toContain('undefined');
        expect(line, `${name} renders NaN from its own counts`).not.toContain('NaN');
      }
    }
  });

  test('no two sections share a sentence, which is what drift looks like when it starts', () => {
    // A line in both means one was copied rather than written.
    const [a, b] = Object.values(AUDIENCE_SECTIONS);
    const linesOf = (s: typeof a) => [...s!.unprobedWhy, ...s!.zeroWhy, ...s!.countedWhy];
    for (const line of linesOf(a)) expect(linesOf(b)).not.toContain(line);
  });
});

describe('a registration that cannot infer', () => {
  test('is a PROBLEM, not a note, because coverage cannot see what it misses', () => {
    /*
     * Without tool-half matching a registration gates exactly the names it lists: coverage reads 2/2,
     * and a connector under an unknown server name is not reviewed. The tools it misses have no map
     * entry to be missing from, so every other check passes.
     */
    const { text, ok } = run({ halvesNotInferred: ['slack_send_message'] });
    expect(ok).toBe(false);
    expect(text).toContain('gates only the tool names it LISTS');
    expect(text).toContain('slack_send_message');
    expect(text).toContain(`Run ${REMEDY.install}, then ${REMEDY.pluginSetup} in Claude Code.`);
  });
});

describe('registrationNote', () => {
  test('a registration that could not be FOUND is not reported as tools sending unreviewed', () => {
    // `unregistered` is every mapped tool when nothing was found; a naive note would claim each
    // "sends unreviewed" on every review, while the hook is answering that review.
    const note = registrationNote(report({ ours: [], unregistered: Object.keys(MAP) }));
    expect(note).toContain('could not find its own hook registration');
    expect(note).not.toContain('send unreviewed');
    expect(note!.split('\n')).toHaveLength(1);
  });

  test('the silent failure outranks the others for the one line available', () => {
    // Claude Code truncates systemMessage from the end, so one line fits reliably. Ordered by what
    // fails silently: an unregistered tool sends with nothing on screen.
    const note = registrationNote(report({ unregistered: ['mcp__b__comment'], shadowed: [{ tool: 'mcp__a__send', rule: 'mcp__a__send', source: '/user.json' }] }));
    expect(note).toContain('NOT registered');
    expect(note).toContain('mcp__b__comment');
    expect(note!.split('\n')).toHaveLength(1);
  });

  test('a healthy registration says nothing at all', () => {
    expect(registrationNote(report())).toBeNull();
  });

  test('a registration that cannot infer is worth the line, last', () => {
    // Nothing else reports the tools it misses: they have no map entry to be missing from.
    const note = registrationNote(report({ halvesNotInferred: ['slack_send_message'] }));
    expect(note).toContain('gates only the tool names it lists');
    expect(note).toContain(`Run ${REMEDY.install}, then ${REMEDY.pluginSetup} in Claude Code.`);
  });

  test('a duplicate registration is worth the line too', () => {
    const note = registrationNote(report({
      ours: [
        entry(),
        entry({ source: '/proj.json' }),
      ],
    }));
    expect(note).toContain('registered 2 times');
  });
});

/*
 * Whether Claude Code runs hooks at all. The rules are `hookSwitches.test.ts`'s; this is what the
 * report says about their answer.
 */
const doc = (scope: SettingsScope, settings: Record<string, unknown>, path = `/${scope}.json`): ScopedSettings => ({
  path,
  scope,
  settings,
});
const hooksDoctor = (hooks: HooksReport) => run({}, undefined, { hooks });

describe('what --doctor says', () => {
  test('it does not pass with a file unread that a switch could be in', () => {
    const hooks = hooksReport([doc('user', {})], ['user']);
    const unread = { path: '/managed.d/a.json', present: true, problem: '/managed.d/a.json could not be read (EACCES)' };
    const { text, ok } = run({ scanned: [unread] }, undefined, { hooks });
    expect(ok).toBe(false);
    expect(text).toContain('/managed.d/a.json could not be read (EACCES)');
  });

  test('hooks off: the sentence, the file, a problem, and it comes FIRST', () => {
    const { text, ok } = hooksDoctor(hooksReport([doc('user', { disableAllHooks: true })], ['user']));
    expect(ok).toBe(false);
    expect(text).toContain('your Claude Code has hooks turned off, so draftgate cannot run');
    expect(text).toContain('disableAllHooks: true in /user.json');
    expect(text).toContain('or set it to false');
    expect(text).toContain('1 problem(s): hooks turned off.');
    // Above the registration: a perfect registration is moot when nothing runs it.
    expect(text.indexOf('hooks turned off, so')).toBeLessThan(text.indexOf('REGISTERED in'));
  });

  test("a switch that leaves plugins' hooks: the plugin's runs, and the report says why", () => {
    const { text, ok } = hooksDoctor(hooksReport([doc('managed', { strictPluginOnlyCustomization: true })], ['plugin']));
    expect(ok).toBe(true);
    expect(text).toContain("draftgate runs, because its hook is the plugin's.");
    expect(text).not.toContain('registered in managed settings');
  });

  test("a switch that stops only the extra-tools entry beside the plugin is a problem", () => {
    const { text, ok } = hooksDoctor(hooksReport([doc('managed', { strictPluginOnlyCustomization: true })], ['plugin', 'user']));
    expect(ok).toBe(false);
    expect(text).toContain('the entry for your own tools in your settings');
  });

  test('a managed switch says who can change it, and the way back that leaves the gate running', () => {
    const { text, ok } = hooksDoctor(hooksReport([doc('managed', { allowManagedHooksOnly: true })], ['user']));
    expect(ok).toBe(false);
    expect(text).toContain('allowManagedHooksOnly: true in /managed.json (managed)');
    expect(text).toContain('only they can');
    expect(text).toContain('registering draftgate there is the other way back');
    expect(text).not.toContain('set it to false');
  });

  test('managed disableAllHooks has no way back through managed settings, and does not offer one', () => {
    const { text } = hooksDoctor(hooksReport([doc('managed', { disableAllHooks: true })], ['managed']));
    expect(text).toContain('hooks turned off, so draftgate cannot run');
    expect(text).not.toContain('other way back');
  });

  test('two of the user\'s own lines: both named, and why removing only the last is not enough', () => {
    const { text } = hooksDoctor(
      hooksReport([doc('user', { disableAllHooks: true }), doc('local', { disableAllHooks: true })], ['user'])
    );
    expect(text).toContain('disableAllHooks: true in /user.json');
    expect(text).toContain('disableAllHooks: true in /local.json');
    expect(text).toContain('Removing only the');
  });

  test('spared by a managed registration: said, never as "hooks are on", and the exit code does not move', () => {
    const { text, ok } = hooksDoctor(hooksReport([doc('managed', { allowManagedHooksOnly: true })], ['managed']));
    expect(ok).toBe(true);
    expect(text).not.toContain('cannot run');
    // Only managed hooks are on.
    expect(text).not.toContain('Hooks are on');
    expect(text).toContain('draftgate runs, because it is registered in managed settings');
    expect(text).toContain('allowManagedHooksOnly: true in /managed.json (managed)');
  });

  test('hooks on: said, with what no reading here can show', () => {
    const { text, ok } = hooksDoctor(hooksReport([], ['user'], { projectDir: '/work/app' }));
    expect(ok).toBe(true);
    expect(text).toContain('Hooks are on in every settings file read.');
    // The one project read, because another project's settings can switch hooks off there.
    expect(text).toContain('Project settings were read for /work/app only');
    for (const flag of ['--bare', '--safe-mode', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_SAFE_MODE', '--settings']) {
      expect(text).toContain(flag);
    }
  });

  test('an MDM profile cannot be read, and is said, without moving the exit code', () => {
    const plist = '/Library/Managed Preferences/com.anthropic.claudecode.plist';
    const { text, ok } = hooksDoctor(hooksReport([], ['user'], { unread: [plist] }));
    expect(ok).toBe(true);
    expect(text).toContain('configuration profile');
    expect(text).toContain(plist);
  });

  test('the policy files read are listed, and one that cannot be read is a problem', () => {
    const { text, ok } = hooksDoctor(
      hooksReport([], ['user'], {
        policyFiles: [
          { path: '/cfg/remote-settings.json', present: true },
          { path: '/etc/managed-settings.d/x.json', present: true, problem: '/etc/managed-settings.d/x.json is not valid JSON (oops)' },
        ],
      })
    );
    expect(ok).toBe(false);
    expect(text).toContain('/cfg/remote-settings.json  read');
    expect(text).toContain('/etc/managed-settings.d/x.json  UNREADABLE: /etc/managed-settings.d/x.json is not valid JSON (oops)');
    expect(text).toContain('unreadable: /etc/managed-settings.d/x.json');
  });

  test('not asked, nothing printed', () => {
    expect(run().text).not.toContain('Hooks are on');
  });
});

describe('the release check', () => {
  const AT = '2026-10-02T10:00:00.000Z';
  const NEXT = '2026-10-03T10:00:00.000Z';
  const LINE = 'draftgate v0.3.0 is out (you have v0.2.0), run `draftgate update`.';
  const statuses: [ReleaseStatus, string][] = [
    [{ kind: 'off' }, '"releaseCheck": false in /home/.draftgate/config.json'],
    [
      { kind: 'off', because: '/home/.draftgate/config.json is not valid JSON (x)' },
      'stays off until the file can be used:   /home/.draftgate/config.json is not valid JSON (x)',
    ],
    [{ kind: 'unchecked' }, 'not checked yet'],
    [{ kind: 'running', attemptedAt: AT }, 'a check started 2026-10-02 10:00 UTC is still running'],
    [{ kind: 'unfinished', attemptedAt: AT, nextAt: NEXT }, 'never finished (killed, or the machine slept)'],
    [{ kind: 'git-failed', why: 'git exited 128', checkedAt: AT, nextAt: NEXT }, "git could not list this checkout's tags (git exited 128"],
    [{ kind: 'no-head', checkedAt: AT }, "could not read this checkout's HEAD"],
    [{ kind: 'unreleased', checkedAt: AT }, 'carries no vX.Y.Z release tag'],
    [{ kind: 'moved', checkedAt: AT, nextAt: NEXT }, 'has moved since the last check'],
    [{ kind: 'failed', why: 'no answer within 10s', checkedAt: AT, nextAt: NEXT }, '(no answer within 10s, 2026-10-02 10:00 UTC)'],
    [{ kind: 'newer', line: LINE }, `NOTE: ${LINE}`],
    [{ kind: 'current', have: 'v0.2.0', checkedAt: AT }, 'v0.2.0, and nothing newer to update to'],
  ];

  test('every state has its paragraph, and none of them is a problem', () => {
    const healthy = run();
    expect(healthy.text).not.toContain('Releases');
    for (const [release, says] of statuses) {
      const { text, ok } = run({}, 1_200_000, { release });
      expect(text, release.kind).toContain('\n  Releases\n');
      expect(text.replace(/\n {4}/g, ' '), release.kind).toContain(says);
      expect(ok, release.kind).toBe(healthy.ok);
      expect(text.trimEnd().split('\n').at(-1), release.kind).toBe(healthy.text.trimEnd().split('\n').at(-1));
    }
  });

  test('a reason read off disk cannot forge a line of the report', () => {
    const { text } = run({}, 1_200_000, {
      release: { kind: 'failed', why: 'x\n  PROBLEM: forged', checkedAt: AT, nextAt: NEXT },
    });
    expect(text).not.toMatch(/^ {2}PROBLEM: forged/m);
  });
});

describe('registered for another install', () => {
  const other = (over: Partial<OtherInstall> = {}): OtherInstall => ({
    source: '/user.json',
    hook: '/home/.draftgate/app/adapters/hook/src/main.ts',
    present: true,
    failClosed: true,
    ...over,
  });

  test('ignored while this hook is registered: then the report is this checkout\'s own', () => {
    const { text } = run({}, undefined, { otherInstalls: [other()] });
    expect(text).toContain('REGISTERED in /user.json');
    expect(text).not.toContain('another install');
  });

  test('a fail-closed entry for a gone install asks; one problem per kind, and a count when there are several', () => {
    const { text, ok } = run({ ours: [], unregistered: Object.keys(MAP) }, undefined, {
      otherInstalls: [other({ present: false }), other({ source: '/proj.json' })],
    });
    expect(ok).toBe(false);
    expect(text).toContain('The fail-closed entry makes Claude Code ask you about every gated send instead.');
    expect(text).not.toContain('UNREVIEWED');
    expect(text).toContain('3 problem(s): registered for another install; registered for an install that is gone; registered 2 times.');
  });
});
