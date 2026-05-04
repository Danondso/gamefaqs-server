import { describe, it, expect } from 'vitest';
import {
  parseGen,
  parseGuideId,
  pickWinner,
  planFromCandidates,
} from '../src/services/DedupePlanner';

const ARC3 = '/tmp/Gamespot_Gamefaqs_TXTs/gamefaqs.gamespot.com.txt.faqs.3.gen.7z';
const ARC4 = '/tmp/Gamespot_Gamefaqs_TXTs/gamefaqs.gamespot.com.txt.faqs.4.gen.7z';
const ARC9 = '/tmp/Gamespot_Gamefaqs_TXTs/gamefaqs.gamespot.com.txt.faqs.9.gen.7z';

const cand = (archivePath: string, internalPath: string, size: number) => ({
  archivePath,
  internalPath,
  size,
  gen: parseGen(archivePath),
});

describe('parseGen', () => {
  it('extracts the gen number from the archive filename', () => {
    expect(parseGen(ARC3)).toBe(3);
    expect(parseGen(ARC9)).toBe(9);
  });

  it('throws when the archive name does not match', () => {
    expect(() => parseGen('/x/random.7z')).toThrow();
  });
});

describe('parseGuideId', () => {
  it('extracts the trailing guide id', () => {
    expect(parseGuideId('3rd/nes/563441-mega-man/faqs/563441-mega-man-faqs-29827.txt')).toBe(29827);
    expect(parseGuideId('9th/ps4/255742-aca-neogeo-ninja-masters/faqs/255742-aca-neogeo-ninja-masters-faqs-10.txt')).toBe(10);
  });

  it('returns null for non-conforming names', () => {
    expect(parseGuideId('3rd/nes/foo/readme.txt')).toBeNull();
    expect(parseGuideId('something-else.txt')).toBeNull();
  });
});

describe('pickWinner tiebreaker chain', () => {
  it('prefers larger size', () => {
    const small = cand(ARC3, '3rd/nes/a/faqs/1-a-faqs-7.txt', 100);
    const big = cand(ARC3, '3rd/nes/b/faqs/2-b-faqs-7.txt', 200);
    expect(pickWinner(small, big)).toBe(big);
    expect(pickWinner(big, small)).toBe(big);
  });

  it('falls back to lower gen when sizes tie', () => {
    const earlyGen = cand(ARC3, '3rd/nes/a/faqs/1-a-faqs-7.txt', 100);
    const laterGen = cand(ARC9, '9th/ps4/b/faqs/2-b-faqs-7.txt', 100);
    expect(pickWinner(earlyGen, laterGen)).toBe(earlyGen);
    expect(pickWinner(laterGen, earlyGen)).toBe(earlyGen);
  });

  it('falls back to lex-smaller path when size and gen tie', () => {
    const aPath = cand(ARC3, '3rd/nes/a/faqs/1-a-faqs-7.txt', 100);
    const zPath = cand(ARC3, '3rd/nes/z/faqs/2-z-faqs-7.txt', 100);
    expect(pickWinner(aPath, zPath)).toBe(aPath);
    expect(pickWinner(zPath, aPath)).toBe(aPath);
  });
});

describe('planFromCandidates', () => {
  it('keeps one survivor per guideId and groups picks by archive', () => {
    const candidates = [
      cand(ARC3, '3rd/nes/a/faqs/100-a-faqs-7.txt', 1000),
      cand(ARC4, '4th/gb/b/faqs/200-b-faqs-7.txt', 1000),
      cand(ARC9, '9th/ps4/c/faqs/300-c-faqs-7.txt', 1001),
      cand(ARC3, '3rd/nes/d/faqs/400-d-faqs-9.txt', 500),
      cand(ARC4, '4th/gb/e/faqs/500-e-faqs-9.txt', 500),
    ];
    const plan = planFromCandidates(candidates);

    expect(plan.stats).toEqual({
      totalFiles: 5,
      uniqueGuides: 2,
      passthrough: 0,
      dropped: 3,
      bytesKept: 1001 + 500,
      bytesDropped: 1000 + 1000 + 500,
    });

    expect(plan.cherryPicks.get(ARC9)).toEqual(['9th/ps4/c/faqs/300-c-faqs-7.txt']);
    expect(plan.cherryPicks.get(ARC3)).toEqual(['3rd/nes/d/faqs/400-d-faqs-9.txt']);
    expect(plan.cherryPicks.has(ARC4)).toBe(false);
  });

  it('size-tied dupes pick the lower-gen archive', () => {
    const candidates = [
      cand(ARC9, '9th/ps4/x/faqs/1-x-faqs-42.txt', 4615),
      cand(ARC4, '4th/neo/y/faqs/2-y-faqs-42.txt', 4615),
      cand(ARC3, '3rd/nes/z/faqs/3-z-faqs-42.txt', 4615),
    ];
    const plan = planFromCandidates(candidates);
    expect(plan.stats.uniqueGuides).toBe(1);
    expect(plan.cherryPicks.get(ARC3)).toEqual(['3rd/nes/z/faqs/3-z-faqs-42.txt']);
    expect(plan.cherryPicks.has(ARC4)).toBe(false);
    expect(plan.cherryPicks.has(ARC9)).toBe(false);
  });

  it('routes paths that do not match the guide-id pattern to passthrough', () => {
    const candidates = [
      cand(ARC3, '3rd/nes/a/faqs/1-a-faqs-1.txt', 10),
      cand(ARC3, '3rd/nes/a/readme.txt', 20),
    ];
    const plan = planFromCandidates(candidates);
    expect(plan.stats).toMatchObject({
      totalFiles: 2,
      uniqueGuides: 1,
      passthrough: 1,
      dropped: 0,
    });
    expect(plan.cherryPicks.get(ARC3)?.sort()).toEqual([
      '3rd/nes/a/faqs/1-a-faqs-1.txt',
      '3rd/nes/a/readme.txt',
    ]);
  });

  it('roughly matches expected reduction ratio on a synthetic corpus', () => {
    const candidates = [];
    for (let g = 1; g <= 1000; g++) {
      candidates.push(cand(ARC3, `3rd/nes/g${g}/faqs/${g}-x-faqs-${g}.txt`, 1000));
    }
    for (let g = 1; g <= 500; g++) {
      candidates.push(cand(ARC4, `4th/gb/g${g}/faqs/${g}-y-faqs-${g}.txt`, 1000));
    }
    for (let g = 1; g <= 500; g++) {
      candidates.push(cand(ARC9, `9th/ps4/g${g}/faqs/${g}-z-faqs-${g}.txt`, 1000));
    }
    const plan = planFromCandidates(candidates);
    expect(plan.stats.totalFiles).toBe(2000);
    expect(plan.stats.uniqueGuides).toBe(1000);
    expect(plan.stats.dropped).toBe(1000);
    expect(plan.cherryPicks.get(ARC3)?.length).toBe(1000);
    expect(plan.cherryPicks.has(ARC4)).toBe(false);
    expect(plan.cherryPicks.has(ARC9)).toBe(false);
  });
});
