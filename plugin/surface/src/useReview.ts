/**
 * The review's state: load the request, hold the document, keep the warnings honest.
 *
 * ## The window judges and sends the body the reviewer READ
 *
 * This is the one place it is explained in full; elsewhere points here. Loading a draft into the
 * editor normalises it (a bare URL comes back as `[url](url)`, media follows the destination's
 * placement), so every review has two candidate bodies: the agent's `canonical` and what the editor
 * holds. The reviewer reads only the second, so that is the body this window judges and sends,
 * edited or not; `blocked` and Approve come from it too. Sending `canonical` for an unedited
 * approval would give one draft two outgoing bodies and make a warning appear and vanish as they
 * edit and undo.
 *
 * Outside the cases `silenced` reports, the round trip keeps what a destination renders. Slack and
 * Linear follow the destination's media placement (`rendersMedia` / `mediaPlacement`). Jira is
 * probed: for an inline image the ADF is byte-identical either way, and for a bare URL the only delta
 * in the torture fixture is one duplicated link mark, which Jira accepts (201) and normalises away,
 * the stored bodies reading back identical. `silenced` is what makes the rest safe.
 *
 * `edited` means a human changed something. The body cannot answer it (an untouched review may
 * differ from `canonical`), so it travels as its own wire field, and the audit log and `draftgate
 * digest` are built on it. It is true only against `baseline`, what the editor produces from an
 * untouched draft, which also gets undo right.
 *
 * The render is recomputed here on every keystroke (`core` is pure, so it equals the CLI's for the
 * same input): showing the pre-edit warnings after an edit is how a reviewer introduces a Jira-fatal
 * blockquote heading and approves.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  render,
  renderPlain,
  renderNoBody,
  baselineFor,
  blockFieldOf,
  editorDocFor,
  markdownFor,
  reviewFieldsComplaint,
  type PmNode,
  type RenderResult,
  type Warning,
} from '../../core/src/index';
// `contract.json`, not `cli/src/surfaces/windowProtocol` (`App.tsx` says why): resolved at build
// time, this number is baked into the bundle, so a stale bundle can notice it is one.
import contract from '../contract.json';
import { bridge, type AppliedFix, type WireRequest } from './bridge';
import { REMEDY } from '../../core/src/remedies';

/**
 * What the round trip changed, as warnings the reviewer would otherwise never see: the codes true of
 * the agent's `canonical` and not of the body being sent. The window changes a message without being
 * asked, so it must not do so invisibly.
 *
 * Not all of these are repairs. Four of the codes in `WARNING_CODES`' `silencedByRoundTrip` column
 * (`surface/silencedWarnings.test.ts` derives the set, so it cannot drift):
 *
 *   `slack/image-becomes-link`      `![x](u)` was rewritten to `[x](u)`  -- reader sees the SAME
 *   `slack/url-swallows-next-line`  the URL became an explicit link      -- reader sees BETTER
 *   `slack/url-label-elided`        the bare URL became an explicit link -- reader sees BETTER
 *   `jira/task-item-media-only`     a checkbox was destroyed             -- reader sees WORSE
 *
 * The last: `- [ ] ![i](u)\n- [ ] a normal item` arrives as two checkboxes and is sent as one plus a
 * loose image, because `hoistMedia` bubbles media out of a task item and an item holding only media
 * has nothing left. Its warning fires on `canonical` only, so without this row the draft would go
 * out with a checkbox gone and nothing on screen or in the log.
 *
 * It does not classify these as fixed or lost: nothing in a `Warning` tells them apart. It states
 * what is certainly true and leaves each warning's message to say what it means.
 *
 * Applied twice, both required:
 *  1. At load, against the render of the body shown. The result is a fact about a fixed pair of
 *     bodies, stored as `silencedAtLoad`.
 *  2. On every render, against the live warnings with that stored set as candidates, which drops a
 *     code the reviewer's own editing brings back.
 *
 * Only the second, with `canonical`'s warnings as candidates, would book the reviewer's repairs to
 * draftgate: a Slack heading ladder survives the round trip, so flatten it by hand and `canonical`
 * minus live reports it. The screen would say draftgate rewrote the draft at load, and the digest
 * would print it under a column whose note reads "the reviewer was NOT shown the warning"
 * (`audit.ts`'s documented corruption in mirror image). Only the first would keep asserting a
 * difference the reviewer has since undone.
 */
