/**
 * Testes da inserção a quente (§2b).
 *
 * O invariante que estes testes protegem acima de tudo: **o slot no ar e a zona
 * congelada são bit-idênticos antes e depois do patch**. Se isso quebrar, o usuário
 * vê o vídeo pular sozinho — o pior defeito possível num produto que imita TV.
 */

import { describe, expect, it } from 'vitest';
import { buildGrid } from './grid.js';
import {
  affinityOf,
  DAY_START_SP,
  emptyHistory,
  makeConfig,
  makePool,
  makeVideo,
  uniformAffinity,
} from './fixtures.js';
import {
  applyHotInsert,
  computeZones,
  dropUnplayable,
  evaluateHotInsertGate,
  relevanceScore,
  topKChannels,
} from './hotinsert.js';
import { findSlotAt } from './tune.js';
import type { AffinityMap, PoolVideo } from './types.js';

const config = makeConfig();
const NOON = DAY_START_SP + 12 * 3_600_000;

const basePool = makePool(200, 1, 600);
const baseAffinity = uniformAffinity(basePool, 0.5);
const baseGrid = buildGrid({
  tvChannelId: 'tv-tudo',
  pool: basePool,
  affinity: baseAffinity,
  history: emptyHistory(),
  config,
  startAtMs: DAY_START_SP,
});

/** Vídeo publicado agora, num canal que não está no pool base. */
function freshVideo(over: Partial<PoolVideo> = {}): PoolVideo {
  return {
    id: 'novo-quente',
    ytChannelId: 'UCnovo',
    title: 'upload de agora',
    durationSec: 600,
    publishedAt: NOON - 60_000,
    categoryId: '20',
    tags: [],
    ...over,
  };
}

function withNewChannel(affinity: AffinityMap, ch: string, value: number): AffinityMap {
  const m = new Map(affinity);
  m.set(ch, value);
  return m;
}

function insert(
  video: PoolVideo,
  opts: {
    nowMs?: number;
    affinity?: AffinityMap;
    favorites?: ReadonlySet<string>;
    priorHotInsertsAtMs?: readonly number[];
    slots?: typeof baseGrid.slots;
    pool?: readonly PoolVideo[];
  } = {},
) {
  const affinity = opts.affinity ?? withNewChannel(baseAffinity, video.ytChannelId, 0.99);
  return applyHotInsert({
    slots: opts.slots ?? baseGrid.slots,
    newVideo: video,
    pool: opts.pool ?? [...basePool, video],
    nowMs: opts.nowMs ?? NOON,
    seed: baseGrid.seed,
    affinity,
    favorites: opts.favorites ?? new Set(),
    history: emptyHistory(),
    config,
    priorHotInsertsAtMs: opts.priorHotInsertsAtMs ?? [],
  });
}

describe('relevanceScore', () => {
  it('cai com a idade do vídeo', () => {
    const affinity = affinityOf({ UCa: 1 });
    const agora = relevanceScore({
      video: freshVideo({ ytChannelId: 'UCa', publishedAt: NOON }),
      nowMs: NOON,
      affinity,
      config,
    });
    const seisHoras = relevanceScore({
      video: freshVideo({ ytChannelId: 'UCa', publishedAt: NOON - 6 * 3_600_000 }),
      nowMs: NOON,
      affinity,
      config,
    });
    expect(agora).toBeCloseTo(1, 6);
    expect(seisHoras).toBeCloseTo(0.5, 6);
  });

  it('é zero para canal sem afinidade registrada', () => {
    const score = relevanceScore({
      video: freshVideo({ ytChannelId: 'UCdesconhecido' }),
      nowMs: NOON,
      affinity: new Map(),
      config,
    });
    expect(score).toBe(0);
  });
});

