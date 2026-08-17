import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DAILY_QUOTA,
  estimatePagedCost,
  estimatePoolRefreshCost,
  QUOTA_COST,
  QuotaExhaustedError,
  QuotaLedger,
  quotaDayKey,
} from './quota.js';

const NOON_UTC = Date.UTC(2026, 7, 17, 12, 0, 0);

describe('custos de cota', () => {
  it('registra search.list como 100× mais caro que as alternativas', () => {
    expect(QUOTA_COST['search.list']).toBe(100);
    expect(QUOTA_COST['playlistItems.list']).toBe(1);
    expect(QUOTA_COST['videos.list']).toBe(1);
  });
});

describe('quotaDayKey', () => {
  it('usa o fuso do Pacífico, não o do usuário', () => {
    // 2026-08-17T05:00:00Z é ainda 16/08 às 22h no Pacífico.
    const ms = Date.UTC(2026, 7, 17, 5, 0, 0);
    expect(quotaDayKey(ms)).toBe('2026-08-16');
  });

  it('vira o dia à meia-noite do Pacífico', () => {
    // 07:00Z = 00:00 PDT (UTC-7 no verão).
    expect(quotaDayKey(Date.UTC(2026, 7, 17, 6, 59, 0))).toBe('2026-08-16');
    expect(quotaDayKey(Date.UTC(2026, 7, 17, 7, 0, 0))).toBe('2026-08-17');
  });
});

describe('QuotaLedger', () => {
  it('começa com o orçamento inteiro', () => {
    const ledger = new QuotaLedger(NOON_UTC);
    const snap = ledger.snapshot(NOON_UTC);
    expect(snap.spent).toBe(0);
    expect(snap.remaining).toBe(DEFAULT_DAILY_QUOTA);
    expect(snap.limit).toBe(DEFAULT_DAILY_QUOTA);
  });

  it('debita o custo de cada método', () => {
    const ledger = new QuotaLedger(NOON_UTC);
    ledger.charge('videos.list', NOON_UTC);
    ledger.charge('search.list', NOON_UTC);

    const snap = ledger.snapshot(NOON_UTC);
    expect(snap.spent).toBe(101);
    expect(snap.byMethod).toEqual({ 'videos.list': 1, 'search.list': 100 });
  });

  it('lança quando o orçamento não cobre a chamada', () => {
    const ledger = new QuotaLedger(NOON_UTC, 50);
    expect(() => ledger.charge('search.list', NOON_UTC)).toThrow(QuotaExhaustedError);
    // A tentativa recusada não debita nada.
    expect(ledger.snapshot(NOON_UTC).spent).toBe(0);
  });

  it('a exceção informa método, custo e saldo', () => {
    const ledger = new QuotaLedger(NOON_UTC, 30);
    try {
      ledger.charge('search.list', NOON_UTC);
      expect.unreachable();
    } catch (err) {
      const e = err as QuotaExhaustedError;
      expect(e.method).toBe('search.list');
      expect(e.cost).toBe(100);
      expect(e.remaining).toBe(30);
    }
  });

  it('zera na virada do dia do Pacífico', () => {
    const ledger = new QuotaLedger(Date.UTC(2026, 7, 17, 6, 0, 0)); // 16/08 no Pacífico
    ledger.charge('search.list', Date.UTC(2026, 7, 17, 6, 0, 0));
    expect(ledger.snapshot(Date.UTC(2026, 7, 17, 6, 30, 0)).spent).toBe(100);

    // 07:00Z já é 17/08 no Pacífico.
    const depois = ledger.snapshot(Date.UTC(2026, 7, 17, 7, 0, 0));
    expect(depois.spent).toBe(0);
    expect(depois.dayKey).toBe('2026-08-17');
  });

  it('canAfford concorda com charge', () => {
    const ledger = new QuotaLedger(NOON_UTC, 100);
    expect(ledger.canAfford('search.list', NOON_UTC)).toBe(true);
    ledger.charge('videos.list', NOON_UTC);
    expect(ledger.canAfford('search.list', NOON_UTC)).toBe(false);
    expect(() => ledger.charge('search.list', NOON_UTC)).toThrow();
  });

  describe('reserva para chamadas interativas', () => {
    it('jobs de fundo param 20% antes do teto', () => {
      const ledger = new QuotaLedger(NOON_UTC, 1_000, 0.2);
      expect(ledger.backgroundRemaining(NOON_UTC)).toBe(800);
    });

    it('o fundo é recusado enquanto o interativo ainda passa', () => {
      const ledger = new QuotaLedger(NOON_UTC, 1_000, 0.2);
      for (let i = 0; i < 800; i++) ledger.charge('videos.list', NOON_UTC, true);

      expect(ledger.canAfford('videos.list', NOON_UTC, true)).toBe(false);
      expect(ledger.canAfford('videos.list', NOON_UTC, false)).toBe(true);
      // A interface continua funcionando mesmo com os jobs de fundo travados.
      expect(() => ledger.charge('videos.list', NOON_UTC, false)).not.toThrow();
    });

    it('reserva zero deixa o fundo usar tudo', () => {
      const ledger = new QuotaLedger(NOON_UTC, 1_000, 0);
      expect(ledger.backgroundRemaining(NOON_UTC)).toBe(1_000);
    });
  });
});

describe('estimativas de custo', () => {
  it('conta uma chamada por página iniciada', () => {
    expect(estimatePagedCost('playlistItems.list', 0)).toBe(0);
    expect(estimatePagedCost('playlistItems.list', 1)).toBe(1);
    expect(estimatePagedCost('playlistItems.list', 50)).toBe(1);
    expect(estimatePagedCost('playlistItems.list', 51)).toBe(2);
  });

  it('quantifica por que search.list está fora de questão para montar pool', () => {
    // 200 canais × 50 vídeos pelo caminho barato.
    const barato = estimatePoolRefreshCost(200, 50);
    expect(barato).toBe(400);
    expect(barato).toBeLessThan(DEFAULT_DAILY_QUOTA);

    // O mesmo trabalho com uma busca por canal.
    const porBusca = 200 * QUOTA_COST['search.list'];
    expect(porBusca).toBe(20_000);
    // Exatamente o dobro da cota diária inteira: inviável, e 50× o caminho barato.
    expect(porBusca).toBe(DEFAULT_DAILY_QUOTA * 2);
    expect(porBusca / barato).toBe(50);
  });

  it('o caminho barato escala dentro do orçamento diário', () => {
    expect(estimatePoolRefreshCost(50, 50)).toBe(100);
    expect(estimatePoolRefreshCost(500, 50)).toBe(1_000);
    expect(estimatePoolRefreshCost(1_000, 50)).toBeLessThan(DEFAULT_DAILY_QUOTA);
  });
});
