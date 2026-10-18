/**
 * The operator's answer to "which Jira projects are service desks", per site.
 *
 * Nothing here throws, and every degradation lands on an undeclared site, which the profile reads
 * as `unknown` (a banner). A file that exists and cannot be fully used says so (`problem`); an
 * absent file is the ordinary state of an installation with no JSM projects.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JIRA_PROJECTS_BASENAME,
  jiraProjectsPath,
  loadJiraProjects,
  parseJiraProjects,
  describeJiraSiteWrite,
  jiraProjectsSummary,
  jiraSiteFileText,
  jiraSiteHostname,
  rememberJiraProject,
  rememberJiraSite,
  withJiraSite,
} from '../src/jiraProjects';
import { jiraSiteFor, type JiraProjectType, type JiraSite } from '../../core/src/index';

const dir = mkdtempSync(join(tmpdir(), 'draftgate-jira-projects-test-'));
// `test/tempDirs.test.ts` fails the suite if this is skipped.
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DEV = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** A DRAFTGATE_HOME of its own per case, so one test's file cannot answer another's read. */
function home(contents?: string): NodeJS.ProcessEnv {
  const h = mkdtempSync(join(dir, 'h'));
  if (contents !== undefined) writeFileSync(join(h, JIRA_PROJECTS_BASENAME), contents);
  return { DRAFTGATE_HOME: h };
}

const parse = (text: string) => parseJiraProjects(text, 'test.json');
const site = (projects: Record<string, string>, host = 'dev.atlassian.net') =>
  JSON.stringify({ sites: { [DEV]: { host, projects } } });

