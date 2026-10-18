/**
 * Flip the ruler to Atlassian's dark theme and measure it the same way.
 *
 * The built dist contains `atlassian-dark-future-*.js` beside the light chunk it loads by default,
 * and Atlassian tokens are CSS custom properties scoped by an attribute on <html>. With the dark
 * chunk loaded and the attribute set, every value `jira.css` claims is re-measured in dark with the
 * same `getComputedStyle`, with no rebuild. Light and dark are reported side by side.
 *
 * Run: `bun run measure:dark`.
 */

const { run } = require('./measure.cjs');

const TOKENS = [
  '--ds-surface', '--ds-text', '--ds-text-subtlest', '--ds-link',
  '--ds-background-neutral', '--ds-border', '--ds-background-th',
];

run(`
  const TOKENS = ${JSON.stringify(TOKENS)};
  // read() from measure.cjs's PRELUDE, which exists precisely so there is one computed-style
  // reader rather than a copy per probe. Custom properties come back with the leading space
  // getPropertyValue preserves, so trim for display.
  // (No backticks in this block: it lives inside a template literal and one silently ends it.)
  const readTokens = () => {
    const raw = read(document.documentElement, TOKENS);
    return Object.fromEntries(TOKENS.map((t) => [t, raw[t].trim()]));
  };
  const codeHost = pm.querySelector('.code-block') || pm.querySelector('pre');
  const sample = () => ({
    tokens: readTokens(),
    body: read(pm, ['color', 'background-color']),
    codeBlock: read(codeHost, ['background-color', 'color']),
  });

  return (async () => {
    const light = sample();

    // The dark chunk sits next to the light one the page already loaded.
    const base = location.href.replace(/\\/[^/]*$/, '');
    let loaded = null;
    for (const name of ['atlassian-dark-future-CCJR4psC.js', 'atlassian-dark-nBNbqyET.js']) {
      try { await import(base + '/assets/' + name); loaded = name; break; } catch (e) { /* try next */ }
    }

    // Atlassian scopes its dark tokens by attribute on <html>; set every spelling in use.
    const html = document.documentElement;
    html.setAttribute('data-color-mode', 'dark');
    html.setAttribute('data-theme', 'dark:dark light:light');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const dark = sample();
    const changed = TOKENS.filter((t) => light.tokens[t] !== dark.tokens[t]);
    return {
      chunkLoaded: loaded,
      verdict: changed.length ? 'DARK TOKENS RESOLVED' : 'no token changed -- flip did not take',
      tokensThatChanged: changed,
      light,
      dark,
    };
  })();
`);
