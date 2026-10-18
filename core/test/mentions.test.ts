/**
 * Mentions across the markdown boundary: a mention node survives serialisation to markdown and
 * back, so editing a draft does not flatten it and Jira receives a real mention.
 *
 * Probed against live Jira: the ADF below POSTed 201, was stored as a mention node, and
 * `expand=renderedBody` returned a user link with `data-account-id` and `class="user-hover"`. Jira
 * resolves the display name from the id: sent `@Ada`, stored `@Ada Lovelace`.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toEditorDoc, fromEditorDoc } from '../src/editor';
import { profiles } from '../src/profiles';
import { encodeMentions, decodeMentions, MENTION_SCHEME } from '../src/mentions';
import { render } from '../src/render';

const ID = '557058:abc-123';

const mentionDoc = () =>
  ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hi ' },
          { type: 'mention', attrs: { id: ID, label: 'Ada' } },
          { type: 'text', text: ', look.' },
        ],
      },
    ],
  }) as unknown as Parameters<typeof fromEditorDoc>[0];

describe('a mention survives the markdown round trip', () => {
  test('the id reaches markdown', () => {
    const md = fromEditorDoc(mentionDoc());
    expect(md).toBe(`Hi [@Ada](${MENTION_SCHEME}${ID}), look.`);
    // Without the encoding this would be `Hi @Ada, look.`, with the id gone.
    expect(md).toContain(ID);
  });

  test('and comes back as a mention NODE, not a link', () => {
    const back = toEditorDoc(fromEditorDoc(mentionDoc()), { structuralMentions: true }) as any;
    const node = back.content[0].content.find((n: any) => n.type === 'mention');
    expect(node).toBeDefined();
    expect(node.attrs.id).toBe(ID);
  });

  test('the round trip is STABLE, so editing twice does not degrade it', () => {
    const once = fromEditorDoc(mentionDoc());
    expect(fromEditorDoc(toEditorDoc(once, { structuralMentions: true }))).toBe(once);
  });

  test('Jira receives a real ADF mention node', () => {
    // What makes it notify rather than render as characters.
    const adf = render(fromEditorDoc(mentionDoc()), 'jira').converted as any;
    const node = adf.content[0].content.find((n: any) => n.type === 'mention');
    expect(node).toEqual({ type: 'mention', attrs: { id: ID, text: '@Ada' } });
  });
});

describe('what must NOT be treated as a mention', () => {
  test('an ordinary link is left completely alone', () => {
    const md = 'See [docs](https://example.org) please.';
    expect(fromEditorDoc(toEditorDoc(md))).toBe(md);
  });

  test("Jira's own wiki syntax stays TEXT, deliberately", () => {
    // `[~accountid:x]` is a mention to Jira and literal characters to Slack and Linear; recognising
    // it would draw a chip in a Slack preview. An explicit scheme cannot be typed by accident.
    const md = 'Hi [~accountid:557058:abc], look.';
    expect(fromEditorDoc(toEditorDoc(md))).toBe(md);
    const adf = render(md, 'jira').converted as any;
    expect(JSON.stringify(adf)).not.toContain('"mention"');
  });

  test('Slack and Linear text forms are untouched, because they already work', () => {
    for (const md of ['ping <@U0123ABCDEF> please', 'ping @johndoe please']) {
      expect(fromEditorDoc(toEditorDoc(md))).toBe(md);
    }
  });
});

describe('malformed mentions degrade to text rather than to a broken link', () => {
  test('a mention with no id becomes plain text', () => {
    const doc: any = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { label: 'Ghost' } }] }],
    };
    // An id-less mention is not a mention; encoding one would link to `mention:` and resolve to
    // nothing.
    expect(fromEditorDoc(doc)).toBe('@Ghost');
  });

  test('an empty mention href is left as the link it is', () => {
    const doc: any = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '@x', marks: [{ type: 'link', attrs: { href: MENTION_SCHEME } }] },
          ],
        },
      ],
    };
    expect(JSON.stringify(decodeMentions(doc))).not.toContain('"mention"');
  });

  test('encode and decode are inverse on a document with no mentions', () => {
    const adf: any = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'plain' }] }] };
    expect(decodeMentions(encodeMentions(adf))).toEqual(adf);
  });
});

describe('a mention chip is only drawn where the destination renders one', () => {
  // Decoding for every destination would draw a chip for a `mention:` link Slack and Linear ship as
  // literal characters.
  const md = 'Hi [@Bob](mention:U1), look.';

  /*
   * `mentions.chips` is a claim; what makes it true for Jira is a separate `decodeMentions` call in
   * its `convert()`. Claiming `true` without the decode gives the reviewer a chip and the recipient
   * characters; `false` with it sends a real mention (whether it notifies is unobserved) for what the
   * reviewer saw as a link. Loops over `profiles`, so a new destination is checked.
   */
  for (const [name, profile] of Object.entries(profiles)) {
    test(`${name}: the flag and what convert() actually does agree`, () => {
      const claimsIt = profile.mentions.chips !== null;

      // What the PREVIEW draws.
      const doc = toEditorDoc(md, { structuralMentions: claimsIt }) as any;
      const chip = doc.content[0].content.some((n: any) => n.type === 'mention');
      expect(chip).toBe(claimsIt);

      // What the destination receives. The two must agree.
      const converted = JSON.stringify(render(md, name).converted);
      expect(converted.includes('"mention"')).toBe(claimsIt);
    });
  }

  test('the default is OFF, so a caller that forgets cannot draw a false chip', () => {
    const doc = toEditorDoc(md) as any;
    expect(doc.content[0].content.some((n: any) => n.type === 'mention')).toBe(false);
  });
});

/*
 * A body written from ADF is written by `markdownFromAdf`, which encodes mentions first. The bare
 * writer spells a mention `@Label`, which still reads as a name and pings nobody, so a second
 * caller that imports it directly can lose every mention it writes -- in a repair, in one click.
 */
describe('only markdownFromAdf writes a body from ADF', () => {
  const ROOT = join(import.meta.dir, '../..');
  const TREES = ['core/src', 'cli/src', 'surface/src', 'surface/harness', 'adapters/hook/src', 'tools'];
  const WRITER = /\bimport\b[^;]*\bconvertAdfToMarkdown\b[^;]*\bfrom\b/;

  test('the matcher sees an import of the writer, and only that', () => {
    expect(WRITER.test("import { convertAdfToMarkdown } from '../adf/adfToMarkdown';")).toBe(true);
    expect(WRITER.test("import {\n  sanitizeAdfForJsm,\n  convertAdfToMarkdown,\n} from '../adf';")).toBe(true);
    expect(WRITER.test("import { markdownFromAdf } from '../editor';")).toBe(false);
  });

  test('outside the converter, editor.ts is the one importer', () => {
    const importers = TREES.flatMap((tree) =>
      (readdirSync(join(ROOT, tree), { recursive: true }) as string[])
        .filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f) && !f.includes('node_modules') && !/\.test\./.test(f))
        .map((f) => `${tree}/${f}`)
        .filter((f) => !f.startsWith('core/src/adf/') && WRITER.test(readFileSync(join(ROOT, f), 'utf8')))
    );
    expect(importers).toEqual(['core/src/editor.ts']);
  });
});
