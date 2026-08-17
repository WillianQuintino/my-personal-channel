import { describe, expect, it } from 'vitest';
import {
  comparePriority,
  filterEligible,
  rank,
  recencyBucket,
  sortByPriority,
} from './priority.js';
import { fillSlots } from './fill.js';
import {
  affinityOf,
  DAY_START_SP,
  emptyHistory,
  historyOf,
  makeConfig,
  makePool,
  makeVideo,
  uniformAffinity,
} from './fixtures.js';
import { RelaxLevel } from './types.js';
import type { RankOptions } from './priority.js';

const config = makeConfig();
const H = 3_600_000;

function opts(over: Partial<RankOptions> = {}): RankOptions {
  return {
    seed: 12345,
    affinity: affinityOf({ UCa: 0.5, UCb: 0.5 }),
    history: emptyHistory(),
    config,
    referenceMs: DAY_START_SP,
    ...over,
  };
}

describe('recencyBucket', () => {
  it('coloca tudo dentro da primeira janela no bucket 0', () => {
    expect(recencyBucket(DAY_START_SP - 0 * H, DAY_START_SP, 6)).toBe(0);
    expect(recencyBucket(DAY_START_SP - 5.9 * H, DAY_START_SP, 6)).toBe(0);
  });

  it('avança um bucket por janela completa', () => {
    expect(recencyBucket(DAY_START_SP - 6 * H, DAY_START_SP, 6)).toBe(1);
    expect(recencyBucket(DAY_START_SP - 24 * H, DAY_START_SP, 6)).toBe(4);
  });

  it('trata publicação no futuro como o bucket mais novo', () => {
    expect(recencyBucket(DAY_START_SP + 10 * H, DAY_START_SP, 6)).toBe(0);
  });

  it('separa "agora" de "mais cedo hoje" — o caso que o bucket diário errava', () => {
    // 40 min atrás contra 12 h atrás: com bucket de dia empatariam, e a inserção
    // a quente perderia para um vídeo da manhã.
    const agora = recencyBucket(DAY_START_SP - 0.66 * H, DAY_START_SP, 6);
    const manha = recencyBucket(DAY_START_SP - 12 * H, DAY_START_SP, 6);
    expect(agora).toBeLessThan(manha);
  });

  it('tolera largura de janela inválida sem dividir por zero', () => {
    expect(Number.isFinite(recencyBucket(DAY_START_SP - H, DAY_START_SP, 0))).toBe(true);
  });
});

describe('filterEligible', () => {
  it('descarta Shorts abaixo da duração mínima', () => {
    const pool = [
      makeVideo({ id: 'short', ytChannelId: 'UCa', durationSec: 45 }),
      makeVideo({ id: 'normal', ytChannelId: 'UCa', durationSec: 600 }),
    ];
    expect(filterEligible(pool, config).map((v) => v.id)).toEqual(['normal']);
  });

  it('descarta duração zero ou negativa', () => {
    const pool = [
      makeVideo({ id: 'zero', ytChannelId: 'UCa', durationSec: 0 }),
      makeVideo({ id: 'neg', ytChannelId: 'UCa', durationSec: -5 }),
    ];
    expect(filterEligible(pool, config)).toEqual([]);
  });

  it('aplica duração máxima quando configurada', () => {
    const pool = [
      makeVideo({ id: 'curto', ytChannelId: 'UCa', durationSec: 600 }),
      makeVideo({ id: 'filme', ytChannelId: 'UCa', durationSec: 9_000 }),
    ];
    expect(filterEligible(pool, makeConfig({ maxDurationSec: 3_600 })).map((v) => v.id)).toEqual([
      'curto',
    ]);
  });

  it('sem limite máximo, aceita vídeos longos', () => {
    const pool = [makeVideo({ id: 'live8h', ytChannelId: 'UCa', durationSec: 28_800 })];
    expect(filterEligible(pool, config).map((v) => v.id)).toEqual(['live8h']);
  });
});

describe('comparePriority', () => {
  it('inédito vence já exibido, independentemente da recência', () => {
    const pool = [
      makeVideo({ id: 'visto', ytChannelId: 'UCa', ageDays: 0.1 }),
      makeVideo({ id: 'inedito', ytChannelId: 'UCb', ageDays: 30 }),
    ];
    const ranked = rank(pool, opts({ history: historyOf('visto') })).sort(comparePriority);
    expect(ranked[0]?.video.id).toBe('inedito');
  });

  it('bucket mais novo vence bucket mais antigo', () => {
    const pool = [
      makeVideo({ id: 'velho', ytChannelId: 'UCa', ageDays: 5 }),
      makeVideo({ id: 'novo', ytChannelId: 'UCb', ageDays: 0.1 }),
    ];
    const ranked = rank(pool, opts()).sort(comparePriority);
    expect(ranked.map((r) => r.video.id)).toEqual(['novo', 'velho']);
  });

  it('é um comparador total: ordena igual em qualquer ordem de entrada', () => {
    const pool = makePool(12, 4);
    const a = sortByPriority(pool, opts({ affinity: uniformAffinity(pool) }));
    const b = sortByPriority([...pool].reverse(), opts({ affinity: uniformAffinity(pool) }));
    expect(b.map((v) => v.id)).toEqual(a.map((v) => v.id));
  });

  it('desempata por id quando afinidade e bucket coincidem', () => {
    // Afinidade zero em ambos anula o jitter, então só resta o id.
    const pool = [
      makeVideo({ id: 'zzz', ytChannelId: 'UCx', ageDays: 1 }),
      makeVideo({ id: 'aaa', ytChannelId: 'UCx', ageDays: 1 }),
    ];
    const sorted = sortByPriority(pool, opts({ affinity: new Map() }));
    expect(sorted.map((v) => v.id)).toEqual(['aaa', 'zzz']);
  });
});

