import { describe, expect, it } from 'bun:test';
import {
  stripFilenameUuid,
  parseJiraWikiLink,
  isImageReference,
} from '../util';

describe('stripFilenameUuid', () => {
  it('strips UUID suffix from filename', () => {
    expect(
      stripFilenameUuid(
        'myfile (a1b2c3d4-e5f6-7890-abcd-ef1234567890).png'
      )
    ).toBe('myfile.png');
  });

  it('handles filename without UUID', () => {
    expect(stripFilenameUuid('normal-file.txt')).toBe('normal-file.txt');
  });

  it('handles UUID in the middle of a path', () => {
    expect(
      stripFilenameUuid(
        'screenshot (12345678-abcd-1234-abcd-123456789012).jpg'
      )
    ).toBe('screenshot.jpg');
  });

  it('preserves filename with parentheses that are not UUIDs', () => {
    expect(stripFilenameUuid('file (copy).txt')).toBe('file (copy).txt');
  });
});

describe('parseJiraWikiLink', () => {
  it('parses two-segment link', () => {
    expect(parseJiraWikiLink('[Click here|https://example.com]')).toEqual({
      display: 'Click here',
      url: 'https://example.com',
    });
  });

  it('strips third segment (smart-link type)', () => {
    expect(
      parseJiraWikiLink('[Title|https://example.com|smart-link]')
    ).toEqual({ display: 'Title', url: 'https://example.com' });
  });

  it('returns null for non-wiki-link text', () => {
    expect(parseJiraWikiLink('not a link')).toBeNull();
  });

  it('returns null for standard Markdown link', () => {
    expect(parseJiraWikiLink('[text](url)')).toBeNull();
  });
});

describe('isImageReference', () => {
  it('detects common image extensions', () => {
    expect(isImageReference('photo.png')).toBe(true);
    expect(isImageReference('photo.jpg')).toBe(true);
    expect(isImageReference('photo.jpeg')).toBe(true);
    expect(isImageReference('photo.gif')).toBe(true);
    expect(isImageReference('photo.webp')).toBe(true);
    expect(isImageReference('photo.svg')).toBe(true);
  });

  it('detects image URLs with query params', () => {
    expect(isImageReference('https://cdn.example.com/img.png?w=100')).toBe(
      true
    );
  });

  it('rejects non-image references', () => {
    expect(isImageReference('document.pdf')).toBe(false);
    expect(isImageReference('file.txt')).toBe(false);
  });
});
