import { describe, expect, it } from 'vitest';
import { buildGrid } from './grid.js';
import { DAY_START_SP, emptyHistory, makeConfig, makePool, uniformAffinity } from './fixtures.js';
import {
  computeTuneIn,
  describeErrorCode,
  evaluateDrift,
  findSlotAt,
  isUnplayableError,
  nextSlot,
  UNPLAYABLE_ERROR_CODES,
} from './tune.js';
import { RelaxLevel } from './types.js';
import type { ScheduleSlot } from './types.js';

const config = makeConfig();
const pool = makePool(200, 1, 600); // 200 canais, vídeos de 10 min
const grid = buildGrid({
  tvChannelId: 'tv-tudo',
  pool,
  affinity: uniformAffinity(pool),
  history: emptyHistory(),
  config,
  startAtMs: DAY_START_SP,
});

function slot(over: Partial<ScheduleSlot> = {}): ScheduleSlot {
  return {
    seq: 0,
    videoId: 'v1',
    ytChannelId: 'UC0',
    startsAtMs: DAY_START_SP,
    endsAtMs: DAY_START_SP + 600_000,
    durationSec: 600,
    relaxedTo: RelaxLevel.Strict,
    isHotInsert: false,
    ...over,
  };
}

describe('findSlotAt', () => {
  it('acha o slot que contém o instante', () => {
    // 90 min depois da meia-noite = 10º slot de 10 min (índice 9).
    const found = findSlotAt(grid.slots, DAY_START_SP + 90 * 60_000);
    expect(found?.seq).toBe(9);
  });

  it('o início do slot pertence ao slot; o fim, ao seguinte', () => {
    const s = grid.slots[5]!;
    expect(findSlotAt(grid.slots, s.startsAtMs)?.seq).toBe(5);
    expect(findSlotAt(grid.slots, s.endsAtMs)?.seq).toBe(6);
    expect(findSlotAt(grid.slots, s.endsAtMs - 1)?.seq).toBe(5);
  });

  it('devolve undefined fora da cobertura', () => {
    expect(findSlotAt(grid.slots, DAY_START_SP - 1)).toBeUndefined();
    expect(findSlotAt(grid.slots, grid.coverageEndMs)).toBeUndefined();
  });

  it('devolve undefined para grade vazia', () => {
    expect(findSlotAt([], DAY_START_SP)).toBeUndefined();
  });

  it('concorda com a varredura linear em toda a grade', () => {
    for (let i = 0; i < grid.slots.length; i++) {
      const s = grid.slots[i]!;
      const mid = s.startsAtMs + Math.floor((s.endsAtMs - s.startsAtMs) / 2);
      expect(findSlotAt(grid.slots, mid)?.seq).toBe(s.seq);
    }
  });
});

describe('computeTuneIn', () => {
  it('calcula o offset de entrada no meio do vídeo', () => {
    const s = grid.slots[3]!;
    const tune = computeTuneIn(grid.slots, s.startsAtMs + 137_000);
    expect(tune?.slot.seq).toBe(3);
    expect(tune?.startSeconds).toBe(137);
  });

  it('entra em zero no início exato do slot', () => {
    const s = grid.slots[3]!;
    expect(computeTuneIn(grid.slots, s.startsAtMs)?.startSeconds).toBe(0);
  });

  it('nunca devolve startSeconds igual à duração', () => {
    // Pedir startSeconds == duração faz o player disparar ENDED na hora e o canal
    // entra em laço de troca. O clamp é o que evita isso.
    const s = grid.slots[3]!;
    const tune = computeTuneIn(grid.slots, s.endsAtMs - 1);
    expect(tune?.startSeconds).toBe(599);
    expect(tune!.startSeconds).toBeLessThan(s.durationSec);
  });

  it('trunca fração de segundo para baixo', () => {
    const s = grid.slots[0]!;
    expect(computeTuneIn(grid.slots, s.startsAtMs + 5_999)?.startSeconds).toBe(5);
  });

  it('devolve null fora da grade', () => {
    expect(computeTuneIn(grid.slots, DAY_START_SP - 1000)).toBeNull();
  });

  it('reconstrói a mesma posição a qualquer momento — sem estado acumulado', () => {
    // Simula o app voltando do background depois de 7 horas: a posição correta sai
    // do relógio, não de seq + 1.
    const later = DAY_START_SP + 7 * 3_600_000 + 42_000;
    const a = computeTuneIn(grid.slots, later);
    const b = computeTuneIn(grid.slots, later);
    expect(b).toEqual(a);
    expect(a?.slot.seq).toBe(42);
    expect(a?.startSeconds).toBe(42);
  });
});