describe('topKChannels', () => {
  it('pega os K de maior afinidade', () => {
    const top = topKChannels(affinityOf({ a: 0.1, b: 0.9, c: 0.5, d: 0.7 }), 2);
    expect([...top].sort()).toEqual(['b', 'd']);
  });

  it('desempata por id para ser determinístico', () => {
    const top = topKChannels(affinityOf({ zzz: 0.5, aaa: 0.5 }), 1);
    expect([...top]).toEqual(['aaa']);
  });

  it('tolera K zero e K maior que o mapa', () => {
    const affinity = affinityOf({ a: 0.5, b: 0.6 });
    expect(topKChannels(affinity, 0).size).toBe(0);
    expect(topKChannels(affinity, 99).size).toBe(2);
  });
});

describe('portão de relevância', () => {
  it('aceita canal no topo da afinidade', () => {
    const gate = evaluateHotInsertGate({
      video: freshVideo(),
      nowMs: NOON,
      affinity: withNewChannel(new Map(), 'UCnovo', 0.9),
      favorites: new Set(),
      config,
    });
    expect(gate).toEqual({ eligible: true, reason: 'top_affinity' });
  });

  it('aceita favorito mesmo com afinidade baixa', () => {
    const gate = evaluateHotInsertGate({
      video: freshVideo(),
      nowMs: NOON,
      affinity: baseAffinity, // 'UCnovo' nem aparece
      favorites: new Set(['UCnovo']),
      config,
    });
    expect(gate).toEqual({ eligible: true, reason: 'favorite' });
  });

  it('aceita live começando agora', () => {
    const gate = evaluateHotInsertGate({
      video: freshVideo({ isLive: true }),
      nowMs: NOON,
      affinity: baseAffinity,
      favorites: new Set(),
      config,
    });
    expect(gate).toEqual({ eligible: true, reason: 'live_start' });
  });

  it('recusa canal fora do top-K — senão todo upload viraria interrupção', () => {
    const gate = evaluateHotInsertGate({
      video: freshVideo(),
      nowMs: NOON,
      affinity: baseAffinity,
      favorites: new Set(),
      config,
    });
    expect(gate).toEqual({ eligible: false, reason: 'low_affinity' });
  });

  it('recusa vídeo antigo: novidade de 3 dias atrás não é novidade', () => {
    const gate = evaluateHotInsertGate({
      video: freshVideo({ publishedAt: NOON - 3 * 86_400_000 }),
      nowMs: NOON,
      affinity: withNewChannel(new Map(), 'UCnovo', 0.9),
      favorites: new Set(),
      config,
    });
    expect(gate).toEqual({ eligible: false, reason: 'stale' });
  });

  it('recusa Short mesmo de canal favorito', () => {
    const gate = evaluateHotInsertGate({
      video: freshVideo({ durationSec: 30 }),
      nowMs: NOON,
      affinity: withNewChannel(new Map(), 'UCnovo', 0.9),
      favorites: new Set(['UCnovo']),
      config,
    });
    expect(gate).toEqual({ eligible: false, reason: 'filtered_out' });
  });
});

describe('computeZones', () => {
  it('separa ao-ar, congelada e cauda', () => {
    const zones = computeZones(baseGrid.slots, NOON, config);
    const onAir = findSlotAt(baseGrid.slots, NOON)!;

    expect(zones.onAir?.seq).toBe(onAir.seq);
    expect(zones.frozen[0]?.seq).toBe(onAir.seq);
    expect(zones.frozen.length).toBeGreaterThan(0);
    expect(zones.tail[0]!.seq).toBe(zones.frozen[zones.frozen.length - 1]!.seq + 1);
  });

  it('descarta o passado das três zonas', () => {
    const zones = computeZones(baseGrid.slots, NOON, config);
    for (const s of [...zones.frozen, ...zones.tail]) {
      expect(s.endsAtMs).toBeGreaterThan(NOON);
    }
  });

  it('a cauda começa exatamente onde a zona congelada termina', () => {
    const zones = computeZones(baseGrid.slots, NOON, config);
    const lastFrozen = zones.frozen[zones.frozen.length - 1]!;
    expect(zones.tailStartsAtMs).toBe(lastFrozen.endsAtMs);
    expect(zones.tail[0]!.startsAtMs).toBe(zones.tailStartsAtMs);
  });

  it('congela um slot só se ele começa antes da fronteira', () => {
    // Horizonte de 10 min sobre slots de 10 min: no início de um slot, o próximo
    // começa exatamente na fronteira e portanto é re-fluível.
    const slotStart = baseGrid.slots[72]!.startsAtMs;
    const zones = computeZones(baseGrid.slots, slotStart, config);
    expect(zones.frozen.map((s) => s.seq)).toEqual([72]);
    expect(zones.tail[0]!.seq).toBe(73);
  });

  it('horizonte maior congela mais slots', () => {
    const largo = makeConfig({ frozenHorizonSec: 3_600 });
    const zones = computeZones(baseGrid.slots, NOON, largo);
    expect(zones.frozen.length).toBeGreaterThanOrEqual(6);
  });
});

