/**
 * The deadline: what was asked for, bounded by what is registered.
 *
 * Most important is the inverse: a registration printed for a deadline yields that deadline back
 * when read. The two directions live in different files, and drift costs every operator a minute
 * or a race.
 */

import { describe, expect, test } from 'bun:test';
import { DEFAULT_TIMEOUT_MS } from '../../../cli/src/review';
import { EVENT_DEFAULT_TIMEOUT_MS } from '../src/registration';
import { PLUGIN_HOOK_TIMEOUT_S, hookTimeoutSecondsFor } from '../src/main';
import {
  GRACE_MS,
  PLUGIN_REVIEW_CEILING_MS,
  UNREGISTERED_CEILING_MS,
  deadlineNote,
  graceFor,
  reviewDeadline,
} from '../src/reviewTimeout';

const CONFIG = '/home/me/.draftgate/config.json';
const FROM_CHECKOUT = { plugin: false, configPath: CONFIG };
const FROM_PLUGIN = { plugin: true, configPath: CONFIG };
/** Twice the ceiling asked for, against the plugin's own registration. */
const AT_CEILING = reviewDeadline(2 * PLUGIN_REVIEW_CEILING_MS, PLUGIN_HOOK_TIMEOUT_S * 1000);

describe('reviewDeadline', () => {
  test('a registration with room to spare grants what was asked for', () => {
    const d = reviewDeadline(600_000, 1_260_000);
    expect(d.ms).toBe(600_000);
    expect(d.basis.kind).toBe('asked');
    expect(deadlineNote(d, FROM_CHECKOUT)).toBeNull();
  });

  test('a shorter registration decides, and says so', () => {
    // A registration older than the configured deadline costs a shorter review (visible in the
    // countdown, named in the timeout denial) instead of Claude Code's fail-open path.
    const d = reviewDeadline(1_800_000, 660_000);
    expect(d.ms).toBe(600_000);
    expect(d.basis).toEqual({ kind: 'clamped', registeredMs: 660_000 });
    expect(deadlineNote(d, FROM_CHECKOUT)).toContain('600s, not the 1800s configured');
  });

  test("from the plugin, a clamp at its own ceiling says to ask for less: nothing lengthens it", () => {
    const d = AT_CEILING;
    expect(d.ms).toBe(PLUGIN_REVIEW_CEILING_MS);
    const note = deadlineNote(d, FROM_PLUGIN)!;
    expect(note).toContain(`ask for at most ${PLUGIN_REVIEW_CEILING_MS / 1000}s in ${CONFIG}.`);
    expect(note).not.toContain('/draftgate:setup');
  });

  test('from the plugin, a clamp shorter than its ceiling is another entry, which setup replaces', () => {
    // The clamp takes the shortest registration, so a checkout's leftover entry decides here.
    const note = deadlineNote(reviewDeadline(1_800_000, 660_000), FROM_PLUGIN)!;
    expect(note).toContain('Another draftgate entry');
    expect(note).toContain('`/draftgate:setup` replaces it.');
    expect(note).not.toContain('ask for at most');
  });

  test('from a checkout, a clamp says to install the plugin, which registers nothing of its own', () => {
    const note = deadlineNote(reviewDeadline(1_800_000, 660_000), FROM_CHECKOUT)!;
    expect(note).toContain('Install the plugin: `curl -fsSL');
    expect(note).not.toContain(CONFIG);
    expect(note).not.toContain('draftgate register');
  });

  test('a config path is one line in the note', () => {
    const d = AT_CEILING;
    expect(deadlineNote(d, { plugin: true, configPath: '/a\nb/config.json' })).not.toContain('\n');
  });

  test('an unfindable registration is capped at the EVENT default, not the shipped one', () => {
    /*
     * `ours: []` happens on working installs: a plugin-provided hook, `claude --settings <file>`, an
     * unreadable `~/.claude/settings.json`. Falling back to `DEFAULT_TIMEOUT_MS` (20 minutes) would
     * hand out 1200s against registrations of 600s (no `timeout`) or 660s (a ten-minute deadline).
     * What is known about an unseen registration: at most the event default.
     */
    const d = reviewDeadline(1_800_000, undefined);
    expect(d.ms).toBe(540_000);
    expect(d.ms).toBeLessThan(EVENT_DEFAULT_TIMEOUT_MS);
    expect(d.basis.kind).toBe('unregistered');
    expect(deadlineNote(d, FROM_CHECKOUT)).toContain('Run `draftgate doctor`.');
  });

  test('and the shipped default does not escape it either', () => {
    // An ordinary install with no config file, where `wantedMs` is the default: a `basis` derived
    // from `ms < wantedMs` would report `asked` and print no warning.
    const d = reviewDeadline(DEFAULT_TIMEOUT_MS, undefined);
    expect(d.ms).toBe(540_000);
    expect(d.basis.kind).toBe('unregistered');
    expect(deadlineNote(d, FROM_CHECKOUT)).not.toBeNull();
  });

  test('asking for less than the cap is honoured, and says nothing about it', () => {
    const d = reviewDeadline(60_000, undefined);
    expect(d.ms).toBe(60_000);
    // Still `unregistered` (the basis is what was known), but nothing was lost, so the per-review
    // line stays quiet; `registrationNote` says the registration could not be found.
    expect(d.basis.kind).toBe('unregistered');
    expect(deadlineNote(d, FROM_CHECKOUT)).toBeNull();
  });

  test('a registration shorter than the flat grace still yields a POSITIVE, ordered deadline', () => {
    // `timeout: 30` would compute -30s with a flat minute, and a floor would put the review past the
    // harness. The fraction keeps it strictly less than what is registered at every size.
    const d = reviewDeadline(1_800_000, 30_000);
    expect(graceFor(30_000)).toBe(3_000);
    expect(d.ms).toBe(27_000);
    expect(d.ms).toBeLessThan(30_000);
    expect(d.ms).toBeGreaterThan(0);
  });

  test('the grace is flat at every size a minute fits into', () => {
    expect(graceFor(600_000)).toBe(GRACE_MS);
    expect(graceFor(1_260_000)).toBe(GRACE_MS);
  });
});