describe('parseJiraProjects', () => {
  test('reads a site and its declared types', () => {
    const r = parse(site({ SUPPORT: 'service_desk', KAN: 'software' }));
    expect(r.sites[DEV]?.projects).toEqual({ SUPPORT: 'service_desk', KAN: 'software' });
    expect(r.sites[DEV]?.host).toBe('dev.atlassian.net');
    expect(r.problem).toBeUndefined();
  });

  test('keeps two sites apart', () => {
    // `SUPPORT` on dev and `SUPPORT` on production are different projects with the same key.
    const r = parse(
      JSON.stringify({
        sites: {
          [DEV]: { projects: { SUPPORT: 'service_desk' } },
          prod: { projects: { SUPPORT: 'software' } },
        },
      })
    );
    expect(r.sites[DEV]?.projects.SUPPORT).toBe('service_desk');
    expect(r.sites.prod?.projects.SUPPORT).toBe('software');
  });

  test('UPPERCASES the project keys, because Jira issue keys are case-insensitive', () => {
    // Probed against Jira: a lower-case issue key is a 200. A lower-case config must still match.
    expect(parse(site({ support: 'service_desk' })).sites[DEV]?.projects).toEqual({
      SUPPORT: 'service_desk',
    });
  });

  test('two spellings of one key that DISAGREE are reported, not silently last-wins', () => {
    // Uppercasing makes a collision possible; insertion order would pick whichever line came second.
    const r = parse(site({ support: 'software', SUPPORT: 'service_desk' }));
    expect(r.problem).toContain('declared twice');
    expect(r.sites[DEV]?.projects.SUPPORT).toBe('software');
  });

  test('and two spellings that AGREE are not a problem', () => {
    const r = parse(site({ support: 'service_desk', SUPPORT: 'service_desk' }));
    expect(r.problem).toBeUndefined();
    expect(r.sites[DEV]?.projects.SUPPORT).toBe('service_desk');
  });

  test('one bad entry costs that entry, not the other thirty-nine', () => {
    const r = parse(site({ SUPPORT: 'service_desk', OOPS: 'servicedesk' }));
    expect(r.sites[DEV]?.projects).toEqual({ SUPPORT: 'service_desk' });
    expect(r.problem).toContain('OOPS');
    // And it says what survived, so it does not read as "the file is dead".
    expect(r.problem).toContain('kept 1');
  });

  test('an unknown type is never guessed at', () => {
    // Not `service_desk` (claims a fact) nor `software` (silences the banner).
    const r = parse(site({ X: 'jira-service-desk', Y: 'true', Z: 'null' }));
    expect(r.sites[DEV]?.projects).toEqual({});
    expect(r.problem).toContain('kept 0');
  });

  test('a mis-shaped site entry is dropped without taking the others with it', () => {
    const r = parse(
      JSON.stringify({
        sites: { [DEV]: { projects: { SUPPORT: 'service_desk' } }, broken: [], alsoBroken: {} },
      })
    );
    expect(r.sites[DEV]?.projects.SUPPORT).toBe('service_desk');
    expect(r.problem).toContain('broken');
  });

  test('invalid JSON degrades to nothing, and says why', () => {
    const r = parse('{oops');
    expect(r.sites).toEqual({});
    expect(r.problem).toContain('not valid JSON');
  });

  test('the wrong top-level shape degrades to nothing, and says why', () => {
    for (const text of ['[]', '"a string"', '42', 'null']) {
      const r = parse(text);
      expect(r.sites).toEqual({});
      expect(r.problem).toBeString();
    }
  });

  test('a missing or mis-shaped "sites" key is reported rather than ignored', () => {
    expect(parse('{}').problem).toContain('no "sites" key');
    expect(parse('{"sites": []}').problem).toContain('keyed by cloud id');
    expect(parse('{"sites": "dev"}').problem).toContain('keyed by cloud id');
  });

  test('an empty declaration is valid and is not a problem', () => {
    const r = parse('{"sites": {}}');
    expect(r.sites).toEqual({});
    expect(r.problem).toBeUndefined();
  });

  test('site keys are NORMALISED, so a hand-written URL key is reachable at all', () => {
    // Stored raw, this key is unreachable by every payload spelling, the byte-identical one
    // included (`jiraSiteFor` normalises what it compares), and nothing in `problem` says why.
    const r = parse(
      JSON.stringify({ sites: { 'https://ACME.atlassian.net/': { projects: { SUP: 'service_desk' } } } })
    );
    expect(Object.keys(r.sites)).toEqual(['acme.atlassian.net']);
    expect(jiraSiteFor('https://acme.atlassian.net/', r.sites)?.projects.SUP).toBe('service_desk');
    expect(jiraSiteFor('acme.atlassian.net', r.sites)?.projects.SUP).toBe('service_desk');
  });

  test('two spellings of ONE site MERGE, so a disagreement is reported rather than ordered', () => {
    // As for two spellings of one project key: kept apart, they resolve by insertion order.
    const r = parse(
      JSON.stringify({
        sites: {
          'https://acme.atlassian.net': { host: 'acme.atlassian.net', projects: { KAN: 'software' } },
          'acme.atlassian.net': { projects: { KAN: 'service_desk', SUP: 'service_desk' } },
        },
      })
    );
    expect(Object.keys(r.sites)).toEqual(['acme.atlassian.net']);
    // The second spelling's other project is kept...
    expect(r.sites['acme.atlassian.net']?.projects.SUP).toBe('service_desk');
    expect(r.sites['acme.atlassian.net']?.host).toBe('acme.atlassian.net');
    // ...and the one they disagree about is named.
    expect(r.problem).toContain('declared twice');
    expect(r.problem).toContain('KAN');
  });

  test('a key that normalises to nothing is rejected rather than filed where nobody looks', () => {
    const r = parse(JSON.stringify({ sites: { '  ': { projects: { SUP: 'service_desk' } } } }));
    expect(r.sites).toEqual({});
    expect(r.problem).toContain('names no site');
  });

  test('prototype keys land as ordinary entries and cannot poison a lookup', () => {
    // The file is hand-written and the map it produces is indexed by an agent-supplied project key.
    const r = parse(site({ __proto__: 'service_desk', SUPPORT: 'software' }));
    expect(r.sites[DEV]?.projects.SUPPORT).toBe('software');
    expect(({} as Record<string, unknown>).SUPPORT).toBeUndefined();
  });
});

describe('loadJiraProjects', () => {
  test('no file is the ordinary state: no sites, and NO problem', () => {
    const r = loadJiraProjects(home());
    expect(r.sites).toEqual({});
    expect(r.problem).toBeUndefined();
  });

  test('reads the file when there is one', () => {
    const r = loadJiraProjects(home(site({ SUPPORT: 'service_desk' })));
    expect(r.sites[DEV]?.projects.SUPPORT).toBe('service_desk');
  });

  test('a file that exists and cannot be READ is reported', () => {
    const env = home();
    // A directory where the file should be: present and unreadable.
    mkdirSync(jiraProjectsPath(env));
    const r = loadJiraProjects(env);
    expect(r.sites).toEqual({});
    expect(r.problem).toContain('could not be read');
  });

  test('never throws, whatever is in the file', () => {
    for (const text of ['', '{oops', '[]', '  ', '\u0000']) {
      expect(() => loadJiraProjects(home(text))).not.toThrow();
    }
  });

  test('the path is under DRAFTGATE_HOME, so it moves with the rest of draftgate state', () => {
    // One definition, `draftgateHome`, so `DRAFTGATE_HOME` cannot relocate only half of it.
    expect(jiraProjectsPath({ DRAFTGATE_HOME: '/tmp/dg' })).toBe('/tmp/dg/jira-projects.json');
  });
});

