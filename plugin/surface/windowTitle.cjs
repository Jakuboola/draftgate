/**
 * What the OS title bar says about a review. CommonJS for `geometry.cjs`'s reason: `bun test` loads
 * it and the WebKit host runs it unchanged in JavaScriptCore.
 *
 * The title names the tool because the window cannot: in a crowded flex row a real MCP name
 * ellipses to nothing (`mcp__claude_ai_Atlas…`). It shows the tool half only, since the server
 * prefix is long and least informative (the destination and routing line name the connector); the
 * full name is shown nowhere.
 *
 * The split matches `toolHalfOf` in `adapters/hook/src/toolMap.ts` (first `__` after `mcp__`), and
 * `windowTitle.test.ts` puts one table through both. Decorative: a wrong split is a worse title,
 * never a wrong review.
 */

/** `mcp__<server>__<tool>` -> `<tool>`; any other shape is returned unchanged. */
function toolHalf(name) {
  if (typeof name !== 'string' || name === '') return '';
  const cut = name.startsWith('mcp__') ? name.indexOf('__', 'mcp__'.length) : -1;
  const half = cut > 0 ? name.slice(cut + 2) : name;
  return half;
}

/** The full title: the destination always, the tool when there is one to name. */
function windowTitle(destination, toolName) {
  const half = toolHalf(toolName);
  return `draftgate review → ${destination}${half === '' ? '' : ` · ${half}`}`;
}

module.exports = { toolHalf, windowTitle };
