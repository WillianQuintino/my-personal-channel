import { describe, expect, it } from 'vitest';
import { formatDuration, parseIsoDuration, videoDurationSec } from './duration.js';

describe('parseIsoDuration', () => {
  it('lê os formatos que a API devolve na prática', () => {
    expect(parseIsoDuration('PT10M')).toBe(600);
    expect(parseIsoDuration('PT4M13S')).toBe(253);
    expect(parseIsoDuration('PT1H2M3S')).toBe(3_723);
    expect(parseIsoDuration('PT59S')).toBe(59);
    expect(parseIsoDuration('PT2H')).toBe(7_200);
  });

  it('lê durações longas de live com dias e semanas', () => {
    expect(parseIsoDuration('P1DT2H')).toBe(93_600);
    expect(parseIsoDuration('P1W')).toBe(604_800);
  });

  it('aceita segundos fracionários arredondando', () => {
    expect(parseIsoDuration('PT1M30.5S')).toBe(91);
    expect(parseIsoDuration('PT0.4S')).toBe(0);
  });

  it('devolve zero para PT0S — o que lives em andamento reportam', () => {
    expect(parseIsoDuration('PT0S')).toBe(0);
  });

  it('devolve null para entrada inválida', () => {
    expect(parseIsoDuration('')).toBeNull();
    expect(parseIsoDuration(null)).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
    expect(parseIsoDuration('10M')).toBeNull();
    expect(parseIsoDuration('PT')).toBeNull();
    expect(parseIsoDuration('P')).toBeNull();
    expect(parseIsoDuration('banana')).toBeNull();
    expect(parseIsoDuration('PT10X')).toBeNull();
  });

  it('tolera espaço em volta', () => {
    expect(parseIsoDuration('  PT10M  ')).toBe(600);
  });
});

describe('videoDurationSec', () => {
  it('devolve a duração de um vídeo normal', () => {
    expect(videoDurationSec('PT10M')).toBe(600);
  });

  it('trata PT0S como duração desconhecida, não como zero', () => {
    /*
     * Distinção que importa: lives em andamento reportam PT0S. Aceitar zero criaria
     * um slot de duração nula na grade, e o player entraria em laço de troca.
     */
    expect(videoDurationSec('PT0S')).toBeNull();
  });

  it('devolve null para entrada inválida', () => {
    expect(videoDurationSec(undefined)).toBeNull();
    expect(videoDurationSec('lixo')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('omite a hora quando não há', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(59)).toBe('0:59');
    expect(formatDuration(600)).toBe('10:00');
    expect(formatDuration(253)).toBe('4:13');
  });

  it('inclui a hora e preenche com zero', () => {
    expect(formatDuration(3_723)).toBe('1:02:03');
    expect(formatDuration(7_200)).toBe('2:00:00');
  });

  it('trata negativo e fração sem quebrar', () => {
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(90.9)).toBe('1:30');
  });
});