/**
 * `rememberJiraProject`: what the window's question writes down. It never throws (a write failure
 * must not alter a decision a human made), and a click cannot overwrite a declaration.
 */
describe('rememberJiraProject', () => {
  test('writes a site that was not there', () => {
    const env = home();
    expect(rememberJiraProject({ cloudId: DEV, key: 'SUPPORT', type: 'service_desk' }, env).error).toBeUndefined();
    expect(loadJiraProjects(env).sites[DEV]?.projects.SUPPORT).toBe('service_desk');
  });

  test('MERGES into an existing site rather than replacing it', () => {
    const env = home(site({ KAN: 'software' }));
    rememberJiraProject({ cloudId: DEV, key: 'SUPPORT', type: 'service_desk' }, env);
    const projects = loadJiraProjects(env).sites[DEV]?.projects;
    expect(projects).toEqual({ KAN: 'software', SUPPORT: 'service_desk' });
    // And the site's recorded host survives.
    expect(loadJiraProjects(env).sites[DEV]?.host).toBe('dev.atlassian.net');
  });

  test('and leaves other sites alone', () => {
    const env = home(
      JSON.stringify({ sites: { other: { projects: { SUPPORT: 'software' } } } })
    );
    rememberJiraProject({ cloudId: DEV, key: 'SUPPORT', type: 'service_desk' }, env);
    const all = loadJiraProjects(env).sites;
    expect(all.other?.projects.SUPPORT).toBe('software');
    expect(all[DEV]?.projects.SUPPORT).toBe('service_desk');
  });

  test('an EXISTING declaration is not overwritten by a click', () => {
    // The generator's answer came from Jira's project list; a click is a recollection.
    const env = home(site({ SUPPORT: 'software' }));
    const { kept } = rememberJiraProject({ cloudId: DEV, key: 'SUPPORT', type: 'service_desk' }, env);
    // Unmarked counts as authoritative: hand-written, or written without provenance.
    expect(kept).toEqual({ type: 'software', source: 'unmarked' });
    expect(loadJiraProjects(env).sites[DEV]?.projects.SUPPORT).toBe('software');
  });

  test('the file it writes is private, like everything else under draftgate home', () => {
    const env = home();
    rememberJiraProject({ cloudId: DEV, key: 'SUPPORT', type: 'service_desk' }, env);
    expect(statSync(jiraProjectsPath(env)).mode & 0o777).toBe(0o600);
  });

  test('never throws when the path cannot be written', () => {
    const env = home();
    // A directory where the file goes: `writePrivateFile` fails, and the caller gets the error
    // rather than an exception.
    mkdirSync(jiraProjectsPath(env));
    const { error } = rememberJiraProject({ cloudId: DEV, key: 'SUPPORT', type: 'service_desk' }, env);
    expect(error).toBeDefined();
  });
});

/**
 * The hostname check, shared by `tools/jira-projects/generate.mjs` and `from-mcp.mjs` (both read
 * argv, stdin or the network at import, so they cannot be tested). The generator sends the Jira API
 * token to this host, so `acme.atlassian.net@evil.test` would deliver it to `evil.test`.
 */
describe('jiraSiteHostname', () => {
  test('a plain host survives, normalised the way the config is keyed', () => {
    expect(jiraSiteHostname('acme.atlassian.net')).toBe('acme.atlassian.net');
    expect(jiraSiteHostname('https://ACME.atlassian.net/')).toBe('acme.atlassian.net');
  });

  test('everything with a delimiter in it is refused, not repaired', () => {
    // `@` makes the leading text userinfo: it reads as the real site, the request goes elsewhere.
    for (const bad of [
      'acme.atlassian.net@evil.test',
      'evil.test/acme.atlassian.net',
      'acme.atlassian.net:8443',
      'acme.atlassian.net?x=1',
      'acme.atlassian.net#y',
      'acme atlassian net',
      '',
      '   ',
    ]) {
      expect(jiraSiteHostname(bad), bad).toBeNull();
    }
  });

  test('a single label is refused, so localhost never receives a token', () => {
    expect(jiraSiteHostname('localhost')).toBeNull();
    expect(jiraSiteHostname('http://localhost/')).toBeNull();
  });

  test('a UUID is not a hostname, which is why this is not `jiraSiteKey`', () => {
    // `jiraSiteKey` normalises a spelling and also keys by cloud id, so it cannot carry a hostname
    // rule.
    expect(jiraSiteHostname(DEV)).toBeNull();
  });
});

