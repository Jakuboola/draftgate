/**
 * Does Jira's editor number the lines of a code block, and how are the numbers styled?
 *
 * draftgate's CodeBlock node view emits a line-number span for every destination, shown only where
 * numbering is measured. This measures Jira's editor, so Jira's numbers rest on the ruler.
 *
 * `read` and `pick` come from measure.cjs's PRELUDE. Do not redeclare them: `const read = ...` here
 * is a SyntaxError in the composed script, reported only as "Script failed to execute".
 *
 * Run: `bun run measure:linenos` from the repo root.
 */

const { run } = require('./measure.cjs');

const TEXT = ['font-family', 'font-size', 'font-weight', 'line-height', 'color', 'text-align'];

run(`
  const TEXT = ${JSON.stringify(TEXT)};
  const block = pm.querySelector('.code-block') || pm.querySelector('pre');
  if (!block) return { error: 'editor-core rendered no code block' };

  const all = [...block.querySelectorAll('*')];
  const numbers = all.filter((el) => !el.children.length && /^\\s*\\d+\\s*$/.test(el.textContent || ''));
  const first = numbers[0];

  return {
    verdict: numbers.length ? 'NUMBERS FOUND' : 'no numbered elements in the code block',
    numbersSeen: numbers.map((el) => el.textContent.trim()),
    numberCls: first ? String(first.className) : null,
    gutterCls: block.querySelector('.line-number-gutter') ? 'line-number-gutter' : null,
    gutter: pick('.line-number-gutter', [...TEXT, 'width', 'background-color', 'padding-left', 'padding-right'], block),
    number: read(first, [...TEXT, 'width', 'padding-left', 'padding-right']),
    codeContent: pick('.code-content', ['padding-left', 'font-size', 'line-height'], block),
    shape: all.slice(0, 8).map((el) => el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 44)),
  };
`);
