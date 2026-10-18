/**
 * The classification-store table, asserted without driving a review: which destinations have a
 * store, and that each refuses every value outside its own vocabulary. That an answer is about this
 * destination is the review's to check, not the store's.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLASSIFICATION_STORES, classificationStore } from '../src/classificationStores';
import {
  profiles,
  type DestinationName,
  type DestinationProfile,
} from '../../core/src/index';

/** The table's keys. There is no exported alias: `Object.keys` is the one spelling. */
const CLASSIFIED = Object.keys(CLASSIFICATION_STORES) as DestinationName[];

/**
 * Every value any destination offers, composed from the profiles. `core` does not export this: a
 * merged list is the wrong question for production code, which always knows its destination.
 */
const EVERY_CLASSIFICATION: readonly string[] = Object.values(profiles).flatMap<string>(
  (p) => p.reviewerAnswers
);

function withHome<T>(fn: (env: NodeJS.ProcessEnv, home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'draftgate-stores-'));
  try {
    return fn({ ...process.env, DRAFTGATE_HOME: join(home, '.draftgate') }, home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** The answer each store accepts, and one target that names something to file it under. */
const SAMPLES: Record<string, { answer: string; context: Record<string, unknown> }> = {
  jira: { answer: 'service_desk', context: { cloudId: 'c1', issueIdOrKey: 'SUP-1' } },
  github: { answer: 'public', context: { owner: 'Jakuboola', repo: 'draftgate' } },
};

describe('the table says which destinations have a classification question', () => {
  test('exactly the two that do, and nothing for the two that do not', () => {
    expect([...CLASSIFIED].sort()).toEqual(['github', 'jira']);
    // Slack and Linear have one audience each; a store for them would print config warnings about
    // a file irrelevant to the draft.
    expect(classificationStore('slack')).toBeUndefined();
    expect(classificationStore('linear')).toBeUndefined();
    // And a destination name this build does not know resolves to nothing rather than throwing.
    expect(classificationStore('jria')).toBeUndefined();
  });

  test('every store answers about a destination whose profile asks an audience question', () => {
    for (const name of CLASSIFIED) {
      // Typed as `DestinationProfile`: `profiles[name]` keeps each literal's narrow type, so only
      // two of the four declare the method.
      const profile: DestinationProfile = profiles[name];
      expect(profile.audienceFor, `${name} has a store and no audience rule`).toBeDefined();
    }
  });
});

describe('every store narrows to its OWN vocabulary', () => {
  /*
   * A store that accepted anything would file a Jira word against GitHub's config the day the two
   * vocabularies collide. Asserted through `remember`, the only thing that acts on the answer.
   */
  for (const name of CLASSIFIED) {
    const store = CLASSIFICATION_STORES[name]!;
    const refuses = (value: string) =>
      withHome((env) => store.remember(SAMPLES[name].context, value, env).includes('ignored'));

    test(`${name} accepts its own values and refuses every other`, () => {
      const mine = EVERY_CLASSIFICATION.filter((v) => !refuses(v));
      expect(mine.length, `${name} accepts nothing`).toBeGreaterThan(0);
      const theirs = EVERY_CLASSIFICATION.filter((v) => refuses(v));
      expect(theirs.length, `${name} accepts the whole union`).toBeGreaterThan(0);
      expect([...mine, ...theirs].sort()).toEqual([...EVERY_CLASSIFICATION].sort());
    });

    test(`${name} REFUSES a foreign answer out loud rather than filing it`, () => {
      withHome((env) => {
        const foreign = EVERY_CLASSIFICATION.find((v) => refuses(v))!;
        const said = store.remember(SAMPLES[name].context, foreign, env);
        expect(said).toContain(foreign);
        expect(said).toContain('ignored');
        expect(store.load(env).classified).toBe(0);
      });
    });
  }
});

describe('every store reports COUNTS in its own vocabulary', () => {
  // The keys `AudienceSection.counted` reads; `counts` is a `Record<string, number>`, so only this
  // stops the two halves drifting.
  const KEYS: Record<string, string[]> = {
    jira: ['sites', 'projects', 'serviceDesks'],
    github: ['repos', 'public'],
  };
  for (const name of CLASSIFIED) {
    test(`${name}`, () => {
      withHome((env) => {
        const store = CLASSIFICATION_STORES[name]!;
        expect(Object.keys(store.load(env).counts).sort()).toEqual([...KEYS[name]].sort());
        store.remember(SAMPLES[name].context, SAMPLES[name].answer as never, env);
        const after = store.load(env);
        expect(Object.keys(after.counts).sort()).toEqual([...KEYS[name]].sort());
        // Every number is a real count, and `classified` is one of them.
        for (const v of Object.values(after.counts)) expect(v).toBeGreaterThanOrEqual(0);
        expect(Object.values(after.counts)).toContain(after.classified);
      });
    });
  }
});

describe('every store round-trips a reviewer answer', () => {
  for (const name of CLASSIFIED) {
    test(`${name}: remembered, then read back as a classified target`, () => {
      withHome((env) => {
        const store = CLASSIFICATION_STORES[name]!;
        const { answer, context } = SAMPLES[name];
        expect(store.load(env).classified).toBe(0);
        expect(store.load(env).present).toBe(false);

        const said = store.remember(context, answer as never, env);
        expect(said).toContain('remembered');
        expect(said).toContain(store.load(env).path);

        const after = store.load(env);
        expect(after.classified).toBe(1);
        expect(after.present).toBe(true);
        expect(after.problem).toBeUndefined();
        expect(Object.keys(after.facts).length).toBe(1);
      });
    });

    test(`${name}: a payload naming no target says so instead of failing quietly`, () => {
      withHome((env) => {
        const store = CLASSIFICATION_STORES[name]!;
        const said = store.remember({}, SAMPLES[name].answer as never, env);
        expect(said).toContain('could not remember');
        expect(store.load(env).classified).toBe(0);
      });
    });

    test(`${name}: a file that exists and is broken reports a problem and does not throw`, () => {
      withHome((env) => {
        const store = CLASSIFICATION_STORES[name]!;
        const path = store.load(env).path;
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, '{ broken');
        const loaded = store.load(env);
        expect(loaded.problem).toBeTruthy();
        expect(loaded.present).toBe(true);
        expect(loaded.classified).toBe(0);
      });
    });
  }
});

/**
 * The authoritative row on disk, for each store, declaring the sample target as `answer`. Written as
 * text: `remember` signs its rows `reviewer`, which are overwritable, and only a row signed by the
 * destination itself outranks the click.
 */
const AUTHORITATIVE: Record<string, (answer: string) => string> = {
  jira: (answer) =>
    JSON.stringify({
      version: 1,
      sites: { c1: { host: 'example.atlassian.net', projects: { SUP: answer }, sources: { SUP: 'jira' } } },
    }),
  github: (answer) =>
    JSON.stringify({
      version: 1,
      repos: { 'jakuboola/draftgate': answer },
      sources: { 'jakuboola/draftgate': 'github' },
    }),
};

describe('a declaration the destination itself signed outranks the reviewer', () => {
  for (const name of CLASSIFIED) {
    const { answer, context } = SAMPLES[name];
    const other = EVERY_CLASSIFICATION.find(
      (v) =>
        v !== answer &&
        !withHome((env) => CLASSIFICATION_STORES[name]!.remember(context, v, env).includes('ignored'))
    )!;

    const seed = (env: NodeJS.ProcessEnv, declared: string) => {
      const path = CLASSIFICATION_STORES[name]!.load(env).path;
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, AUTHORITATIVE[name](declared));
    };

    test(`${name}: a CONTRADICTING answer is refused, said out loud, and the file is unchanged`, () => {
      withHome((env) => {
        const store = CLASSIFICATION_STORES[name]!;
        seed(env, answer);
        const before = readFileSync(store.load(env).path, 'utf8');
        const said = store.remember(context, other, env);
        expect(said).toContain(answer);
        expect(said).toContain('Keeping that');
        // The record, not the message, is what the audience banner reads.
        expect(readFileSync(store.load(env).path, 'utf8')).toBe(before);
        expect(store.load(env).classified).toBe(1);
      });
    });

    test(`${name}: an AGREEING answer is silent, because nothing changed`, () => {
      withHome((env) => {
        const store = CLASSIFICATION_STORES[name]!;
        seed(env, answer);
        // The one case both stores say nothing about; the contradiction above separates the two.
        expect(store.remember(context, answer, env)).toBe('');
        expect(store.load(env).classified).toBe(1);
      });
    });
  }
});