/**
 * The site writer both instruments in `tools/jira-projects/` call. Neither can be tested, so the
 * merge they share is tested here.
 */
describe('rememberJiraSite', () => {
  const measured = { cloudId: DEV, host: 'dev.atlassian.net', projects: { SUPPORT: 'service_desk' as const } };

  test('a first run writes the site, stamped as JIRA rather than as a recollection', () => {
    const env = home();
    const out = rememberJiraSite(measured, env);
    expect(out).not.toHaveProperty('error');
    const raw = JSON.parse(readFileSync(jiraProjectsPath(env), 'utf8'));
    expect(raw.sites[DEV].projects.SUPPORT).toBe('service_desk');
    // The stamp lets a later run correct this and stops a click overwriting it.
    expect(raw.sites[DEV].sources.SUPPORT).toBe('jira');
  });

  test('0600, because this file names the projects a team supports', () => {
    const env = home();
    rememberJiraSite(measured, env);
    expect(statSync(jiraProjectsPath(env)).mode & 0o777).toBe(0o600);
  });

  test('a second site does not discard the first, and says what it carried', () => {
    const env = home(site({ LEGACY: 'software' }));
    const out = rememberJiraSite(measured, env);
    // `siteRows` is what the file holds; `jiraProjectsSummary` counts what is usable, which
    // differs once a row is unparseable.
    expect(out).toMatchObject({ replaced: true, siteRows: 1, carried: ['LEGACY'] });
    const projects = loadJiraProjects(env).sites[DEV]?.projects;
    // An archived project the search does not return is carried forward (`withJiraSite`).
    expect(projects).toEqual({ LEGACY: 'software', SUPPORT: 'service_desk' });
  });

  test('a cloudId that names no site is refused, not written under an empty key', () => {
    /*
     * The guard `rememberJiraProject` has. A `sites[""]` row is unreachable (`jiraSiteKeysFor`
     * filters `''`), and its `problem` makes `--doctor` exit 1. Both instruments validate first;
     * the exported writer must not depend on that.
     */
    const env = home();
    const out = rememberJiraSite({ ...measured, cloudId: '   ' }, env);
    expect(out).toHaveProperty('error');
    expect(loadJiraProjects(env).sites).toEqual({});
  });

  test('an unparseable file is REFUSED and left byte-identical', () => {
    // A reader may drop what it does not understand; a writer doing the same deletes the config.
    const broken = '{"sites":{"cloud-1":{"projects":{"A":"software",}}}}';
    const env = home(broken);
    const out = rememberJiraSite(measured, env);
    expect(out).toHaveProperty('error');
    expect(readFileSync(jiraProjectsPath(env), 'utf8')).toBe(broken);
  });
});

/**
 * The count both `--doctor` and `draftgate setup` print, which is not `Object.keys(sites).length`:
 * this parser's partial credit creates the shape it accounts for.
 */
describe('jiraProjectsSummary', () => {
  test('a site with nothing usable in it is not a classified site', () => {
    // A site whose every project was rejected survives as an empty entry; counting it prints
    // "1 classified site" over a file that classifies nothing.
    const summary = jiraProjectsSummary({
      sites: { dead: { projects: {} }, live: { projects: { SUPPORT: 'service_desk' } } },
    });
    expect(summary).toEqual({ sites: 1, projects: 1, serviceDesks: 1 });
  });

  test('desks are counted across every site and are a subset of the projects', () => {
    const summary = jiraProjectsSummary({
      sites: {
        a: { projects: { SUPPORT: 'service_desk', KAN: 'software' } },
        b: { projects: { HELP: 'service_desk' } },
      },
    });
    expect(summary).toEqual({ sites: 2, projects: 3, serviceDesks: 2 });
  });

  test('an empty file summarises to zeroes rather than throwing', () => {
    expect(jiraProjectsSummary({ sites: {} })).toEqual({ sites: 0, projects: 0, serviceDesks: 0 });
  });
});

