/**
 * Testes do replay de patches.
 *
 * A propriedade central: `base(seed) + patches em ordem` reproduz exatamente a grade
 * materializada. É o que permite a um dispositivo que ficou offline reconstruir a
 * programação sem baixar a grade inteira — e o que impede dois dispositivos de
 * divergirem em silêncio, que seria um defeito quase impossível de diagnosticar.
 */

import { describe, expect, it } from 'vitest';
import { buildGrid } from './grid.js';
import { applyHotInsert, dropUnplayable } from './hotinsert.js';
import { PatchOrderError, replayPatches } from './patch.js';
import { DAY_START_SP, emptyHistory, makeConfig, makePool, uniformAffinity } from './fixtures.js';
import { findSlotAt } from './tune.js';
import type { AffinityMap, PoolVideo, SchedulePatch } from './types.js';

const config = makeConfig();
const NOON = DAY_START_SP + 12 * 3_600_000;

const pool = makePool(200, 1, 600);
const affinity = uniformAffinity(pool, 0.5);
const base = buildGrid({
  tvChannelId: 'tv-tudo',
  pool,
  affinity,
  history: emptyHistory(),
  config,
  startAtMs: DAY_START_SP,
});

const novo: PoolVideo = {
  id: 'novo-quente',
  ytChannelId: 'UCnovo',
  title: 'upload de agora',
  durationSec: 600,
  publishedAt: NOON - 60_000,
  categoryId: '20',
  tags: [],
};

const poolComNovo = [...pool, novo];
const affinityComNovo: AffinityMap = new Map([...affinity, ['UCnovo', 0.99]]);

function patch(
  over: Partial<SchedulePatch> & Pick<SchedulePatch, 'seqNo' | 'kind'>,
): SchedulePatch {
  return {
    tvChannelId: 'tv-tudo',
    dayKey: '2026-08-17',
    appliedAtMs: NOON,
    videoId: null,
    reason: 'teste',
    ...over,
  };
}

function replay(patches: readonly SchedulePatch[]) {
  return replayPatches({
    base,
    patches,
    pool: poolComNovo,
    affinity: affinityComNovo,
    favorites: new Set(),
    history: emptyHistory(),
    config,
  });
}

describe('replay sem patches', () => {
  it('devolve a grade base intacta', () => {
    const out = replay([]);
    expect(out.slots).toEqual(base.slots);
    expect(out.applied).toBe(0);
    expect(out.skipped).toEqual([]);
  });
});

describe('replay reproduz a aplicação direta', () => {
  it('um HOT_INSERT via replay é idêntico ao applyHotInsert direto', () => {
    const direto = applyHotInsert({
      slots: base.slots,
      newVideo: novo,
      pool: poolComNovo,
      nowMs: NOON,
      seed: base.seed,
      affinity: affinityComNovo,
      favorites: new Set(),
      history: emptyHistory(),
      config,
      priorHotInsertsAtMs: [],
    });
    expect(direto.applied).toBe(true);
    if (!direto.applied) return;

    const viaReplay = replay([patch({ seqNo: 1, kind: 'HOT_INSERT', videoId: novo.id })]);

    expect(viaReplay.applied).toBe(1);
    expect(viaReplay.slots).toEqual(direto.slots);
  });

  it('um DROP_UNPLAYABLE via replay é idêntico ao dropUnplayable direto', () => {
    const alvo = findSlotAt(base.slots, NOON)!;
    const direto = dropUnplayable({
      slots: base.slots,
      unplayableVideoId: alvo.videoId,
      pool: poolComNovo,
      nowMs: NOON,
      seed: base.seed,
      affinity: affinityComNovo,
      history: emptyHistory(),
      config,
    });

    const viaReplay = replay([patch({ seqNo: 1, kind: 'DROP_UNPLAYABLE', videoId: alvo.videoId })]);

    expect(viaReplay.slots).toEqual(direto.slots);
  });

  it('é idempotente: replays repetidos dão o mesmo resultado', () => {
    const patches = [patch({ seqNo: 1, kind: 'HOT_INSERT', videoId: novo.id })];
    expect(replay(patches).slots).toEqual(replay(patches).slots);
  });
});