export function silencedWarnings(candidates: Warning[], current: Warning[]): Warning[] {
  const live = new Set(current.map((w) => w.code));
  const seen = new Set<string>();
  // By code, deduped: two firings of one rule are one thing to tell the reviewer (in
  // `AuditRecord.warnings` the count is the signal). Order is `allWarnings`' severity ranking.
  return candidates.filter((w) => !live.has(w.code) && !seen.has(w.code) && seen.add(w.code));
}

export interface Loaded {
  status: 'ready';
  request: WireRequest;
  /**
   * The document the editor holds, replaced only by the one-click fix. Absent for a plain body: a
   * plain field stores text verbatim (`**bold**` stays nine characters, which `baselineFor` would
   * make bold), so the window shows a textarea and there is no document. See `renderPlain`.
   */
  doc?: PmNode;
  /**
   * Render of the body that will be sent, which is the body on screen. `current.canonical` is that
   * body (`render()` returns its input verbatim), so there is no separate `body` field to keep in
   * step.
   *
   * **What `render()` judged is what `approve()` sends.** At load and on every keystroke that body
   * is `markdownFor(doc)`; the one exception is right after `applyFix` (see there).
   *
   * `current.suggestedFix` and `current.previewFidelity` come from the profile, so this hook never
   * tests the destination.
   */
  current: RenderResult;
  /**
   * Whether the human changed anything. Not derivable from `current.canonical` against the body as
   * it arrived, in either direction (an edit can re-serialise to the original bytes, and an
   * untouched review may send different ones), so it is sent as its own field. Only a comparison
   * against `baseline` answers what the audit log asks.
   */
  edited: boolean;
  /**
   * What the round trip silenced: true of the agent's `canonical`, not of the body first shown.
   * Computed once at load and stored, because it is a fact about a fixed pair of bodies; `canonical`
   * minus the live warnings would also count the reviewer's own repairs as draftgate's. It is the
   * candidate set: `App.tsx` runs it through `silencedWarnings` against the live warnings.
   */
  silencedAtLoad: Warning[];
  /**
   * What the editor produces from an untouched draft: the first body shown, what an unedited
   * approval sends, and the yardstick for `edited`. Its own field although it equals
   * `current.canonical` at load, because `current` moves with every keystroke and this must not.
   */
  baseline: string;
  /**
   * Which offered repairs the reviewer has accepted, in order, for the audit log. Accumulated, not
   * derived: after `applyFix` nothing in the text says whether it was clicked or typed, and an
   * accepted repair is a mechanical lesson where a hand edit is a prose lesson. Never reset, even
   * when a later hand edit undoes the repair: it records what the reviewer did.
   */
  fixes: AppliedFix[];
}

export type ReviewState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | Loaded;

/**
 * A `Loaded` from the parts that differ. `status`, `request`, `edited: false` and `fixes: []` are
 * the same for every review that loads, and every branch commits through here, so a field added to
 * `Loaded` cannot be missing from the body-less branch.
 */
function ready(
  request: WireRequest,
  parts: Pick<Loaded, 'current' | 'baseline'> & Partial<Pick<Loaded, 'doc' | 'silencedAtLoad'>>
): Loaded {
  return { status: 'ready', request, edited: false, fixes: [], silencedAtLoad: [], ...parts };
}