/**
 * `loadJiraProjects` answers the two questions its callers would otherwise ask the filesystem.
 * `present` is not derivable: an absent file and `{"sites":{}}` both parse to no sites and no
 * problem.
 */
describe('loadJiraProjects reports where it looked', () => {
  test('an absent file is not present, and says where it was not', () => {
    const env = home();
    const loaded = loadJiraProjects(env);
    expect(loaded.present).toBe(false);
    expect(loaded.path).toBe(jiraProjectsPath(env));
    expect(loaded.problem).toBeUndefined();
  });

  test('an EMPTY declaration is present, which is the case a count cannot distinguish', () => {
    const loaded = loadJiraProjects(home('{"sites":{}}'));
    expect(loaded.present).toBe(true);
    expect(jiraProjectsSummary(loaded).sites).toBe(0);
  });

  test('a file that exists and cannot be read is PRESENT, not absent', () => {
    // Something answered, and it was not "no such file".
    const env = home();
    mkdirSync(jiraProjectsPath(env));
    const loaded = loadJiraProjects(env);
    expect(loaded.present).toBe(true);
    expect(loaded.problem).toContain('could not be read');
  });
});

/**
 * What the two instruments tell an operator, written once for both; their reports differ by one
 * word. Neither instrument can be tested, so the wording is checked only here.
 */
describe('describeJiraSiteWrite', () => {
  const measured = {
    cloudId: DEV,
    host: 'dev.atlassian.net',
    projects: { SUPPORT: 'service_desk' as const, KAN: 'software' as const },
  };

  test('a write names what happened, where, and what it kept', () => {
    const lines = describeJiraSiteWrite(
      measured,
      { carried: ['LEGACY'], replaced: true, siteRows: 2, path: '/p.json' },
      'search'
    );
    expect(lines[0]).toContain('updated dev.atlassian.net');
    expect(lines[0]).toContain('/p.json');
    expect(lines[1]).toContain('kept 1 existing classification(s) this search did not cover: LEGACY');
  });

  test('the ONE difference between the two instruments is the word for what it read', () => {
    // `generate.mjs` runs a search; `from-mcp.mjs` is handed a read.
    const outcome = { carried: ['X'], replaced: false, siteRows: 1, path: '/p.json' };
    const search = describeJiraSiteWrite(measured, outcome, 'search').join('\n');
    const read = describeJiraSiteWrite(measured, outcome, 'read').join('\n');
    expect(search.replace('this search did not', 'this read did not')).toBe(read);
  });

  test('nothing carried means no line about carrying', () => {
    const lines = describeJiraSiteWrite(measured, { carried: [], replaced: false, siteRows: 1, path: '/p.json' }, 'read');
    expect(lines.join('\n')).not.toContain('kept');
  });

  test('an error names the file and does not claim a write', () => {
    const lines = describeJiraSiteWrite(measured, { error: new Error('boom'), path: '/p.json' }, 'read');
    expect(lines[0]).toBe('boom.');
    expect(lines[1]).toContain('Nothing was written to /p.json');
    expect(lines.join('\n')).not.toContain('added');
    expect(lines.join('\n')).not.toContain('updated');
  });

  test('--print reports the projects without claiming anything was written', () => {
    const lines = describeJiraSiteWrite(measured, null, 'read').join('\n');
    expect(lines).not.toContain('Nothing was written');
    expect(lines).not.toContain('added');
    expect(lines).toContain('2 project(s) on dev.atlassian.net; 1 service desk(s): SUPPORT');
  });

  test('and every outcome states who reads a service-desk comment', () => {
    for (const outcome of [null, { carried: [], replaced: false, siteRows: 1, path: '/p.json' }]) {
      expect(describeJiraSiteWrite(measured, outcome, 'read').join('\n')).toContain(
        'PUBLIC replies to the customer'
      );
    }
  });
});

/**
 * `--print` and the write serialise the same way, so `--print` is what a first run writes.
 */
describe('jiraSiteFileText', () => {
  test('is byte-identical to what a first run leaves on disk', () => {
    const env = home();
    const measured = { cloudId: DEV, host: 'dev.atlassian.net', projects: { SUPPORT: 'service_desk' as const } };
    const printed = jiraSiteFileText(measured);
    expect(rememberJiraSite(measured, env)).not.toHaveProperty('error');
    expect(readFileSync(jiraProjectsPath(env), 'utf8')).toBe(printed);
  });
});