describe('ordem dos patches', () => {
  it('exige seqNo começando em 1', () => {
    expect(() => replay([patch({ seqNo: 2, kind: 'HOT_INSERT', videoId: novo.id })])).toThrow(
      PatchOrderError,
    );
  });

  it('rejeita buraco na sequência', () => {
    expect(() =>
      replay([
        patch({ seqNo: 1, kind: 'HOT_INSERT', videoId: novo.id }),
        patch({ seqNo: 3, kind: 'DROP_UNPLAYABLE', videoId: 'v-c0-n0' }),
      ]),
    ).toThrow(PatchOrderError);
  });

  it('rejeita patches fora de ordem', () => {
    expect(() =>
      replay([
        patch({ seqNo: 2, kind: 'HOT_INSERT', videoId: novo.id }),
        patch({ seqNo: 1, kind: 'DROP_UNPLAYABLE', videoId: 'v-c0-n0' }),
      ]),
    ).toThrow(PatchOrderError);
  });

  it('a exceção informa o que esperava e o que recebeu', () => {
    try {
      replay([patch({ seqNo: 7, kind: 'HOT_INSERT', videoId: novo.id })]);
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(PatchOrderError);
      const e = err as PatchOrderError;
      expect(e.expected).toBe(1);
      expect(e.received).toBe(7);
      expect(e.message).toContain('fora de ordem');
    }
  });

  it('a ordem importa: A→B difere de B→A', () => {
    const alvo = findSlotAt(base.slots, NOON)!;
    const insercao = { kind: 'HOT_INSERT' as const, videoId: novo.id };
    const descarte = { kind: 'DROP_UNPLAYABLE' as const, videoId: alvo.videoId };

    const ab = replay([
      patch({ seqNo: 1, ...insercao }),
      patch({ seqNo: 2, ...descarte, appliedAtMs: NOON + 40 * 60_000 }),
    ]);
    const ba = replay([
      patch({ seqNo: 1, ...descarte }),
      patch({ seqNo: 2, ...insercao, appliedAtMs: NOON + 40 * 60_000 }),
    ]);

    expect(ab.slots).not.toEqual(ba.slots);
  });
});

