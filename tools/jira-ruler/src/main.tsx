/**
 * The jira-ruler's app: @atlaskit/editor-core in Electron, loading the torture fixture.
 *
 * What a run shows:
 *   1. Whether it builds (with the media-svg alias).
 *   2. Whether it renders the fixture's ADF.
 *   3. What visibly breaks with no Atlassian providers wired up.
 *   4. Time to interactive.
 *
 * Diagnostics are rendered into the page, not just logged, so a screenshot answers all four.
 */
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import adf from './fixture.json';

const t0 = performance.now();
const notes: string[] = [];
const note = (s: string) => {
  notes.push(`${(performance.now() - t0).toFixed(0)}ms  ${s}`);
};

function Diagnostics({ extra }: { extra: string[] }) {
  return (
    <pre
      style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, maxHeight: '35vh', overflow: 'auto',
        margin: 0, padding: '8px 12px', font: '11px ui-monospace, monospace',
        background: '#1c1c1e', color: '#d6d6d6', borderTop: '2px solid #444', zIndex: 9999,
      }}
    >
      {[...notes, ...extra].join('\n')}
    </pre>
  );
}

function Ruler() {
  const [Editor, setEditor] = useState<any>(null);
  const [err, setErr] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      try {
        note('importing @atlaskit/editor-core ...');
        const mod: any = await import('@atlaskit/editor-core');
        note(`imported. exports: ${Object.keys(mod).slice(0, 14).join(', ')}`);
        const E = mod.Editor ?? mod.ComposableEditor ?? mod.default;
        if (!E) { setErr((e) => [...e, 'NO USABLE EDITOR EXPORT FOUND']); return; }
        note(`using export: ${mod.Editor ? 'Editor' : mod.ComposableEditor ? 'ComposableEditor' : 'default'}`);
        setEditor(() => E);
      } catch (e: any) {
        setErr((x) => [...x, `IMPORT FAILED: ${e?.message ?? e}`, (e?.stack ?? '').split('\n').slice(0, 6).join('\n')]);
      }
    })();
  }, []);

  useEffect(() => {
    const onErr = (e: ErrorEvent) => setErr((x) => [...x, `window.error: ${e.message}`]);
    const onRej = (e: PromiseRejectionEvent) => setErr((x) => [...x, `unhandled rejection: ${e.reason}`]);
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    return () => { window.removeEventListener('error', onErr); window.removeEventListener('unhandledrejection', onRej); };
  }, []);

  return (
    <div style={{ font: '14px -apple-system, system-ui, sans-serif', padding: 16, paddingBottom: '38vh' }}>
      <div style={{ marginBottom: 12, color: '#666' }}>
        draftgate jira-ruler &middot; @atlaskit/editor-core &middot; torture fixture, no providers wired
      </div>
      <div style={{ border: '1px solid #ddd', borderRadius: 4, minHeight: 300 }}>
        {Editor ? (
          <Editor
            appearance="comment"
            defaultValue={adf}
            allowTables
            allowTextColor
            allowRule
            allowPanel
            allowTasksAndDecisions
            onChange={() => note('onChange fired -- editing works')}
          />
        ) : (
          <div style={{ padding: 24, color: '#999' }}>loading editor…</div>
        )}
      </div>
      <Diagnostics extra={err.map((e) => `ERROR  ${e}`)} />
    </div>
  );
}

note('boot');
createRoot(document.getElementById('root')!).render(
  <IntlProvider locale="en">
    <Ruler />
  </IntlProvider>
);
