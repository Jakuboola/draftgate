#!/usr/bin/env bun
/**
 * A stand-in for the review window, driven by `DRAFTGATE_TEST_MODE`: a real child process through a
 * real spawn, reading the real request file and writing the real decision file. Not the window
 * itself (no WebKit, TipTap or CSP): `surface/harness/probe.ts` verifies those against the host.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { surfaceLayout } from '../../src/surfaces/bundleStamp';
// The version the CLI will accept, never a literal: a stale one fails every fixture as 'unavailable'.
import { PROTOCOL_VERSION } from '../../src/surfaces/windowProtocol';

const mode = process.env.DRAFTGATE_TEST_MODE ?? 'approve-unedited';
const requestPath = process.env.DRAFTGATE_REQUEST!;
const decisionPath = process.env.DRAFTGATE_DECISION!;

const write = (obj: unknown) => writeFileSync(decisionPath, JSON.stringify(obj));

/** When a surviving child writes its marker; `windowSurface.test.ts` sets it and says why. */
const MARKER_DELAY_MS = Number(process.env.DRAFTGATE_TEST_MARKER_MS);

/** Say the child is ready (its handlers installed), then write the marker if it is still alive. */
function armMarker(text: string) {
  const marker = process.env.DRAFTGATE_TEST_MARKER;
  if (!marker) return;
  writeFileSync(`${marker}.ready`, '');
  setTimeout(() => writeFileSync(marker, text), MARKER_DELAY_MS);
}

switch (mode) {
  case 'approve-unedited':
    // No `fields`. This is the shape that makes the CLI send what the agent wrote.
    write({ protocol: PROTOCOL_VERSION, action: 'approve' });
    break;

  case 'approve-edited':
    // Keyed by PATH: the body is the entry for the field the route reviews, not a `body` string
    // beside "the other ones".
    write({
      protocol: PROTOCOL_VERSION,
      action: 'approve',
      fields: { commentBody: 'Edited by the reviewer.' },
    });
    break;

  // Approve only if the bundle beside it is whole when the window starts: the built page and the
  // stamp, written last. The concurrent-rebuild test's witness that no review opened a build in
  // progress.
  case 'approve-if-built': {
    const layout = surfaceLayout('/unused', process.env.DRAFTGATE_TEST_DIST!);
    let whole = false;
    try {
      whole =
        existsSync(layout.builtRenderer) &&
        typeof JSON.parse(readFileSync(layout.stampFile, 'utf8')).stamp === 'string';
    } catch {
      // Not whole.
    }
    write(
      whole
        ? { protocol: PROTOCOL_VERSION, action: 'approve' }
        : { protocol: PROTOCOL_VERSION, action: 'reject', reason: 'the bundle was not whole' }
    );
    break;
  }

  case 'reject':
    write({ protocol: PROTOCOL_VERSION, action: 'reject', reason: 'wrong ticket' });
    break;

  case 'reject-no-reason':
    write({ protocol: PROTOCOL_VERSION, action: 'reject' });
    break;

  // A reviewer who picked a theme and then decided, either way.
  case 'approve-choosing-dark':
    write({ protocol: PROTOCOL_VERSION, action: 'approve', theme: 'dark' });
    break;

  case 'reject-choosing-light':
    write({ protocol: PROTOCOL_VERSION, action: 'reject', reason: 'no', theme: 'light' });
    break;

  // Echo the request back so a test can assert what the window was actually handed.
  case 'echo-request':
    write({ protocol: PROTOCOL_VERSION, action: 'reject', reason: readFileSync(requestPath, 'utf8') });
    break;

  // The human closed the window. Nothing written, clean exit.
  case 'close-without-decision':
    break;

  case 'crash':
    process.stderr.write('a renderer noise line\nsomething went badly wrong\n');
    process.exit(3);

  // A built window older or newer than this CLI.
  case 'bad-protocol':
    write({ protocol: 99, action: 'approve', body: 'should never be sent' });
    break;

  case 'garbage':
    writeFileSync(decisionPath, '{not json at all');
    break;

  // An approval whose body is the wrong type. Must not be read as an unedited approval either.
  case 'malformed-approve':
    write({ protocol: PROTOCOL_VERSION, action: 'approve', fields: { commentBody: { not: 'a string' } } });
    break;


  // Outlive the timeout, and leave a marker if never killed, at a path the test owns: the surface
  // deletes its own temp directory on the way out.
  case 'hang':
    armMarker('still running');
    break;

  // Outlive the timeout and refuse SIGTERM, so only SIGKILL stops it: the only mode that tells a
  // SIGKILL at the deadline from a SIGTERM, or from a kill parked on a timer that never runs because
  // `main.ts` exits once the outcome is known. Every other mode dies on the first signal.
  case 'hang-ignoring-sigterm':
    process.on('SIGTERM', () => {});
    process.on('SIGINT', () => {});
    armMarker('survived SIGTERM');
    break;

  default:
    process.stderr.write(`fakeSurfaceApp: unknown mode ${mode}\n`);
    process.exit(1);
}