describe('inserção a quente — invariantes', () => {
  it('nunca altera o slot no ar', () => {
    const antes = findSlotAt(baseGrid.slots, NOON)!;
    const out = insert(freshVideo());
    expect(out.applied).toBe(true);
    if (!out.applied) return;

    const depois = findSlotAt(out.slots, NOON)!;
    expect(depois).toEqual(antes);
  });

  it('nunca altera a zona congelada', () => {
    const zonesAntes = computeZones(baseGrid.slots, NOON, config);
    const out = insert(freshVideo());
    if (!out.applied) throw new Error('esperava inserção aplicada');

    const zonesDepois = computeZones(out.slots, NOON, config);
    expect(zonesDepois.frozen).toEqual(zonesAntes.frozen);
  });

  it('preserva o passado intacto', () => {
    const passadoAntes = baseGrid.slots.filter((s) => s.endsAtMs <= NOON);
    const out = insert(freshVideo());
    if (!out.applied) throw new Error('esperava inserção aplicada');

    const passadoDepois = out.slots.filter((s) => s.endsAtMs <= NOON);
    expect(passadoDepois).toEqual(passadoAntes);
  });

  it('coloca o vídeo novo no primeiro slot da cauda — R-A manda', () => {
    const zones = computeZones(baseGrid.slots, NOON, config);
    const out = insert(freshVideo());
    if (!out.applied) throw new Error('esperava inserção aplicada');

    expect(out.insertedAtSeq).toBe(zones.tail[0]!.seq);
    const inserido = out.slots.find((s) => s.seq === out.insertedAtSeq)!;
    expect(inserido.videoId).toBe('novo-quente');
    expect(inserido.isHotInsert).toBe(true);
    expect(inserido.startsAtMs).toBe(zones.tailStartsAtMs);
  });

  it('mantém a grade contígua depois do re-fluxo', () => {
    const out = insert(freshVideo());
    if (!out.applied) throw new Error('esperava inserção aplicada');

    for (let i = 1; i < out.slots.length; i++) {
      expect(out.slots[i]!.startsAtMs).toBe(out.slots[i - 1]!.endsAtMs);
      expect(out.slots[i]!.seq).toBe(out.slots[i - 1]!.seq + 1);
    }
  });

  it('empurra a cauda para frente sem perder cobertura do dia', () => {
    const out = insert(freshVideo());
    if (!out.applied) throw new Error('esperava inserção aplicada');
    expect(out.coverageEndMs).toBeGreaterThanOrEqual(DAY_START_SP + 86_400_000);
  });

  it('preserva R-B: nenhum canal duas vezes depois do patch', () => {
    const out = insert(freshVideo());
    if (!out.applied) throw new Error('esperava inserção aplicada');

    const seen = new Set<string>();
    for (const s of out.slots) {
      expect(seen.has(s.ytChannelId)).toBe(false);
      seen.add(s.ytChannelId);
    }
  });

  it('preserva R-A dentro da cauda re-fluída', () => {
    const zones = computeZones(baseGrid.slots, NOON, config);
    const out = insert(freshVideo());
    if (!out.applied) throw new Error('esperava inserção aplicada');

    const byId = new Map([...basePool, freshVideo()].map((v) => [v.id, v]));
    const tail = out.slots.filter((s) => s.startsAtMs >= zones.tailStartsAtMs);
    expect(tail.length).toBeGreaterThan(10);

    for (let i = 1; i < tail.length; i++) {
      const prev = byId.get(tail[i - 1]!.videoId)!;
      const cur = byId.get(tail[i]!.videoId)!;
      expect(cur.publishedAt).toBeLessThanOrEqual(prev.publishedAt);
    }
  });

  it('R-A não atravessa a fronteira congelada — e isso é intencional', () => {
    /*
     * A zona congelada é imutável por decisão de projeto, então ela pode conter
     * vídeos mais antigos do que o que entra logo depois. Ou seja: existe um degrau
     * "antigo → novo" exatamente na fronteira.
     *
     * O teste registra isso de propósito. A alternativa seria re-fluir a zona
     * congelada para manter R-A global, mas aí o vídeo que o usuário está assistindo
     * mudaria embaixo dele — um defeito muito pior do que um degrau no guia.
     */
    const zones = computeZones(baseGrid.slots, NOON, config);
    const out = insert(freshVideo());
    if (!out.applied) throw new Error('esperava inserção aplicada');

    const byId = new Map([...basePool, freshVideo()].map((v) => [v.id, v]));
    const ultimoCongelado = byId.get(zones.frozen[zones.frozen.length - 1]!.videoId)!;
    const primeiroDaCauda = byId.get(
      out.slots.find((s) => s.startsAtMs === zones.tailStartsAtMs)!.videoId,
    )!;

    expect(primeiroDaCauda.publishedAt).toBeGreaterThan(ultimoCongelado.publishedAt);
  });
});

