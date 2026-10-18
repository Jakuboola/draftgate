/**
 * The emoji picker, on real Unicode data: `unicode-emoji-json` (MIT), grouped as Unicode groups it.
 *
 * The ~412 KB dataset is behind a dynamic `import()`, its own Vite chunk fetched on first open from
 * disk, because the window is holding up an agent and must appear immediately.
 *
 * Emoji are Unicode characters: `🎉` survives markdown byte-identically and every destination
 * renders it (verified through the editor round trip). A mention has an id that a markdown wire loses.
 */

import { useEffect, useState } from 'react';

interface Group {
  name: string;
  emojis: { emoji: string; name: string }[];
}

/**
 * Cached across opens. A `.map()` into fresh objects would keep a second copy of all 1,914 entries
 * alive, since the registry retains the module namespace anyway; a type alias narrows at no cost.
 */
let cache: Group[] | null = null;

async function loadEmoji(): Promise<Group[]> {
  if (cache) return cache;
  // The package ships `[{ name, slug, emojis: [{ emoji, name, ... }] }]`.
  cache = (await import('unicode-emoji-json/data-by-group.json')).default as Group[];
  return cache;
}

interface EmojiPickerProps {
  onPick(e: string): void;
  onClose(): void;
  /**
   * The element that owns the toggle button and this popover. Without it the outside-click handler
   * treats the toggle as outside: clicking it while open closes then toggles, so the picker remounts
   * and loses the search query (`preventDefault` does not stop a document listener).
   */
  hostRef: React.RefObject<HTMLElement | null>;
}

export function EmojiPicker({ onPick, onClose, hostRef }: EmojiPickerProps) {
  const [groups, setGroups] = useState<Group[] | null>(cache);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let live = true;
    // A failed import must not take the review down with it: the picker is a convenience, and the
    // editor behind it is the thing that matters.
    loadEmoji().then(
      (g) => live && setGroups(g),
      () => live && setGroups([])
    );
    return () => {
      live = false;
    };
  }, []);

  // Escape closes, and a click outside closes. Both because this is a popover over an editor the
  // reviewer is mid-thought in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: MouseEvent) => {
      if (!hostRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose, hostRef]);

  const q = query.trim().toLowerCase();
  const shown = (groups ?? [])
    .map((g) => ({ ...g, emojis: q ? g.emojis.filter((e) => e.name.includes(q)) : g.emojis }))
    .filter((g) => g.emojis.length > 0);

  return (
    <div className="dg-emoji" role="dialog" aria-label="Emoji">
      <input
        className="dg-emoji-search"
        type="text"
        placeholder="Search emoji…"
        aria-label="Search emoji"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="dg-emoji-scroll">
        {groups === null && <p className="dg-emoji-note">loading…</p>}
        {groups !== null && shown.length === 0 && <p className="dg-emoji-note">nothing matches</p>}
        {shown.map((g) => (
          <section key={g.name}>
            <h4 className="dg-emoji-group">{g.name}</h4>
            {/* ONE delegated handler, not one closure per button: the full set is 1,914 entries,
                and the grid is remounted on every keystroke of the search box. */}
            <div
              className="dg-emoji-grid"
              onClick={(e) => {
                const pick = (e.target as HTMLElement).closest('[data-emoji]');
                if (pick) onPick((pick as HTMLElement).dataset.emoji!);
              }}
            >
              {g.emojis.map((e) => (
                <button
                  key={e.emoji}
                  type="button"
                  className="dg-emoji-btn"
                  data-emoji={e.emoji}
                  title={e.name}
                  aria-label={e.name}
                >
                  {e.emoji}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