export function useReview() {
  const [state, setState] = useState<ReviewState>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const request = await bridge().request();
        if (!live) return;
        if (!request) throw new Error('the window host returned no review to show');
        /*
         * The bundle's protocol against the request's: the only version check that can see a stale
         * `surface/dist/`. The window process reads `contract.json` at runtime, as does the CLI, so
         * its own check always compares current numbers. A bundle built for an older protocol still
         * renders and can send back a shape that has since changed, which is dropped without a word:
         * an audience answer sent as a bare string, where `sanitiseClassification` accepts only the
         * object, changes the banner and then `sanitiseDecision` drops it (the failure
         * `classificationStores.ts` names in its header). A throw, because it lands in the
         * fail-closed `status: 'failed'` path: `Fatal`, no Approve button.
         */
        if (request.protocol !== contract.protocolVersion) {
          throw new Error(
            `this review window speaks protocol ${contract.protocolVersion} and the request is ` +
              `protocol ${request.protocol}. The built window is stale: run ` +
              `${REMEDY.rebuildWindow}.`
          );
        }

        /*
         * Two renders; only the second is the verdict. The first judges the agent's draft, and the
         * difference between the two warning sets is `silencedAtLoad`.
         *
         * `editorDocFor` and `markdownFor`, not `toEditorDoc` and `fromEditorDoc`: the document
         * depends on two profile facts (whether a `mention:` link becomes a chip, whether media is
         * hoisted), and serialising without the profile hoists an inline image straight back out.
         * See `core/src/editor.ts`.
         */
        /*
         * The list, checked where it is accepted: this process receives it across a process boundary
         * from a CLI that may be another version, and a rule enforced only where it cannot be broken
         * is the `PROTOCOL_VERSION` shape. A two-block list would show the first and send the second
         * unreviewed. A throw becomes `status: 'failed'` (`Fatal`, Reject only).
         */
        const complaint = reviewFieldsComplaint(request.fields);
        if (complaint !== null) throw new Error(complaint);
        /*
         * The block field: the one this window's editor, warnings and repairs are about.
         * `request.fields` carries markdown-or-text per field, because whether a field stores
         * markdown is a fact about the tool and this renderer has no tool map.
         *
         * A list with no block is a real review: the route names a body field and the payload has
         * none (a title-only `issue_write`, a `create_pull_request` with no description). There is
         * no document, baseline or silenced code. `renderNoBody` gives `blocked: false`, no warnings
         * and `format: 'absent'`, which stops a body being written back. Not `render('')`: an empty
         * body is a reviewer deleting the message, which `body/empty` blocks, leaving a dead Approve
         * on a title they have no objection to.
         */
        const block = blockFieldOf(request.fields);
        if (block === undefined) {
          setState(ready(request, { current: renderNoBody(request.destination), baseline: '' }));
          return;
        }
        // A plain body is its own baseline: no parse, no round trip, so `silencedAtLoad` is empty.
        const plain = block.kind === 'text';
        // `doc` is the document on screen, never one the reviewer built: see the verdict below.
        const renderFor = (body: string, doc?: PmNode) =>
          plain ? renderPlain(body, request.destination) : render(body, request.destination, doc, false);
        const parsed = renderFor(block.value);
        // Both legs of the round trip, from `core`'s own pairing (the body an unedited approval
        // sends is this composition, so it has one spelling).
        const { doc, body: shown } = plain
          ? { doc: undefined, body: block.value }
          : baselineFor(parsed);
        /*
         * The verdict, on the body on screen and sent. `built: false`, measured: `lostInMarkdown`
         * asks whether markdown can carry what the editor holds, a question about something the
         * reviewer built, and on load they built nothing (`doc` is a parse of the body being
         * judged). Passing it anyway blocks drafts on parse artifacts: over an 18,000-pair fuzz
         * (6,000 shapes x 3 destinations) it blocked 22 sendable Jira drafts, each a
         * whitespace-only paragraph in a blockquote, against 0 with it left off. The document is
         * still passed for `body/text-changed`, which asks whether the text on screen comes back as
         * text (a `\# of tickets` the agent escaped must not go out as a heading) and ignores
         * whitespace.
         */
        const current = renderFor(shown, doc);
        setState(
          ready(request, {
            ...(doc === undefined ? {} : { doc }),
            current,
            // The round trip's own work, fixed here: `canonical`'s codes minus the shown body's.
            // See `silencedWarnings` for why it is not re-derived per render.
            silencedAtLoad: silencedWarnings(parsed.warnings, current.warnings),
            baseline: shown,
          })
        );
      } catch (e) {
        if (live) setState({ status: 'failed', message: (e as Error).message });
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  /**
   * Called on every keystroke in a plain body's textarea. Its own callback because it is handed the
   * text, not a ProseMirror document. `edited` is a plain comparison with the baseline: a plain
   * body has no accepted repairs to make it sticky (`renderPlain` produces no `suggestedFix`).
   */
  const onPlainChange = useCallback((text: string) => {
    setState((prev) => {
      if (prev.status !== 'ready') return prev;
      return {
        ...prev,
        current: renderPlain(text, prev.request.destination),
        edited: text !== prev.baseline,
      };
    });
  }, []);

  /** Called on every editor change. */
  const onChange = useCallback((doc: PmNode) => {
    setState((prev) => {
      if (prev.status !== 'ready') return prev;
      const next = markdownFor(prev.current, doc);
      /*
       * An applied repair makes the draft edited for good, whatever it serialises to. The baseline
       * comparison alone fails in one case: a bare URL ending a line is normalised to `[url](url)`
       * on load, so the repair leaves the document equal to `baseline` and the next keystroke would
       * record an accepted repair as an untouched review. Keyed on `fixes`, which is never reset
       * (`applyFix` has one call site and `pendingFix.applied` is required), and there is no way
       * back: `applyFix` remounts the editor and discards undo history. It does not decide which
       * body is sent, only what the audit log is told.
       */
      const edited = next !== prev.baseline || prev.fixes.length > 0;
      // The body is the editor's, always. The document is always passed, and `edited` says whether
      // the reviewer built it: on an edit `render` checks that markdown can carry what the editor
      // holds (its schema is wider than markdown's grammar; a quote inside a checklist item has no
      // spelling and `fromEditorDoc` writes the closest thing silently). See `lostInMarkdown`.
      // Unedited, only `body/text-changed` is asked, as at load.
      return {
        ...prev,
        edited,
        current: render(next, prev.request.destination, doc, edited),
      };
    });
  }, []);

  /**
   * Apply a repair the reviewer accepted and remount the editor (discarding undo history). `body`
   * is the repaired markdown and `applied` is how the audit log names it; both are required, since
   * there is one call site (`App.tsx`) and `onChange`'s stickiness relies on it: an optional
   * `applied` would log an accepted fix nothing can group. A blocked draft's whole-document repair
   * and a single warning's `fix.body` come through here alike, and `render()` re-derives the
   * remaining warnings. Always an edit.
   *
   * The one place `current.canonical` is not the editor's own serialisation: the repair body is
   * sent verbatim. Measured: of the 9 repairs the repo's fixtures offer, 6 are not fixed points of
   * the editor. `slack/url-swallows-next-line`'s "Add a blank line after it" exists to keep the URL
   * bare, and re-serialising would rewrite it to `[url](url)`, swapping the reviewer's choice for
   * the other button in the log (the two render identically in Slack). The reviewer confirmed this
   * exact body in the before/after diff; the next keystroke re-serialises as usual.
   */
  const applyFix = useCallback((body: string, applied: AppliedFix) => {
    setState((prev) => {
      if (prev.status !== 'ready') return prev;
      return {
        ...prev,
        doc: editorDocFor(prev.current, body),
        edited: true,
        current: render(body, prev.request.destination),
        fixes: [...prev.fixes, applied],
      };
    });
  }, []);

  return { state, onChange, onPlainChange, applyFix };
}