describe('referenceMs', () => {
  it('muda a ordem conforme o instante de referência avança', () => {
    const pool = [
      makeVideo({ id: 'a', ytChannelId: 'UCa', ageDays: 0.1 }),
      makeVideo({ id: 'b', ytChannelId: 'UCb', ageDays: 2 }),
    ];
    const naMeiaNoite = sortByPriority(pool, opts()).map((v) => v.id);
    // Referência 10 dias depois: os dois viram "antigos" e caem em buckets distantes,
    // mas a ordem relativa por recência se mantém.
    const dezDiasDepois = sortByPriority(
      pool,
      opts({ referenceMs: DAY_START_SP + 10 * 86_400_000 }),
    ).map((v) => v.id);
    expect(naMeiaNoite).toEqual(['a', 'b']);
    expect(dezDiasDepois).toEqual(['a', 'b']);
  });
});

describe('pino de preenchimento (pinFirst)', () => {
  /**
   * Regressão do defeito que o pino existe para corrigir: sem ele, o nível estrito
   * de R-B sempre achava outro canal inédito e o vídeo de maior prioridade era
   * preterido a cada slot, para sempre.
   */
  it('sem pino, um vídeo de canal já usado é preterido indefinidamente', () => {
    const pool = makePool(50, 1, 600);
    const repetido = makeVideo({ id: 'repetido', ytChannelId: 'UC0', durationSec: 600 });
    const candidates = [repetido, ...pool];

    const semPino = fillSlots({
      candidates,
      startAtMs: DAY_START_SP,
      coverageSec: 3_600, // 6 slots
      startSeq: 0,
      preUsedLastSeq: new Map([['UC0', 0]]),
    });

    expect(semPino.slots.some((s) => s.videoId === 'repetido')).toBe(false);
  });

  it('com pino, entra na primeira posição em que R-B permite', () => {
    const pool = makePool(50, 1, 600);
    const repetido = makeVideo({ id: 'repetido', ytChannelId: 'UC0', durationSec: 600 });

    const comPino = fillSlots({
      candidates: [repetido, ...pool],
      startAtMs: DAY_START_SP,
      coverageSec: 3_600,
      startSeq: 2,
      preUsedLastSeq: new Map([['UC0', 0]]),
      pinFirst: repetido,
    });

    const posicao = comPino.slots.findIndex((s) => s.videoId === 'repetido');
    expect(posicao).toBe(0); // seq 2, distância 2 do último uso: Distance2 permite
    expect(comPino.slots[0]?.relaxedTo).toBe(RelaxLevel.Distance2);
  });

  it('o pino espera quando o canal acabou de passar, em vez de colar', () => {
    const pool = makePool(50, 1, 600);
    const repetido = makeVideo({ id: 'repetido', ytChannelId: 'UC0', durationSec: 600 });

    const out = fillSlots({
      candidates: [repetido, ...pool],
      startAtMs: DAY_START_SP,
      coverageSec: 3_600,
      startSeq: 5,
      preUsedLastSeq: new Map([['UC0', 4]]), // canal usado no slot imediatamente anterior
      pinFirst: repetido,
    });

    // Distância 1 não basta; entra no slot seguinte, com distância 2.
    expect(out.slots[0]?.videoId).not.toBe('repetido');
    expect(out.slots[1]?.videoId).toBe('repetido');
  });

  it('o pino não usa o nível Any para furar a fila', () => {
    /*
     * Pool de um único canal, o mesmo do pino, com o canal ocupando o slot anterior:
     * nenhum nível até Distance2 permite. O pino cede a vez.
     *
     * A cascata normal ainda pode escolher esse mesmo vídeo — num pool de um canal
     * tudo entra em `Any`. O que o teste garante é que ele não recebeu tratamento
     * privilegiado: o slot é marcado `Any`, não `Distance2`.
     */
    const soUmCanal = makePool(1, 5, 600);
    const repetido = makeVideo({ id: 'pin-mesmo-canal', ytChannelId: 'UC0', durationSec: 600 });

    const out = fillSlots({
      candidates: [...soUmCanal, repetido],
      startAtMs: DAY_START_SP,
      coverageSec: 1_200,
      startSeq: 1,
      preUsedLastSeq: new Map([['UC0', 0]]),
      pinFirst: repetido,
    });

    expect(out.slots[0]?.relaxedTo).toBe(RelaxLevel.Any);
    // A cascata normal respeita a ordem dos candidatos, então o pino não vem primeiro.
    expect(out.slots[0]?.videoId).not.toBe('pin-mesmo-canal');
  });

  it('pino de canal inédito entra imediatamente, em nível estrito', () => {
    const pool = makePool(50, 1, 600);
    const novo = makeVideo({ id: 'novo', ytChannelId: 'UCnovo', durationSec: 600 });

    const out = fillSlots({
      candidates: [novo, ...pool],
      startAtMs: DAY_START_SP,
      coverageSec: 3_600,
      startSeq: 0,
      preUsedLastSeq: new Map(),
      pinFirst: novo,
    });

    expect(out.slots[0]?.videoId).toBe('novo');
    expect(out.slots[0]?.relaxedTo).toBe(RelaxLevel.Strict);
  });
});