/**
 * What `rememberJiraProject` must not destroy. `loadJiraProjects` is a reader's view, not a base
 * to write from: the writer refuses to overwrite what it cannot fully read.
 */
describe('rememberJiraProject does not destroy the operator file', () => {
  test('an UNPARSEABLE file is refused and left byte-identical', () => {
    // Otherwise one trailing comma turns three declared projects into the one just clicked, and the
    // call reports success.
    const broken = '{"sites":{"cloud-1":{"projects":{"A":"software","B":"software",}}}}';
    const env = home(broken);
    const { error } = rememberJiraProject({ cloudId: 'cloud-9', key: 'NEW', type: 'software' }, env);
    expect(error).toBeDefined();
    expect(error!.message).toContain('not valid JSON');
    expect(readFileSync(jiraProjectsPath(env), 'utf8')).toBe(broken);
  });

  test('a file of the wrong SHAPE is refused too', () => {
    for (const text of ['[]', '"a string"', '42', '{"sites": []}']) {
      const env = home(text);
      expect(rememberJiraProject({ cloudId: 'c', key: 'NEW', type: 'software' }, env).error).toBeDefined();
      expect(readFileSync(jiraProjectsPath(env), 'utf8')).toBe(text);
    }
  });

  test('entries this module would REJECT on read still survive the write', () => {
    // Re-serialising only the kept entries would erase the typo'd line and its diagnostic.
    const env = home(
      JSON.stringify({ sites: { [DEV]: { projects: { SUPPORT: 'service_desk', OPS: 'servicedesk' } } } })
    );
    expect(rememberJiraProject({ cloudId: DEV, key: 'NEW', type: 'software' }, env).error).toBeUndefined();
    const raw = JSON.parse(readFileSync(jiraProjectsPath(env), 'utf8'));
    expect(raw.sites[DEV].projects).toEqual({
      SUPPORT: 'service_desk',
      OPS: 'servicedesk',
      NEW: 'software',
    });
  });

  test('and so do keys this module knows nothing about', () => {
    const env = home(JSON.stringify({ note: 'hand-written', sites: { [DEV]: { projects: {} } } }));
    rememberJiraProject({ cloudId: DEV, key: 'NEW', type: 'software' }, env);
    expect(JSON.parse(readFileSync(jiraProjectsPath(env), 'utf8')).note).toBe('hand-written');
  });

  test('the site key is NORMALISED, so the answer can be read back', () => {
    // Stored raw, a URL-spelled `cloudId` goes where `jiraSiteFor` never looks: "ask once" becomes
    // "ask every time".
    const env = home();
    rememberJiraProject({ cloudId: 'https://acme.atlassian.net/', key: 'SUP', type: 'service_desk' }, env);
    expect(Object.keys(loadJiraProjects(env).sites)).toEqual(['acme.atlassian.net']);
  });

  test('a site the READER can find by host is merged into, not shadowed by a second row', () => {
    // Every reader goes through `jiraSiteFor`, which also matches on `host`, so the writer must too.
    // Against a file keyed by UUID, a payload spelling `cloudId` as the site URL (the tool's schema
    // accepts both) would otherwise land in a second row no read reaches.
    const env = home(
      JSON.stringify({
        sites: { [DEV]: { host: 'acme.atlassian.net', projects: { KAN: 'software' } } },
      })
    );
    const { error } = rememberJiraProject(
      { cloudId: 'https://acme.atlassian.net', key: 'SUPPORT', type: 'service_desk' },
      env
    );
    expect(error).toBeUndefined();
    // One row: an existing spelling is reused.
    const raw = JSON.parse(readFileSync(jiraProjectsPath(env), 'utf8'));
    expect(Object.keys(raw.sites)).toEqual([DEV]);
    // And the answer is read back through the lookup the profile uses.
    const found = jiraSiteFor('https://acme.atlassian.net', loadJiraProjects(env).sites);
    expect(found?.projects).toEqual({ KAN: 'software', SUPPORT: 'service_desk' });
  });

  test('and provenance still outranks a click that arrives under the other spelling', () => {
    // Missing the row, the click would never meet the `jira` mark it must lose to.
    const env = home(
      JSON.stringify({
        sites: {
          [DEV]: {
            host: 'acme.atlassian.net',
            projects: { SUPPORT: 'service_desk' },
            sources: { SUPPORT: 'jira' },
          },
        },
      })
    );
    const { kept } = rememberJiraProject(
      { cloudId: 'https://acme.atlassian.net', key: 'SUPPORT', type: 'software' },
      env
    );
    expect(kept).toEqual({ type: 'service_desk', source: 'jira' });
    expect(jiraSiteFor(DEV, loadJiraProjects(env).sites)?.projects.SUPPORT).toBe('service_desk');
  });

  test('a site the payload cannot name is refused rather than filed under nothing', () => {
    expect(rememberJiraProject({ cloudId: '   ', key: 'SUP', type: 'software' }, home()).error).toBeDefined();
  });
});

