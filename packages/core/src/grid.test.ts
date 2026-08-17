/**
 * Testes das duas regras de programação:
 *   R-A — mais recente antes do mais antigo
 *   R-B — não repetir o mesmo canal do YouTube no mesmo dia
 *
 * São as regras que definem a sensação de "TV" do produto, então recebem a maior
 * densidade de asserções do projeto.
 */

import { describe, expect, it } from 'vitest';
import { buildGrid, buildGridForDay } from './grid.js';
import {
  affinityOf,
  DAY_START_SP,
  emptyHistory,
  historyOf,
  makeConfig,
  makePool,
  makeVideo,
  TZ_SP,
  uniformAffinity,
} from './fixtures.js';
import { localDayKey } from './time.js';
import { RelaxLevel } from './types.js';
import type { PoolVideo, ScheduleSlot } from './types.js';

const config = makeConfig();

function build(pool: readonly PoolVideo[], over: Parameters<typeof makeConfig>[0] = {}) {
  const cfg = makeConfig(over);
  return buildGrid({
    tvChannelId: 'tv-tudo',
    pool,
    affinity: uniformAffinity(pool),
    history: emptyHistory(),
    config: cfg,
    startAtMs: DAY_START_SP,
  });
}

/** Chaves de dia de publicação na ordem em que os slots vão ao ar. */
function publishedDayKeys(slots: readonly ScheduleSlot[], pool: readonly PoolVideo[]): string[] {
  const byId = new Map(pool.map((v) => [v.id, v]));
  return slots.map((s) => {
    const v = byId.get(s.videoId);
    if (!v) throw new Error(`slot referencia vídeo fora do pool: ${s.videoId}`);
    return localDayKey(v.publishedAt, TZ_SP);
  });
}

describe('estrutura da grade', () => {
  it('cobre as 24 horas pedidas', () => {
    const pool = makePool(40, 10, 600);
    const { slots, coverageEndMs, poolExhausted } = build(pool);

    expect(poolExhausted).toBe(false);
    expect(coverageEndMs).toBeGreaterThanOrEqual(DAY_START_SP + 86_400_000);
    // 24h divididas por vídeos de 10 min dão 144 slots exatos, sem slot a cavalo.
    expect(slots.length).toBe(144);
    expect(coverageEndMs).toBe(DAY_START_SP + 86_400_000);
  });

  it('deixa o último slot atravessar a fronteira quando a duração não divide o dia', () => {
    // 7 min não divide 24h: o último slot começa antes da fronteira e termina depois.
    const pool = makePool(300, 1, 420);
    const { slots, coverageEndMs } = build(pool);
    const last = slots[slots.length - 1]!;

    expect(last.startsAtMs).toBeLessThan(DAY_START_SP + 86_400_000);
    expect(last.endsAtMs).toBeGreaterThan(DAY_START_SP + 86_400_000);
    expect(coverageEndMs).toBe(last.endsAtMs);
  });

  it('gera slots contíguos, sem buraco nem sobreposição', () => {
    const { slots } = build(makePool(40, 10));
    expect(slots[0]?.startsAtMs).toBe(DAY_START_SP);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i]!.startsAtMs).toBe(slots[i - 1]!.endsAtMs);
    }
  });

  it('mantém seq sequencial começando em zero', () => {
    const { slots } = build(makePool(40, 10));
    slots.forEach((s, i) => expect(s.seq).toBe(i));
  });

  it('respeita endsAtMs = startsAtMs + duração', () => {
    const { slots } = build(makePool(40, 10));
    for (const s of slots) {
      expect(s.endsAtMs - s.startsAtMs).toBe(s.durationSec * 1000);
    }
  });
});

