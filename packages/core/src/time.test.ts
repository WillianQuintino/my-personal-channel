import { describe, expect, it } from 'vitest';
import {
  halfLifeDecay,
  localDayKey,
  startOfLocalDay,
  startOfNextLocalDay,
  tzOffsetMs,
} from './time.js';

const SP = 'America/Sao_Paulo';
const NY = 'America/New_York';

describe('localDayKey', () => {
  it('usa o dia local, não o UTC', () => {
    // 2026-08-17T02:00:00Z é ainda 16/08 às 23h em São Paulo (UTC-3).
    const ms = Date.UTC(2026, 7, 17, 2, 0, 0);
    expect(localDayKey(ms, SP)).toBe('2026-08-16');
    expect(localDayKey(ms, 'UTC')).toBe('2026-08-17');
  });

  it('formata sempre com zero à esquerda', () => {
    expect(localDayKey(Date.UTC(2026, 0, 5, 12), 'UTC')).toBe('2026-01-05');
  });
});

describe('tzOffsetMs', () => {
  it('mede o offset fixo do Brasil (UTC-3, sem horário de verão desde 2019)', () => {
    expect(tzOffsetMs(Date.UTC(2026, 0, 15, 12), SP)).toBe(-3 * 3_600_000);
    expect(tzOffsetMs(Date.UTC(2026, 6, 15, 12), SP)).toBe(-3 * 3_600_000);
  });

  it('acompanha o horário de verão de Nova York', () => {
    expect(tzOffsetMs(Date.UTC(2026, 0, 15, 12), NY)).toBe(-5 * 3_600_000); // EST
    expect(tzOffsetMs(Date.UTC(2026, 6, 15, 12), NY)).toBe(-4 * 3_600_000); // EDT
  });
});

describe('startOfLocalDay', () => {
  it('cai na meia-noite local', () => {
    const noon = Date.UTC(2026, 7, 17, 15, 30, 0); // 12:30 em SP
    const start = startOfLocalDay(noon, SP);
    expect(start).toBe(Date.UTC(2026, 7, 17, 3, 0, 0));
    expect(localDayKey(start, SP)).toBe('2026-08-17');
  });

  it('é idempotente', () => {
    const start = startOfLocalDay(Date.UTC(2026, 7, 17, 15, 30), SP);
    expect(startOfLocalDay(start, SP)).toBe(start);
  });

  it('mantém a chave de dia na virada do horário de verão (primavera em NY)', () => {
    // 2026-03-08 é o adiantamento nos EUA: o dia local tem 23h.
    const duringDst = Date.UTC(2026, 2, 8, 18, 0); // 14:00 EDT
    const start = startOfLocalDay(duringDst, NY);
    expect(localDayKey(start, NY)).toBe('2026-03-08');
    expect(startOfLocalDay(start, NY)).toBe(start);
  });

  it('mantém a chave de dia no atraso do horário de verão (outono em NY)', () => {
    // 2026-11-01 é o atraso: o dia local tem 25h.
    const duringDst = Date.UTC(2026, 10, 1, 18, 0);
    const start = startOfLocalDay(duringDst, NY);
    expect(localDayKey(start, NY)).toBe('2026-11-01');
    expect(startOfLocalDay(start, NY)).toBe(start);
  });
});

describe('startOfNextLocalDay', () => {
  it('avança exatamente um dia de calendário', () => {
    const start = startOfLocalDay(Date.UTC(2026, 7, 17, 15), SP);
    expect(localDayKey(startOfNextLocalDay(start, SP), SP)).toBe('2026-08-18');
  });

  it('atravessa a virada de mês e o dia curto do horário de verão', () => {
    const aug31 = startOfLocalDay(Date.UTC(2026, 7, 31, 15), SP);
    expect(localDayKey(startOfNextLocalDay(aug31, SP), SP)).toBe('2026-09-01');

    const dstDay = startOfLocalDay(Date.UTC(2026, 2, 8, 18), NY); // dia de 23h
    expect(localDayKey(startOfNextLocalDay(dstDay, NY), NY)).toBe('2026-03-09');
  });
});

describe('halfLifeDecay', () => {
  it('vale 1 no instante da publicação', () => {
    expect(halfLifeDecay(0, 6)).toBe(1);
    expect(halfLifeDecay(-1000, 6)).toBe(1);
  });

  it('cai à metade a cada meia-vida', () => {
    expect(halfLifeDecay(6 * 3_600_000, 6)).toBeCloseTo(0.5, 10);
    expect(halfLifeDecay(12 * 3_600_000, 6)).toBeCloseTo(0.25, 10);
  });

  it('é monotonicamente decrescente', () => {
    let prev = Infinity;
    for (let h = 0; h <= 48; h += 3) {
      const v = halfLifeDecay(h * 3_600_000, 6);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });
});
