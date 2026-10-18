/**
 * `link/text-host-mismatch`: a link whose text names one host and opens another.
 *
 * Asserted through `render()` on all four destinations, because the warning is what the window
 * draws -- plus `hostNamedBy` directly for the heuristic's edges, where a false positive is the
 * failure that teaches a reviewer to skip the row.
 */
import { describe, expect, test } from 'bun:test';
import { render } from '../src/render';
import { hostNamedBy } from '../src/linkHosts';

const DESTINATIONS = ['jira', 'slack', 'linear', 'github'] as const;
const CODE = 'link/text-host-mismatch';
const hits = (md: string, d: (typeof DESTINATIONS)[number] = 'jira') =>
  render(md, d).warnings.filter((w) => w.code === CODE);

describe('link/text-host-mismatch', () => {
  test("a URL label that opens a look-alike host warns on every destination, names both hosts and the full target, and does not block", () => {
    const md = 'Reset here: [https://id.example.org/reset](https://id-example.evil.test/reset)\n';
    for (const d of DESTINATIONS) {
      const r = render(md, d);
      const w = r.warnings.filter((x) => x.code === CODE);
      expect(w, d).toHaveLength(1);
      expect(w[0]!.severity).toBe('warning');
      expect(w[0]!.message).toContain('id.example.org');
      expect(w[0]!.message).toContain('https://id-example.evil.test/reset');
      expect(r.blocked, d).toBe(false);
    }
  });

  test('a bare host as the label counts, and so does a label split across marks', () => {
    expect(hits('[example.org](https://evil.test/)')).toHaveLength(1);
    expect(hits('[www.example.org/login](https://evil.test/)')).toHaveLength(1);
    // The converter spells this as two text nodes under one link; one node at a time reads neither.
    expect(hits('[**https**://example.org](https://evil.test/)')).toHaveLength(1);
    expect(hits('[`https://example.org`](https://evil.test/)')).toHaveLength(1);
  });

  test('an IDN look-alike target is a different host, however alike it looks', () => {
    // Cyrillic "а": equal on screen, unequal as strings.
    expect(hits('[https://example.org](https://exаmple.org/)')).toHaveLength(1);
  });

  test('the host is the one a browser opens: after the last `@`, before the port, past backslashes', () => {
    expect(hits('[example.org](https://example.org@evil.test/)')).toHaveLength(1);
    expect(hits('[example.org](https://example.org.evil.test:443/)')).toHaveLength(1);
    expect(hits('[example.org](https:\\\\evil.test/)')).toHaveLength(1);
    expect(hits('[example.org](https://user@example.org:8443/x)')).toHaveLength(0);
  });

  test('a scheme-relative target has a host, and it is the one compared', () => {
    expect(hits('[example.org](//evil.test/x)', 'github')).toHaveLength(1);
    expect(hits('[example.org](//example.org/x)', 'github')).toHaveLength(0);
  });

  test('labels differing only by surrounding space are one link, and one warning', () => {
    expect(hits('[https://example.org](https://evil.test) and [ https://example.org](https://evil.test)')).toHaveLength(1);
  });

  test('a subdomain is a different host', () => {
    expect(hits('[example.org](https://help.example.org/x)')).toHaveLength(1);
  });

  test("on a destination that draws no picture, an image's URL-looking alt is the link text Slack shows", () => {
    // Slack draws `![alt](src)` as a link labelled `alt` (`imagesAsLinks`), so this is the same lie.
    expect(hits('![https://example.org](https://evil.test/i.png)', 'slack')).toHaveLength(1);
    // Jira draws the picture, and an alt text is not a link anyone clicks.
    expect(hits('![https://example.org](https://evil.test/i.png)', 'jira')).toHaveLength(0);
  });

  test('one warning per distinct link, not per occurrence', () => {
    const md = '[a.com](https://b.test/) and [a.com](https://b.test/) and [c.com](https://d.test/)';
    expect(hits(md)).toHaveLength(2);
  });

  test('ordinary links stay silent', () => {
    for (const md of [
      '[https://example.org/reset](https://example.org/other)',
      '[example.org](https://www.example.org/)',
      '[www.example.org](https://example.org/)',
      '[EXAMPLE.ORG](https://example.org./)',
      '[the docs](https://evil.test/)',
      // A sentence that STARTS with a URL is not a host, whatever its first word reads as.
      '[https://example.org docs](https://example.org/docs)',
      '[https://example.org is ours](https://example.org)',
      '[Node.js](https://nodejs.org/)',
      '[README.md](https://github.com/x/y/blob/main/README.md)',
      '[setup.py](https://evil.test/setup.py)',
      'A bare https://example.org and <https://example.org>.',
      '[support@example.org](mailto:help@evil.test)',
      '[https://example.org](mailto:x@example.org)',
      'Hi [@Jakub](mention:557058:abc).',
    ]) {
      for (const d of DESTINATIONS) expect(hits(md, d), `${d}: ${md}`).toHaveLength(0);
    }
  });

  test('a body with no `](` is never parsed for this, and a code span holds no link', () => {
    expect(hits('`[https://a.com](https://b.test)`')).toHaveLength(0);
    expect(hits('```\n[https://a.com](https://b.test)\n```\n')).toHaveLength(0);
  });
});

describe('hostNamedBy', () => {
  test.each([
    ['https://id.example.org/reset', 'id.example.org'],
    ['  http://Example.ORG  ', 'example.org'],
    ['ftp://files.example.org', 'files.example.org'],
    ['example.org', 'example.org'],
    ['example.org:8443/path?q=1', 'example.org'],
    ['www.example.xyz', 'example.xyz'],
    // `www.` makes any TLD a host: nobody writes a file name that way.
    ['www.example.md', 'example.md'],
  ])('%p names %p', (label, host) => {
    expect(hostNamedBy(label)).toBe(host);
  });

  test.each([
    'Node.js',
    'README.md',
    'setup.py',
    'e.g.',
    'see example.org',
    'https://example.org docs',
    'example',
    'mailto:x@example.org',
    'support@example.org',
    '',
  ])('%p names no host', (label) => {
    expect(hostNamedBy(label)).toBeNull();
  });
});