describe('R-A — mais recente antes do mais antigo', () => {
  it('o bucket de dia de publicação é monotonicamente não-crescente', () => {
    const pool = makePool(40, 10);
    const { slots } = build(pool);
    const keys = publishedDayKeys(slots, pool);

    for (let i = 1; i < keys.length; i++) {
      expect(keys[i]! <= keys[i - 1]!).toBe(true);
    }
  });

  it('um vídeo de ontem nunca passa depois de um de um mês atrás', () => {
    // As idades são escolhidas para cair em dias locais distintos: a grade começa
    // à meia-noite, então `ageDays: 1` é o dia anterior inteiro, não "hoje".
    const pool = [
      makeVideo({ id: 'antigo', ytChannelId: 'UCa', ageDays: 30 }),
      makeVideo({ id: 'ontem', ytChannelId: 'UCb', ageDays: 1 }),
      makeVideo({ id: 'anteontem', ytChannelId: 'UCc', ageDays: 2 }),
    ];
    const { slots } = build(pool);
    expect(slots.slice(0, 3).map((s) => s.videoId)).toEqual(['ontem', 'anteontem', 'antigo']);
  });

  it('empata no mesmo bucket quando dois vídeos caem no mesmo dia local', () => {
    // 0,1 dia antes da meia-noite ainda é o dia anterior — mesma coisa que ageDays 1.
    // O teste registra essa sutileza para quem for mexer nas fixtures depois.
    const pool = [
      makeVideo({ id: 'noite-de-ontem', ytChannelId: 'UCa', ageDays: 0.1 }),
      makeVideo({ id: 'manha-de-ontem', ytChannelId: 'UCb', ageDays: 1 }),
    ];
    const keys = publishedDayKeys(build(pool).slots.slice(0, 2), pool);
    expect(keys[0]).toBe(keys[1]);
  });

  it('o jitter reordena dentro do mesmo dia, mas nunca entre dias', () => {
    // Seis vídeos do mesmo dia em canais distintos, e um bem antigo no fim.
    const sameDay = Array.from({ length: 6 }, (_, i) =>
      makeVideo({ id: `mesmo-${i}`, ytChannelId: `UC${i}`, ageDays: 1 }),
    );
    const pool = [...sameDay, makeVideo({ id: 'velho', ytChannelId: 'UCz', ageDays: 20 })];

    const ordersSeen = new Set<string>();
    for (const tvChannelId of ['tv-1', 'tv-2', 'tv-3', 'tv-4', 'tv-5']) {
      const { slots } = buildGrid({
        tvChannelId,
        pool,
        affinity: uniformAffinity(pool),
        history: emptyHistory(),
        config,
        startAtMs: DAY_START_SP,
      });
      const firstSix = slots.slice(0, 6).map((s) => s.videoId);
      // 'velho' nunca invade os seis primeiros: R-A é inviolável entre dias.
      expect(firstSix).not.toContain('velho');
      expect(slots[6]?.videoId).toBe('velho');
      ordersSeen.add(firstSix.join(','));
    }
    // Seeds diferentes produzem ordens diferentes dentro do dia.
    expect(ordersSeen.size).toBeGreaterThan(1);
  });

  it('prioriza inéditos sobre já exibidos, mesmo quando os já exibidos são mais recentes', () => {
    const pool = [
      makeVideo({ id: 'recente-visto', ytChannelId: 'UCa', ageDays: 0.2 }),
      makeVideo({ id: 'antigo-inedito', ytChannelId: 'UCb', ageDays: 10 }),
    ];
    const { slots } = buildGrid({
      tvChannelId: 'tv-1',
      pool,
      affinity: uniformAffinity(pool),
      history: historyOf('recente-visto'),
      config,
      startAtMs: DAY_START_SP,
    });
    expect(slots[0]?.videoId).toBe('antigo-inedito');
  });

  it('desempata por afinidade dentro do mesmo dia', () => {
    const pool = [
      makeVideo({ id: 'de-canal-fraco', ytChannelId: 'UCfraco', ageDays: 1 }),
      makeVideo({ id: 'de-canal-forte', ytChannelId: 'UCforte', ageDays: 1 }),
    ];
    // Diferença grande o suficiente para o jitter de ±10% não inverter.
    const { slots } = buildGrid({
      tvChannelId: 'tv-1',
      pool,
      affinity: affinityOf({ UCfraco: 0.1, UCforte: 0.95 }),
      history: emptyHistory(),
      config,
      startAtMs: DAY_START_SP,
    });
    expect(slots[0]?.videoId).toBe('de-canal-forte');
  });
});

describe('R-B — um canal por dia', () => {
  it('com canais suficientes, nenhum canal aparece duas vezes no dia', () => {
    // 200 canais × 1 vídeo de 10 min = 2000 min > 24h, então o dia inteiro é coberto
    // sem precisar reusar canal.
    const pool = makePool(200, 1, 600);
    const { slots, maxRelaxUsed } = build(pool);

    const seen = new Set<string>();
    for (const s of slots) {
      expect(seen.has(s.ytChannelId)).toBe(false);
      seen.add(s.ytChannelId);
    }
    expect(maxRelaxUsed).toBe(RelaxLevel.Strict);
    expect(slots.every((s) => s.relaxedTo === RelaxLevel.Strict)).toBe(true);
  });

  it('vale para 30 dias sintéticos consecutivos', () => {
    const pool = makePool(200, 1, 600);
    for (let day = 0; day < 30; day++) {
      const startAtMs = DAY_START_SP + day * 86_400_000;
      const { slots } = buildGrid({
        tvChannelId: 'tv-tudo',
        pool,
        affinity: uniformAffinity(pool),
        history: emptyHistory(),
        config,
        startAtMs,
      });
      const seen = new Set<string>();
      for (const s of slots) {
        expect(seen.has(s.ytChannelId)).toBe(false);
        seen.add(s.ytChannelId);
      }
    }
  });

  it('prefere canal inédito mesmo quando um vídeo mais recente repetiria o canal', () => {
    const pool = [
      makeVideo({ id: 'a1', ytChannelId: 'UCa', ageDays: 1 }),
      makeVideo({ id: 'a2', ytChannelId: 'UCa', ageDays: 1.5 }), // mesmo canal, 2º mais recente
      makeVideo({ id: 'b1', ytChannelId: 'UCb', ageDays: 5 }),
    ];
    const { slots } = build(pool);
    // R-B empurra 'a2' para trás de 'b1', apesar de 'a2' ser mais recente.
    expect(slots.slice(0, 3).map((s) => s.videoId)).toEqual(['a1', 'b1', 'a2']);
  });
});