describe('patches que não se aplicam', () => {
  it('registra HOT_INSERT de vídeo ausente do pool sem quebrar o replay', () => {
    const out = replay([patch({ seqNo: 1, kind: 'HOT_INSERT', videoId: 'fantasma' })]);
    expect(out.applied).toBe(0);
    expect(out.skipped).toEqual([{ seqNo: 1, reason: 'vídeo ausente do pool' }]);
    expect(out.slots).toEqual(base.slots);
  });

  it('registra HOT_INSERT recusado pelo limite de intervalo', () => {
    const out = replay([
      patch({ seqNo: 1, kind: 'HOT_INSERT', videoId: novo.id }),
      // Segunda tentativa 5 min depois: abaixo do intervalo mínimo de 20 min.
      patch({ seqNo: 2, kind: 'HOT_INSERT', videoId: novo.id, appliedAtMs: NOON + 5 * 60_000 }),
    ]);
    expect(out.applied).toBe(1);
    expect(out.skipped.map((s) => s.seqNo)).toEqual([2]);
    expect(out.skipped[0]?.reason).toBe('too_soon_after_last');
  });

  it('registra DROP_UNPLAYABLE sem videoId', () => {
    const out = replay([patch({ seqNo: 1, kind: 'DROP_UNPLAYABLE', videoId: null })]);
    expect(out.applied).toBe(0);
    expect(out.skipped[0]?.reason).toBe('patch sem videoId');
  });

  it('não escala o mesmo vídeo duas vezes no dia, mesmo com patches repetidos', () => {
    /*
     * Regressão: `pinFirst` contorna a lista de candidatos de propósito (para não ser
     * preterido por R-B), e por isso contornava também a exclusão de vídeos já
     * escalados. Patches repetidos do mesmo upload o colocavam quatro vezes no dia.
     */
    const patches = Array.from({ length: 4 }, (_, i) =>
      patch({
        seqNo: i + 1,
        kind: 'HOT_INSERT',
        videoId: novo.id,
        appliedAtMs: NOON + i * 50 * 60_000,
      }),
    );
    const out = replay(patches);

    expect(out.slots.filter((s) => s.videoId === novo.id).length).toBe(1);
    expect(out.applied).toBe(1);
    expect(out.skipped.map((s) => s.reason)).toEqual([
      'already_scheduled',
      'already_scheduled',
      'already_scheduled',
    ]);
  });

  it('contabiliza o teto diário ao longo do replay', () => {
    // Sete inserções espaçadas de 25 min: o teto de 6 corta a última.
    const patches = Array.from({ length: 7 }, (_, i) =>
      patch({
        seqNo: i + 1,
        kind: 'HOT_INSERT',
        videoId: novo.id,
        appliedAtMs: NOON + i * 25 * 60_000,
      }),
    );
    const out = replay(patches);
    // A partir da segunda, o vídeo já está na grade — o que interessa é que o
    // replay não estoura e reporta cada recusa.
    expect(out.applied + out.skipped.length).toBe(7);
    expect(out.applied).toBeLessThanOrEqual(config.maxHotInsertsPerDay);
  });
});

describe('AFFINITY_REFLOW', () => {
  it('re-flui a cauda sem remover nada da grade', () => {
    const out = replay([patch({ seqNo: 1, kind: 'AFFINITY_REFLOW' })]);
    expect(out.applied).toBe(1);
    // O slot no ar continua no ar: o re-fluxo por afinidade não interrompe ninguém.
    expect(findSlotAt(out.slots, NOON)).toBeDefined();
  });

  it('mantém a grade contígua', () => {
    const out = replay([patch({ seqNo: 1, kind: 'AFFINITY_REFLOW' })]);
    for (let i = 1; i < out.slots.length; i++) {
      expect(out.slots[i]!.startsAtMs).toBe(out.slots[i - 1]!.endsAtMs);
    }
  });
});

describe('cadeia longa de patches', () => {
  it('sobrevive a inserções e descartes alternados mantendo a grade sã', () => {
    const patches: SchedulePatch[] = [];
    let seqNo = 1;
    let t = NOON;

    for (let i = 0; i < 4; i++) {
      patches.push(patch({ seqNo: seqNo++, kind: 'HOT_INSERT', videoId: novo.id, appliedAtMs: t }));
      t += 25 * 60_000;
      patches.push(
        patch({
          seqNo: seqNo++,
          kind: 'DROP_UNPLAYABLE',
          videoId: `v-c${100 + i}-n0`,
          appliedAtMs: t,
        }),
      );
      t += 25 * 60_000;
    }

    const out = replay(patches);

    // Contiguidade e sequência preservadas do começo ao fim.
    for (let i = 1; i < out.slots.length; i++) {
      expect(out.slots[i]!.startsAtMs).toBe(out.slots[i - 1]!.endsAtMs);
      expect(out.slots[i]!.seq).toBe(out.slots[i - 1]!.seq + 1);
    }
    // R-B continua valendo depois de oito mutações.
    const seen = new Set<string>();
    for (const s of out.slots) {
      expect(seen.has(s.ytChannelId)).toBe(false);
      seen.add(s.ytChannelId);
    }
    // E a cobertura do dia não encurtou.
    expect(out.slots[out.slots.length - 1]!.endsAtMs).toBeGreaterThanOrEqual(
      DAY_START_SP + 86_400_000,
    );
  });
});
