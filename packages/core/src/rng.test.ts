import { describe, expect, it } from 'vitest';
import { gridSeed, hashSeed, mulberry32, stableJitter } from './rng.js';

describe('hashSeed', () => {
  it('é determinístico e cabe em 32 bits sem sinal', () => {
    const a = hashSeed('canal-1:2026-08-17');
    expect(hashSeed('canal-1:2026-08-17')).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(2 ** 32);
  });

  it('separa entradas parecidas', () => {
    expect(hashSeed('canal-1:2026-08-17')).not.toBe(hashSeed('canal-1:2026-08-18'));
    expect(hashSeed('canal-1:2026-08-17')).not.toBe(hashSeed('canal-2:2026-08-17'));
  });
});

describe('mulberry32', () => {
  it('reproduz a mesma sequência para o mesmo seed', () => {
    const seq = (s: number) => Array.from({ length: 8 }, mulberry32(s));
    expect(seq(12345)).toEqual(seq(12345));
    expect(seq(12345)).not.toEqual(seq(12346));
  });

  it('produz valores em [0, 1)', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 2000; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('cobre o intervalo razoavelmente (média perto de 0,5)', () => {
    const rng = mulberry32(99);
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) sum += rng();
    expect(sum / n).toBeCloseTo(0.5, 1);
  });
});

describe('stableJitter', () => {
  it('depende do id do vídeo, não da ordem de chamada', () => {
    const seed = gridSeed('tv-1', '2026-08-17');
    // A ordem inversa tem de dar exatamente os mesmos valores por vídeo.
    const direct = ['a', 'b', 'c'].map((id) => stableJitter(seed, id, 0.1));
    const reversed = ['c', 'b', 'a'].map((id) => stableJitter(seed, id, 0.1)).reverse();
    expect(direct).toEqual(reversed);
  });

  it('respeita a amplitude', () => {
    const seed = gridSeed('tv-1', '2026-08-17');
    for (let i = 0; i < 500; i++) {
      const j = stableJitter(seed, `v${i}`, 0.1);
      expect(j).toBeGreaterThanOrEqual(0.9);
      expect(j).toBeLessThanOrEqual(1.1);
    }
  });

  it('amplitude zero neutraliza o jitter', () => {
    expect(stableJitter(123, 'abc', 0)).toBe(1);
  });
});