describe('inserção a quente — recusas', () => {
  it('recusa quando o portão de relevância nega', () => {
    const out = insert(freshVideo(), { affinity: baseAffinity });
    expect(out).toMatchObject({ applied: false, reason: 'gate_rejected' });
    expect(out.slots).toEqual(baseGrid.slots);
  });

  it('recusa ao atingir o teto diário de inserções', () => {
    const priores = Array.from({ length: 6 }, (_, i) => NOON - (i + 2) * 3_600_000);
    const out = insert(freshVideo(), { priorHotInsertsAtMs: priores });
    expect(out).toMatchObject({ applied: false, reason: 'rate_limited' });
  });

  it('recusa quando a última inserção foi há menos de 20 min', () => {
    const out = insert(freshVideo(), { priorHotInsertsAtMs: [NOON - 10 * 60_000] });
    expect(out).toMatchObject({ applied: false, reason: 'too_soon_after_last' });
  });

  it('aceita quando o intervalo mínimo já passou', () => {
    const out = insert(freshVideo(), { priorHotInsertsAtMs: [NOON - 25 * 60_000] });
    expect(out.applied).toBe(true);
  });

  it('recusa quando não há cauda re-fluível (fim do dia)', () => {
    const quaseFim = baseGrid.coverageEndMs - 60_000;
    const out = insert(freshVideo({ publishedAt: quaseFim - 1000 }), { nowMs: quaseFim });
    expect(out).toMatchObject({ applied: false, reason: 'no_reflowable_tail' });
  });

  it('recusa vídeo que já está na zona congelada', () => {
    const jaNoAr = baseGrid.slots[findSlotAt(baseGrid.slots, NOON)!.seq]!;
    const dup = basePool.find((v) => v.id === jaNoAr.videoId)!;
    const out = insert(
      { ...dup, publishedAt: NOON - 60_000 },
      {
        affinity: withNewChannel(baseAffinity, dup.ytChannelId, 0.99),
      },
    );
    expect(out.applied).toBe(false);
  });
});

