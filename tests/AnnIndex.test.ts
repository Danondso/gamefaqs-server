import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AnnIndex } from '../src/services/AnnIndex';

const DIM = 8;

function vec(...xs: number[]): Float32Array {
  if (xs.length !== DIM) throw new Error(`test vec wrong dim: ${xs.length}`);
  return new Float32Array(xs);
}

describe('AnnIndex', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annidx-'));
    file = path.join(dir, 'test.ann');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('add / search / size round-trip', () => {
    const idx = new AnnIndex({ dim: DIM, file });
    idx.add(1, vec(1, 0, 0, 0, 0, 0, 0, 0));
    idx.add(2, vec(0, 1, 0, 0, 0, 0, 0, 0));
    idx.add(3, vec(0, 0, 1, 0, 0, 0, 0, 0));
    expect(idx.size()).toBe(3);

    const hits = idx.search(vec(1, 0, 0, 0, 0, 0, 0, 0), 2);
    expect(hits[0].rowid).toBe(1);
    expect(hits[0].distance).toBeCloseTo(0, 4);
  });

  it('save and reload preserves the index', () => {
    const idx = new AnnIndex({ dim: DIM, file });
    idx.add(42, vec(1, 1, 0, 0, 0, 0, 0, 0));
    expect(idx.saveIfDirty()).toBe(true);
    expect(idx.saveIfDirty()).toBe(false); // no-op when clean

    const idx2 = new AnnIndex({ dim: DIM, file });
    expect(idx2.load()).toBe(true);
    expect(idx2.size()).toBe(1);
    const hits = idx2.search(vec(1, 1, 0, 0, 0, 0, 0, 0), 1);
    expect(hits[0].rowid).toBe(42);
  });

  it('load returns false when the file does not exist', () => {
    const idx = new AnnIndex({ dim: DIM, file });
    expect(idx.load()).toBe(false);
    expect(idx.size()).toBe(0);
  });

  it('remove drops a key from results', () => {
    const idx = new AnnIndex({ dim: DIM, file });
    idx.add(1, vec(1, 0, 0, 0, 0, 0, 0, 0));
    idx.add(2, vec(1, 0, 0, 0, 0, 0, 0, 0)); // tied with 1
    idx.remove(1);
    const hits = idx.search(vec(1, 0, 0, 0, 0, 0, 0, 0), 5);
    const ids = hits.map((h) => h.rowid);
    expect(ids).not.toContain(1);
    expect(ids).toContain(2);
  });

  it('rejects vectors with the wrong dimension', () => {
    const idx = new AnnIndex({ dim: DIM, file });
    expect(() => idx.add(1, new Float32Array(4))).toThrow(/dim/);
  });

  it('atomic save: tmp file is renamed, not left behind', () => {
    const idx = new AnnIndex({ dim: DIM, file });
    idx.add(1, vec(1, 0, 0, 0, 0, 0, 0, 0));
    idx.saveNow();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(file + '.tmp')).toBe(false);
  });
});