/**
 * The generator's merge: a measurement replaces what it measured, and nothing else. It lives here
 * because `tools/jira-projects/generate.mjs` cannot be tested.
 */
describe('withJiraSite', () => {
  const HOST = 'acme.atlassian.net';
  const measure = (root: Record<string, unknown>, projects: Record<string, JiraProjectType>) =>
    withJiraSite(root, { cloudId: DEV, host: HOST, projects });

  const classified = (projects: Record<string, string>, sources: Record<string, string>) => ({
    sites: { [DEV]: { host: HOST, projects, sources } },
  });

  test('a project the search did not COVER keeps its classification, and is named', () => {
    // A reviewer classifies LEGACY, the project is archived (`/rest/api/3/project/search` excludes
    // those by default), and a re-run of `jira:projects` must not drop it: the search did not
    // measure it.
    const out = measure(
      classified(
        { SUPPORT: 'service_desk', LEGACY: 'service_desk' },
        { SUPPORT: 'jira', LEGACY: 'reviewer' }
      ),
      { SUPPORT: 'service_desk', KAN: 'software' }
    );
    const site = (out.root.sites as Record<string, JiraSite>)[DEV]!;
    expect(site.projects).toEqual({
      LEGACY: 'service_desk',
      SUPPORT: 'service_desk',
      KAN: 'software',
    });
    expect(site.sources).toEqual({ LEGACY: 'reviewer', SUPPORT: 'jira', KAN: 'jira' });
    // Named, not carried in silence.
    expect(out.carried).toEqual(['LEGACY']);
    expect(out.replaced).toBe(true);
  });

  test('and a project it DID cover is replaced, mark and all -- the correction path', () => {
    // The control: this tool with a real token is how a reviewer's mis-click gets corrected.
    const out = measure(classified({ SUPPORT: 'service_desk' }, { SUPPORT: 'reviewer' }), {
      SUPPORT: 'software',
    });
    const site = (out.root.sites as Record<string, JiraSite>)[DEV]!;
    expect(site.projects.SUPPORT).toBe('software');
    expect(site.sources?.SUPPORT).toBe('jira');
    expect(out.carried).toEqual([]);
  });

  test('a reviewer answer filed under the site URL is UPDATED, not shadowed by a second row', () => {
    // The generator keys by the UUID; a click can arrive with `cloudId` spelled as the site URL.
    // As in `withJiraProject`: find the row the reader finds.
    const out = measure(
      { sites: { [HOST]: { projects: { LEGACY: 'service_desk' }, sources: { LEGACY: 'reviewer' } } } },
      { KAN: 'software' }
    );
    // One row, keyed by the cloud id, which only this tool knows.
    expect(Object.keys(out.root.sites as object)).toEqual([DEV]);
    const site = (out.root.sites as Record<string, JiraSite>)[DEV]!;
    expect(site.projects).toEqual({ LEGACY: 'service_desk', KAN: 'software' });
    expect(site.host).toBe(HOST);
    expect(out.carried).toEqual(['LEGACY']);
  });

  test('and a file that ALREADY holds two rows for one site is consolidated', () => {
    // What a writer that misses the reader's row leaves behind. This tool knows the site's real
    // identity, so it merges rather than picks a winner.
    const out = measure(
      {
        sites: {
          [HOST]: { projects: { LEGACY: 'service_desk' }, sources: { LEGACY: 'reviewer' } },
          [DEV]: { host: HOST, projects: { OLD: 'software' }, sources: { OLD: 'jira' } },
        },
      },
      { KAN: 'software' }
    );
    expect(Object.keys(out.root.sites as object)).toEqual([DEV]);
    const site = (out.root.sites as Record<string, JiraSite>)[DEV]!;
    expect(site.projects).toEqual({ LEGACY: 'service_desk', OLD: 'software', KAN: 'software' });
    expect(site.sources).toEqual({ LEGACY: 'reviewer', OLD: 'jira', KAN: 'jira' });
    expect(out.carried).toEqual(['LEGACY', 'OLD']);
  });

  test('other sites and unknown keys are untouched, at both levels', () => {
    const out = measure(
      {
        note: 'hand-written',
        sites: {
          prod: { host: 'acme-prod.atlassian.net', projects: { SUPPORT: 'software' } },
          [DEV]: { host: HOST, projects: {}, comment: 'mine' },
        },
      },
      { KAN: 'software' }
    );
    expect(out.root.note).toBe('hand-written');
    const sites = out.root.sites as Record<string, Record<string, unknown>>;
    expect(sites.prod).toEqual({ host: 'acme-prod.atlassian.net', projects: { SUPPORT: 'software' } });
    expect(sites[DEV]!.comment).toBe('mine');
  });

  test('a first run on an empty file simply adds the site', () => {
    const out = measure({}, { SUPPORT: 'service_desk' });
    expect(out.replaced).toBe(false);
    expect(out.carried).toEqual([]);
    expect((out.root.sites as Record<string, JiraSite>)[DEV]?.projects).toEqual({
      SUPPORT: 'service_desk',
    });
  });
});