describe('inserção a quente — conflito de R-B', () => {
  /**
   * Monta um pool rico em que o canal `UCrep` tem uma única aparição no dia
   * (R-B estrito) e devolve grade, afinidade e a posição dessa aparição.
   */
  function cenarioRep() {
    const pool: PoolVideo[] = [
      ...makePool(150, 1, 600),
      // Mesmo bucket de recência dos demais, para a afinidade alta poder decidir.
      makeVideo({ id: 'rep-antigo', ytChannelId: 'UCrep', ageDays: 1, durationSec: 600 }),
    ];
    const affinity = withNewChannel(uniformAffinity(pool, 0.5), 'UCrep', 0.99);
    const grid = buildGrid({
      tvChannelId: 'tv-rep',
      pool,
      affinity,
      history: emptyHistory(),
      config,
      startAtMs: DAY_START_SP,
    });
    const ocorrencia = grid.slots.find((s) => s.ytChannelId === 'UCrep');
    if (!ocorrencia) throw new Error('cenário inválido: UCrep não entrou na grade');
    return { pool, affinity, grid, ocorrencia };
  }

  function inserirNovoDoMesmoCanal(agora: number) {
    const { pool, affinity, grid } = cenarioRep();
    const novo = makeVideo({ id: 'rep-novissimo', ytChannelId: 'UCrep', durationSec: 600 });
    const comData = { ...novo, publishedAt: agora - 60_000 };
    return {
      grid,
      out: applyHotInsert({
        slots: grid.slots,
        newVideo: comData,
        pool: [...pool, comData],
        nowMs: agora,
        seed: grid.seed,
        affinity,
        favorites: new Set(['UCrep']),
        history: emptyHistory(),
        config,
        priorHotInsertsAtMs: [],
      }),
    };
  }

  it('a ocorrência antiga do canal sai da cauda quando a nova entra', () => {
    const { ocorrencia } = cenarioRep();
    // "Agora" bem antes da aparição do canal, que fica portanto na cauda re-fluível.
    const agora = ocorrencia.startsAtMs - 40 * 60_000;
    const { out } = inserirNovoDoMesmoCanal(agora);

    expect(out.applied).toBe(true);
    if (!out.applied) return;

    // R-B segue valendo: uma aparição por dia, e é a versão mais nova.
    const doCanal = out.slots.filter((s) => s.ytChannelId === 'UCrep');
    expect(doCanal.length).toBe(1);
    expect(doCanal[0]!.videoId).toBe('rep-novissimo');
    expect(out.displacedVideoId).toBe('rep-antigo');
  });

  it('não cola duas aparições do canal quando ele acabou de passar', () => {
    // "Agora" no meio da aparição do canal: ela fica na zona congelada, e o vídeo
    // novo do mesmo canal não pode entrar imediatamente depois.
    const { ocorrencia } = cenarioRep();
    const agora = ocorrencia.startsAtMs + 60_000;
    const { out } = inserirNovoDoMesmoCanal(agora);

    expect(out.applied).toBe(true);
    if (!out.applied) return;

    const posicoes = out.slots
      .map((s, i) => ({ i, ch: s.ytChannelId }))
      .filter((x) => x.ch === 'UCrep')
      .map((x) => x.i);

    expect(posicoes.length).toBeGreaterThanOrEqual(1);
    for (let k = 1; k < posicoes.length; k++) {
      expect(posicoes[k]! - posicoes[k - 1]!).toBeGreaterThanOrEqual(2);
    }
    // O relaxamento em cascata resolveu o conflito sem descartar a novidade.
    expect(out.slots.some((s) => s.videoId === 'rep-novissimo')).toBe(true);
  });
});