describe('the two directions are inverses', () => {
  test('a registration printed for a deadline yields that deadline back', () => {
    // `hookTimeoutSecondsFor` (adapters/hook/src/main.ts) writes the registration; `reviewDeadline`
    // reads it. This table holds them together.
    for (const wantedMs of [60_000, 600_000, DEFAULT_TIMEOUT_MS, 1_800_000, 3_600_000]) {
      const registeredMs = hookTimeoutSecondsFor(wantedMs) * 1000;
      const d = reviewDeadline(wantedMs, registeredMs);
      expect(d.ms, `printed ${registeredMs}ms for a ${wantedMs}ms review`).toBe(wantedMs);
      expect(d.basis.kind).toBe('asked');
    }
  });

  test('the shipped default round-trips, which is what an untouched install does', () => {
    const registeredMs = hookTimeoutSecondsFor(DEFAULT_TIMEOUT_MS) * 1000;
    expect(registeredMs).toBe(1_260_000);
    expect(reviewDeadline(DEFAULT_TIMEOUT_MS, registeredMs).ms).toBe(DEFAULT_TIMEOUT_MS);
  });

  test('a stale paste shortens the review rather than inverting the ordering', () => {
    // A 660 printed for a ten-minute deadline, under a twenty-minute default: without the clamp the
    // harness fires first (fail-open); with it, ten minutes and a line saying to re-paste.
    const d = reviewDeadline(DEFAULT_TIMEOUT_MS, 660_000);
    expect(d.ms).toBe(600_000);
    expect(d.ms).toBeLessThan(660_000);
    expect(deadlineNote(d, FROM_CHECKOUT)).toContain('must outlive it');
  });
});

describe('the unregistered ceiling is a fact about Claude Code, not a copy of our default', () => {
  test('it is the event default less its grace, and independent of DEFAULT_TIMEOUT_MS', () => {
    // A relationship rather than 540_000, so a constant starting to mean something else fails here.
    expect(UNREGISTERED_CEILING_MS).toBe(EVENT_DEFAULT_TIMEOUT_MS - GRACE_MS);
    expect(UNREGISTERED_CEILING_MS).toBeLessThan(EVENT_DEFAULT_TIMEOUT_MS);
  });
});