/**
 * Provenance: what makes "never overwrite" a rule rather than a blanket refusal. Without a mark,
 * every overwrite must be refused and a mis-click is permanent until the generator runs with an API
 * token. The three lines of the rule are one test each.
 */
describe('a remembered answer can be corrected, a measured one cannot', () => {
  const remember = (env: NodeJS.ProcessEnv, key: string, type: 'service_desk' | 'software') =>
    rememberJiraProject({ cloudId: DEV, key, type }, env);

  test('a recollection MAY replace a recollection -- a second click fixes a mis-click', () => {
    // No API token anywhere in this test.
    const env = home();
    remember(env, 'SUPPORT', 'software'); // the mis-click
    const { error, kept } = remember(env, 'SUPPORT', 'service_desk'); // noticing, and fixing it
    expect(error).toBeUndefined();
    expect(kept).toBeUndefined();
    expect(loadJiraProjects(env).sites[DEV]?.projects.SUPPORT).toBe('service_desk');
  });

  test('a recollection NEVER replaces a measurement', () => {
    const env = home(
      JSON.stringify({
        sites: { [DEV]: { projects: { SUPPORT: 'service_desk' }, sources: { SUPPORT: 'jira' } } },
      })
    );
    const { kept } = remember(env, 'SUPPORT', 'software');
    expect(kept).toEqual({ type: 'service_desk', source: 'jira' });
    expect(loadJiraProjects(env).sites[DEV]?.projects.SUPPORT).toBe('service_desk');
  });

  test('an answer records where it came from', () => {
    const env = home();
    remember(env, 'SUPPORT', 'service_desk');
    expect(loadJiraProjects(env).sites[DEV]?.sources).toEqual({ SUPPORT: 'reviewer' });
  });

  test('a source for a project that is not declared is harmless', () => {
    const env = home(
      JSON.stringify({ sites: { [DEV]: { projects: {}, sources: { GONE: 'reviewer' } } } })
    );
    expect(loadJiraProjects(env).sites[DEV]?.sources).toEqual({ GONE: 'reviewer' });
    expect(remember(env, 'SUPPORT', 'service_desk').error).toBeUndefined();
  });

  test('a nonsense source is dropped without taking the classification with it', () => {
    // A bad label on a good fact; dropping the fact would turn a declared service desk unknown.
    const env = home(
      JSON.stringify({
        sites: { [DEV]: { projects: { SUPPORT: 'service_desk' }, sources: { SUPPORT: 'guess' } } },
      })
    );
    const site_ = loadJiraProjects(env).sites[DEV];
    expect(site_?.projects.SUPPORT).toBe('service_desk');
    expect(site_?.sources).toBeUndefined();
    // And with no usable label it is unmarked, so a click still cannot replace it.
    expect(remember(env, 'SUPPORT', 'software').kept?.source).toBe('unmarked');
  });

  test('sources are keyed the same way projects are', () => {
    const env = home(
      JSON.stringify({
        sites: { [DEV]: { projects: { support: 'service_desk' }, sources: { support: 'jira' } } },
      })
    );
    expect(loadJiraProjects(env).sites[DEV]?.sources).toEqual({ SUPPORT: 'jira' });
    expect(remember(env, 'SUPPORT', 'software').kept?.source).toBe('jira');
  });
});
