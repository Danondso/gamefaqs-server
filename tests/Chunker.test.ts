import { describe, it, expect } from 'vitest';
import { chunkGuide, type ChunkOpts } from '../src/services/Chunker';

const opts = (override: Partial<ChunkOpts> = {}): ChunkOpts => ({
  chunkSizeTokens: 800,
  chunkOverlapTokens: 100,
  ...override,
});

describe('Chunker.chunkGuide', () => {
  it('returns [] for empty content', () => {
    expect(chunkGuide('', opts())).toEqual([]);
    expect(chunkGuide('   \n\n  ', opts())).toEqual([]);
  });

  it('returns one chunk for a short paragraph with correct offsets', () => {
    const text = 'This is a single short paragraph about saving the game.';
    const chunks = chunkGuide(text, opts());
    expect(chunks.length).toBe(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].charStart).toBe(0);
    expect(chunks[0].charEnd).toBe(text.length);
    expect(chunks[0].content).toBe(text);
  });

  it('packs multiple short paragraphs into a single window', () => {
    const text = ['First paragraph here.', 'Second one continues.', 'Third one closes.'].join('\n\n');
    const chunks = chunkGuide(text, opts());
    expect(chunks.length).toBe(1);
    // Spans from first to last character of last paragraph
    expect(chunks[0].charStart).toBe(0);
    expect(chunks[0].charEnd).toBe(text.length);
  });

  it('sentence-splits a single oversize paragraph into multiple chunks', () => {
    // chunkSizeTokens: 5 → window = 20 chars. Force splitting by sentence.
    const text = 'Step one is here. Step two follows. Step three then comes. Step four ends.';
    const chunks = chunkGuide(text, opts({ chunkSizeTokens: 5, chunkOverlapTokens: 0 }));
    expect(chunks.length).toBeGreaterThan(1);
    // Offsets are non-decreasing
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].charStart).toBeGreaterThanOrEqual(chunks[i - 1].charStart);
    }
  });

  it('skips chunks that are mostly ASCII art and preserves prose', () => {
    const ascii = '*'.repeat(40) + '\n' + '|' + ' '.repeat(38) + '|\n' + '*'.repeat(40);
    const prose = 'This is a regular paragraph of helpful prose that should survive.';
    const text = ascii + '\n\n' + prose;
    const chunks = chunkGuide(text, opts());
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toContain('helpful prose');
    expect(chunks[0].content).not.toContain('****');
  });

  it('overlaps consecutive chunks by approximately chunkOverlapTokens*4 chars', () => {
    // chunkSizeTokens: 50 → window = 200 chars; overlap 10 tokens → 40 chars
    const para1 = 'A'.repeat(180) + ' end-of-first.';
    const para2 = 'B'.repeat(180) + ' end-of-second.';
    const text = `${para1}\n\n${para2}`;

    const chunks = chunkGuide(text, opts({ chunkSizeTokens: 50, chunkOverlapTokens: 10 }));
    expect(chunks.length).toBe(2);

    // The second chunk should start with the tail of the first paragraph (overlap),
    // then a separator, then the second paragraph.
    const tail = para1.slice(para1.length - 40);
    expect(chunks[1].content.startsWith(tail)).toBe(true);
    expect(chunks[1].content).toContain(para2);

    // Offsets reflect original guide, not the prefixed overlap
    expect(chunks[1].charStart).toBe(text.indexOf(para2));
    expect(chunks[1].charEnd).toBe(text.length);
  });

  it('emits no overlap when chunkOverlapTokens = 0', () => {
    const para1 = 'A'.repeat(180) + ' end-of-first.';
    const para2 = 'B'.repeat(180) + ' end-of-second.';
    const text = `${para1}\n\n${para2}`;

    const chunks = chunkGuide(text, opts({ chunkSizeTokens: 50, chunkOverlapTokens: 0 }));
    expect(chunks.length).toBe(2);
    expect(chunks[1].content.startsWith('B')).toBe(true);
  });
});