describe('nextSlot', () => {
  it('avança um slot', () => {
    expect(nextSlot(grid.slots, grid.slots[10]!)?.seq).toBe(11);
  });

  it('devolve undefined no fim da grade', () => {
    expect(nextSlot(grid.slots, grid.slots[grid.slots.length - 1]!)).toBeUndefined();
  });
});

describe('evaluateDrift', () => {
  const s = slot();

  it('não corrige quando está dentro da tolerância', () => {
    const d = evaluateDrift({
      slot: s,
      nowMs: s.startsAtMs + 100_000,
      playerCurrentSec: 102,
      alreadyCorrected: false,
    });
    expect(d.shouldSeek).toBe(false);
    expect(d.driftSec).toBeCloseTo(2, 6);
  });

  it('corrige quando o player está adiantado além da tolerância', () => {
    const d = evaluateDrift({
      slot: s,
      nowMs: s.startsAtMs + 100_000,
      playerCurrentSec: 130,
      alreadyCorrected: false,
    });
    expect(d.shouldSeek).toBe(true);
    expect(d.driftSec).toBeCloseTo(30, 6);
    expect(d.targetSec).toBeCloseTo(100, 6);
  });

  it('corrige quando o player está atrasado além da tolerância', () => {
    const d = evaluateDrift({
      slot: s,
      nowMs: s.startsAtMs + 100_000,
      playerCurrentSec: 40,
      alreadyCorrected: false,
    });
    expect(d.shouldSeek).toBe(true);
    expect(d.driftSec).toBeCloseTo(-60, 6);
  });

  it('não corrige duas vezes no mesmo slot', () => {
    // Sem esse freio, um vídeo com duração real diferente da armazenada entra em
    // laço de seekTo e trava a reprodução.
    const d = evaluateDrift({
      slot: s,
      nowMs: s.startsAtMs + 100_000,
      playerCurrentSec: 500,
      alreadyCorrected: true,
    });
    expect(d.shouldSeek).toBe(false);
  });

  it('limita o alvo a duração - 1', () => {
    const d = evaluateDrift({
      slot: s,
      nowMs: s.endsAtMs + 30_000, // relógio já passou do fim do slot
      playerCurrentSec: 10,
      alreadyCorrected: false,
    });
    expect(d.targetSec).toBe(599);
  });

  it('respeita tolerância customizada', () => {
    const base = {
      slot: s,
      nowMs: s.startsAtMs + 100_000,
      playerCurrentSec: 103,
      alreadyCorrected: false,
    };
    expect(evaluateDrift(base).shouldSeek).toBe(false);
    expect(evaluateDrift({ ...base, toleranceSec: 1 }).shouldSeek).toBe(true);
  });
});

describe('classificação de erros do player', () => {
  it('reconhece os códigos que significam "não vai tocar aqui"', () => {
    for (const code of UNPLAYABLE_ERROR_CODES) {
      expect(isUnplayableError(code)).toBe(true);
    }
  });

  it('ignora códigos desconhecidos', () => {
    expect(isUnplayableError(0)).toBe(false);
    expect(isUnplayableError(42)).toBe(false);
  });

  it('descreve 101 e 150 como o mesmo problema de embed', () => {
    expect(describeErrorCode(101)).toBe(describeErrorCode(150));
    expect(describeErrorCode(101)).toContain('embed');
  });

  it('descreve os demais códigos conhecidos', () => {
    expect(describeErrorCode(2)).toContain('inválido');
    expect(describeErrorCode(100)).toContain('removido');
    expect(describeErrorCode(999)).toContain('desconhecido');
  });
});
