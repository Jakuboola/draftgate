/**
 * The review window's chrome: what is being sent, where, what the destination will do to it, and
 * the two buttons that decide.
 *
 * Every failure path here ends in a rejection, never in an approval. A reviewer who cannot see the
 * draft must not be able to approve it, so a document the editor refuses to load leaves Reject as
 * the only button. Closing the window is also a rejection -- the CLI reads an absent decision file
 * that way -- so there is no state in which shutting this down sends the message.
 */

import { Component, Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type {
  Audience, DestinationName, EditFieldValue, FixOffer, PmNode, RenderResult, ReviewFieldValue,
  TargetAnswer,
  Warning,
} from '../../core/src/index';
import {
  audienceFor, blockFieldOf, fieldWarnings, hasBlockingWarning, hideLineBreaks, isBlockField,
  showLineBreaks, sortWarnings,
} from '../../core/src/index';
import { contextLabels } from './contextLabels';
// `contract.json`, not `cli/src/surfaces/windowProtocol`: a first VALUE import of a `cli` module
// would break the policy in `cli/src/text.ts`. The protocol module reads the number from the same
// file.
import contract from '../contract.json';
import { bridge, type AppliedFix } from './bridge';
import { isThemeChoice, resolveTheme, type ThemeChoice } from '../../core/src/index';
import { ThemeToggle } from './ThemeToggle';
import { DestinationMark } from './DestinationMark';
import { Editor } from './Editor';
import { EditorBoundary } from './EditorBoundary';
import { FixDiff } from './FixDiff';
import { PatchEdits } from './PatchEdits';
import { useReview, silencedWarnings, type Loaded } from './useReview';
import { useSettledWarnings } from './settledWarnings';
import { useShortcutArmed } from './shortcutGrace';
import { DRAFT_KEY, focusDraft, isDraftKey, nothingFocused } from './draftKey';
import { mentionNote, mentionSummary } from '../../core/src/index';

/**
 * Set (or, for `undefined`, remove) `data-*` attributes on the root, and touch the root on the NEXT
 * frame so WebKit restyles what it had drawn. Each attribute gets a `--dg-restyle-<name>` marker,
 * and the harness's `isRendered` waits for one per attribute it finds.
 *
 * WebKit only (22625, macOS 27), pinned by `surface:host`'s "the first destination and audience
 * restyle what was already drawn": without it the FIRST `data-destination` and `data-audience`
 * leave `.dg-shell`, `.dg-body` and `.dg-compose` on the custom properties from before (Jira's
 * compose frame draws the shell's neutral grey, GitHub's radius is 4px, JSM's internal note has no
 * yellow). A layout effect or an inline custom property in the same task does not help; any root
 * change after the first style pass does.
 */
function setRootData(root: HTMLElement, data: Record<string, string | undefined>): () => void {
  for (const [name, value] of Object.entries(data)) {
    if (value === undefined) delete root.dataset[name];
    else root.dataset[name] = value;
  }
  const frame = requestAnimationFrame(() => {
    for (const [name, value] of Object.entries(data)) {
      if (value !== undefined) root.style.setProperty(`--dg-restyle-${name}`, value);
    }
  });
  return () => cancelAnimationFrame(frame);
}

export function App() {
  const { state, onChange, onPlainChange, applyFix } = useReview();

  /*
   * Narrow deps, not `[state]`: `state` is a new object per keystroke, so depending on it would
   * rebuild the `prefers-color-scheme` listener per character. The three values read cannot change
   * while a review is open.
   */
  const ready = state.status === 'ready' ? state : null;
  const destination = ready?.request.destination;
  const themes = ready?.current.themes;

  /*
   * The requested theme is STATE, seeded from the wire request. `'system'` is the default: a Jira
   * comment is read in many themes, so there is no single destination theme; following the OS shows
   * how the REVIEWER will see it and the switcher shows the rest. A click rides the decision as
   * `theme` and the next request carries it back as `rememberedTheme`, since the host's
   * `draftgate://` storage keeps nothing between reviews.
   *
   * DERIVED, not stored then corrected. Precedence: this session's click, an explicit wire theme,
   * the remembered one, then `system`. Seeding state from the stored theme and overwriting it on
   * arrival paints the wrong theme for a frame and presents a wire-forced theme as the reviewer's.
   */
  const [clicked, setClicked] = useState<ThemeChoice | null>(null);
  // Every source is checked: `request.cjs` checks only the request's SHAPE, and a value the
  // switcher has no face for would take the window down.
  const requestedTheme: ThemeChoice =
    [clicked, ready?.request.theme, ready?.request.rememberedTheme].find(isThemeChoice) ?? 'system';

  const chooseTheme = useCallback((next: ThemeChoice) => setClicked(next), []);

  useEffect(() => {
    if (!destination || !themes) return;
    const root = document.documentElement;

    /*
     * `data-theme` beside `data-destination` on the same element, so a destination sheet can scope
     * `[data-destination="jira"][data-theme="dark"]` and outrank its light rules; on a wrapper the
     * dark block would LOSE (the trap in `.claude/rules/styles.md`). `resolveTheme` intersects the
     * preference with `render.themes`, so a dark system on a light-only destination stays light.
     * Re-resolved on an OS change, since a review can sit open while macOS switches themes.
     */
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const resolved = () => resolveTheme(themes, query.matches ? 'dark' : 'light', requestedTheme);
    const cancel = setRootData(root, { destination, theme: resolved() });
    const apply = () => {
      root.dataset.theme = resolved();
    };
    query.addEventListener('change', apply);
    return () => {
      cancel();
      query.removeEventListener('change', apply);
    };
  }, [destination, themes, requestedTheme]);

  if (state.status === 'loading') return <div className="dg-centred">loading the draft…</div>;
  if (state.status === 'failed') {
    return (
      <Fatal
        title="This draft could not be loaded"
        detail={state.message}
        // No approve path: nothing was displayed, so nothing was reviewed.
        reason={`draftgate could not display the draft: ${state.message}`}
      />
    );
  }
  return (
    <Review
      state={state}
      onChange={onChange}
      onPlainChange={onPlainChange}
      applyFix={applyFix}
      themePref={requestedTheme}
      // A click in this window. The surface keeps only a choice that differs from the remembered
      // one (`keepTheme` in `cli/src/surfaces/window.ts`).
      themeChosen={clicked}
      onThemeChange={chooseTheme}
    />
  );
}

interface ReviewProps {
  state: Loaded;
  onChange(doc: PmNode): void;
  /** The same, for a PLAIN body: text rather than a document, because there is none. */
  onPlainChange(text: string): void;
  applyFix(body: string, applied: AppliedFix): void;
  /** The reviewer's theme choice, lifted to `App` because that is where it is applied to <html>. */
  themePref: ThemeChoice;
  /** The choice the decision carries for the CLI to keep, or null: a click made in this window. */
  themeChosen: ThemeChoice | null;
  onThemeChange(next: ThemeChoice): void;
}

function Review({ state, onChange, onPlainChange, applyFix, themePref, themeChosen, onThemeChange }: ReviewProps) {
  const { request, current: bodyReview, edited, doc, fixes } = state;
  /*
   * What the round trip CHANGED, and it is on screen for the reason `silencedWarnings` gives.
   * `silencedAtLoad` is the candidate set, fixed at load; this narrows it against the CURRENT body,
   * so an edit that brings a code back stops claiming it is not true. The candidates are not
   * `canonical`'s warnings: any code the human edited away would then be credited to draftgate.
   */
  const silenced = silencedWarnings(state.silencedAtLoad, bodyReview.warnings);
  /*
   * WHO this draft will notify, from the body being SENT. Recomputed per render, since the reviewer
   * can delete a mention. `current.canonical` is the live body; `state.doc` is frozen at load
   * (`useEditor`'s `[doc]` deps would remount on every keystroke), so counting from `doc` would
   * keep describing a deleted Jira mention. `countMentionChips` reads the body.
   */
  const mentions = mentionNote(
    mentionSummary(bodyReview.canonical, bodyReview.mentions),
    bodyReview.mentions
  );
  // Every field but the body. Memoised because it feeds a dependency array: unmemoised the `current`
  // memo below would never hit (a `fieldWarnings` pass and a `sortWarnings` per render).
  const shownTyped = useMemo(() => request.fields.filter((f) => !isBlockField(f)), [request.fields]);
  /*
   * Does this review have a DRAFT at all? A title-only `issue_write` or a `create_pull_request`
   * with no description has `fields` of lines and no block, and `useReview` hands back
   * `renderNoBody`. Read off the list the compose frame is driven by (`fieldGroups`), so the two
   * agree. Two consumers: the footer's promise and the note where the draft would be. Not
   * memoised: a boolean's identity feeds nothing.
   */
  const hasDraft = blockFieldOf(request.fields) !== undefined;
  // What each routing field is CALLED on screen: its own name where that is unambiguous, the full
  // path where it is not. See `contextLabels`.
  const labels = contextLabels(Object.keys(request.context));
  /*
   * Everything the agent wrote beside the body: a title or a summary (a line), a patch's edits
   * (`PatchEdits.tsx`). Plain strings with no `render()` or round trip, so ordinary React state, one
   * map keyed by path. Compared against the request to decide `typedEdited`, not tracked by a dirty
   * flag: typing a character and deleting it is not an edit.
   */
  const [typed, setTyped] = useState<Record<string, string>>(() =>
    Object.fromEntries(shownTyped.map((f) => [f.field, f.value]))
  );
  const typedEdited = shownTyped.some((f) => liveValue(typed, f) !== f.value);
  const setField = useCallback(
    (field: string, text: string) => setTyped((v) => ({ ...v, [field]: text })),
    []
  );
  const hasEdits = shownTyped.some((f) => f.kind === 'edit');
  /*
   * The review the rest of this component reads: the BODY's render plus what is wrong with the
   * fields beside it. `render()` is handed only the body, so it cannot see a blanked title or an
   * emptied insertion; `fieldWarnings` is the second producer and this is where the two join. Not inside `useReview`,
   * because `silenced` must read the raw render: a prose warning there would credit draftgate with
   * a field it never touched. It reads the LIVE `typed`, so it covers the reviewer emptying a title
   * as well as the agent sending one empty.
   */
  const current = useMemo(() => {
    const issues = fieldWarnings(
      shownTyped.map((f) => ({ ...f, value: liveValue(typed, f) })),
      request.destination,
      request.toolName
    );
    if (issues.length === 0) return bodyReview;
    return {
      ...bodyReview,
      warnings: sortWarnings([...bodyReview.warnings, ...issues]),
      // `blocked` disables Approve, so a gating rule sets it. A prose error is an error (probed 400
      // on Jira, and the whole call is lost); a prose WARNING (a title in a length bracket) is
      // asked, not assumed.
      blocked: bodyReview.blocked || hasBlockingWarning(issues),
    };
  }, [bodyReview, shownTyped, typed, request.destination, request.toolName]);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  /*
   * The warnings to DISPLAY: `current.warnings` minus any non-blocking one that has only just
   * arrived. A filter, so every row is a live object and its actions read `editorPath` and
   * `fix.body` straight off it, with no snapshot to go stale. `settledWarnings.ts` has the argument.
   */
  const shownWarnings = useSettledWarnings(current.warnings);
  /*
   * Is the warning list unfurled? FURLED by default: an overlay over the top of the draft on
   * arrival is worse than a click, since the first thing a reviewer does is read the message.
   * The row carries the most severe warning inline and the rest is one click away. Nothing opens it
   * but the reviewer; a warning arriving mid-edit updates the row's line only.
   */
  const [warningsOpen, setWarningsOpen] = useState(false);
  /** One closure for all three controls that toggle the list, rather than three inline arrows. */
  const toggleWarnings = useCallback(() => setWarningsOpen((was) => !was), []);
  /*
   * Where the reviewer asked to be shown, if they have. Only `body/structure-lost`,
   * `body/mark-lost` and `body/text-changed` carry a location (`Warning.editorPath`); see
   * `lostHighlight.ts` for why no other can. The nonce lets the same button work twice: the path
   * does not change, so without it the second click is not a new prop.
   */
  const [highlight, setHighlight] = useState<{ path: number[]; nonce: number }>();

  /** The warning the footer shows: the most severe one, or none at all. `sortWarnings` ranks them. */
  const [shown] = shownWarnings;
  /**
   * Is there anything for the list to SHOW? The render guard and the auto-furl effect share it, so
   * the list cannot be unfurled with nothing in it.
   */
  const hasSomethingToOpen = shown !== undefined || silenced.length > 0 || mentions !== null;

  /**
   * Point the reviewer at a node, using the path on the row they clicked. The row IS the live
   * render's warning, so `editorPath` indexes the document in the editor; an outline on the wrong
   * node is the failure `lostHighlight.ts` exists to avoid.
   */
  const showMe = useCallback((w: Warning) => {
    if (w.editorPath === undefined) return;
    const path = w.editorPath;
    // The nonce lets the same button work twice (see `highlight`).
    setHighlight((was) => ({ path, nonce: (was?.nonce ?? 0) + 1 }));
  }, []);

  /*
   * A pointer into a document that no longer exists means nothing: `applyFix` replaces `doc`, the
   * editor rebuilds, and the highlight effect would outline whatever now sits at the OLD path.
   */
  useEffect(() => setHighlight(undefined), [doc]);

  /*
   * A list with nothing in it is closed. `warningsOpen` is otherwise the reviewer's alone, but
   * unfurl, edit until clean, and it stays `true`; the next warning would then unfurl itself over
   * the draft. `silenced` and mentions count (the same predicate as the render guard), or the list
   * would shut on a clean-but-rewritten draft, whose only content is the account of what changed.
   */
  useEffect(() => {
    if (!hasSomethingToOpen) setWarningsOpen(false);
  }, [hasSomethingToOpen]);

  /** Open the diff for the BLOCKED draft's whole-document repair. */
  const reviewSuggestedFix = useCallback(() => {
    if (current.suggestedFix === undefined) return;
    setPendingFix({
      // Straight from the repair: the window composes no part of its identity.
      applied: { code: current.suggestedFix.code, label: current.suggestedFix.label },
      title: current.suggestedFix.label,
      note:
        'The destination cannot show some of this structure, so it is converted to what it can. ' +
        'No text is lost; only formatting is simplified.',
      // `current.canonical`, not the raw field: `suggestedFix` is a re-serialisation, and diffing
      // against the agent's markdown would mix the serialiser's normalisation into the sanitiser's
      // changes. Both sides must come from one serialiser.
      before: current.canonical,
      body: current.suggestedFix.body,
    });
  }, [current]);

  /**
   * Open the diff for ONE warning's repair, off the row clicked. The row came out of the render for
   * the CURRENT document, so `offer.body` is a change to the draft on screen: a stale body cannot
   * exist, because a row lives only while its warning does.
   */
  const applyWarningFix = useCallback(
    (w: Warning, offer: FixOffer) => {
      const applied: AppliedFix = { code: w.code, label: offer.label };
      setPendingFix({
        applied,
        title: offer.label,
        note: 'This repairs the warning above. Nothing else in the draft changes.',
        // `canonical`, not `baseline`: a warning's repair is computed from it. Against the baseline
        // the explicit-link repair would show no change, since the round trip already normalises a
        // bare URL into one.
        before: current.canonical,
        body: offer.body,
      });
    },
    [current]
  );
  /**
   * The "N changed on load" control, built once for both arms of the strip's ternary: it sits in a
   * different position in each, so the element is hoisted, not the position.
   */
  const changed = (
    <ChangedOnLoad count={silenced.length} open={warningsOpen} onToggle={toggleWarnings} />
  );
  /*
   * INLINE in the strip like `changed`: a note is not a row, because `.dg-status` has a FIXED height
   * and anything above the draft moves the editor. The strip says a few words and the explanation
   * hangs in the unfurled panel, which is absolute.
   */
  const mentionsNote =
    mentions === null ? null : (
      <button
        type="button"
        className="dg-mentions"
        data-broadcast={mentions.broadcast ? 'true' : undefined}
        aria-expanded={warningsOpen}
        onClick={toggleWarnings}
      >
        {mentions.label}
      </button>
    );

  /*
   * The pending repair, `null` when the modal is closed. A BLOCKED draft's `suggestedFix` and a
   * single warning's repair share ONE preview: an instantly applied repair would get less review
   * than the blocked one, though it is no less consequential.
   */
  const [pendingFix, setPendingFix] = useState<{
    title: string;
    note: string;
    /** What to diff AGAINST. It differs by fix kind -- see where each is set. */
    before: string;
    body: string;
    /** How this repair is named in the audit log. Carried through the modal: by apply time the
     *  body is replaced and the warning that offered it may be gone. */
    applied: AppliedFix;
  } | null>(null);
  /*
   * A preview of a draft that has since CHANGED is a preview of nothing: applying it would load a
   * repair of a document no longer on screen and discard what happened in between, with the diff
   * still looking right. `FixDiff`'s focus trap removes the human route (the backdrop blocks the
   * mouse, and Tab would walk through the editor); this makes the staleness structurally moot, as
   * a warning row exists only while its warning does. In practice it fires for nobody.
   */
  useEffect(() => {
    if (pendingFix !== null && pendingFix.before !== current.canonical) setPendingFix(null);
  }, [current.canonical, pendingFix]);

  const [submitted, setSubmitted] = useState(false);
  // The message, not the Error: nothing here reads anything else off it.
  const [editorError, setEditorError] = useState<string | null>(null);

  /*
   * The reviewer's own answer about this target, when the banner asked. Applied IMMEDIATELY: the
   * audience is recomputed from the profile, so answering "service desk" shows the customer-visible
   * banner before they decide. The window passes an ANSWER, not a config map
   * (`AudienceFacts.classified`), so the recompute needs no `cloudId` or project key. The whole
   * answer, destination included, is state: pairing it back on at each use would rebuild the
   * object per render and churn `approve`, `reject` and the shortcut effect.
   */
  const [answered, setAnswered] = useState<TargetAnswer<DestinationName> | undefined>(
    undefined
  );
  const audience =
    answered === undefined
      ? request.audience
      : audienceFor(request.destination, request.context, {
          toolName: request.toolName,
          // The CLI asked with it, so the recompute must too.
          routeInferred: request.routeInferred !== undefined,
          classified: answered,
        });
  const kind = audience?.kind;

  /*
   * `data-audience` on the ROOT beside `data-destination`, for their reason: a sheet scopes
   * `[data-destination="jira"][data-audience="internal"]` and outranks its unscoped rules (a wrapper
   * class loses on specificity: `.claude/rules/styles.md`). It is for fidelity: JSM draws an
   * internal note on yellow and Jira's `previewFidelity` is `probe-derived`, so a white preview
   * showed what the reader will not see. The banner's amber still means "a customer will read
   * this". The KIND is published so a sheet can style any audience it has evidence for; removed on
   * unmount so a fatal screen keeps no stale ground.
   */
  useEffect(() => {
    const root = document.documentElement;
    const cancel = setRootData(root, { audience: kind });
    return () => {
      cancel();
      delete root.dataset.audience;
    };
    // The KIND, the only thing read: `audience` is a fresh object per render once answered, and
    // depending on it would reset the attribute on every keystroke.
  }, [kind]);

  /*
   * What the footer promises when nothing changed. Both spellings name what is on SCREEN; the
   * second does not imply a message body. A const, since the footer's ternary had no room. Until
   * something is edited it also names the key into the draft (`draftKey.ts`); the third line has
   * no room for it at the narrowest window, and `⌘J` works there too.
   */
  const unchangedHint = hasDraft
    ? `Exactly what you see above will be sent. ${DRAFT_KEY} to edit.`
    : hasEdits
      ? `Exactly these edits will be sent. ${DRAFT_KEY} to edit.`
      : 'Exactly the fields above will be sent. This call carries no message body.';
  // Did a person change anything at all: the body, a line or an edit. The badge, the hint and the
  // decision's `edited` all mean this.
  const anyEdit = edited || typedEdited;

  /*
   * What rides EITHER decision beside the send (`HumanDecision`): `classifyProject`, kept on a
   * rejection too because it told us the truth about the project either way, and the theme to
   * keep. Spread, so an absent one leaves its key off.
   */
  const said = useMemo(
    () => ({
      ...(answered === undefined ? {} : { classifyProject: answered }),
      ...(themeChosen === null ? {} : { theme: themeChosen }),
    }),
    [answered, themeChosen]
  );

  const approve = useCallback(() => {
    if (current.blocked || submitted) return;
    setSubmitted(true);
    // The body ALWAYS goes, edited or not: an approval approves what was shown (`useReview.ts`).
    // `edited` travels on its own, because the log and digest need it to mean a PERSON changed
    // something; `silenced` is what draftgate itself changed. `fixes` goes always, including
    // empty: absent means "this window cannot report repairs" (`AppliedFix` in `windowProtocol.ts`).
    bridge().decide({
      action: 'approve',
      /*
       * EVERY field the window showed, with the value on screen: the decision's half of
       * `WireRequest.fields`. The body is the entry whose kind is not `line`, so a body-less review
       * has no entry for one and `current.canonical` (`''`) cannot reach the payload. All fields,
       * unchanged ones too, so a FULL map is how "changed none" is spelled; an absent key or an
       * empty map is a renderer that does not speak this vocabulary, and the CLI denies it.
       */
      fields: Object.fromEntries(
        request.fields.map((f) => [
          f.field,
          isBlockField(f) ? current.canonical : liveValue(typed, f),
        ])
      ),
      // A prose or patch edit is a human change even when the BODY is untouched (there is none in a
      // patch). The CLI ORs both in again: a surface may report `edited` for the body alone.
      edited: anyEdit,
      // The body alone, so the agent is shown a body only when the reviewer changed it.
      bodyEdited: edited,
      // Codes, not messages: the code is the stable identity the log and the digest are keyed on.
      silenced: silenced.map((w) => w.code),
      fixes,
      ...said,
    });
  }, [
    current.blocked, current.canonical, anyEdit, edited, fixes, typed, request.fields, said,
    silenced, submitted,
  ]);

  const reject = useCallback(() => {
    if (submitted) return;
    setSubmitted(true);
    bridge().decide({ action: 'reject', reason: reason.trim() || undefined, ...said });
  }, [reason, said, submitted]);

  /*
   * The shortcuts are registered ONLY while the shell that advertises them is on screen. Nothing
   * else tears this listener down when `editorError` fires, so `⌘↵` would outlive the button: the
   * fatal screen removes "Approve & send (⌘↵)" and the key would approve anyway, since `approve()`
   * is gated on `current.blocked`, which knows nothing about the editor. Not registering is
   * stronger than a guard in `onKey`. `surface/window.test.tsx` dispatches the real event.
   */
  const shortcutArmed = useShortcutArmed();
  useEffect(() => {
    if (editorError !== null) return;
    const onKey = (e: KeyboardEvent) => {
      // With nothing focused a Tab would hand the keyboard to the page's first control, and stray
      // typing after it to the draft: `⌘J` is the way in (`draftKey.ts`).
      if (e.key === 'Tab' && nothingFocused()) {
        e.preventDefault();
        return;
      }
      const draftKey = isDraftKey(e);
      if (!draftKey && (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter')) return;
      /*
       * Not while a sub-dialog asks a DIFFERENT question. With the repair preview open, `⌘↵` would
       * approve the UNREPAIRED body (`blocked` does not save this: a warning's repair is offered on
       * an approvable draft); with the link row focused it races `UrlInput`'s Enter. The preview is
       * `pendingFix`; the link row's state is inside `Toolbar`, so it is detected on the EVENT:
       * a keystroke inside `.dg-linkrow` belongs to it. That also covers the next sub-dialog, and
       * keeps `⌘J` from taking the focus out of one.
       */
      if (pendingFix !== null) return;
      const target = e.target as Element | null;
      if (target?.closest?.('.dg-linkrow, .dg-modal')) return;

      /*
       * Only a FRESH press, and only once the window has held the keyboard for a second
       * (`shortcutGrace.ts`). After the exemptions above, so a keystroke that belongs to one is left
       * alone. A swallowed press is still `preventDefault`ed; what keeps `⌘↵` out of the DRAFT is
       * the editor's own `'Mod-Enter': () => true` in `Editor.tsx`, since window listeners run after
       * ProseMirror's. The editor binds nothing to `⌘J`.
       */
      e.preventDefault();
      if (e.repeat || !shortcutArmed()) return;
      if (draftKey) focusDraft();
      else if (rejecting) reject();
      else approve();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [approve, reject, rejecting, editorError, pendingFix, shortcutArmed]);

  // An editor that refused to load replaces the WHOLE shell. Wrapping only `<Editor>` would leave
  // the footer's enabled "Approve & send" under the error, since `disabled` comes from
  // `current.blocked`, which knows nothing about the editor.
  if (editorError) {
    return (
      <Fatal
        title="The editor could not load this draft"
        detail={editorError}
        reason={`draftgate could not display the draft for review: ${editorError}`}
      />
    );
  }

  return (
    <div className="dg-shell">
      {/*
        LINE ONE: what this is and where it is going. The routing sits beside the destination, not
        in a block of its own that would add a strip above the draft. A `<dl>`, so `destination`
        summarises the raw fields rather than replacing them.
      */}
      <header className="dg-header">
        <div className="dg-header-main">
          <DestinationMark destination={request.destination} />
          <span className="dg-dest">{request.destination}</span>
          {/* Routing is read-only: you review the body, not where it goes. */}
          {(request.destinationLabel !== undefined || Object.keys(request.context).length > 0) && (
            <dl className="dg-context">
              {/* Where it is going, in words: composed by the PROFILE (the renderer cannot resolve a
                  `cloudId` to a hostname) and absent when nothing verifiable could be composed. */}
              {request.destinationLabel !== undefined && (
                <div className="dg-destination">
                  <dt>destination</dt>
                  <dd>{request.destinationLabel}</dd>
                </div>
              )}
              {Object.entries(request.context).map(([k, v]) => {
                const text = typeof v === 'string' ? v : JSON.stringify(v);
                return (
                  <div key={k}>
                    {/*
                      * The field's own name, not the path draftgate addressed it by: a wildcard
                      * route makes every label share a prefix (`fields.labels`, `fields.priority`)
                      * and costs width. The full path stays in `title`, and `contextLabels` falls
                      * back to it for a leaf that is not unique.
                      */}
                    <dt title={k}>{labels.get(k)}</dt>
                    {/* `title`, because the value ellipses and a clipped `cloudId` is unrecoverable. */}
                    <dd title={text}>{text}</dd>
                  </div>
                );
              })}
            </dl>
          )}
          {/* No tool chip: the full MCP name would ellipsis to nothing useful on this line. The
              window title carries the tool half (`windowTitle.cjs`). */}
          {/* Nobody configured this tool. Here, not in `.dg-status`: that strip is about the BODY
              and has a fixed height, and this is a fact about the ROUTING. */}
          {request.routeInferred && (
            <span
              className="dg-inferred"
              title={
                `No tool map entry matched, so the destination was inferred from the tool name (it ` +
                `resembles ${request.routeInferred.matchedEntry}). Styling, warnings and audience ` +
                'follow that guess. If it is wrong, reject.'
              }
            >
              destination inferred
            </span>
          )}
          {/* `anyEdit`: the badge means what the decision means, and a title-only edit sends
              `edited: true`. `surface:e2e` types into a real title and checks both. */}
          {anyEdit && <span className="dg-edited">edited</span>}
        </div>
        <div className="dg-header-side">
          <ThemeToggle
            value={themePref}
            supported={current.themes}
            onChange={onThemeChange}
          />
          <Countdown ms={request.timeoutMs} />
        </div>
      </header>

      {/* WHO gets this: the frame of the review, so above the verdict. */}
      <AudienceBanner
        audience={audience}
        classified={answered?.value}
        onClassify={(value) =>
          setAnswered(
            value === undefined ? undefined : { destination: request.destination, value }
          )
        }
      />

      {/*
        LINE TWO: the verdict, always here, as a strip of its own. Not a block above the draft (it
        moves the editor), not the footer's hint line (its actions would read as siblings of
        Approve), not the header's tool-name slot. A clean draft says so in green, because chrome
        that appears with a warning jumps the editor.
      */}
      <div
        className="dg-status"
        data-severity={shown?.severity ?? 'ok'}
        data-blocked={current.blocked ? 'true' : undefined}
      >
        {/* The unfurled list, absolute so it cannot change the strip's height (`shell.css`). */}
        {warningsOpen && hasSomethingToOpen && (
          <Warnings
            warnings={shownWarnings}
            silenced={silenced}
            mentions={mentions?.detail ?? null}
            onFix={applyWarningFix}
            onFind={showMe}
          />
        )}
        {/* The padded row: `.dg-status` carries no padding, because an absolute child is offset from
            the padding box and would be inset by it. */}
        <div className="dg-status-row">
        {shown === undefined ? (
          <>
            <p className="dg-status-ok">
              <Check className="dg-status-tick" aria-hidden="true" />
              No problems found
            </p>
            {/* Green is a claim about the body being SENT, so say that body is not the agent's. */}
            {changed}
            {/* Not a problem, but "this will notify someone" is what a reviewer wants before Approve. */}
            {mentionsNote}
          </>
        ) : (
          <>
            {/*
              Severity, what you can DO, then the message. The chip sits outside the toggle for that
              order. Text links, not buttons: a button is taller than the row and reads as a sibling
              of Reject and Approve.
            */}
            <span className="dg-sev">{SEVERITY_LABEL[shown.severity]}</span>
            {shown.editorPath !== undefined && (
              <button
                type="button"
                className="dg-warnlink"
                onClick={() => showMe(shown)}
              >
                Show me
              </button>
            )}
            {current.blocked && current.suggestedFix !== undefined && (
              <button type="button" className="dg-warnlink" onClick={reviewSuggestedFix}>
                Review suggested fix
              </button>
            )}
            {changed}
            {mentionsNote}
            <button
              type="button"
              className="dg-warnbar"
              aria-expanded={warningsOpen}
              onClick={toggleWarnings}
            >
              {/* One line, clipped: wrapping would make the strip taller. */}
              <span className="dg-warnbar-msg">{shown.message}</span>
              {shownWarnings.length > 1 && (
                <span className="dg-warnbar-more">+{shownWarnings.length - 1} more</span>
              )}
              <ChevronDown className="dg-warnbar-chev" aria-hidden="true" />
            </button>
          </>
        )}
        </div>
      </div>

      <main className="dg-body">
        {/*
          * The fields in the order the plan put them (`cli/src/reviewPlan.ts`, asserted by
          * `cli/test/reviewPlan.test.ts`): walked, not filtered into fixed slots, so reordering
          * the wire list changes what is drawn. A title sits above the draft, the order a reader
          * meets them in. Outside `.dg-status`, whose height is fixed: these are part of the
          * message, and `.dg-body` scrolls, so several of them cannot push the editor off screen.
          */}
        {fieldGroups(request.fields).map((group) =>
          group.kind === 'edits' ? (
            // A patch: its edits, one card each, where the draft would be (`PatchEdits.tsx`).
            <PatchEdits
              key={group.fields[0]!.field}
              destination={request.destination}
              fields={group.fields}
              values={group.fields.map((f) => liveValue(typed, f))}
              onChange={setField}
              // A preview that cannot load fails the shell, as the body editor does.
              onError={(e) => setEditorError(e.message)}
            />
          ) : group.kind === 'lines' ? (
            /*
             * A single-line `<input>`: these fields are plain lines at every destination probed, so a
             * toolbar would promise formatting that gets sent literally.
             *
             * UNLABELLED: position says this is prose beside the draft, and the text in the field
             * says which one. An empty field draws a `placeholder` naming it, so two empty boxes
             * read `name` and `summary` (Linear's `save_project`). `title`, `aria-label` and
             * `placeholder` are all the raw path the operator wrote: a friendlier name would be the
             * window claiming destination knowledge.
             *
             * An empty box arises from a `""` the payload sent (an absent field draws no box), a
             * blanked title in an update, or the reviewer deleting the text. `"   "` draws no
             * placeholder, so `prose/empty` blocks it: Jira answers 400 to `"   "` as to `""`
             * (probed), and `isBlankBody` is what the rule tests.
             */
            <div className="dg-prose" key={group.fields[0]!.field}>
              {group.fields.map((p) => (
                <input
                  key={p.field}
                  className="dg-prose-field"
                  type="text"
                  title={p.field}
                  aria-label={p.field}
                  placeholder={p.field}
                  // An `<input>` strips CR and LF, so an agent's break is drawn as a control
                  // picture and mapped back on change; an untouched field sends the exact value.
                  value={showLineBreaks(liveValue(typed, p), p.value)}
                  // The CLI refuses an over-cap value, which would lose the window, not the field.
                  maxLength={contract.maxProseLength}
                  spellCheck
                  onChange={(e) =>
                    // A newline can be PASTED into an `<input>`: flattened, not refused (the paste
                    // is the reviewer's own text). Pictures then go back to the breaks they stand
                    // for, so an agent's break is kept and named by `prose/line-break`.
                    setField(p.field, hideLineBreaks(e.target.value.replace(/\s*\n+\s*/g, ' '), p.value))
                  }
                />
              ))}
            </div>
          ) : (
            /*
             * The compose frame (`.dg-compose`): a wrapper, not a border on `.ProseMirror`, so a
             * shared rule cannot lose a specificity tie with the destination sheets.
             *
             * A PLAIN body gets a textarea, not the editor, and stays editable. No toolbar and no
             * markdown parsing, so `**bold**` stays nine characters. An editor with its extensions
             * stripped would still apply TipTap's markdown input rules (`# ` becomes a heading).
             * `doc` is the discriminator, not `group.field.kind`: `useReview` decided what the
             * editor can load.
             */
            <Fragment key={group.field.field}>
              {doc === undefined ? (
                <>
                  <p className="dg-plain-note">
                    Plain text. This field stores exactly these characters, so markdown is not
                    formatting here -- <code>**bold**</code> is sent as those nine characters.
                  </p>
                  <div className="dg-compose">
                    <textarea
                      className="dg-plain-body"
                      value={current.canonical}
                      spellCheck
                      onChange={(e) => onPlainChange(e.target.value)}
                    />
                  </div>
                </>
              ) : (
                <div className="dg-compose">
                  <EditorBoundary onError={(e) => setEditorError(e.message)}>
                    <Editor
                      doc={doc}
                      onChange={onChange}
                      toolbar={current.toolbar}
                      highlight={highlight}
                      rendersMedia={current.rendersMedia}
                      mentions={current.mentions}
                      codeSpanMarks={current.codeSpanMarks}
                    />
                  </EditorBoundary>
                </div>
              )}
            </Fragment>
          )
        )}
        {/*
          * Where the draft would be, when this call carries none. A `.dg-plain-note`, so the reviewer
          * who reads a title and finds nothing below it is told nothing is missing. The field is not
          * named: position says which thing is the draft. A note, not a warning: the tool's schema
          * allows the call, and what could still block is a blank title (`prose/empty`).
          */}
        {!hasDraft && !hasEdits && (
          <p className="dg-plain-note">
            No message body. This call sets the fields above and sends no draft, so there is nothing
            more to read.
          </p>
        )}
      </main>

      <footer className="dg-footer">
        {rejecting ? (
          <div className="dg-reject">
            <label htmlFor="dg-reason">
              Why? The agent is told this, so it does not retry the same send.
            </label>
            <textarea
              id="dg-reason"
              autoFocus
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. wrong ticket, or drop the second paragraph"
            />
            <div className="dg-actions">
              <button type="button" className="dg-btn" onClick={() => setRejecting(false)}>
                Back
              </button>
              <button type="button" className="dg-btn dg-btn-danger" onClick={reject}>
                Reject (⌘↵)
              </button>
            </div>
          </div>
        ) : (
          <div className="dg-actions">
            {/* The DECISION and nothing else: warning controls here would look like these two. The
                unedited hint names the body, not "the writing", which the silenced panel above may
                have just denied is the agent's. */}
            <span className="dg-hint">
              {current.blocked
                ? 'Fix the blocking problems to enable approval.'
                : anyEdit
                  ? 'Your edited text will be sent.'
                  : unchangedHint}
            </span>
            <button type="button" className="dg-btn" onClick={() => setRejecting(true)}>
              Reject
            </button>
            <button
              type="button"
              className="dg-btn dg-btn-primary"
              disabled={current.blocked || submitted}
              onClick={approve}
            >
              Approve &amp; send (⌘↵)
            </button>
          </div>
        )}
      </footer>

      {pendingFix !== null && (
        <FixDiff
          before={pendingFix.before}
          after={pendingFix.body}
          title={pendingFix.title}
          note={pendingFix.note}
          onCancel={() => setPendingFix(null)}
          onApply={() => {
            const { body, applied } = pendingFix;
            setPendingFix(null);
            applyFix(body, applied);
          }}
        />
      )}
    </div>
  );
}

/**
 * The value of one LINE or EDIT field now: what the reviewer typed, or what they were shown. `typed` is
 * seeded from the list callers walk, so the fallback cannot fire today; it is written once because
 * the `prose/empty` verdict, the input, `edited` and the decision must agree.
 */
function liveValue(typed: Record<string, string>, field: ReviewFieldValue): string {
  return typed[field.field] ?? field.value;
}

/**
 * What the window DRAWS: a run of consecutive LINE fields is one `.dg-prose` row, a BLOCK field is
 * the compose frame. Grouping, not two filters, so the plan's order survives into the DOM.
 */
type FieldGroup =
  | { kind: 'lines'; fields: ReviewFieldValue[] }
  | { kind: 'edits'; fields: EditFieldValue[] }
  | { kind: 'block'; field: ReviewFieldValue };

function fieldGroups(fields: readonly ReviewFieldValue[]): FieldGroup[] {
  const out: FieldGroup[] = [];
  for (const f of fields) {
    if (isBlockField(f)) {
      out.push({ kind: 'block', field: f });
      continue;
    }
    // A run of consecutive edits is one group, as a run of lines is.
    const last = out[out.length - 1];
    if (f.kind === 'edit') {
      if (last?.kind === 'edits') last.fields.push(f);
      else out.push({ kind: 'edits', fields: [f] });
    } else if (last?.kind === 'lines') last.fields.push(f);
    else out.push({ kind: 'lines', fields: [f] });
  }
  return out;
}

const SEVERITY_LABEL: Record<Warning['severity'], string> = {
  error: 'blocking',
  warning: 'warning',
  info: 'info',
};

/**
 * The chip on a SILENCED row: not a severity word and not an outcome. The row hangs under a green
 * `No problems found`, so `WARNING` would contradict it, and `fixed` would be false for the codes
 * that lost something (`jira/task-item-media-only` destroys a checkbox); nothing in a `Warning`
 * tells them apart. `info` is out too: a live info row can sit directly above a silenced one
 * (`jira-silenced` in `probe.ts`), and both chips would read INFO on one `--dg-info-bg` ground.
 * `note` reads low-stakes; the section heading and the message carry the weight. Severity survives
 * only in the ORDER, which `silencedWarnings` takes from `allWarnings`.
 */
const SILENCED_LABEL = 'note';

/**
 * The strip's marker for "draftgate rewrote this draft when it loaded", beside the green verdict as
 * well as beside a warning: green speaks about the body being SENT, which is not the one the agent
 * wrote. It states a count only, because the strip must not wrap or change height; `Warnings`'
 * section carries the claim.
 */
function ChangedOnLoad({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle(): void;
}) {
  if (count === 0) return null;
  return (
    <button type="button" className="dg-changed" aria-expanded={open} onClick={onToggle}>
      {count} changed on load
    </button>
  );
}

/**
 * The warning list. A warning that names a DERIVABLE repair gets a button for it:
 * `slack/url-swallows-next-line` says "write [text](url)", and a blocked draft already gets a
 * one-click fix. `slack/image-becomes-link` names a fix (upload the file) with no button, because
 * draftgate holds no destination credentials and never contacts a destination.
 *
 * The warning CODE is not shown. It is draftgate's identifier, not something a reviewer acts on;
 * the audit log and `draftgate digest` read it off the decision.
 */
function Warnings({
  warnings,
  silenced,
  mentions,
  onFix,
  onFind,
}: {
  /**
   * The list to draw: live warnings minus those still settling (`settledWarnings.ts`). Every element
   * is an object out of `current.warnings`, so `f.body` cannot repair a draft typed past.
   */
  warnings: Warning[];
  /** Open the diff for one row's repair. Both halves come off the row; see `applyWarningFix`. */
  onFix(w: Warning, offer: FixOffer): void;
  /** Show where this warning is. Per row as well, because the strip shows only the most severe one. */
  onFind(w: Warning): void;
  /**
   * Warnings true of the AGENT's draft and not of what will be sent, in a quieter section at the
   * bottom. One of these codes means a checkbox was destroyed, so they are on screen, not only in
   * the log. No repairs and no "Show me": both act on the CURRENT document, which these do not
   * describe (see `silencedWarnings`).
   */
  silenced: Warning[];
  /**
   * The sentences saying what approving will NOTIFY, or null. The detail string, not the whole
   * `mentionNote`, so a consumer cannot re-derive `broadcast` from label text. Not a `Warning`: a
   * mention is not a defect, and a severity would put it in the acted-on list and let it drive
   * `blocked`. The copy comes from `core`, which owns what a destination will do.
   */
  mentions: string | null;
}) {
  return (
    <ul className="dg-warnings">
      {warnings.map((w, i) => (
        <WarningRow
          key={`${w.code}-${i}`}
          w={w}
          chip={SEVERITY_LABEL[w.severity]}
          className={`dg-warn-${w.severity}`}
        >
          {w.editorPath !== undefined && (
            <button type="button" className="dg-warn-fix" onClick={() => onFind(w)}>
              Show me
            </button>
          )}
          {w.fixes?.map((f) => (
            <button
              key={f.label}
              type="button"
              className="dg-warn-fix"
              onClick={() => onFix(w, f)}
            >
              {f.label}
            </button>
          ))}
        </WarningRow>
      ))}
      {mentions !== null && (
        <li className="dg-warn-mentions">
          <span className="dg-warn-text">{mentions}</span>
        </li>
      )}
      {silenced.length > 0 && (
        <li className="dg-warn-silenced-head">
          {/*
            The two clauses that are certainly true. Not sorted into "fixed" and "lost": the codes
            that reach here include a no-op, improvements and a loss (`jira/task-item-media-only`
            destroys a checkbox), and nothing in a `Warning` tells them apart. See `SILENCED_LABEL`.
          */}
          <span className="dg-warn-text">
            True of the agent's draft, not of what will be sent. draftgate rewrote the draft when it
            loaded; check each one below still reads the way you intend.
          </span>
        </li>
      )}
      {/* No actions: both act on the CURRENT document, which these warnings do not describe. */}
      {silenced.map((w) => (
        <WarningRow
          key={`silenced-${w.code}`}
          w={w}
          chip={SILENCED_LABEL}
          className="dg-warn-silenced"
        />
      ))}
    </ul>
  );
}

/**
 * One row of the unfurled list, live or silenced. One component, so the grid-track invariant below
 * is written once and a silenced row cannot lack what a live one has: the probe counts those rows
 * and reads their colour, so a missing badge would be invisible to it.
 *
 * `children` is the actions cell; passing none is how a silenced row offers none (see `Warnings`).
 * `chip` is required and not read off `w.severity`, so `WARNING` cannot land under a green verdict.
 */
function WarningRow({
  w,
  chip,
  className,
  children,
}: {
  w: Warning;
  chip: string;
  className: string;
  children?: ReactNode;
}) {
  return (
    <li className={`dg-warn ${className}`}>
      <span className="dg-sev">{chip}</span>
      {/* Chip, message, actions: the collapsed strip's reading order. */}
      <span className="dg-warn-text">
        {w.message}
        {w.unverified && <em className="dg-unverified"> (unverified)</em>}
      </span>
      {/*
        Actions to the RIGHT of the message, stacked, which gives the prose its width back (a column
        before the text would put ~300px of labels between the chip and every message). Always
        rendered, even empty: it is a grid cell, and a row that skipped it would slide its message
        into the actions column.
      */}
      <span className="dg-warn-actions">{children}</span>
    </li>
  );
}

/**
 * WHO receives this message. `kind`, `label` and `detail` all come from the profile through the CLI;
 * this component only picks a colour and a shape. A `destination === 'jira'` test here would break
 * that rule, as it would for `previewFidelity` and `suggestedFix`.
 *
 * `public` is the loudest chrome. `unavailable`, when the profile supplies one, is drawn beside it
 * as text, never a control: JSM's composer has `Reply to customer` and `Add internal note` tabs,
 * and probed `addCommentToJiraIssue` has no parameter for the second (the server drops extras).
 */
function AudienceBanner({
  audience,
  classified,
  onClassify,
}: {
  audience?: Audience;
  /** The reviewer's answer, if they have given one. `undefined` is also how Undo is expressed. */
  classified?: string;
  onClassify(type: string | undefined): void;
}) {
  const answered = classified !== undefined;
  // One button, used by both return paths below. `setClassified(undefined)` is the undo, so Undo
  // needs no handler of its own.
  const undo = answered ? (
    <button type="button" className="dg-audience-answer" onClick={() => onClassify(undefined)}>
      Undo
    </button>
  ) : null;

  /*
   * An answered question needs a way BACK, even when the answer removed the banner. "No" on a real
   * service desk takes the whole banner with it; `software` is persisted on approval and never
   * overwritten, so with no Undo on screen nothing could correct it. Nothing is written until the
   * decision is submitted, so an undo here prevents the bad record.
   */
  if (audience === undefined) {
    return answered ? (
      <div className="dg-banner dg-audience dg-audience-answered" role="note">
        <span className="dg-audience-detail">Recorded: this project is internal.</span>
        {undo}
      </div>
    ) : null;
  }

  return (
    <div className={`dg-banner dg-audience dg-audience-${audience.kind}`} role="note">
      <span className="dg-audience-label">{audience.label}</span>
      {audience.unavailable !== undefined && (
        <span className="dg-audience-off">{audience.unavailable} -- not available here</span>
      )}
      <span className="dg-audience-detail">{audience.detail}</span>
      {/* The question, asked once: the reviewer knows the answer. Every word is the profile's. */}
      {audience.ask !== undefined && (
        <span className="dg-audience-ask">
          {audience.ask.question}
          {audience.ask.options.map((option) => (
            <button
              key={option.value}
              type="button"
              className="dg-audience-answer"
              onClick={() => onClassify(option.value)}
            >
              {option.label}
            </button>
          ))}
        </span>
      )}
      {undo}
    </div>
  );
}

function Countdown({ ms }: { ms: number }) {
  const [left, setLeft] = useState(ms);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setLeft(Math.max(0, ms - (Date.now() - started))), 1000);
    return () => clearInterval(t);
  }, [ms]);

  const seconds = Math.ceil(left / 1000);
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, '0');
  return (
    <span className={`dg-clock${seconds <= 60 ? ' dg-clock-urgent' : ''}`} title="Time before draftgate denies the send">
      {mm}:{ss}
    </span>
  );
}

function Fatal({ title, detail, reason }: { title: string; detail: string; reason: string }) {
  const [submitted, setSubmitted] = useState(false);
  return (
    <div className="dg-centred dg-fatal">
      <h1>{title}</h1>
      <p className="dg-fatal-detail">{detail}</p>
      <p>Nothing has been sent. Closing this window denies the send, as does the button below.</p>
      <button
        type="button"
        className="dg-btn dg-btn-danger"
        disabled={submitted}
        onClick={() => {
          setSubmitted(true);
          bridge().decide({ action: 'reject', reason });
        }}
      >
        Deny the send
      </button>
    </div>
  );
}