describe('dropUnplayable', () => {
  it('remove o vídeo que falhou e re-flui dali para frente', () => {
    const alvo = findSlotAt(baseGrid.slots, NOON)!;
    const out = dropUnplayable({
      slots: baseGrid.slots,
      unplayableVideoId: alvo.videoId,
      pool: basePool,
      nowMs: NOON,
      seed: baseGrid.seed,
      affinity: baseAffinity,
      history: emptyHistory(),
      config,
    });

    expect(out.slots.some((s) => s.videoId === alvo.videoId)).toBe(false);
  });

  it('o substituto começa exatamente no instante do erro — sem tela preta', () => {
    const alvo = findSlotAt(baseGrid.slots, NOON)!;
    const out = dropUnplayable({
      slots: baseGrid.slots,
      unplayableVideoId: alvo.videoId,
      pool: basePool,
      nowMs: NOON,
      seed: baseGrid.seed,
      affinity: baseAffinity,
      history: emptyHistory(),
      config,
    });

    const substituto = findSlotAt(out.slots, NOON);
    expect(substituto).toBeDefined();
    expect(substituto!.startsAtMs).toBe(NOON);
  });

  it('preserva R-B no re-fluxo', () => {
    const alvo = findSlotAt(baseGrid.slots, NOON)!;
    const out = dropUnplayable({
      slots: baseGrid.slots,
      unplayableVideoId: alvo.videoId,
      pool: basePool,
      nowMs: NOON,
      seed: baseGrid.seed,
      affinity: baseAffinity,
      history: emptyHistory(),
      config,
    });

    const seen = new Set<string>();
    for (const s of out.slots) {
      expect(seen.has(s.ytChannelId)).toBe(false);
      seen.add(s.ytChannelId);
    }
  });

  it('mantém a grade contígua', () => {
    const alvo = findSlotAt(baseGrid.slots, NOON)!;
    const out = dropUnplayable({
      slots: baseGrid.slots,
      unplayableVideoId: alvo.videoId,
      pool: basePool,
      nowMs: NOON,
      seed: baseGrid.seed,
      affinity: baseAffinity,
      history: emptyHistory(),
      config,
    });

    for (let i = 1; i < out.slots.length; i++) {
      expect(out.slots[i]!.startsAtMs).toBe(out.slots[i - 1]!.endsAtMs);
    }
  });

  it('sobrevive a falhas consecutivas', () => {
    let slots = baseGrid.slots;
    for (let i = 0; i < 3; i++) {
      const atual = findSlotAt(slots, NOON);
      expect(atual).toBeDefined();
      slots = dropUnplayable({
        slots,
        unplayableVideoId: atual!.videoId,
        pool: basePool,
        nowMs: NOON,
        seed: baseGrid.seed,
        affinity: baseAffinity,
        history: emptyHistory(),
        config,
      }).slots;
    }
    expect(findSlotAt(slots, NOON)).toBeDefined();
  });
});

describe('anti-turbulência', () => {
  it('uma rajada de 20 uploads gera no máximo 6 inserções no dia', () => {
    let slots = baseGrid.slots;
    const aplicadas: number[] = [];
    let agora = NOON;

    for (let i = 0; i < 20; i++) {
      const video = freshVideo({
        id: `rajada-${i}`,
        ytChannelId: `UCraj${i}`,
        publishedAt: agora - 30_000,
      });
      const out = applyHotInsert({
        slots,
        newVideo: video,
        pool: [...basePool, video],
        nowMs: agora,
        seed: baseGrid.seed,
        affinity: withNewChannel(baseAffinity, video.ytChannelId, 0.99),
        favorites: new Set(),
        history: emptyHistory(),
        config,
        priorHotInsertsAtMs: aplicadas,
      });
      if (out.applied) {
        slots = out.slots;
        aplicadas.push(agora);
      }
      agora += 25 * 60_000; // 25 min entre tentativas: passa do intervalo mínimo
    }

    expect(aplicadas.length).toBe(config.maxHotInsertsPerDay);
  });

  it('rajada simultânea aplica só a primeira', () => {
    let slots = baseGrid.slots;
    const aplicadas: number[] = [];

    for (let i = 0; i < 5; i++) {
      const video = freshVideo({
        id: `simult-${i}`,
        ytChannelId: `UCsim${i}`,
        publishedAt: NOON - 30_000,
      });
      const out = applyHotInsert({
        slots,
        newVideo: video,
        pool: [...basePool, video],
        nowMs: NOON,
        seed: baseGrid.seed,
        affinity: withNewChannel(baseAffinity, video.ytChannelId, 0.99),
        favorites: new Set(),
        history: emptyHistory(),
        config,
        priorHotInsertsAtMs: aplicadas,
      });
      if (out.applied) {
        slots = out.slots;
        aplicadas.push(NOON);
      }
    }

    expect(aplicadas.length).toBe(1);
  });
});