describe('relaxamento em cascata', () => {
  it('pool de 3 canais nunca coloca dois slots seguidos do mesmo canal', () => {
    // 3 canais × 20 vídeos de 10 min = 600 min < 24h, então R-B estrito é impossível.
    const pool = makePool(3, 20, 600);
    const { slots, maxRelaxUsed } = build(pool);

    expect(maxRelaxUsed).toBeGreaterThan(RelaxLevel.Strict);
    expect(maxRelaxUsed).toBeLessThanOrEqual(RelaxLevel.Distance2);

    for (let i = 1; i < slots.length; i++) {
      expect(slots[i]!.ytChannelId).not.toBe(slots[i - 1]!.ytChannelId);
    }
  });

  it('marca relaxedTo em cada slot que precisou relaxar', () => {
    const { slots } = build(makePool(3, 20, 600));
    const relaxed = slots.filter((s) => s.relaxedTo > RelaxLevel.Strict);
    expect(relaxed.length).toBeGreaterThan(0);
    // Os três primeiros slots ainda são de canais inéditos.
    expect(slots.slice(0, 3).every((s) => s.relaxedTo === RelaxLevel.Strict)).toBe(true);
  });

  it('canal único degenera para RelaxLevel.Any sem travar', () => {
    const pool = makePool(1, 30, 600);
    const { slots, maxRelaxUsed } = build(pool);

    expect(maxRelaxUsed).toBe(RelaxLevel.Any);
    expect(slots.length).toBeGreaterThan(100);
    expect(slots.every((s) => s.ytChannelId === 'UC0')).toBe(true);
  });

  it('pool vazio devolve grade vazia em vez de laçar', () => {
    const { slots, poolExhausted, coverageEndMs } = build([]);
    expect(slots).toEqual([]);
    expect(poolExhausted).toBe(true);
    expect(coverageEndMs).toBe(DAY_START_SP);
  });

  it('pool cujos vídeos são todos filtrados devolve grade vazia', () => {
    // Shorts de 30s com minDurationSec = 60.
    const pool = makePool(5, 5, 30);
    const { slots, poolExhausted } = build(pool);
    expect(slots).toEqual([]);
    expect(poolExhausted).toBe(true);
  });
});

describe('determinismo', () => {
  it('mesmo seed e mesmo pool geram grade idêntica', () => {
    const pool = makePool(40, 5);
    const a = build(pool);
    const b = build(pool);
    expect(b.slots).toEqual(a.slots);
    expect(b.seed).toBe(a.seed);
  });

  it('a ordem do pool de entrada não afeta a grade', () => {
    const pool = makePool(40, 5);
    const shuffled = [...pool].reverse();
    expect(build(shuffled).slots).toEqual(build(pool).slots);
  });

  it('canais de TV diferentes geram grades diferentes do mesmo pool', () => {
    const pool = makePool(40, 5);
    const common = {
      pool,
      affinity: uniformAffinity(pool),
      history: emptyHistory(),
      config,
      startAtMs: DAY_START_SP,
    };
    const a = buildGrid({ tvChannelId: 'tv-1', ...common });
    const b = buildGrid({ tvChannelId: 'tv-2', ...common });
    expect(b.slots.map((s) => s.videoId)).not.toEqual(a.slots.map((s) => s.videoId));
  });

  it('dias diferentes geram grades diferentes', () => {
    const pool = makePool(40, 5);
    const common = {
      tvChannelId: 'tv-1',
      pool,
      affinity: uniformAffinity(pool),
      history: emptyHistory(),
      config,
    };
    const d1 = buildGrid({ ...common, startAtMs: DAY_START_SP });
    const d2 = buildGrid({ ...common, startAtMs: DAY_START_SP + 86_400_000 });
    expect(d2.dayKey).not.toBe(d1.dayKey);
    expect(d2.slots.map((s) => s.videoId)).not.toEqual(d1.slots.map((s) => s.videoId));
  });

  it('não repete vídeo dentro do mesmo dia enquanto houver inéditos', () => {
    const pool = makePool(200, 1, 600);
    const { slots } = build(pool);
    const ids = slots.map((s) => s.videoId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('buildGridForDay', () => {
  it('ancora na meia-noite local independentemente da hora do "agora"', () => {
    const pool = makePool(40, 5);
    const args = {
      tvChannelId: 'tv-1',
      pool,
      affinity: uniformAffinity(pool),
      history: emptyHistory(),
      config,
    };
    const manha = buildGridForDay({ ...args, nowMs: DAY_START_SP + 8 * 3_600_000 });
    const noite = buildGridForDay({ ...args, nowMs: DAY_START_SP + 22 * 3_600_000 });

    expect(manha.slots[0]?.startsAtMs).toBe(DAY_START_SP);
    expect(noite.slots).toEqual(manha.slots);
    expect(noite.dayKey).toBe('2026-08-17');
  });
});
