import { describe, expect, it } from 'bun:test';
import { truncateMarkdown, truncateMarkdownToLimit } from '../truncate';

describe('truncateMarkdown', () => {
  it('returns text unchanged when under limit', () => {
    expect(truncateMarkdown('short text', 100)).toBe('short text');
  });

  it('returns text unchanged when exactly at limit', () => {
    const text = 'a'.repeat(50);
    expect(truncateMarkdown(text, 50)).toBe(text);
  });

  it('truncates at paragraph boundary', () => {
    const text = 'First paragraph.\n\nSecond paragraph that is longer.';
    const result = truncateMarkdown(text, 30);
    expect(result).toBe('First paragraph.…');
    expect(result).not.toContain('Second');
  });

  it('truncates at line boundary when no paragraph break', () => {
    const text = 'Line one.\nLine two is longer content here.';
    const result = truncateMarkdown(text, 25);
    expect(result).toBe('Line one.…');
  });

  it('truncates at word boundary when no line break', () => {
    const text = 'These are several words in a sentence that is too long.';
    const result = truncateMarkdown(text, 30);
    expect(result).toMatch(/…$/);
    // Should cut at a space, not mid-word like "sente…"
    expect(result).toBe('These are several words in a…');
  });

  it('never cuts inside a markdown link', () => {
    const text = 'Check [this documentation](https://example.com/very/long/path/to/docs) for details.';
    const result = truncateMarkdown(text, 40);
    expect(result).not.toContain('(https://example.com/very/long');
    expect(result).toBe('Check…');
  });

  it('never cuts inside an image reference', () => {
    const text = 'See ![screenshot](https://img.example.com/very/long/image.png) below.';
    const result = truncateMarkdown(text, 35);
    expect(result).not.toContain('(https://img.example.com/very');
    expect(result).toBe('See…');
  });

  it('never cuts inside inline code', () => {
    const text = 'Run `some-very-long-command --with-flags` to fix it.';
    const result = truncateMarkdown(text, 25);
    expect(result).not.toContain('`some-very-long-command');
    expect(result).toBe('Run…');
  });

  it('never cuts inside a code block', () => {
    const text = 'Example:\n\n```\nfunction hello() {\n  console.log("hi");\n}\n```\n\nDone.';
    const result = truncateMarkdown(text, 30);
    expect(result).not.toContain('function hello');
    expect(result).toBe('Example:…');
  });

  it('preserves complete link when it fits within limit', () => {
    const text = 'See [docs](https://example.com) and then some extra filler text to exceed the limit.';
    const result = truncateMarkdown(text, 50);
    expect(result).toContain('[docs](https://example.com)');
  });

  it('handles text that is all one long word', () => {
    const text = 'a'.repeat(100);
    const result = truncateMarkdown(text, 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result).toMatch(/…$/);
  });

  it('appends ellipsis character', () => {
    const text = 'a '.repeat(100);
    const result = truncateMarkdown(text, 50);
    expect(result).toMatch(/…$/);
  });
});

describe('truncateMarkdownToLimit', () => {
  it('returns text unchanged when under limit', () => {
    expect(truncateMarkdownToLimit('short', 100)).toBe('short');
  });

  it('returns text unchanged when exactly at limit', () => {
    const text = 'a'.repeat(50);
    expect(truncateMarkdownToLimit(text, 50)).toBe(text);
  });

  it('stays within the budget', () => {
    const text = 'x'.repeat(200);
    expect(truncateMarkdownToLimit(text, 50).length).toBeLessThanOrEqual(50);
  });

  it('keeps the HEAD of an oversized fenced code block', () => {
    const log = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const text = `Here is the output:\n\n\`\`\`\n${log}\n\`\`\`\n`;
    const result = truncateMarkdownToLimit(text, 200);
    // Unlike truncateMarkdown, the log content is preserved, not dropped.
    expect(result).toContain('line 0');
    expect(result).toContain('Here is the output');
  });

  it('re-closes a code fence left open by the cut', () => {
    const log = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const text = `prefix\n\n\`\`\`\n${log}\n\`\`\`\n`;
    const result = truncateMarkdownToLimit(text, 200);
    // Even number of fences -> valid, balanced code block.
    expect((result.match(/```/g) ?? []).length % 2).toBe(0);
    expect(result.endsWith('```')).toBe(true);
  });

  it('prefers a line boundary when one is near the budget', () => {
    const text = 'aaaa\nbbbb\ncccc\ndddd\neeee\nffff';
    const result = truncateMarkdownToLimit(text, 12);
    // Cut at the newline within the back half of the budget, no dangling line.
    expect(result.endsWith('\n')).toBe(false);
    expect(result).toBe('aaaa\nbbbb');
  });
});
