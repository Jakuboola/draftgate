/**
 * The demo's review request, produced by the gate itself rather than written by hand.
 *
 * `runReview` gets the tool call an agent would make and a surface that records the request instead
 * of opening a window; `toWireRequest` projects it exactly as the window surface does. The
 * composition loads the result as the bridge's answer, so what the video shows is what the real
 * window would be handed for this call. Writes `dist/request.json` and `dist/frame.json` (the
 * window's size and title on a 1920x1080 display); writes nothing else, the review log included.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runReview } from '../../cli/src/review';
import { toWireRequest } from '../../cli/src/surfaces/window';
import type { WireRequest } from '../../cli/src/surfaces/windowProtocol';
import { DEFAULT_TOOL_MAP, resolveRoute } from '../../adapters/hook/src/toolMap';

const TOOL = 'mcp__claude_ai_Slack__slack_send_message';

/** Made-up data only: an invented channel id and an invented incident. One copy, which the
 * recording reads too (`record/record.sh`). */
const TOOL_INPUT = JSON.parse(readFileSync(join(import.meta.dir, 'draft.json'), 'utf8')).tool_input as Record<string, unknown>;

/** The display the frame stands for, menu bar excluded as macOS reports `visibleFrame`. */
const WORK_AREA = { x: 0, y: 25, width: 1920, height: 1055 };

const resolved = resolveRoute(TOOL, DEFAULT_TOOL_MAP);
if (!resolved) throw new Error(`${TOOL} is not in the default tool map`);

let wire: WireRequest | undefined;
await runReview({
  ...resolved.route,
  toolInput: TOOL_INPUT,
  toolName: TOOL,
  surface: {
    human: false,
    review: async (request) => {
      wire = toWireRequest(request);
      return { action: 'reject', reason: 'recorded for the demo' };
    },
  },
});
if (!wire) throw new Error('the review ended before it reached a surface');

const require = createRequire(import.meta.url);
const { reviewWindowBounds } = require('../../surface/geometry.cjs');
const { windowTitle } = require('../../surface/windowTitle.cjs');
const bounds = reviewWindowBounds(WORK_AREA);

const out = join(import.meta.dir, 'dist');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'request.json'), `${JSON.stringify(wire, null, 2)}\n`);
writeFileSync(
  join(out, 'frame.json'),
  `${JSON.stringify({ width: bounds.width, height: bounds.height, title: windowTitle(wire.destination, TOOL) }, null, 2)}\n`
);
process.stderr.write(`demo-video: wrote ${out}/request.json and frame.json (${bounds.width}x${bounds.height})\n`);
